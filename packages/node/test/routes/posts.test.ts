import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { initDb, closeDb } from '../../src/store/db.js';
import { insertIdentity, getIdentity } from '../../src/store/identities.js';
import { insertPost, getPost, queryPosts } from '../../src/store/posts.js';
import { consumeChallenge, getActiveChallenge } from '../../src/store/challenges.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import { getKarmaBox } from '../../src/store/utxo.js';
import { verifyPost } from '../../src/services/verifier.js';
import {
  encodePost,
  generateKeyPair,
  getUserId,
} from '@dagsocial/types';
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
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const deps = {
      insertPost,
      consumeChallenge,
      getPost,
      queryPosts,
      encodePost,
      verifyPost,
      getActiveChallenge,
      getIdentity,
      getKarmaBox,
      getCurrentHeight,
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

  it('POST /posts with missing fields returns 400', async () => {
    const res = await request('/', 'POST', {});
    expect(res.status).toBe(400);
  });

  it('POST /posts with invalid hex returns 400', async () => {
    const res = await request('/', 'POST', {
      content: 'test',
      author: 'someone',
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
    const userId = getUserId(kp.publicKey);
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
