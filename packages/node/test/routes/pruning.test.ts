import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { initDb, closeDb } from '../../src/store/db.js';
import { insertIdentity } from '../../src/store/identities.js';
import { insertPost, getPost } from '../../src/store/posts.js';
import { executePrune } from '../../src/services/stump-engine.js';
import {
  computeStumpId,
  computePostId,
  generateKeyPair,
  getUserId,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { Post } from '@dagsocial/types';
import { createRouter } from '../../src/routes/pruning.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-routes-pruning.sqlite';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePost(authorId: string, parentRefs: string[] = []): Post {
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
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const deps = { executePrune, computeStumpId };
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
      if (body !== undefined) r.write(JSON.stringify(body));
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
  let authorId: string;

  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);

    // Create an author
    const kp = generateKeyPair();
    authorId = getUserId(kp.publicKey);
    insertIdentity(authorId, kp.publicKey);

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
      authorId,
      trigger: 'author',
      signature: 'ff'.repeat(64),
    });
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(typeof body.stumpId).toBe('string');
  });

  it('POST /posts/:id/prune on non-root post returns 400', async () => {
    const res = await request(childPostId, {
      authorId,
      trigger: 'author',
      signature: 'ff'.repeat(64),
    });
    expect(res.status).toBe(400);
  });

  it('POST /posts/:id/prune with wrong author returns 403', async () => {
    // Create another root post by a different author
    const kp2 = generateKeyPair();
    const author2 = getUserId(kp2.publicKey);
    insertIdentity(author2, kp2.publicKey);

    const otherRoot = makePost(author2, []);
    const otherRootId = computePostId(otherRoot);
    insertPost(otherRoot, new Uint8Array(16));

    // Try to prune as the first author (not the post's author)
    const res = await request(otherRootId, {
      authorId, // wrong author!
      trigger: 'author',
      signature: 'ff'.repeat(64),
    });
    expect(res.status).toBe(403);
  });
});
