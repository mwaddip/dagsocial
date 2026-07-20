import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb } from '../../src/store/db.js';
import {
  insertPost,
  getPost,
  queryPosts,
  getPendingPosts,
  confirmPost,
  getParentRefs,
  getSubtree,
  pruneSubtree,
} from '../../src/store/posts.js';
import { computePostId } from '@dagsocial/types';
import { randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import type { Post, Stump } from '@dagsocial/types';

const TEST_DB = '/tmp/dagsocial-test-posts-store.sqlite';

function bytes(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    content: 'integration test post',
    author: 'author-integration',
    parentRefs: [],
    challenge: bytes(32),
    powNonce: 42,
    protocolVersion: 1,
    timestamp: Date.now(),
    signature: bytes(64),
    ...overrides,
  };
}

function makeStump(rootPostHash: string, overrides: Partial<Stump> = {}): Stump {
  return {
    rootPostHash,
    subtreeMerkleRoot: bytes(32),
    authorId: 'author-integration',
    pruneSignature: bytes(64),
    karmaDeltas: [],
    replyCount: 0,
    upvoteCount: 0,
    trigger: 'author',
    protocolVersion: 1,
    compactedAtBlockHeight: 1,
    ...overrides,
  } as Stump;
}

describe('posts store (integration)', () => {
  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
  });

  it('inserts and retrieves a post via getPost', () => {
    const post = makePost({ content: 'integration round-trip' });
    insertPost(post, bytes(16));
    const id = computePostId(post);
    const retrieved = getPost(id);
    expect(retrieved).not.toBeNull();
    const p = retrieved as Post;
    expect(p.content).toBe('integration round-trip');
    expect(p.author).toBe('author-integration');
    expect(p.parentRefs).toEqual([]);
  });

  it('queryPosts returns live posts ordered newest first', () => {
    const post1 = makePost({ content: 'older', timestamp: 1000 });
    const post2 = makePost({ content: 'newer', timestamp: 2000 });
    insertPost(post1, bytes(8));
    insertPost(post2, bytes(8));

    const results = queryPosts({});
    const contents = results.map((p) => p.content);
    const idxNewer = contents.indexOf('newer');
    const idxOlder = contents.indexOf('older');
    expect(idxNewer).toBeLessThan(idxOlder);
  });

  it('queryPosts filters by author', () => {
    const suffix = Date.now();
    const alice = 'alice-int-' + suffix;
    const bob = 'bob-int-' + suffix;

    insertPost(makePost({ author: alice, content: 'alice post' }), bytes(8));
    insertPost(makePost({ author: bob, content: 'bob post' }), bytes(8));

    const aliceResults = queryPosts({ author: alice });
    expect(aliceResults.every((p) => p.author === alice)).toBe(true);

    const bobResults = queryPosts({ author: bob });
    expect(bobResults.every((p) => p.author === bob)).toBe(true);
  });

  it('post lifecycle: pending -> confirm -> not in pending', () => {
    const post = makePost({ content: 'lifecycle-' + Date.now() });
    insertPost(post, bytes(8));
    const postId = computePostId(post);

    // Should be pending
    const pending = getPendingPosts(100);
    const pendingIds = pending.map((p) => computePostId(p));
    expect(pendingIds).toContain(postId);

    // Confirm
    confirmPost(postId, 5);

    // No longer pending
    const afterConfirm = getPendingPosts(100);
    const afterIds = afterConfirm.map((p) => computePostId(p));
    expect(afterIds).not.toContain(postId);
  });

  it('getParentRefs returns correct parent IDs', () => {
    const suffix = Date.now();
    const refs = ['ref-a-' + suffix, 'ref-b-' + suffix];

    const post = makePost({ parentRefs: refs });
    insertPost(post, bytes(8));
    const postId = computePostId(post);

    expect(getParentRefs(postId)).toEqual(refs);
  });

  it('getSubtree returns all descendants across levels', () => {
    // Root
    const root = makePost({ content: 'tree-root', parentRefs: [] });
    insertPost(root, bytes(8));
    const rootId = computePostId(root);

    // Child
    const child = makePost({ content: 'tree-child', parentRefs: [rootId] });
    insertPost(child, bytes(8));
    const childId = computePostId(child);

    // Grandchild
    const grandchild = makePost({ content: 'tree-grandchild', parentRefs: [childId] });
    insertPost(grandchild, bytes(8));

    const subtree = getSubtree(rootId);
    const contents = subtree.map((p) => p.content).sort();
    expect(contents).toEqual(['tree-child', 'tree-grandchild']);
  });

  it('pruneSubtree marks posts as pruned and inserts stump', () => {
    const root = makePost({ content: 'prune-root', parentRefs: [] });
    insertPost(root, bytes(8));
    const rootId = computePostId(root);

    const child = makePost({ content: 'prune-child', parentRefs: [rootId] });
    insertPost(child, bytes(8));

    const stump = makeStump(rootId, {
      replyCount: 1,
      upvoteCount: 3,
      compactedAtBlockHeight: 10,
    });

    pruneSubtree(rootId, stump);

    // Root post should now return a Stump
    const rootResult = getPost(rootId);
    expect(rootResult).not.toBeNull();
    const rootStump = rootResult as Stump;
    expect(rootStump.rootPostHash).toBe(rootId);
    expect(rootStump.replyCount).toBe(1);
    expect(rootStump.upvoteCount).toBe(3);
  });

  it('getPost returns null for unknown id', () => {
    expect(getPost('definitely-not-a-real-post-id-' + Date.now())).toBeNull();
  });
});
