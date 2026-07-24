import { uid } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';

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

async function importLikesFresh() {
  const mod = await import('../../src/store/likes.js');
  return mod as {
    insertLike: (targetPostId: string, likerId: Uint8Array) => string;
    hasLiked: (targetPostId: string, likerId: Uint8Array) => boolean;
    getLikeCount: (postId: string) => { locked: number; free: number };
    getUnprocessedFreeLikes: () => Array<{
      id: string;
      targetPostId: string;
      likerId: Uint8Array;
    }>;
    markFreeLikesProcessed: (likeIds: string[]) => void;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('likes store', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('insertLike returns a string id', async () => {
    const { initDb } = await importDbFresh();
    const { insertLike } = await importLikesFresh();

    initDb(':memory:');

    const id = insertLike('post-1', 'user-a');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('insertLike throws on duplicate (UNIQUE violation)', async () => {
    const { initDb } = await importDbFresh();
    const { insertLike } = await importLikesFresh();

    initDb(':memory:');

    insertLike('post-1', 'user-a');
    expect(() => insertLike('post-1', 'user-a')).toThrow();
  });

  it('hasLiked returns true after insertLike', async () => {
    const { initDb } = await importDbFresh();
    const { insertLike, hasLiked } = await importLikesFresh();

    initDb(':memory:');

    expect(hasLiked('post-1', 'user-a')).toBe(false);
    insertLike('post-1', 'user-a');
    expect(hasLiked('post-1', 'user-a')).toBe(true);
  });

  it('getLikeCount returns correct locked and free counts', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertLike, getLikeCount } = await importLikesFresh();

    initDb(':memory:');

    // Insert two free likes
    insertLike('post-1', 'user-a');
    insertLike('post-1', 'user-b');

    // Insert one locked like in utxo_boxes (simulates a like box)
    getDb().prepare(
      `INSERT INTO utxo_boxes (id, box_type, value, created_at_block, guard, extra_data)
       VALUES (?, 'like', 2, 5, 'epoch_tally', ?)`,
    ).run('locked-box-1', JSON.stringify({ likerId: uid('user-c'), targetPostId: 'post-1' }));

    const counts = getLikeCount('post-1');
    expect(counts.locked).toBe(1);
    expect(counts.free).toBe(2);
  });

  it('markFreeLikesProcessed sets processed=1 for given ids', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertLike, getUnprocessedFreeLikes, markFreeLikesProcessed } =
      await importLikesFresh();

    initDb(':memory:');

    const id1 = insertLike('post-1', 'user-a');
    const id2 = insertLike('post-2', 'user-b');
    const id3 = insertLike('post-3', 'user-c');

    // Verify all 3 are unprocessed
    const before = getUnprocessedFreeLikes();
    expect(before).toHaveLength(3);

    // Mark two as processed
    markFreeLikesProcessed([id1, id3]);

    // Only id2 should remain unprocessed
    const after = getUnprocessedFreeLikes();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(id2);

    // Verify id1 and id3 are processed in DB
    for (const id of [id1, id3]) {
      const row = getDb()
        .prepare('SELECT processed FROM dag_likes WHERE id = ?')
        .get(id) as { processed: number } | undefined;
      expect(row!.processed).toBe(1);
    }
  });
});
