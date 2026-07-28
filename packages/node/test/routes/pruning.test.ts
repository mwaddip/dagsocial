import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'http';
import { deleteRoutes } from '../../src/routes/delete.js';
import type { PruneIntent, PruneEntry } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(
  postId: string,
  body: unknown,
  executePruneImpl?: (intent: PruneIntent) => PruneEntry,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const mockEntry: PruneEntry = {
      rootPostHash: postId,
      subtreePostIds: [postId],
      subtreeMerkleRoot: new Uint8Array(32),
      authorId: new Uint8Array(32),
      authorSignature: new Uint8Array(64),
      trigger: 'author',
    };

    const deps = {
      executePrune: executePruneImpl ?? (() => mockEntry),
    };
    const app = express();
    app.use(express.json());
    app.use(deleteRoutes(deps));
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
      if (body !== undefined) {
        r.write(JSON.stringify(body, (_k, v) =>
          v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v));
      }
      r.end();
    });
  });
}

const TEST_POST_HASH = 'd'.repeat(64);
const TEST_AUTHOR_ID = 'e'.repeat(64);
const TEST_MERKLE_ROOT = 'f'.repeat(64);
const TEST_SIGNATURE = 'a'.repeat(128);

function validBody() {
  return {
    rootPostHash: TEST_POST_HASH,
    authorId: TEST_AUTHOR_ID,
    subtreeMerkleRoot: TEST_MERKLE_ROOT,
    subtreePostIds: [TEST_POST_HASH],
    signature: TEST_SIGNATURE,
    trigger: 'author',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pruning routes', () => {
  it('POST /posts/:id/prune with valid body returns 201', async () => {
    const res = await request(TEST_POST_HASH, validBody());
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('deleted');
    expect(typeof body.entryId).toBe('string');
    expect(body.postId).toBe(TEST_POST_HASH);
  });

  it('POST /posts/:id/prune missing required fields returns 400', async () => {
    const res = await request(TEST_POST_HASH, {});
    expect(res.status).toBe(400);
    const body = res.data as Record<string, unknown>;
    expect(body.error).toContain('Missing required fields');
  });

  it('POST /posts/:id/prune missing subtreePostIds returns 400', async () => {
    const { subtreePostIds: _, ...rest } = validBody();
    const res = await request(TEST_POST_HASH, rest);
    expect(res.status).toBe(400);
  });

  it('POST /posts/:id/prune with empty subtreePostIds returns 400', async () => {
    const res = await request(TEST_POST_HASH, {
      ...validBody(),
      subtreePostIds: [],
    });
    expect(res.status).toBe(400);
    const body = res.data as Record<string, unknown>;
    expect(body.error).toContain('subtreePostIds must be a non-empty array');
  });

  it('POST /posts/:id/prune with invalid rootPostHash format returns 400', async () => {
    const res = await request(TEST_POST_HASH, {
      ...validBody(),
      rootPostHash: 'not-hex',
    });
    expect(res.status).toBe(400);
  });

  it('POST /posts/:id/prune with invalid authorId format returns 400', async () => {
    const res = await request(TEST_POST_HASH, {
      ...validBody(),
      authorId: 'not-hex',
    });
    expect(res.status).toBe(400);
  });

  it('POST /posts/:id/prune with invalid subtreeMerkleRoot format returns 400', async () => {
    const res = await request(TEST_POST_HASH, {
      ...validBody(),
      subtreeMerkleRoot: 'not-hex',
    });
    expect(res.status).toBe(400);
  });

  it('POST /posts/:id/prune with invalid signature format returns 400', async () => {
    const res = await request(TEST_POST_HASH, {
      ...validBody(),
      signature: 'too-short',
    });
    expect(res.status).toBe(400);
  });

  it('POST /posts/:id/prune returns 404 when executePrune throws 404', async () => {
    const res = await request(TEST_POST_HASH, validBody(), () => {
      throw Object.assign(new Error('Post not found'), { statusCode: 404 });
    });
    expect(res.status).toBe(404);
  });

  it('POST /posts/:id/prune returns 403 when executePrune throws 403', async () => {
    const res = await request(TEST_POST_HASH, validBody(), () => {
      throw Object.assign(new Error('Author mismatch'), { statusCode: 403 });
    });
    expect(res.status).toBe(403);
  });

  it('POST /posts/:id/prune returns 500 for unexpected errors', async () => {
    const res = await request(TEST_POST_HASH, validBody(), () => {
      throw new Error('unexpected');
    });
    expect(res.status).toBe(500);
  });
});
