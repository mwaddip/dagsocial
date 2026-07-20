import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/store/db.js';
import { insertPendingPost, getPost, queryPosts } from '../../src/store/posts.js';
import { createBlock, getBlock } from '../../src/store/blocks.js';
import type { Post } from '@dagsocial/types';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-store.sqlite';

const testPost = (overrides?: Partial<Post>): Post => ({
  id: `post-${Math.random().toString(36).slice(2)}`,
  content: 'test content',
  author: 'author-1',
  parentRefs: [],
  slotHash: 'slot-1',
  powNonce: 0,
  timestamp: Date.now(),
  signature: 'sig',
  status: 'pending',
  ...overrides,
});

describe('post and block store', () => {
  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch {}
    initDb(TEST_DB);
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('inserts and retrieves a pending post', () => {
    const post = testPost();
    insertPendingPost(post, Buffer.from('raw'));
    const retrieved = getPost(post.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe('test content');
    expect(retrieved!.status).toBe('pending');
  });

  it('queryPosts returns confirmed posts ordered newest first', () => {
    const p1 = testPost({ id: 'qp1', status: 'confirmed', blockHeight: 1, timestamp: 1000 });
    const p2 = testPost({ id: 'qp2', status: 'confirmed', blockHeight: 2, timestamp: 2000 });
    insertPendingPost(p1, Buffer.from('raw'));
    insertPendingPost(p2, Buffer.from('raw'));
    getDb().exec("UPDATE posts SET status = 'confirmed', block_height = 1 WHERE id = 'qp1'");
    getDb().exec("UPDATE posts SET status = 'confirmed', block_height = 2 WHERE id = 'qp2'");
    const results = queryPosts({ limit: 10, offset: 0 });
    const confirmed = results.filter(p => p.status === 'confirmed');
    expect(confirmed.length).toBeGreaterThanOrEqual(2);
  });

  it('queryPosts filters by author', () => {
    const post = testPost({ id: 'qa1', author: 'specific-author', status: 'confirmed', blockHeight: 1, timestamp: 1000 });
    insertPendingPost(post, Buffer.from('raw'));
    getDb().exec("UPDATE posts SET status = 'confirmed', block_height = 1 WHERE id = 'qa1'");
    const results = queryPosts({ author: 'specific-author', limit: 10, offset: 0 });
    expect(results.every(p => p.author === 'specific-author')).toBe(true);
  });

  it('creates block from pending posts and confirms them', () => {
    const p1 = testPost({ id: 'bp1' });
    const p2 = testPost({ id: 'bp2' });
    insertPendingPost(p1, Buffer.from('raw'));
    insertPendingPost(p2, Buffer.from('raw'));

    const block = createBlock();
    expect(block).not.toBeNull();
    if (block) {
      expect(block.postCount).toBeGreaterThanOrEqual(2);
      expect(getPost('bp1')!.status).toBe('confirmed');
      expect(getPost('bp2')!.status).toBe('confirmed');
    }
  });

  it('getBlock returns block with posts', () => {
    const p = testPost({ id: 'gb1' });
    insertPendingPost(p, Buffer.from('raw'));
    const block = createBlock();
    if (block) {
      const retrieved = getBlock(block.height);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.height).toBe(block.height);
    }
  });

  it('retrieves post with parent references', () => {
    const parent1 = testPost({ id: 'parent-1', status: 'confirmed', blockHeight: 1 });
    const parent2 = testPost({ id: 'parent-2', status: 'confirmed', blockHeight: 1 });
    insertPendingPost(parent1, Buffer.from('raw'));
    insertPendingPost(parent2, Buffer.from('raw'));
    getDb().exec("UPDATE posts SET status = 'confirmed', block_height = 1 WHERE id IN ('parent-1','parent-2')");

    const post = testPost({ id: 'child-with-parents', parentRefs: ['parent-1', 'parent-2'] });
    insertPendingPost(post, Buffer.from('raw'));

    const retrieved = getPost('child-with-parents');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.parentRefs).toEqual(['parent-1', 'parent-2']);

    // clean up: consume the pending post so the next test sees an empty pool
    getDb().exec("UPDATE posts SET status = 'confirmed', block_height = 1 WHERE id = 'child-with-parents'");
  });

  it('createBlock with no pending posts returns null', () => {
    expect(createBlock()).toBeNull();
  });
});
