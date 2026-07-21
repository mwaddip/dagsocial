import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createHash, createPrivateKey, sign as cryptoSign } from 'crypto';
import { initDb, closeDb } from '../../src/store/db.js';
import { insertIdentity } from '../../src/store/identities.js';
import { insertPost } from '../../src/store/posts.js';
import { insertBox } from '../../src/store/utxo.js';
import { insertLike } from '../../src/store/likes.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import { castLike, removeLike } from '../../src/services/likes.js';
import {
  generateKeyPair,
  getUserId,
  computeBoxId,
  computePostId,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { Post, KarmaBox } from '@dagsocial/types';
import { createRouter } from '../../src/routes/likes.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-routes-likes.sqlite';

// ---------------------------------------------------------------------------
// Ed25519 helpers
// ---------------------------------------------------------------------------

function signLike(likerId: string, targetPostId: string, secretKey: Uint8Array): string {
  const keyObj = createPrivateKey({
    key: Buffer.from(secretKey),
    format: 'der',
    type: 'pkcs8',
  });
  const signData = JSON.stringify({ targetPostId, likerId });
  const hash = createHash('blake2b512').update(signData).digest().subarray(0, 32);
  const sig = cryptoSign(null, hash, keyObj);
  return Buffer.from(sig).toString('hex');
}

function signUnlike(likerId: string, targetPostId: string, secretKey: Uint8Array): string {
  const keyObj = createPrivateKey({
    key: Buffer.from(secretKey),
    format: 'der',
    type: 'pkcs8',
  });
  const signData = JSON.stringify({ targetPostId, likerId, action: 'unlike' });
  const hash = createHash('blake2b512').update(signData).digest().subarray(0, 32);
  const sig = cryptoSign(null, hash, keyObj);
  return Buffer.from(sig).toString('hex');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(
  path: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const deps = { castLike, removeLike, getCurrentHeight };
    const app = express();
    app.use(express.json());
    app.use('/likes', createRouter(deps));
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('likes routes', () => {
  let postId: string;
  let likerId: string;
  let likerKp: ReturnType<typeof generateKeyPair>;
  let postId2: string;
  let freeLikerId: string;
  let freeLikerKp: ReturnType<typeof generateKeyPair>;

  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);

    // Create a post author (needed for post insertion)
    const authorKp = generateKeyPair();
    const authorId = getUserId(authorKp.publicKey);
    insertIdentity(authorId, authorKp.publicKey);

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
    likerId = getUserId(likerKp.publicKey);
    insertIdentity(likerId, likerKp.publicKey);

    const karmaBox: KarmaBox = {
      boxType: 'karma',
      value: 100,
      createdAtBlock: 1,
      owner: likerKp.publicKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 1,
    };
    const karmaBoxId = computeBoxId(karmaBox);
    insertBox({ ...karmaBox, id: karmaBoxId });

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
    freeLikerId = getUserId(freeLikerKp.publicKey);
    insertIdentity(freeLikerId, freeLikerKp.publicKey);

    const freeKarmaBox: KarmaBox = {
      boxType: 'karma',
      value: 100,
      createdAtBlock: 1,
      owner: freeLikerKp.publicKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 1,
    };
    const freeKarmaBoxId = computeBoxId(freeKarmaBox);
    insertBox({ ...freeKarmaBox, id: freeKarmaBoxId });

    // Insert a free like row directly (bypasses castLike's threshold check)
    insertLike(postId2, freeLikerId);
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
  });

  it('POST /likes with missing fields returns 400', async () => {
    const res = await request('/', 'POST', {});
    expect(res.status).toBe(400);
  });

  it('POST /likes with invalid hex signature returns 400', async () => {
    const res = await request('/', 'POST', {
      targetPostId: postId,
      likerId,
      signature: 'zzz##nothex',
    });
    expect(res.status).toBe(400);
  });

  it('POST /likes to unknown post returns 400', async () => {
    const sig = signLike(likerId, 'nonexistent-post', likerKp.secretKey);
    const res = await request('/', 'POST', {
      targetPostId: 'nonexistent-post',
      likerId,
      signature: sig,
    });
    expect(res.status).toBe(400);
  });

  it('POST /likes with valid signed like returns 201 (locked)', async () => {
    const sig = signLike(likerId, postId, likerKp.secretKey);
    const res = await request('/', 'POST', {
      targetPostId: postId,
      likerId,
      signature: sig,
    });
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(typeof body.likeId).toBe('string');
    expect(body.type).toBe('locked');
  });

  it('POST /likes duplicate returns 400', async () => {
    // Like the same post with same liker — should fail
    const sig = signLike(likerId, postId, likerKp.secretKey);
    const res = await request('/', 'POST', {
      targetPostId: postId,
      likerId,
      signature: sig,
    });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // POST /likes/remove
  // ---------------------------------------------------------------------------

  it('POST /likes/remove with missing fields returns 400', async () => {
    const res = await request('/remove', 'POST', {});
    expect(res.status).toBe(400);
  });

  it('POST /likes/remove with invalid hex signature returns 400', async () => {
    const res = await request('/remove', 'POST', {
      targetPostId: postId,
      likerId,
      signature: 'zzz##nothex',
    });
    expect(res.status).toBe(400);
  });

  it('POST /likes/remove on unknown post returns 400', async () => {
    const sig = signUnlike(likerId, 'nonexistent-post', likerKp.secretKey);
    const res = await request('/remove', 'POST', {
      targetPostId: 'nonexistent-post',
      likerId,
      signature: sig,
    });
    expect(res.status).toBe(400);
  });

  it('POST /likes/remove locked like returns 200 with netKarma=1', async () => {
    // The like from the earlier test is already cast (locked). Remove it.
    const sig = signUnlike(likerId, postId, likerKp.secretKey);
    const res = await request('/remove', 'POST', {
      targetPostId: postId,
      likerId,
      signature: sig,
    });
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.removed).toBe(true);
    expect(body.netKarma).toBe(1);
  });

  it('POST /likes/remove like that is already removed returns 404', async () => {
    // Already removed in the previous test
    const sig = signUnlike(likerId, postId, likerKp.secretKey);
    const res = await request('/remove', 'POST', {
      targetPostId: postId,
      likerId,
      signature: sig,
    });
    expect(res.status).toBe(404);
  });

  it('POST /likes/remove free like returns 200 with netKarma=-1', async () => {
    const sig = signUnlike(freeLikerId, postId2, freeLikerKp.secretKey);
    const res = await request('/remove', 'POST', {
      targetPostId: postId2,
      likerId: freeLikerId,
      signature: sig,
    });
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.removed).toBe(true);
    expect(body.netKarma).toBe(-1);
  });

  it('POST /likes/remove with wrong signature returns 400', async () => {
    // Sign for a different action — should fail verification
    const sig = signLike(freeLikerId, postId2, freeLikerKp.secretKey);
    const res = await request('/remove', 'POST', {
      targetPostId: postId2,
      likerId: freeLikerId,
      signature: sig,
    });
    expect(res.status).toBe(400);
  });
});
