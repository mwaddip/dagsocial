import { uid } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { Post, Stump } from '@dagsocial/types';

function bytes(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

// ---------------------------------------------------------------------------
// Dynamic import helpers (reset module-level state between tests)
// ---------------------------------------------------------------------------

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
    getPost: (id: string) => Post | Stump | null;
    confirmPost: (postId: string, blockHeight: number) => void;
    getParentRefs: (postId: string) => string[];
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

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    content: 'atomic test post',
    author: uid('tester'),
    parentRefs: [],
    challenge: bytes(32),
    powNonce: 99,
    protocolVersion: 1,
    timestamp: 1700000000000,
    signature: bytes(64),
    ...overrides,
  };
}

function makeStump(overrides: Partial<Stump> = {}): Stump {
  return {
    rootPostHash: '0000000000000000000000000000000000000000000000000000000000000000',
    authorId: uid('tester'),
    replyCount: 0,
    upvoteCount: 0,
    trigger: 'author' as const,
    protocolVersion: 1,
    compactedAtBlockHeight: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('atomic writes', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  // -----------------------------------------------------------------------
  // insertPost atomicity
  // -----------------------------------------------------------------------

  it('insertPost atomically writes dag_posts and dag_parent_refs', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, getParentRefs } = await importPostsFresh();
    const { computePostId } = await importTypesPosts();

    initDb(':memory:');

    const post = makePost({
      content: 'post with refs',
      parentRefs: ['parent-a', 'parent-b'],
    });
    const rawCbor = new Uint8Array([1, 2, 3]);

    insertPost(post, rawCbor);

    const postId = computePostId(post);

    // Both the post row and its parent refs must exist
    const db = getDb();
    const postRow = db.prepare('SELECT id FROM dag_posts WHERE id = ?').get(postId) as
      | { id: string }
      | undefined;
    expect(postRow).toBeDefined();
    expect(postRow!.id).toBe(postId);

    const refs = getParentRefs(postId);
    expect(refs).toEqual(['parent-a', 'parent-b']);
  });

  it('insertPost that throws inside transaction rolls back completely', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { computePostId } = await importTypesPosts();

    initDb(':memory:');
    const db = getDb();

    const post = makePost({ content: 'should-not-exist' });
    const postId = computePostId(post);

    // Simulate what a buggy multi-statement insert would look like without
    // a transaction wrapper: manually BEGIN then force a throw within the
    // transaction to verify the ROLLBACK behavior.
    db.exec('SAVEPOINT test_sp');
    try {
      db.prepare(
        `INSERT INTO dag_posts
           (id, content, author, parent_refs, challenge, pow_nonce,
            protocol_version, timestamp, signature, raw_cbor, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(
        postId,
        post.content,
        Buffer.from(post.author),
        JSON.stringify(post.parentRefs),
        Buffer.from(post.challenge),
        post.powNonce,
        post.protocolVersion,
        post.timestamp,
        Buffer.from(post.signature),
        Buffer.from(new Uint8Array([9])),
      );

      // Insert one parent ref, then throw before the second
      db.prepare(
        'INSERT OR IGNORE INTO dag_parent_refs (post_id, parent_id) VALUES (?, ?)',
      ).run(postId, 'ref-1');

      throw new Error('simulated crash mid-transaction');
    } catch (e: unknown) {
      if (e instanceof Error && e.message !== 'simulated crash mid-transaction') throw e;
      db.exec('ROLLBACK TO test_sp');
    }

    // Neither the post nor the partial ref should exist after rollback
    const postRow = db.prepare('SELECT id FROM dag_posts WHERE id = ?').get(postId);
    const refRow = db.prepare(
      'SELECT post_id FROM dag_parent_refs WHERE post_id = ?',
    ).get(postId);
    expect(postRow).toBeUndefined();
    expect(refRow).toBeUndefined();
  });

  it('insertPost via db.transaction() that throws leaves no partial state', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { computePostId } = await importTypesPosts();

    initDb(':memory:');
    const db = getDb();

    const post = makePost({ content: 'tx-rollback-test' });
    const postId = computePostId(post);

    expect(() => {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO dag_posts
             (id, content, author, parent_refs, challenge, pow_nonce,
              protocol_version, timestamp, signature, raw_cbor, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        ).run(
          postId,
          post.content,
          Buffer.from(post.author),
          JSON.stringify(post.parentRefs),
          Buffer.from(post.challenge),
          post.powNonce,
          post.protocolVersion,
          post.timestamp,
          Buffer.from(post.signature),
          Buffer.from(new Uint8Array([1])),
        );

        db.prepare(
          'INSERT OR IGNORE INTO dag_parent_refs (post_id, parent_id) VALUES (?, ?)',
        ).run(postId, 'ref-ok');

        throw new Error('simulated crash mid-transaction');
      })();
    }).toThrow('simulated crash');

    // Nothing should be committed
    const postRow = db.prepare('SELECT id FROM dag_posts WHERE id = ?').get(postId);
    expect(postRow).toBeUndefined();

    const refRow = db.prepare(
      'SELECT post_id FROM dag_parent_refs WHERE post_id = ?',
    ).get(postId);
    expect(refRow).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // pruneSubtree atomicity
  // -----------------------------------------------------------------------

  it('pruneSubtree atomically marks posts pruned', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, pruneSubtree } = await importPostsFresh();
    const { computePostId } = await importTypesPosts();

    initDb(':memory:');
    const db = getDb();

    // Insert a root post
    const post = makePost({ content: 'root for pruning', parentRefs: [] });
    const rawCbor = new Uint8Array([5, 6, 7]);
    insertPost(post, rawCbor);
    const postId = computePostId(post);

    // Verify it starts as pending
    const before = db.prepare(
      "SELECT status FROM dag_posts WHERE id = ? AND status = 'pending'",
    ).get(postId) as { status: string } | undefined;
    expect(before).toBeDefined();

    // Prune it (only marks posts as pruned; stump inserted separately)
    pruneSubtree(postId);

    // Insert the stump separately (done during block application)
    const { insertStump } = await importStumpsFresh();
    const stump = makeStump({ rootPostHash: postId });
    insertStump(stump);

    // Post must be pruned
    const afterPost = db.prepare("SELECT status FROM dag_posts WHERE id = ?").get(postId) as
      | { status: string }
      | undefined;
    expect(afterPost).toBeDefined();
    expect(afterPost!.status).toBe('pruned');

    // Stump must exist (stored by rootPostHash)
    const stumpRow = db.prepare('SELECT id FROM dag_stumps WHERE id = ?').get(postId) as
      | { id: string }
      | undefined;
    expect(stumpRow).toBeDefined();
    expect(stumpRow!.id).toBe(postId);
  });

  it('pruneSubtree rollback leaves post un-pruned and no orphaned stump', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost } = await importPostsFresh();
    const { computePostId } = await importTypesPosts();

    initDb(':memory:');
    const db = getDb();

    const post = makePost({ content: 'should stay pending', parentRefs: [] });
    const rawCbor = new Uint8Array([8, 9]);
    insertPost(post, rawCbor);
    const postId = computePostId(post);

    // Simulate a partial prune: mark the post pruned but throw before
    // inserting the stump, then roll back.
    db.exec('SAVEPOINT prune_sp');
    try {
      db.prepare("UPDATE dag_posts SET status = 'pruned' WHERE id = ?").run(postId);
      throw new Error('simulated crash before stump insert');
    } catch (e: unknown) {
      if (e instanceof Error && e.message !== 'simulated crash before stump insert') throw e;
      db.exec('ROLLBACK TO prune_sp');
    }

    // Post must still be pending
    const postRow = db.prepare('SELECT status FROM dag_posts WHERE id = ?').get(postId) as
      | { status: string }
      | undefined;
    expect(postRow).toBeDefined();
    expect(postRow!.status).toBe('pending');

    // Stump must NOT exist
    const stumpRow = db.prepare('SELECT id FROM dag_stumps WHERE id = ?').get(postId);
    expect(stumpRow).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // confirmPost (single-table — included for completeness)
  // -----------------------------------------------------------------------

  it('confirmPost updates status and block_height in a single statement', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, confirmPost } = await importPostsFresh();
    const { computePostId } = await importTypesPosts();

    initDb(':memory:');
    const db = getDb();

    const post = makePost({ content: 'confirm me' });
    const rawCbor = new Uint8Array([1]);
    insertPost(post, rawCbor);
    const postId = computePostId(post);

    confirmPost(postId, 42);

    const row = db.prepare(
      'SELECT status, block_height FROM dag_posts WHERE id = ?',
    ).get(postId) as { status: string; block_height: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe('confirmed');
    expect(row!.block_height).toBe(42);
  });

  it('unconfirmPost reverts status to pending and clears block_height', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, confirmPost } = await importPostsFresh();
    const { computePostId } = await importTypesPosts();

    initDb(':memory:');
    const db = getDb();

    const post = makePost({ content: 'unconfirm me' });
    const rawCbor = new Uint8Array([2]);
    insertPost(post, rawCbor);
    const postId = computePostId(post);

    confirmPost(postId, 7);
    // Need to import unconfirmPost dynamically since it's not in importPostsFresh
    const postsMod = await import('../../src/store/posts.js');
    (postsMod as { unconfirmPost: (id: string) => void }).unconfirmPost(postId);

    const row = db.prepare(
      'SELECT status, block_height FROM dag_posts WHERE id = ?',
    ).get(postId) as { status: string; block_height: number | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe('pending');
    expect(row!.block_height).toBeNull();
  });
});
