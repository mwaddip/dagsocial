import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { uid } from '../helpers.js';

/**
 * P2-D N2a — the like-record store (NODE_INTERFACE "Like-records").
 *
 * `(liker, targetPostId)` pairs written only at block application. Nothing
 * calls these yet — N2b wires block application — so the tests exercise the
 * primitives directly, the same way the identity-record store was tested in
 * its own build phase.
 */

// ---------------------------------------------------------------------------
// Dynamic import helpers (reset module-level state between tests — the
// journal recording context is a module-level singleton in journal.ts)
// ---------------------------------------------------------------------------

async function importAll() {
  const db = await import('../../src/store/db.js');
  const journal = await import('../../src/store/journal.js');
  const likes = await import('../../src/store/likes.js');
  const utxo = await import('../../src/store/utxo.js');
  return { ...db, ...journal, ...likes, ...utxo } as typeof db &
    typeof journal &
    typeof likes &
    typeof utxo;
}

const LIKER_A = uid('lr-liker-a');
const LIKER_B = uid('lr-liker-b');
const LIKER_C = uid('lr-liker-c');

describe('like-records store (P2-D N2a)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  // --- CRUD ------------------------------------------------------------------

  it('insert → has and count observe the record', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    expect(s.hasLikeRecord('post-1', LIKER_A)).toBe(false);
    expect(s.getLikeRecordCount('post-1')).toBe(0);

    s.insertLikeRecord('post-1', LIKER_A, 7);

    expect(s.hasLikeRecord('post-1', LIKER_A)).toBe(true);
    expect(s.hasLikeRecord('post-1', LIKER_B)).toBe(false);
    expect(s.hasLikeRecord('post-2', LIKER_A)).toBe(false);
    expect(s.getLikeRecordCount('post-1')).toBe(1);

    s.insertLikeRecord('post-1', LIKER_B, 7);
    expect(s.getLikeRecordCount('post-1')).toBe(2);
    expect(s.getLikeRecordCount('post-2')).toBe(0);
  });

  it('a duplicate insert THROWS on the primary key — the structural dedup', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertLikeRecord('post-1', LIKER_A, 3);
    expect(() => s.insertLikeRecord('post-1', LIKER_A, 4)).toThrow();

    // The original row is untouched — same applied height, count still 1.
    const row = s.getDb()
      .prepare('SELECT applied_at_block FROM like_records WHERE target_post_id = ? AND liker_id = ?')
      .get('post-1', Buffer.from(LIKER_A)) as { applied_at_block: number };
    expect(row.applied_at_block).toBe(3);
    expect(s.getLikeRecordCount('post-1')).toBe(1);
  });

  it('the same liker may like different posts, different likers the same post', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertLikeRecord('post-1', LIKER_A, 1);
    expect(() => s.insertLikeRecord('post-2', LIKER_A, 1)).not.toThrow();
    expect(() => s.insertLikeRecord('post-1', LIKER_B, 1)).not.toThrow();
  });

  it('deleteLikeRecordsForPosts removes every record of the named posts and no others', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertLikeRecord('post-1', LIKER_A, 1);
    s.insertLikeRecord('post-1', LIKER_B, 2);
    s.insertLikeRecord('post-2', LIKER_C, 3);
    s.insertLikeRecord('post-3', LIKER_A, 4);

    s.deleteLikeRecordsForPosts(['post-1', 'post-2']);

    expect(s.getLikeRecordCount('post-1')).toBe(0);
    expect(s.getLikeRecordCount('post-2')).toBe(0);
    expect(s.hasLikeRecord('post-3', LIKER_A)).toBe(true);
  });

  it('deleteLikeRecordsForPosts on an empty list is a no-op', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertLikeRecord('post-1', LIKER_A, 1);
    expect(() => s.deleteLikeRecordsForPosts([])).not.toThrow();
    expect(s.getLikeRecordCount('post-1')).toBe(1);
  });

  it('getLikersForPost returns exactly the record-holders as hex ids (N4a repoint)', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertLikeRecord('post-1', LIKER_A, 1);
    s.insertLikeRecord('post-1', LIKER_B, 2);
    s.insertLikeRecord('post-2', LIKER_C, 3);

    const hexOf = (u: Uint8Array) => Buffer.from(u).toString('hex');
    // Rows come back ordered by liker_id bytes; hex encoding preserves that
    // order, so sorting the expected hexes states the same order.
    expect(s.getLikersForPost('post-1')).toEqual([hexOf(LIKER_A), hexOf(LIKER_B)].sort());
    expect(s.getLikersForPost('post-2')).toEqual([hexOf(LIKER_C)]);
    expect(s.getLikersForPost('post-none')).toEqual([]);
  });

  // --- Inverses --------------------------------------------------------------

  it('deleteLikeRecord is the exact inverse of one insert', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertLikeRecord('post-1', LIKER_A, 5);
    s.insertLikeRecord('post-1', LIKER_B, 5);

    s.deleteLikeRecord('post-1', LIKER_A);

    expect(s.hasLikeRecord('post-1', LIKER_A)).toBe(false);
    expect(s.hasLikeRecord('post-1', LIKER_B)).toBe(true);
  });

  it('restoreLikeRecord restores all three columns exactly', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertLikeRecord('post-1', LIKER_A, 41);
    s.deleteLikeRecordsForPosts(['post-1']);
    expect(s.hasLikeRecord('post-1', LIKER_A)).toBe(false);

    s.restoreLikeRecord('post-1', LIKER_A, 41);

    expect(s.hasLikeRecord('post-1', LIKER_A)).toBe(true);
    const row = s.getDb()
      .prepare('SELECT target_post_id, liker_id, applied_at_block FROM like_records WHERE target_post_id = ?')
      .get('post-1') as { target_post_id: string; liker_id: Buffer; applied_at_block: number };
    expect(row.target_post_id).toBe('post-1');
    expect(new Uint8Array(row.liker_id)).toEqual(LIKER_A);
    expect(row.applied_at_block).toBe(41);
  });

  it('restoreLikeRecord onto an existing key throws — a rollback-ordering bug, not an upsert', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertLikeRecord('post-1', LIKER_A, 5);
    expect(() => s.restoreLikeRecord('post-1', LIKER_A, 5)).toThrow();
  });

  // --- Journal capture (choke-point recording) -------------------------------

  it('insertLikeRecord records a likeRecordInsertions side-record while a journal is open', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.beginBlockJournal(9);
    s.insertLikeRecord('post-1', LIKER_A, 9);
    s.insertLikeRecord('post-2', LIKER_B, 9);
    const j = s.finishBlockJournal();

    expect(j.likeRecordInsertions).toEqual([
      { targetPostId: 'post-1', likerId: LIKER_A },
      { targetPostId: 'post-2', likerId: LIKER_B },
    ]);
    expect(j.likeRecordDeletions).toEqual([]);
    // A like-record is content-layer state — never a `mutations` (stateRoot) entry.
    expect(j.mutations).toEqual([]);
  });

  it('a duplicate insert reaches the journal ZERO times — the throw precedes recording', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertLikeRecord('post-1', LIKER_A, 1);

    s.beginBlockJournal(2);
    expect(() => s.insertLikeRecord('post-1', LIKER_A, 2)).toThrow();
    const j = s.finishBlockJournal();

    expect(j.likeRecordInsertions).toEqual([]);
  });

  it('deleteLikeRecordsForPosts captures every deleted row, all three columns, BEFORE deleting', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertLikeRecord('post-1', LIKER_A, 1);
    s.insertLikeRecord('post-1', LIKER_B, 2);
    s.insertLikeRecord('post-2', LIKER_C, 3);
    s.insertLikeRecord('post-3', LIKER_A, 4); // untouched

    s.beginBlockJournal(10);
    s.deleteLikeRecordsForPosts(['post-1', 'post-2']);
    const j = s.finishBlockJournal();

    // Capture order is pinned by the PK (target_post_id, liker_id) — a
    // function of state, not of SQLite row order. uid('lr-liker-a') <
    // uid('lr-liker-b') is not guaranteed byte-wise, so sort expectations the
    // same way the capture does.
    const expected = [
      { targetPostId: 'post-1', likerId: LIKER_A, appliedAtBlock: 1 },
      { targetPostId: 'post-1', likerId: LIKER_B, appliedAtBlock: 2 },
    ].sort((a, b) => Buffer.from(a.likerId).compare(Buffer.from(b.likerId)));
    expect(j.likeRecordDeletions).toEqual([
      ...expected,
      { targetPostId: 'post-2', likerId: LIKER_C, appliedAtBlock: 3 },
    ]);
    expect(j.likeRecordInsertions).toEqual([]);

    // And the rows are actually gone.
    expect(s.getLikeRecordCount('post-1')).toBe(0);
    expect(s.getLikeRecordCount('post-2')).toBe(0);
    expect(s.getLikeRecordCount('post-3')).toBe(1);
  });

  it('with no journal open, neither choke point records anything', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertLikeRecord('post-1', LIKER_A, 1);
    s.deleteLikeRecordsForPosts(['post-1']);

    // A journal opened afterwards starts empty.
    s.beginBlockJournal(5);
    const j = s.finishBlockJournal();
    expect(j.likeRecordInsertions).toEqual([]);
    expect(j.likeRecordDeletions).toEqual([]);
  });

  it('the inverses never record, even while a journal is open', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertLikeRecord('post-1', LIKER_A, 1);

    s.beginBlockJournal(6);
    s.deleteLikeRecord('post-1', LIKER_A);
    s.restoreLikeRecord('post-1', LIKER_A, 1);
    const j = s.finishBlockJournal();

    expect(j.likeRecordInsertions).toEqual([]);
    expect(j.likeRecordDeletions).toEqual([]);
    expect(j.mutations).toEqual([]);
  });

  it('inverses applied from a journal restore the exact pre-block rows', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    // Pre-state: two records on post-1, one on post-2.
    s.insertLikeRecord('post-1', LIKER_A, 1);
    s.insertLikeRecord('post-1', LIKER_B, 2);
    s.insertLikeRecord('post-2', LIKER_C, 3);
    const preRows = s.getDb()
      .prepare('SELECT * FROM like_records ORDER BY target_post_id, liker_id')
      .all();

    // A block inserts one record and prunes post-1.
    s.beginBlockJournal(9);
    s.insertLikeRecord('post-2', LIKER_A, 9);
    s.deleteLikeRecordsForPosts(['post-1']);
    const j = s.finishBlockJournal();

    // Revert: side-record inverses, reverse order within each class.
    for (const ins of [...j.likeRecordInsertions].reverse()) {
      s.deleteLikeRecord(ins.targetPostId, ins.likerId);
    }
    for (const del of [...j.likeRecordDeletions].reverse()) {
      s.restoreLikeRecord(del.targetPostId, del.likerId, del.appliedAtBlock);
    }

    const postRows = s.getDb()
      .prepare('SELECT * FROM like_records ORDER BY target_post_id, liker_id')
      .all();
    expect(postRows).toEqual(preRows);
  });

  // --- Journal row round-trip ------------------------------------------------

  it('the persisted journal row round-trips both new arrays', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertLikeRecord('post-old', LIKER_C, 2);

    s.beginBlockJournal(11);
    s.insertLikeRecord('post-1', LIKER_A, 11);
    s.deleteLikeRecordsForPosts(['post-old']);
    const j = s.finishBlockJournal();

    s.insertBlockJournal(j);
    const back = s.getBlockJournal(11);
    expect(back).not.toBeNull();

    // CBOR hands byte fields back as plain Uint8Array — compare content-wise.
    expect(back!.likeRecordInsertions).toHaveLength(1);
    expect(back!.likeRecordInsertions[0]!.targetPostId).toBe('post-1');
    expect(new Uint8Array(back!.likeRecordInsertions[0]!.likerId)).toEqual(LIKER_A);

    expect(back!.likeRecordDeletions).toHaveLength(1);
    expect(back!.likeRecordDeletions[0]!.targetPostId).toBe('post-old');
    expect(new Uint8Array(back!.likeRecordDeletions[0]!.likerId)).toEqual(LIKER_C);
    expect(back!.likeRecordDeletions[0]!.appliedAtBlock).toBe(2);
  });

  it('an empty journal round-trips the new arrays as empty, not absent', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.beginBlockJournal(12);
    const j = s.finishBlockJournal();
    s.insertBlockJournal(j);

    const back = s.getBlockJournal(12)!;
    expect(back.likeRecordInsertions).toEqual([]);
    expect(back.likeRecordDeletions).toEqual([]);
  });
});
