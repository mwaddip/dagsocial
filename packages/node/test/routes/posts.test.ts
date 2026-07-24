import { uid } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { initDb, closeDb } from '../../src/store/db.js';
import { insertIdentity, getIdentity } from '../../src/store/identities.js';
import { insertPost, getPost, queryPosts } from '../../src/store/posts.js';
import { consumeChallenge, getActiveChallenge } from '../../src/store/challenges.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import { getKarmaBox, insertBox } from '../../src/store/utxo.js';
import { getLikeCount } from '../../src/store/likes.js';
import { insertSubBlock as insertMempoolSubBlock, insertUtxoTx, getPendingEntries } from '../../src/store/mempool.js';
import { verifyPost } from '../../src/services/verifier.js';
import {
  encodePost,
  generateKeyPair,
  PROTOCOL_VERSION,
  computeBoxId,
} from '@dagsocial/types';
import type { KarmaBox } from '@dagsocial/types';
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
    const deps = {
      insertPost,
      consumeChallenge,
      getPost,
      queryPosts,
      encodePost,
      verifyPost: overrides?.verifyPost ?? verifyPost,
      getActiveChallenge,
      getIdentity,
      getKarmaBox,
      getLikeCount,
      getCurrentHeight,
      insertMempoolSubBlock,
      insertUtxoTx,
      onSubBlockReceived: () => {},
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
      author: uid('someone'),
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
    insertIdentity(userId, kp.publicKey);

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
  // Success case: post → mempool batch
  // -----------------------------------------------------------------------

  it('POST /posts with valid post inserts batch into mempool', async () => {
    const kp = generateKeyPair();
    const userId = kp.publicKey;
    const userIdHex = Buffer.from(userId).toString('hex');

    // Setup: identity
    insertIdentity(userId, kp.publicKey);

    // Setup: karma box
    const karmaBox: KarmaBox = {
      boxType: 'karma',
      value: 100,
      createdAtBlock: 1,
      owner: userId,
      guard: 'owner_signature',
      proofSource: 'genesis',
      lastTouchBlock: 1,
    };
    const karmaBoxId = computeBoxId(karmaBox);
    const karmaBoxWithId: KarmaBox = { ...karmaBox, id: karmaBoxId };
    insertBox(karmaBoxWithId);

    // Setup: challenge
    const challengeBytes = new Uint8Array(Buffer.from('cc'.repeat(32), 'hex'));
    const { createChallenge } = await import('../../src/store/challenges.js');
    createChallenge(userId, challengeBytes, 9999);

    const timestamp = Date.now();

    // Mock verifyPost to return valid
    const mockVerify = () => ({ valid: true as const });

    const res = await request('/', 'POST', {
      content: 'hello mempool',
      author: userIdHex,
      parentRefs: [],
      challenge: Buffer.from(challengeBytes).toString('hex'),
      powNonce: 42,
      protocolVersion: PROTOCOL_VERSION,
      timestamp,
      signature: 'dd'.repeat(64),
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
