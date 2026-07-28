import { uid } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { initDb, closeDb } from '../../src/store/db.js';
import { insertPost, getPost } from '../../src/store/posts.js';
import { executePrune } from '../../src/services/stump-engine.js';
import {
  computeStumpId,
  computePostId,
  generateKeyPair,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { Post, KeyPair } from '@dagsocial/types';
import { createRouter } from '../../src/routes/pruning.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-routes-pruning.sqlite';

// ---------------------------------------------------------------------------
// Challenge + signature helpers
// ---------------------------------------------------------------------------

function signChallenge(challenge: Uint8Array, secretKey: Uint8Array): Uint8Array {
  const hash = createHash('blake2b512').update(challenge).digest().subarray(0, 32);
  const privKeyObj = createPrivateKey({
    key: Buffer.from(secretKey),
    format: 'der',
    type: 'pkcs8',
  });
  return new Uint8Array(cryptoSign(null, hash, privKeyObj));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePost(authorId: Uint8Array, parentRefs: string[] = []): Post {
  return {
    content: 'test post for pruning',
    author: authorId,
    parentRefs,
    challenge: new Uint8Array(32),
    powNonce: 0,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: Date.now(),
    signature: new Uint8Array(64),
  };
}

async function request(
  postId: string,
  body: unknown,
  mockDeps?: {
    getActiveChallenge?: (userId: Uint8Array) => { challenge: Uint8Array; expiresAtBlock: number; userId: Uint8Array } | null;
    consumeChallenge?: (userId: Uint8Array, challenge: Uint8Array) => void;
    getCurrentHeight?: () => number;
  },
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const deps = {
      executePrune,
      computeStumpId,
      getActiveChallenge: mockDeps?.getActiveChallenge ?? (() => null),
      consumeChallenge: mockDeps?.consumeChallenge ?? (() => {}),
      getCurrentHeight: mockDeps?.getCurrentHeight ?? (() => 0),
    };
    const app = express();
    app.use(express.json());
    app.use(createRouter(deps));
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const r = http.request(
        {
          hostname: 'localhost',
          port: addr.port,
          path: `/posts/${postId}/prune`,
          method: 'POST',
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
      if (body !== undefined) r.write(JSON.stringify(body, (_k, v) => v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v));
      r.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pruning routes', () => {
  let rootPostId: string;
  let childPostId: string;
  let authorId: Uint8Array;
  let authorKeypair: KeyPair;
  let testChallenge: Uint8Array;
  let testChallengeHex: string;
  let testSignatureHex: string;
  let testHeight = 100;

  function makeMockDeps() {
    return {
      getActiveChallenge: (userId: Uint8Array) => ({
        challenge: testChallenge,
        expiresAtBlock: testHeight + 10,
        userId,
      }),
      consumeChallenge: () => {},
      getCurrentHeight: () => testHeight,
    };
  }

  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);

    // Create an author
    authorKeypair = generateKeyPair();
    authorId = authorKeypair.publicKey;

    // Create a challenge + signature for challenge-response auth
    testChallenge = new Uint8Array(32);
    crypto.getRandomValues(testChallenge);
    testChallengeHex = Buffer.from(testChallenge).toString('hex');
    const sig = signChallenge(testChallenge, authorKeypair.secretKey);
    testSignatureHex = Buffer.from(sig).toString('hex');

    // Create a root post (empty parentRefs)
    const rootPost = makePost(authorId, []);
    rootPostId = computePostId(rootPost);
    insertPost(rootPost, new Uint8Array(16));

    // Create a child post (has parentRefs — not a root)
    const childPost = makePost(authorId, [rootPostId]);
    childPostId = computePostId(childPost);
    insertPost(childPost, new Uint8Array(16));
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
  });

  it('POST /posts/:id/prune on root post returns 201', async () => {
    const res = await request(rootPostId, {
      authorId: Buffer.from(authorId).toString('hex'),
      trigger: 'author',
      challenge: testChallengeHex,
      signature: testSignatureHex,
    }, makeMockDeps());
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(typeof body.stumpId).toBe('string');
  });

  it('POST /posts/:id/prune on non-root post returns 201', async () => {
    const res = await request(childPostId, {
      authorId: Buffer.from(authorId).toString('hex'),
      trigger: 'author',
      challenge: testChallengeHex,
      signature: testSignatureHex,
    }, makeMockDeps());
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(typeof body.stumpId).toBe('string');
  });

  it('POST /posts/:id/prune with wrong author returns 403', async () => {
    // Create another root post by a different author
    const kp2 = generateKeyPair();
    const author2 = kp2.publicKey;

    const otherRoot = makePost(author2, []);
    const otherRootId = computePostId(otherRoot);
    insertPost(otherRoot, new Uint8Array(16));

    // Try to prune as the first author (not the post's author)
    // The signature is valid (we sign with authorId's key), but
    // executePrune rejects because authorId != the post's author.
    const res = await request(otherRootId, {
      authorId: Buffer.from(authorId).toString('hex'),
      trigger: 'author',
      challenge: testChallengeHex,
      signature: testSignatureHex,
    }, makeMockDeps());
    expect(res.status).toBe(403);
  });

  it('POST /posts/:id/prune missing challenge returns 400', async () => {
    const res = await request(rootPostId, {
      authorId: Buffer.from(authorId).toString('hex'),
      trigger: 'author',
      signature: testSignatureHex,
    }, makeMockDeps());
    expect(res.status).toBe(400);
  });

  it('POST /posts/:id/prune with expired challenge returns 403', async () => {
    const expiredDeps = {
      getActiveChallenge: (userId: Uint8Array) => ({
        challenge: testChallenge,
        expiresAtBlock: testHeight - 1, // expired
        userId,
      }),
      consumeChallenge: () => {},
      getCurrentHeight: () => testHeight,
    };
    const res = await request(rootPostId, {
      authorId: Buffer.from(authorId).toString('hex'),
      trigger: 'author',
      challenge: testChallengeHex,
      signature: testSignatureHex,
    }, expiredDeps);
    expect(res.status).toBe(403);
  });

  it('POST /posts/:id/prune with wrong signature returns 403', async () => {
    const wrongSig = new Uint8Array(64); // all zeros, not a valid sig
    const res = await request(rootPostId, {
      authorId: Buffer.from(authorId).toString('hex'),
      trigger: 'author',
      challenge: testChallengeHex,
      signature: Buffer.from(wrongSig).toString('hex'),
    }, makeMockDeps());
    expect(res.status).toBe(403);
  });

  it('POST /posts/:id/prune with challenge bytes mismatch returns 403', async () => {
    const wrongChallenge = new Uint8Array(32);
    crypto.getRandomValues(wrongChallenge);
    const res = await request(rootPostId, {
      authorId: Buffer.from(authorId).toString('hex'),
      trigger: 'author',
      challenge: Buffer.from(wrongChallenge).toString('hex'),
      signature: testSignatureHex,
    }, makeMockDeps());
    expect(res.status).toBe(403);
  });
});
