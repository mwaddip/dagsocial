import {
  fixtureProvenance, uid } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AnyBox, KarmaBox, LikeBox } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dynamic import helpers (reset module-level state between tests — the
// journal recording context is a module-level singleton in journal.ts)
// ---------------------------------------------------------------------------

async function importAll() {
  const db = await import('../../src/store/db.js');
  const journal = await import('../../src/store/journal.js');
  const utxo = await import('../../src/store/utxo.js');
  const likes = await import('../../src/store/likes.js');
  const cooldowns = await import('../../src/store/vouch-cooldowns.js');
  return { ...db, ...journal, ...utxo, ...likes, ...cooldowns };
}

// ---------------------------------------------------------------------------
// Box factories
// ---------------------------------------------------------------------------

const OWNER = uid('journal-owner');

function makeKarmaBox(id: string, value = 100n): KarmaBox {
  const candidate = {
    boxType: 'karma' as const,
    value,
    owner: OWNER,
    guard: 'owner_signature' as const,
    proofSource: `tx-test-${id}`,
  };
  return { id, ...candidate, ...fixtureProvenance(candidate, 1) };
}

function makeLikeBox(id: string, liker: string, targetPostId: string): LikeBox {
  const candidate = {
    boxType: 'like' as const,
    value: 2n,
    likerId: uid(liker),
    targetPostId,
    guard: 'epoch_tally' as const,
  };
  return { id, ...candidate, ...fixtureProvenance(candidate, 1, hashSeed(id)) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('block journal (store choke-point recording)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  // --- Lifecycle -----------------------------------------------------------

  it('beginBlockJournal while a journal is open throws', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.beginBlockJournal(5);
    expect(() => s.beginBlockJournal(6)).toThrow();
  });

  it('finishBlockJournal returns the journal and closes it', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.beginBlockJournal(7);
    const j = s.finishBlockJournal();

    expect(j.blockHeight).toBe(7);
    expect(j.mutations).toEqual([]);
    expect(j.confirmedSubBlockIds).toEqual([]);
    expect(j.appliedUtxoTxs).toEqual([]);
    expect(j.processedFreeLikeIds).toEqual([]);
    expect(j.likeRecordInsertions).toEqual([]);
    expect(j.likeRecordDeletions).toEqual([]);
    expect(j.vouchCooldownInsertions).toEqual([]);
    expect(j.vouchCooldownDeletions).toEqual([]);
    expect(s.isBlockJournalOpen()).toBe(false);
    expect(() => s.finishBlockJournal()).toThrow();
  });

  it('abortBlockJournal discards the open journal and is a no-op when none open', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    expect(() => s.abortBlockJournal()).not.toThrow();

    s.beginBlockJournal(3);
    s.insertBox(makeKarmaBox('box-aborted'));
    s.abortBlockJournal();
    expect(s.isBlockJournalOpen()).toBe(false);

    // Discarded — a journal opened afterwards starts empty
    s.beginBlockJournal(4);
    const j = s.finishBlockJournal();
    expect(j.mutations).toEqual([]);
  });

  it('beginBlockJournal works again after finish and after abort', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.beginBlockJournal(1);
    s.finishBlockJournal();
    expect(() => s.beginBlockJournal(2)).not.toThrow();

    s.abortBlockJournal();
    expect(() => s.beginBlockJournal(3)).not.toThrow();
  });

  // --- Choke-point recording, one case per primitive -----------------------

  it('insertBox records {op: insert, boxId, box} while open', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.beginBlockJournal(1);
    const box = makeKarmaBox('box-k1', 250n);
    s.insertBox(box);
    const j = s.finishBlockJournal();

    // Spec G phase D: a non-decay karma box also advances its owner's activity
    // clock at this same choke point, so the karma case journals two mutations
    // — the box, then the record it caused, in that order.
    expect(j.mutations[0]).toEqual({ kind: 'box', op: 'insert', boxId: 'box-k1', box });
    expect(j.mutations[1]).toMatchObject({
      kind: 'record',
      identityId: OWNER,
      record: { lastActivityBlock: 1, lastDecayBlock: 0 },
    });
    expect(j.mutations).toHaveLength(2);
  });

  it('consumeBox records {kind: box, op: remove, boxId} while open', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertBox(makeKarmaBox('box-k2'));

    s.beginBlockJournal(2);
    s.consumeBox('box-k2', 2);
    const j = s.finishBlockJournal();

    expect(j.mutations).toEqual([{ kind: 'box', op: 'remove', boxId: 'box-k2' }]);
  });

  it('markLikeBoxesTallied records one remove per box id and keeps the -1 sentinel', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertBox(makeLikeBox('like-1', 'liker-a', 'post-1'));
    s.insertBox(makeLikeBox('like-2', 'liker-b', 'post-1'));

    s.beginBlockJournal(3);
    s.markLikeBoxesTallied(['like-1', 'like-2']);
    const j = s.finishBlockJournal();

    expect(j.mutations).toEqual([
      { kind: 'box', op: 'remove', boxId: 'like-1' },
      { kind: 'box', op: 'remove', boxId: 'like-2' },
    ]);
    for (const id of ['like-1', 'like-2']) {
      const row = s
        .getDb()
        .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
        .get(id) as { spent_at_block: number };
      expect(row.spent_at_block).toBe(-1);
    }
  });

  it('markFreeLikesProcessed records the processed like ids while open', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    const id1 = s.insertLike('post-1', uid('fl-a'));
    const id2 = s.insertLike('post-2', uid('fl-b'));

    s.beginBlockJournal(4);
    s.markFreeLikesProcessed([id1, id2]);
    const j = s.finishBlockJournal();

    expect(j.processedFreeLikeIds).toEqual([id1, id2]);
  });

  it('insertVouchCooldown on a fresh pair records the side-record without replaced', async () => {
    const s = await importAll();
    s.initDb(':memory:');
    const voucher = uid('voucher-1');
    const target = uid('target-1');

    s.beginBlockJournal(5);
    s.insertVouchCooldown(voucher, target, 100, 40n);
    const j = s.finishBlockJournal();

    expect(j.vouchCooldownInsertions).toHaveLength(1);
    expect(j.vouchCooldownInsertions[0].voucherId).toEqual(voucher);
    expect(j.vouchCooldownInsertions[0].targetId).toEqual(target);
    expect(j.vouchCooldownInsertions[0].replaced).toBeUndefined();
  });

  it('insertVouchCooldown over an existing row captures the replaced row', async () => {
    const s = await importAll();
    s.initDb(':memory:');
    const voucher = uid('voucher-2');
    const target = uid('target-2');

    s.insertVouchCooldown(voucher, target, 80, 25n);

    s.beginBlockJournal(6);
    s.insertVouchCooldown(voucher, target, 200, 60n);
    const j = s.finishBlockJournal();

    expect(j.vouchCooldownInsertions).toHaveLength(1);
    expect(j.vouchCooldownInsertions[0].replaced).toEqual({
      releaseAtBlock: 80,
      karmaAmount: 25n,
    });

    // The stored row carries the new values
    const rows = s.getVouchCooldowns(voucher);
    expect(rows).toHaveLength(1);
    expect(rows[0].releaseAtBlock).toBe(200);
    expect(rows[0].karmaAmount).toBe(60n);
  });

  it('deleteVouchCooldown captures the deleted row while open', async () => {
    const s = await importAll();
    s.initDb(':memory:');
    const voucher = uid('voucher-3');
    const target = uid('target-3');

    s.insertVouchCooldown(voucher, target, 120, 33n);

    s.beginBlockJournal(7);
    s.deleteVouchCooldown(voucher, target);
    const j = s.finishBlockJournal();

    expect(j.vouchCooldownDeletions).toHaveLength(1);
    const d = j.vouchCooldownDeletions[0];
    expect(d.voucherId).toEqual(voucher);
    expect(d.targetId).toEqual(target);
    expect(d.releaseAtBlock).toBe(120);
    expect(d.karmaAmount).toBe(33n);
    expect(s.hasActiveVouchCooldown(voucher, target)).toBe(false);
  });

  // --- Ordering -------------------------------------------------------------

  it('a mixed mutation sequence lands in the journal in application order', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertBox(makeKarmaBox('pre-existing'));
    s.insertBox(makeLikeBox('like-z', 'liker-z', 'post-z'));

    s.beginBlockJournal(9);
    s.insertBox(makeKarmaBox('new-1'));
    s.consumeBox('pre-existing', 9);
    s.markLikeBoxesTallied(['like-z']);
    s.insertBox(makeKarmaBox('new-2'));
    const j = s.finishBlockJournal();

    // Each karma insert is immediately followed by the activity-clock record it
    // caused (Spec G phase D) — the record's position in the log is what makes
    // reverse-order rollback undo the write before deleting the box behind it.
    expect(j.mutations.map((m) => [m.kind, (m as { op?: string }).op, (m as { boxId?: string }).boxId])).toEqual([
      ['box', 'insert', 'new-1'],
      ['record', undefined, undefined],
      ['box', 'remove', 'pre-existing'],
      ['box', 'remove', 'like-z'],
      ['box', 'insert', 'new-2'],
      ['record', undefined, undefined],
    ]);
  });

  // --- Negative: no journal open → nothing records --------------------------

  it('with no journal open, none of the primitives record', async () => {
    const s = await importAll();
    s.initDb(':memory:');
    const voucher = uid('voucher-4');
    const target = uid('target-4');

    s.insertBox(makeKarmaBox('nj-1'));
    s.consumeBox('nj-1', 1);
    s.insertBox(makeLikeBox('nj-like', 'nj-liker', 'nj-post'));
    s.markLikeBoxesTallied(['nj-like']);
    const likeId = s.insertLike('nj-post-2', uid('nj-fl'));
    s.markFreeLikesProcessed([likeId]);
    s.insertVouchCooldown(voucher, target, 50, 10n);
    s.deleteVouchCooldown(voucher, target);

    // A journal opened afterwards is empty
    s.beginBlockJournal(10);
    const j = s.finishBlockJournal();
    expect(j.mutations).toEqual([]);
    expect(j.processedFreeLikeIds).toEqual([]);
    expect(j.vouchCooldownInsertions).toEqual([]);
    expect(j.vouchCooldownDeletions).toEqual([]);
  });

  it('deleteBox, unconsumeBox, markFreeLikesUnprocessed never record even while open', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertBox(makeKarmaBox('inv-1'));
    s.consumeBox('inv-1', 1);
    s.insertBox(makeKarmaBox('inv-2'));
    const likeId = s.insertLike('inv-post', uid('inv-fl'));
    s.markFreeLikesProcessed([likeId]);

    s.beginBlockJournal(11);
    s.unconsumeBox('inv-1');
    s.deleteBox('inv-2');
    s.markFreeLikesUnprocessed([likeId]);
    const j = s.finishBlockJournal();

    expect(j.mutations).toEqual([]);
    expect(j.processedFreeLikeIds).toEqual([]);
  });

  it('markFreeLikesUnprocessed is the exact inverse of markFreeLikesProcessed', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    const id1 = s.insertLike('p1', uid('u1'));
    const id2 = s.insertLike('p2', uid('u2'));
    s.markFreeLikesProcessed([id1, id2]);
    expect(s.getUnprocessedFreeLikes()).toHaveLength(0);

    s.markFreeLikesUnprocessed([id1]);
    const unprocessed = s.getUnprocessedFreeLikes();
    expect(unprocessed).toHaveLength(1);
    expect(unprocessed[0].id).toBe(id1);
  });

  // --- insertBox missing-id guard -------------------------------------------

  it('insertBox with a missing box.id while open throws and inserts nothing', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.beginBlockJournal(12);

    expect(() => s.insertBox(makeKarmaBox(''))).toThrow();

    const noIdField = makeKarmaBox('would-be-id') as AnyBox;
    delete noIdField.id;
    expect(() => s.insertBox(noIdField)).toThrow();

    const j = s.finishBlockJournal();
    expect(j.mutations).toEqual([]);
    const cnt = s
      .getDb()
      .prepare('SELECT COUNT(*) AS c FROM utxo_boxes')
      .get() as { c: number };
    expect(cnt.c).toBe(0);
  });

  it('insertBox with an empty box.id and no journal open behaves as before', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    expect(() => s.insertBox(makeKarmaBox(''))).not.toThrow();
    const cnt = s
      .getDb()
      .prepare('SELECT COUNT(*) AS c FROM utxo_boxes')
      .get() as { c: number };
    expect(cnt.c).toBe(1);
  });
});

/** Stable small integer from a fixture id, so distinct boxes get distinct provenance. */
function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 1_000_000;
}
