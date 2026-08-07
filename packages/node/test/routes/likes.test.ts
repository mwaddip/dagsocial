import {
  fixtureProvenance, txToJson, rawPublicKey, signTransaction } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { generateKeyPairSync, createPrivateKey, type KeyObject } from 'crypto';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import { insertPost } from '../../src/store/posts.js';
import {
  getBoxByProvenance as storeGetBoxByProvenance, insertBox, getKarmaBox, getKarmaBoxes, getBox as storeGetBox } from '../../src/store/utxo.js';
import { hasActiveVouchCooldown as storeHasActiveVouchCooldown } from '../../src/store/vouch-cooldowns.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import { castLike } from '../../src/services/likes.js';
import {
  generateKeyPair,
  computeBoxId,
  computePostId,
  LIKE_KARMA_COST,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { Post, KarmaBox, UtxoTransaction, AnyBox } from '@dagsocial/types';
import { createRouter } from '../../src/routes/likes.js';
import type { LikesDeps } from '../../src/routes/likes.js';
import { ClientError } from '../../src/services/client-error.js';
import { MempoolFullError } from '../../src/store/mempool.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-routes-likes.sqlite';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(
  path: string,
  method: string,
  body?: unknown,
  depOverrides?: Partial<LikesDeps>,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const db = getDb();
    const deps: LikesDeps = {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db
          .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
          .get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
      getBoxByProvenance: storeGetBoxByProvenance,
      insertBox: (box: AnyBox) => {
        insertBox(box);
      },
      consumeBox: (id: string, atBlock: number) => {
        db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(atBlock, id);
      },
      getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
      getKarmaValue: (owner: Uint8Array) =>
        getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
      hasActiveVouchCooldown: storeHasActiveVouchCooldown,
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
      castLike,
      getCurrentHeight,
    };
    const app = express();
    app.use(express.json());
    app.use('/likes', createRouter({ ...deps, ...depOverrides }));
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const r = http.request(
        {
          hostname: 'localhost',
          port: addr.port,
          path: '/likes' + path,
          method,
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode ?? 0, data: JSON.parse(d) });
            } catch {
              resolve({ status: res.statusCode ?? 0, data: d });
            }
          });
        },
      );
      if (body !== undefined) r.write(JSON.stringify(body));
      r.end();
    });
  });
}

/**
 * Build a signed burn-shape like tx (P2-D) and its JSON form: karma box in,
 * one karma output at −LIKE_KARMA_COST, `likeTarget` naming the post.
 */
