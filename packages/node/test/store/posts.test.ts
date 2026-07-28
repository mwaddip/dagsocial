import { uid } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

function hex(u: Uint8Array): string { return Buffer.from(u).toString('hex'); }
import type { Post, Stump } from '@dagsocial/types';

// Module-level state in db.ts requires reset between tests.
async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database;
    closeDb: () => void;
  };
}

async function importPostsFresh() {
  const mod = await import('../../src/store/posts.js');
  return mod as {
    insertPost: (post: Post, rawCbor: Uint8Array) => void;
    insertPostPlaceholder: (postId: string, parentRefs: string[]) => void;
    getPost: (id: string) => Post | Stump | null;
    queryPosts: (opts: { author?: string; limit?: number; offset?: number }) => Post[];
    getPendingPosts: (limit: number) => Post[];
    confirmPost: (postId: string, blockHeight: number) => void;
    getParentRefs: (postId: string) => string[];
    getSubtree: (postId: string) => Post[];
    pruneSubtree: (rootPostId: string) => void;
  };
}

async function importStumpsFresh() {
  const mod = await import('../../src/store/stumps.js');
  return mod as {
    insertStump: (stump: Stump) => void;
  };
}

async function importTypesPosts() {
  const mod = await import('@dagsocial/types');
  return mod as {
    computePostId: (post: Post) => string;
    PROTOCOL_VERSION: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytes(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    content: 'Hello, world!',
    author: uid('alice123'),
    parentRefs: [],
    challenge: bytes(32),
    powNonce: 42,
    protocolVersion: 1,
    timestamp: 1700000000000,
    signature: bytes(64),
    ...overrides,
  };
}

function makeStump(overrides: Partial<Stump>): Stump {
  return {
    rootPostHash: '0000000000000000000000000000000000000000000000000000000000000000',
    authorId: uid('alice123'),
    replyCount: 0,
    upvoteCount: 0,
    trigger: 'author',
    protocolVersion: 1,
    compactedAtBlockHeight: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('posts store', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  // 1. insertPost + getPost round-trip
  it('insertPost + getPost round-trip (all fields including Uint8Array via CBOR)', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, getPost } = await importPostsFresh();

    initDb(':memory:');

    const post = makePost({
      content: 'round-trip test',
      parentRefs: [],
      powNonce: 12345,
      timestamp: 1700000000001,
    });
    const rawCbor = new Uint8Array([10, 20, 30]);

    insertPost(post, rawCbor);

    const { computePostId } = await importTypesPosts();
    const id = computePostId(post);

    const result = getPost(id);
    expect(result).not.toBeNull();

    // Should be a Post (not a Stump)
    const retrieved = result as Post;
    expect(retrieved.content).toBe('round-trip test');
    expect(retrieved.author).toEqual(uid('alice123'));
    expect(retrieved.parentRefs).toEqual([]);
    expect(retrieved.challenge).toEqual(post.challenge);
    expect(retrieved.powNonce).toBe(12345);
    expect(retrieved.protocolVersion).toBe(1);
    expect(retrieved.timestamp).toBe(1700000000001);
    expect(retrieved.signature).toEqual(post.signature);
  });

  // 2. getPost returns null for unknown id
  it('getPost returns null for unknown id', async () => {
    const { initDb } = await importDbFresh();
    const { getPost } = await importPostsFresh();

    initDb(':memory:');

    const result = getPost('nonexistent-id');
    expect(result).toBeNull();
  });

  // 3. getPost returns Stump when post pruned and stump exists
  it('getPost returns Stump when post pruned and stump exists', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, getPost, pruneSubtree } = await importPostsFresh();
    const { insertStump } = await importStumpsFresh();
    const { computePostId } = await importTypesPosts();

    initDb(':memory:');

    const post = makePost({ content: 'will be pruned' });
    const rawCbor = bytes(16);
    insertPost(post, rawCbor);

    const postId = computePostId(post);

    // Verify it's a Post first
    expect(getPost(postId)).not.toBeNull();

    const stump = makeStump({
      rootPostHash: postId,
      authorId: post.author,
      replyCount: 3,
      upvoteCount: 7,
      compactedAtBlockHeight: 5,
    });

    pruneSubtree(postId);
    insertStump(stump);

    const result = getPost(postId);
    expect(result).not.toBeNull();

    // Should now be a Stump, not a Post
    const retrieved = result as Stump;
    expect(retrieved.rootPostHash).toBe(postId);
    expect(retrieved.authorId).toEqual(post.author);
    expect(retrieved.replyCount).toBe(3);
    expect(retrieved.upvoteCount).toBe(7);
    expect(retrieved.compactedAtBlockHeight).toBe(5);
    expect(retrieved.trigger).toBe('author');
  });

  // 4. queryPosts with author filter
  it('queryPosts with author filter', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, queryPosts } = await importPostsFresh();

    initDb(':memory:');

    const alicePost = makePost({ author: uid('alice'), content: 'alice post', timestamp: 100 });
    const bobPost = makePost({ author: uid('bob'), content: 'bob post', timestamp: 200 });

    insertPost(alicePost, bytes(8));
    insertPost(bobPost, bytes(8));

    const aliceResults = queryPosts({ author: uid('alice') });
    expect(aliceResults).toHaveLength(1);
    expect(aliceResults[0].content).toBe('alice post');

    const bobResults = queryPosts({ author: uid('bob') });
    expect(bobResults).toHaveLength(1);
    expect(bobResults[0].content).toBe('bob post');

    const allResults = queryPosts({});
    expect(allResults).toHaveLength(2);
  });

  // 5. queryPosts with limit/offset pagination
  it('queryPosts with limit/offset pagination', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, queryPosts } = await importPostsFresh();

    initDb(':memory:');

    // Insert 5 posts with staggered timestamps
    for (let i = 0; i < 5; i++) {
      const post = makePost({
        content: `post-${i}`,
        timestamp: 1000 + i,
      });
      insertPost(post, bytes(8));
    }

    // Default limit=50, offset=0 — should return all 5
    const all = queryPosts({});
    expect(all).toHaveLength(5);

    // Limit 2, offset 0 — newest 2
    const page1 = queryPosts({ limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);
    expect(page1[0].content).toBe('post-4'); // newest first
    expect(page1[1].content).toBe('post-3');

    // Limit 2, offset 2 — next 2
    const page2 = queryPosts({ limit: 2, offset: 2 });
    expect(page2).toHaveLength(2);
    expect(page2[0].content).toBe('post-2');
    expect(page2[1].content).toBe('post-1');

    // Limit 2, offset 4 — last 1
    const page3 = queryPosts({ limit: 2, offset: 4 });
    expect(page3).toHaveLength(1);
    expect(page3[0].content).toBe('post-0');
  });

  // 6. queryPosts excludes pruned posts
  it('queryPosts excludes pruned posts', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, queryPosts, pruneSubtree } = await importPostsFresh();
    const { insertStump } = await importStumpsFresh();
    const { computePostId } = await importTypesPosts();

    initDb(':memory:');

    const post = makePost({ content: 'doomed', timestamp: 100 });
    insertPost(post, bytes(8));

    // Before pruning, query returns the post
    expect(queryPosts({})).toHaveLength(1);

    const postId = computePostId(post);
    const stump = makeStump({ rootPostHash: postId });
    pruneSubtree(postId);
    insertStump(stump);

    // After pruning, query excludes the pruned post
    const results = queryPosts({});
    expect(results).toHaveLength(0);
  });

  // 7. getPendingPosts returns oldest first
  it('getPendingPosts returns oldest first', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, getPendingPosts } = await importPostsFresh();

    initDb(':memory:');

    insertPost(makePost({ content: 'oldest', timestamp: 100 }), bytes(8));
    insertPost(makePost({ content: 'middle', timestamp: 200 }), bytes(8));
    insertPost(makePost({ content: 'newest', timestamp: 300 }), bytes(8));

    const pending = getPendingPosts(10);
    expect(pending).toHaveLength(3);
    expect(pending[0].content).toBe('oldest');
    expect(pending[1].content).toBe('middle');
    expect(pending[2].content).toBe('newest');
  });

  // 8. confirmPost updates status and blockHeight
  it('confirmPost updates status and blockHeight', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, confirmPost, getPendingPosts } = await importPostsFresh();
    const { computePostId } = await importTypesPosts();

    initDb(':memory:');

    const post = makePost({ content: 'confirm me' });
    insertPost(post, bytes(8));
    const postId = computePostId(post);

    // Still pending before confirm
    expect(getPendingPosts(10)).toHaveLength(1);

    confirmPost(postId, 42);

    // No longer pending after confirm
    expect(getPendingPosts(10)).toHaveLength(0);

    // Verify in DB directly
    const row = getDb()
      .prepare('SELECT status, block_height FROM dag_posts WHERE id = ?')
      .get(postId) as { status: string; block_height: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe('confirmed');
    expect(row!.block_height).toBe(42);
  });

  // 9. getParentRefs returns array of parent IDs
  it('getParentRefs returns array of parent IDs', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, getParentRefs } = await importPostsFresh();
    const { computePostId } = await importTypesPosts();

    initDb(':memory:');

    const post = makePost({
      parentRefs: ['parent1', 'parent2', 'parent3'],
    });
    insertPost(post, bytes(8));
    const postId = computePostId(post);

    const refs = getParentRefs(postId);
    expect(refs).toEqual(['parent1', 'parent2', 'parent3']);
  });

  // 10. getSubtree returns all descendants (multi-level)
  it('getSubtree returns all descendants (multi-level)', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, getSubtree } = await importPostsFresh();
    const { computePostId } = await importTypesPosts();

    initDb(':memory:');

    // Root post
    const root = makePost({ content: 'root', parentRefs: [] });
    insertPost(root, bytes(8));
    const rootId = computePostId(root);

    // Child of root
    const child = makePost({
      content: 'child',
      parentRefs: [rootId],
    });
    insertPost(child, bytes(8));
    const childId = computePostId(child);

    // Grandchild of root (child of child)
    const grandchild = makePost({
      content: 'grandchild',
      parentRefs: [childId],
    });
    insertPost(grandchild, bytes(8));

    const subtree = getSubtree(rootId);
    expect(subtree).toHaveLength(2);

    const contents = subtree.map((p) => p.content).sort();
    expect(contents).toEqual(['child', 'grandchild']);
  });

  // 11. pruneSubtree marks posts as pruned
  it('pruneSubtree marks posts as pruned, inserts stump', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, getPost, pruneSubtree } = await importPostsFresh();
    const { insertStump } = await importStumpsFresh();
    const { computePostId } = await importTypesPosts();

    initDb(':memory:');

    const post = makePost({ content: 'prune me' });
    insertPost(post, bytes(8));
    const postId = computePostId(post);

    const stump = makeStump({
      rootPostHash: postId,
      replyCount: 0,
      upvoteCount: 0,
      compactedAtBlockHeight: 99,
    });

    pruneSubtree(postId);
    insertStump(stump);

    // Post row is marked as pruned
    const postRow = getDb()
      .prepare('SELECT status FROM dag_posts WHERE id = ?')
      .get(postId) as { status: string } | undefined;
    expect(postRow).toBeDefined();
    expect(postRow!.status).toBe('pruned');

    // getPost returns the Stump
    const result = getPost(postId) as Stump;
    expect(result.rootPostHash).toBe(postId);
    expect(result.compactedAtBlockHeight).toBe(99);
  });

  // 12. pruneSubtree correctly handles nested replies
  it('pruneSubtree correctly handles nested replies', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, getPost, pruneSubtree } = await importPostsFresh();
    const { insertStump } = await importStumpsFresh();
    const { computePostId } = await importTypesPosts();

    initDb(':memory:');

    // Build chain: root -> child -> grandchild
    const root = makePost({ content: 'root', parentRefs: [] });
    insertPost(root, bytes(8));
    const rootId = computePostId(root);

    const child = makePost({ content: 'child', parentRefs: [rootId] });
    insertPost(child, bytes(8));
    const childId = computePostId(child);

    const grandchild = makePost({ content: 'grandchild', parentRefs: [childId] });
    insertPost(grandchild, bytes(8));
    const grandchildId = computePostId(grandchild);

    const stump = makeStump({
      rootPostHash: rootId,
      replyCount: 2,
      upvoteCount: 5,
    });

    pruneSubtree(rootId);
    insertStump(stump);

    // All three posts are marked as pruned
    for (const id of [rootId, childId, grandchildId]) {
      const row = getDb()
        .prepare('SELECT status FROM dag_posts WHERE id = ?')
        .get(id) as { status: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.status).toBe('pruned');
    }

    // getPost on root returns Stump
    const result = getPost(rootId) as Stump;
    expect(result.replyCount).toBe(2);
    expect(result.upvoteCount).toBe(5);
  });

  // 13. getPost returns a stump when queried by stump id (rootPostHash) directly
  it('getPost returns a stump when queried by stump id directly', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, getPost, pruneSubtree } = await importPostsFresh();
    const { insertStump } = await importStumpsFresh();
    const { computePostId } = await importTypesPosts();

    initDb(':memory:');

    const post = makePost({ content: 'stump-direct' });
    insertPost(post, bytes(8));
    const postId = computePostId(post);

    const stump = makeStump({
      rootPostHash: postId,
      replyCount: 5,
      upvoteCount: 10,
      compactedAtBlockHeight: 7,
    });

    pruneSubtree(postId);
    insertStump(stump);

    // Stump ID is its rootPostHash
    const stumpId = stump.rootPostHash;

    // Query by stump id directly
    const result = getPost(stumpId);
    expect(result).not.toBeNull();

    const retrieved = result as Stump;
    expect(retrieved.rootPostHash).toBe(postId);
    expect(retrieved.replyCount).toBe(5);
    expect(retrieved.upvoteCount).toBe(10);

    // Query by post id also returns the Stump
    const byPostId = getPost(postId);
    expect(byPostId).not.toBeNull();
    const byPostIdStump = byPostId as Stump;
    expect(byPostIdStump.rootPostHash).toBe(postId);
  });

  // 14. getPendingPosts respects the limit parameter
  it('getPendingPosts respects the limit parameter', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, getPendingPosts } = await importPostsFresh();

    initDb(':memory:');

    for (let i = 0; i < 5; i++) {
      insertPost(makePost({ content: `pending-${i}`, timestamp: 100 + i }), bytes(8));
    }

    const limited = getPendingPosts(3);
    expect(limited).toHaveLength(3);
    // Oldest first
    expect(limited[0].content).toBe('pending-0');
    expect(limited[1].content).toBe('pending-1');
    expect(limited[2].content).toBe('pending-2');
  });

  // 15. insertPost upgrades an existing placeholder with real content
  it('insertPost upgrades an existing placeholder with real content', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, insertPostPlaceholder } = await importPostsFresh();
    const { computePostId } = await importTypesPosts();

    initDb(':memory:');

    // Build the post first so we can compute its real postId
    const post: Post = {
      content: 'real content',
      author: new Uint8Array(32).fill(1),
      parentRefs: ['bb'.repeat(32)],
      challenge: new Uint8Array(32).fill(2),
      powNonce: 42,
      protocolVersion: 1,
      timestamp: 1700000000000,
      signature: new Uint8Array(64).fill(3),
    };
    const postId = computePostId(post);

    // Create a placeholder (simulating block-apply before gossip arrives)
    insertPostPlaceholder(postId, ['bb'.repeat(32)]);

    // Verify placeholder exists with empty content
    const placeholder = getDb()
      .prepare('SELECT content, author FROM dag_posts WHERE id = ?')
      .get(postId) as any;
    expect(placeholder.content).toBe('');

    // Now insert real content via insertPost (simulating gossip arrival)
    insertPost(post, new Uint8Array([1, 2, 3]));

    // Verify content was upgraded
    const upgraded = getDb()
      .prepare('SELECT content, author, pow_nonce FROM dag_posts WHERE id = ?')
      .get(postId) as any;
    expect(upgraded.content).toBe('real content');
    expect(upgraded.pow_nonce).toBe(42);
  });

  // 16. insertPost still works for a new post (no placeholder)
  it('insertPost still works for a new post (no placeholder)', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost } = await importPostsFresh();
    const { computePostId } = await importTypesPosts();

    initDb(':memory:');

    const post: Post = {
      content: 'fresh post',
      author: new Uint8Array(32).fill(9),
      parentRefs: [],
      challenge: new Uint8Array(32).fill(8),
      powNonce: 7,
      protocolVersion: 1,
      timestamp: 1700000000000,
      signature: new Uint8Array(64).fill(6),
    };
    insertPost(post, new Uint8Array([4, 5, 6]));

    const postId = computePostId(post);
    const row = getDb()
      .prepare('SELECT content FROM dag_posts WHERE id = ?')
      .get(postId) as any;
    expect(row.content).toBe('fresh post');
  });
});
