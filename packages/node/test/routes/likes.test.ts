import {
  fixtureProvenance,
  uid, txToJson, rawPublicKey, signTransaction } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { createHash, generateKeyPairSync, createPrivateKey, sign as cryptoSign } from 'crypto';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import { insertPost } from '../../src/store/posts.js';
import {
  getBoxByProvenance as storeGetBoxByProvenance, insertBox, getKarmaBox, getBox as storeGetBox } from '../../src/store/utxo.js';
import { insertLike } from '../../src/store/likes.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import { castLike, removeLike } from '../../src/services/likes.js';
import {
  generateKeyPair,
  computeBoxId,
  computePostId,
  LIKE_COST,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { Post, KarmaBox, LikeBox, UtxoTransaction, AnyBox } from '@dagsocial/types';
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
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
      castLike,
      removeLike,
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

/** Build a signed like tx and return the tx with its JSON representation. */
function buildLikeTx(
  karmaBox: KarmaBox,
  likerId: Uint8Array,
  likerPrivKey: ReturnType<typeof createPrivateKey>,
  likerPubKey: Uint8Array,
  likerPubKeyHex: string,
  postId: string,
  seed: number,
): { tx: UtxoTransaction; txJson: Record<string, unknown> } {
  const newKarma: KarmaBox = {
    boxType: 'karma',
    value: karmaBox.value - LIKE_COST,
    owner: likerPubKey,
    guard: 'owner_signature',
    proofSource: `like:${postId}`,
  };
  const likeBox: LikeBox = {
    boxType: 'like',
    value: LIKE_COST,
    likerId,
    targetPostId: postId,
    guard: 'epoch_tally',
  };

  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!],
    outputs: [
      { ...newKarma, id: computeBoxId(newKarma) },
      { ...likeBox, id: computeBoxId(likeBox) },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
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
  let postId2: string;
  let freeLikerId: Uint8Array;
  let freeLikerKp: ReturnType<typeof generateKeyPair>;
  let freeLikerPrivKey: ReturnType<typeof createPrivateKey>;
  let freeLikerPubKeyHex: string;

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

    // ---- Setup for free like removal test ----

    // Second post
    const post2: Post = {
      content: 'test post for free unlike',
      author: authorId,
      parentRefs: [],
      challenge: new Uint8Array(32),
      powNonce: 0,
      protocolVersion: PROTOCOL_VERSION,
      timestamp: Date.now(),
      signature: new Uint8Array(64),
    };
    postId2 = computePostId(post2);
    insertPost(post2, new Uint8Array(16));

    // Free liker with karma
    freeLikerKp = generateKeyPair();
    freeLikerId = freeLikerKp.publicKey;
    freeLikerPrivKey = createPrivateKey({
      key: Buffer.from(freeLikerKp.secretKey),
      format: 'der',
      type: 'pkcs8',
    });
    freeLikerPubKeyHex = Buffer.from(freeLikerId).toString('hex');

    const freeKarmaBox: KarmaBox = {
      boxType: 'karma',
      value: 100n,
      owner: freeLikerKp.publicKey,
      guard: 'owner_signature',
      proofSource: 'test',
    };
    Object.assign(freeKarmaBox, fixtureProvenance(freeKarmaBox, 1));
    const freeKarmaBoxId = computeBoxId(freeKarmaBox);
    insertBox({ ...freeKarmaBox, id: freeKarmaBoxId });

    // Insert a free like row directly (bypasses castLike's threshold check)
    insertLike(postId2, freeLikerId);
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

  it('POST /likes to unknown post returns 400', async () => {
    const { txJson } = buildLikeTx(
      karmaBox,
      likerId,
      likerPrivKey,
      likerId,
      likerPubKeyHex,
      'nonexistent-post',
      5,
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
        karmaBox,
        likerId,
        likerPrivKey,
        likerId,
        likerPubKeyHex,
        postId,
        5,
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

    it('applies the same policy on POST /likes/remove', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const unexpected = await request('/remove', 'POST', { tx: validTxJson() }, {
          removeLike: () => {
            throw new Error(SECRET);
          },
        });
        expect(unexpected.status).toBe(500);
        expect((unexpected.data as Record<string, unknown>).error).toBe('Internal error');
        expect(JSON.stringify(unexpected.data)).not.toContain('SQLITE_CORRUPT');

        const intentional = await request('/remove', 'POST', { tx: validTxJson() }, {
          removeLike: () => {
            throw new ClientError('Transaction does not consume a LikeBox');
          },
        });
        expect(intentional.status).toBe(400);
        expect((intentional.data as Record<string, unknown>).reason).toBe(
          'Transaction does not consume a LikeBox',
        );
      } finally {
        error.mockRestore();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // POST /likes — pending (locked)
  // ---------------------------------------------------------------------------

  it('POST /likes with valid signed tx returns 200 with pending status', async () => {
    const { txJson } = buildLikeTx(
      karmaBox,
      likerId,
      likerPrivKey,
      likerId,
      likerPubKeyHex,
      postId,
      5,
    );
    const res = await request('/', 'POST', { tx: txJson });
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(typeof body.txId).toBe('string');
    expect(typeof body.expiresAtHeight).toBe('number');
  });

  // ---------------------------------------------------------------------------
  // POST /likes — duplicate (detected via mempool)
  // ---------------------------------------------------------------------------

  it('POST /likes duplicate returns 400', async () => {
    const { txJson } = buildLikeTx(
      karmaBox,
      likerId,
      likerPrivKey,
      likerId,
      likerPubKeyHex,
      postId,
      5,
    );
    // First like consumed the karma box in previous test via mempool
    // The karma box is already spent in the pending tx, so this should fail
    // Actually: the pending tx only inserts into mempool, doesn't consume.
    // So the karma box is still unspent. But the second like with same
    // target/liker will be caught as duplicate via mempool scan.
    const res = await request('/', 'POST', { tx: txJson });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // POST /likes/remove validation errors
  // ---------------------------------------------------------------------------

  it('POST /likes/remove with missing tx returns 400', async () => {
    const res = await request('/remove', 'POST', {});
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // POST /likes/remove — locked like (pending)
  // ---------------------------------------------------------------------------

  it('POST /likes/remove locked like returns 200 with pending', async () => {
    // Insert a locked like box directly into utxo_boxes
    const likeBox: LikeBox = {
      boxType: 'like',
      value: LIKE_COST,
      likerId,
      targetPostId: postId,
      guard: 'epoch_tally',
    };
    Object.assign(likeBox, fixtureProvenance(likeBox, 1));
    const likeBoxId = computeBoxId(likeBox);
    insertBox({ ...likeBox, id: likeBoxId });

    // Build unlike tx: consume LikeBox -> produce karma
    const karmaOut: KarmaBox = {
      boxType: 'karma',
      value: LIKE_COST,
      owner: likerId,
      guard: 'owner_signature',
      proofSource: `unlike:${postId}`,
    };

    const tx: UtxoTransaction = {
      inputs: [likeBoxId],
      outputs: [
        { ...karmaOut, id: computeBoxId(karmaOut) },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    signTransaction(tx, likerPrivKey, likerPubKeyHex);
    const txJson = txToJson(tx);

    const res = await request('/remove', 'POST', { tx: txJson });
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(typeof body.txId).toBe('string');
    expect(typeof body.expiresAtHeight).toBe('number');
  });
});