function buildLikeTx(
  karmaBox: KarmaBox,
  likerPrivKey: KeyObject,
  likerPubKey: Uint8Array,
  likerPubKeyHex: string,
  postId: string,
): { tx: UtxoTransaction; txJson: Record<string, unknown> } {
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!],
    outputs: [
      {
        boxType: 'karma',
        value: karmaBox.value - LIKE_KARMA_COST,
        owner: likerPubKey,
        guard: 'owner_signature',
        proofSource: `like:${postId.slice(0, 8)}`,
      } as KarmaBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    likeTarget: postId,
  };

  signTransaction(tx, likerPrivKey, likerPubKeyHex);
  return { tx, txJson: txToJson(tx) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('likes routes', () => {
  let postId: string;
  let likerId: Uint8Array;
  let likerKp: ReturnType<typeof generateKeyPair>;
  let likerPrivKey: ReturnType<typeof createPrivateKey>;
  let likerPubKeyHex: string;
  let karmaBox: KarmaBox;

  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);

    // Create a post author (needed for post insertion)
    const authorKp = generateKeyPair();
    const authorId = authorKp.publicKey;

    // Create the target post
    const post: Post = {
      content: 'test post for likes',
      author: authorId,
      parentRefs: [],
      challenge: new Uint8Array(32),
      powNonce: 0,
      protocolVersion: PROTOCOL_VERSION,
      timestamp: Date.now(),
      signature: new Uint8Array(64),
    };
    postId = computePostId(post);
    insertPost(post, new Uint8Array(16));

    // Create a liker with sufficient karma
    likerKp = generateKeyPair();
    likerId = likerKp.publicKey;
    likerPrivKey = createPrivateKey({
      key: Buffer.from(likerKp.secretKey),
      format: 'der',
      type: 'pkcs8',
    });
    likerPubKeyHex = Buffer.from(likerId).toString('hex');

    karmaBox = {
      boxType: 'karma',
      value: 100n,
      owner: likerKp.publicKey,
      guard: 'owner_signature',
      proofSource: 'test',
    };
    Object.assign(karmaBox, fixtureProvenance(karmaBox, 1));
    const karmaBoxId = computeBoxId(karmaBox);
    const karmaWithId: KarmaBox = { ...karmaBox, id: karmaBoxId };
    insertBox(karmaWithId);
    karmaBox = karmaWithId;
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
  });

  // ---------------------------------------------------------------------------
  // POST /likes validation errors
  // ---------------------------------------------------------------------------

  it('POST /likes with missing tx returns 400', async () => {
    const res = await request('/', 'POST', {});
    expect(res.status).toBe(400);
  });

  it('POST /likes with invalid tx returns 400', async () => {
    const res = await request('/', 'POST', { tx: { inputs: 'not-an-array' } });
    expect(res.status).toBe(400);
  });

  it('POST /likes without likeTarget returns 400 with a legible reason', async () => {
    const { txJson } = buildLikeTx(karmaBox, likerPrivKey, likerId, likerPubKeyHex, postId);
    delete txJson.likeTarget;
    const res = await request('/', 'POST', { tx: txJson });
    expect(res.status).toBe(400);
    expect((res.data as Record<string, unknown>).reason).toContain('likeTarget');
  });

  it('POST /likes to unknown post returns 400', async () => {
    const { txJson } = buildLikeTx(
      karmaBox, likerPrivKey, likerId, likerPubKeyHex, 'ef'.repeat(32),
    );
    const res = await request('/', 'POST', { tx: txJson });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Route error policy (audit L-12, M-8) — a service's intentional rejection
  // reaches the client; an unexpected error never does.
  // ---------------------------------------------------------------------------

  describe('error policy', () => {
    const SECRET = 'SQLITE_CORRUPT: database disk image is malformed at /srv/dagsocial.db';

    function validTxJson(): Record<string, unknown> {
      return buildLikeTx(
        karmaBox, likerPrivKey, likerId, likerPubKeyHex, postId,
      ).txJson;
    }

    it('returns a generic 500 and logs when the service throws an unexpected error', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await request('/', 'POST', { tx: validTxJson() }, {
          castLike: () => {
            throw new Error(SECRET);
          },
        });

        expect(res.status).toBe(500);
        const body = res.data as Record<string, unknown>;
        expect(body.error).toBe('Internal error');
        expect(JSON.stringify(res.data)).not.toContain('SQLITE_CORRUPT');
        expect(JSON.stringify(res.data)).not.toContain('/srv/dagsocial.db');
        // The detail is kept server-side rather than dropped.
        expect(
          error.mock.calls.some((c) => c.some((a) => String((a as Error)?.message ?? a).includes('SQLITE_CORRUPT'))),
        ).toBe(true);
      } finally {
        error.mockRestore();
      }
    });

    it('control — an intentional rejection still returns its message with 400', async () => {
      const res = await request('/', 'POST', { tx: validTxJson() }, {
        castLike: () => {
          throw new ClientError('Already liked this post');
        },
      });

      expect(res.status).toBe(400);
      const body = res.data as Record<string, unknown>;
      expect(body.reason).toBe('Already liked this post');
    });

    it('maps a full mempool to 503 with a generic body', async () => {
      const res = await request('/', 'POST', { tx: validTxJson() }, {
        castLike: () => {
          throw new MempoolFullError(10000);
        },
      });

      expect(res.status).toBe(503);
      expect(res.data).toEqual({ error: 'mempool full' });
    });
  });

  // ---------------------------------------------------------------------------
  // POST /likes — pending
  // ---------------------------------------------------------------------------

  it('POST /likes with valid signed burn tx returns 200 with pending status', async () => {
    const { txJson } = buildLikeTx(karmaBox, likerPrivKey, likerId, likerPubKeyHex, postId);
    const res = await request('/', 'POST', { tx: txJson });
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(typeof body.txId).toBe('string');
    expect(typeof body.expiresAtHeight).toBe('number');
  });

  // ---------------------------------------------------------------------------
  // POST /likes — duplicate (detected via mempool gate)
  // ---------------------------------------------------------------------------

  it('POST /likes duplicate returns 400', async () => {
    const { txJson } = buildLikeTx(karmaBox, likerPrivKey, likerId, likerPubKeyHex, postId);
    // The pending like from the previous test occupies the (liker, post) pair
    // in the mempool gate, so the same pair is rejected.
    const res = await request('/', 'POST', { tx: txJson });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // POST /likes/remove — the route no longer exists (unlike is not a feature).
  // Router-level wiring assertion: no tombstone, no 410 — a plain 404.
  // ---------------------------------------------------------------------------

  it('POST /likes/remove returns 404 — the route is gone', async () => {
    const res = await request('/remove', 'POST', { tx: {} });
    expect(res.status).toBe(404);
  });
});
