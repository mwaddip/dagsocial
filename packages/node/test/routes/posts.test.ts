import { uid, txToJson, rawPublicKey, signTransaction } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createHash, generateKeyPairSync, createPrivateKey } from 'crypto';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import { insertPost, getPost, getPostRaw, queryPosts, getAncestors, getSubtree } from '../../src/store/posts.js';
import { consumeChallenge, getActiveChallenge } from '../../src/store/challenges.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import { getKarmaBox, getKarmaBoxes, insertBox, getBox as storeGetBox } from '../../src/store/utxo.js';
import { getLikeCount } from '../../src/store/likes.js';
import { getLikersForPost } from '../../src/store/utxo.js';
import { metaPut, metaGet } from '../../src/store/meta.js';
import { insertSubBlock as insertMempoolSubBlock, insertUtxoTx, getPendingEntries } from '../../src/store/mempool.js';
import { verifyPost } from '../../src/services/verifier.js';
import { validateTx } from '../../src/services/utxo-engine.js';
import {
  encodePost,
  generateKeyPair,
  PROTOCOL_VERSION,
  computeBoxId,
  POST_LOCK_THREAD_COST,
} from '@dagsocial/types';
import type { KarmaBox, PostLockBox, UtxoTransaction, AnyBox } from '@dagsocial/types';
import { createRouter } from '../../src/routes/posts.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-routes-posts.sqlite';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(
  path: string,
  method: string,
  body?: unknown,
  overrides?: {
    verifyPost?: typeof import('../../src/services/verifier.js').verifyPost;
  },
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const db = getDb();
    const deps = {
      insertPost,
      consumeChallenge,
      getPost,
      getPostRaw,
      queryPosts,
      encodePost,
      verifyPost: overrides?.verifyPost ?? verifyPost,
      getActiveChallenge,
      getKarmaBoxes,
      getKarmaBox,
      getLikeCount,
      getLikersForPost,
      getAncestors,
      getSubtree,
      getCurrentHeight,
      insertMempoolSubBlock,
      insertUtxoTx,
      onSubBlockReceived: () => {},
      metaPut,
      metaGet,
      validateTx: (tx: UtxoTransaction, height: number) => {
        return validateTx(
          {
            getBox: (id: string): AnyBox | null => {
              const box = storeGetBox(id);
              if (!box) return null;
              const r = db.prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?').get(id) as { spent_at_block: number | null } | undefined;
              return r && r.spent_at_block === null ? box : null;
            },
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
          },
          tx,
          height,
        );
      },
	      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db.prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?').get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
    };
    const app = express();
    app.use(express.json());
    app.use('/posts', createRouter(deps));
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const r = http.request(
        {
          hostname: 'localhost',
          port: addr.port,
          path: '/posts' + path,
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

describe('posts routes', () => {
  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
  });

  // -----------------------------------------------------------------------
  // Error cases
  // -----------------------------------------------------------------------

  it('POST /posts with missing fields returns 400', async () => {
    const res = await request('/', 'POST', {});
    expect(res.status).toBe(400);
  });

  it('POST /posts with invalid hex returns 400', async () => {
    const res = await request('/', 'POST', {
      content: 'test',
      author: 'not-hex!!@@',
      parentRefs: [],
      challenge: 'not-hex!!@@',
      powNonce: 0,
      protocolVersion: 1,
      timestamp: Date.now(),
      signature: 'ff'.repeat(64),
    });
    expect(res.status).toBe(400);
  });

  it('POST /posts with no challenge returns 400', async () => {
    // Create identity but no challenge
    const kp = generateKeyPair();
    const userId = kp.publicKey;

    const res = await request('/', 'POST', {
      content: 'test',
      author: userId,
      parentRefs: [],
      challenge: 'aa'.repeat(32),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: Date.now(),
      signature: 'bb'.repeat(64),
    });
    expect(res.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // Success case: post -> mempool batch with karmaLockTx
  // -----------------------------------------------------------------------

  it('POST /posts with valid post and karmaLockTx inserts batch into mempool', async () => {
    const kp = generateKeyPair();
    const userId = kp.publicKey;
    const userIdHex = Buffer.from(userId).toString('hex');
    const privKeyObj = createPrivateKey({
      key: Buffer.from(kp.secretKey),
      format: 'der',
      type: 'pkcs8',
    });

    // Setup: identity

    // Setup: karma box
    const karmaBox: KarmaBox = {
      boxType: 'karma',
      value: 100n,
      createdAtBlock: 1,
      owner: userId,
      guard: 'owner_signature',
      proofSource: 'genesis',
      lastTouchBlock: 1,
    };
    const karmaBoxId = computeBoxId(karmaBox);
    insertBox({ ...karmaBox, id: karmaBoxId });

    // Setup: challenge
    const challengeBytes = new Uint8Array(Buffer.from('cc'.repeat(32), 'hex'));
    const { createChallenge } = await import('../../src/store/challenges.js');
    createChallenge(userId, challengeBytes, 9999);

    const timestamp = Date.now();

    // Build karma-lock tx
    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 100n - POST_LOCK_THREAD_COST,
      createdAtBlock: 5,
      owner: userId,
      guard: 'owner_signature',
      proofSource: 'post-lock',
      lastTouchBlock: 5,
    };
    const newKarmaId = computeBoxId(newKarma);

    const postLockBox: PostLockBox = {
      boxType: 'post_lock',
      value: POST_LOCK_THREAD_COST,
      createdAtBlock: 5,
      originalValue: POST_LOCK_THREAD_COST,
      owner: userId,
      targetPostId: '', // Will be filled by postId after submission
      guard: 'epoch_tally',
    };

    // Use a placeholder postId for the lock box (the tx is validated before the
    // post ID is known, but the lock box must reference a valid post ID)
    // We'll compute it from the post so it matches
    const challengeHex = Buffer.from(challengeBytes).toString('hex');

    const karmaLockTx: UtxoTransaction = {
      inputs: [karmaBoxId],
      outputs: [
        { ...newKarma, id: newKarmaId },
        { ...postLockBox, id: computeBoxId(postLockBox) },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(karmaLockTx, privKeyObj, userIdHex);
    const karmaLockTxJson = txToJson(karmaLockTx);

    // Mock verifyPost to return valid
    const mockVerify = () => ({ valid: true as const });

    const res = await request('/', 'POST', {
      content: 'hello mempool',
      author: userIdHex,
      parentRefs: [],
      challenge: challengeHex,
      powNonce: 42,
      protocolVersion: PROTOCOL_VERSION,
      timestamp,
      signature: 'dd'.repeat(64),
      karmaLockTx: karmaLockTxJson,
    }, { verifyPost: mockVerify as typeof verifyPost });

    expect(res.status).toBe(200);

    const body = res.data as Record<string, unknown>;
    expect(body).toHaveProperty('postId');
    expect(body.status).toBe('pending');
    expect(body).toHaveProperty('expiresAtHeight');
    expect(typeof body.expiresAtHeight).toBe('number');

    // Verify mempool has both entries with matching batchId
    const entries = getPendingEntries(100);
    const subBlockEntry = entries.find((e) => e.entryType === 'subblock');
    const utxoEntry = entries.find((e) => e.entryType === 'utxo_tx');

    expect(subBlockEntry).toBeDefined();
    expect(utxoEntry).toBeDefined();
    expect(subBlockEntry!.batchId).toBe(body.postId);
    expect(utxoEntry!.batchId).toBe(body.postId);
    expect(subBlockEntry!.batchId).toBe(utxoEntry!.batchId);
    expect(subBlockEntry!.expiresAtHeight).toBe(body.expiresAtHeight);
    expect(utxoEntry!.expiresAtHeight).toBe(body.expiresAtHeight);
  });

  // -----------------------------------------------------------------------
  // GET tests
  // -----------------------------------------------------------------------

  it('GET /posts/:id returns 404 for unknown post', async () => {
    const res = await request('/nonexistent-post-id', 'GET');
    expect(res.status).toBe(404);
  });

  it('GET /posts with pagination returns empty array when no posts', async () => {
    const res = await request('/', 'GET');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });
});
