import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { computeBoxId } from '@dagsocial/types';
import type { AnyBox, CreditBox, KarmaBox, UserId } from '@dagsocial/types';
import type { BlockJournal } from '../../src/store/journal.js';
import type { IdentityRecord } from '../../src/store/identity-records.js';

/**
 * Spec G phase D2 — `insertBox` populates the identity record's activity clock.
 *
 * The clock moves off box `createdAtBlock` and onto the committed record, and
 * the swap is only behaviour-preserving if the record says the same thing the
 * boxes used to. The choke point is what makes that true by construction:
 * `insertBox` bumps `lastActivityBlock` for exactly the boxes the old staleness
 * predicate counted — karma boxes with `decayBurn !== true` — so no producer
 * has to remember to do it.
 *
 * The height comes from the **open journal**, never from the box. `insertBox`
 * takes no height, and `createdAtBlock` is the field Spec G removes: reading it
 * would reintroduce the dependency this phase exists to delete, and would break
 * outright at phase G. These tests therefore always drive a journal height that
 * differs from the box's own `createdAtBlock`, so a implementation reading the
 * box cannot pass.
 */

async function importDbFresh() {
  return (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
  };
}

async function importUtxoFresh() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: AnyBox) => void;
  };
}

async function importJournalFresh() {
  return (await import('../../src/store/journal.js')) as {
    beginBlockJournal: (height: number) => void;
    finishBlockJournal: () => BlockJournal;
    openBlockJournalHeight: () => number | null;
  };
}

async function importRecordsFresh() {
  return (await import('../../src/store/identity-records.js')) as {
    getIdentityRecord: (id: UserId) => IdentityRecord | null;
    putIdentityRecord: (id: UserId, r: IdentityRecord) => void;
    identityRecordKey: (id: UserId) => string;
  };
}

function owner(label: string): UserId {
  return new Uint8Array(createHash('blake2b512').update(label).digest().subarray(0, 32));
}

function karmaBox(o: UserId, value: bigint, createdAtBlock: number, decayBurn?: boolean): KarmaBox {
  const box: KarmaBox = {
    boxType: 'karma',
    value,
    createdAtBlock,
    owner: o,
    guard: 'owner_signature',
    proofSource: `p-${createdAtBlock}-${value}-${decayBurn ?? 'n'}`,
    lastTouchBlock: createdAtBlock,
  };
  if (decayBurn !== undefined) box.decayBurn = decayBurn;
  box.id = computeBoxId(box);
  return box;
}

function creditBox(o: UserId, value: bigint, createdAtBlock: number): CreditBox {
  const box: CreditBox = {
    boxType: 'credit',
    value,
    createdAtBlock,
    owner: o,
    guard: 'owner_signature',
    proofSource: createdAtBlock,
  };
  box.id = computeBoxId(box);
  return box;
}

describe('insertBox populates the activity clock (Spec G phase D2)', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('a non-decay karma box creates the record at the journal height', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    beginBlockJournal(42);
    insertBox(karmaBox(alice, 100n, 42));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toEqual({ lastActivityBlock: 42, lastDecayBlock: 0 });
  });

  it('the height is the journal height, not the box createdAtBlock', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    // `applyTx` rewrites `createdAtBlock` to the settled height, but every other
    // producer sets it itself — and phase G deletes the field. The record must
    // never depend on it.
    const alice = owner('alice');
    beginBlockJournal(90);
    insertBox(karmaBox(alice, 100n, 7));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toEqual({ lastActivityBlock: 90, lastDecayBlock: 0 });
  });

  it('a decay-burn karma box does NOT bump the activity clock', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    // The whole point of `decayBurn` is that decay's own replacement box is not
    // activity — if it were, one decay would make the identity look fresh and
    // no second cycle could ever fire.
    const alice = owner('alice');
    beginBlockJournal(50);
    insertBox(karmaBox(alice, 100n, 50, true));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toBeNull();
  });

  it('an explicit `decayBurn: false` box IS activity', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    // `!== true`, matching the old predicate — not `=== undefined`.
    const alice = owner('alice');
    beginBlockJournal(50);
    insertBox(karmaBox(alice, 100n, 50, false));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toEqual({ lastActivityBlock: 50, lastDecayBlock: 0 });
  });

  it('a decay-burn insert leaves an existing record untouched', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    beginBlockJournal(10);
    insertBox(karmaBox(alice, 100n, 10));
    finishBlockJournal();

    beginBlockJournal(80);
    insertBox(karmaBox(alice, 70n, 80, true));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toEqual({ lastActivityBlock: 10, lastDecayBlock: 0 });
  });

  it('a non-karma box creates no record', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    beginBlockJournal(12);
    insertBox(creditBox(alice, 5000n, 12));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toBeNull();
  });

  it('with no journal open nothing is recorded', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    // Genesis and bootstrap: `insertBox` behaves exactly as before, because
    // there is no settled height to record.
    const alice = owner('alice');
    insertBox(karmaBox(alice, 100n, 1));

    expect(getIdentityRecord(alice)).toBeNull();
  });

  it('a later activity bump preserves lastDecayBlock', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord, putIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    // The two halves of the record have different writers. An activity bump
    // that reset the decay clock would hand the owner a free interval.
    const alice = owner('alice');
    putIdentityRecord(alice, { lastActivityBlock: 5, lastDecayBlock: 33 });

    beginBlockJournal(77);
    insertBox(karmaBox(alice, 100n, 77));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toEqual({ lastActivityBlock: 77, lastDecayBlock: 33 });
  });

  it('each identity gets its own clock', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    const bob = owner('bob');
    beginBlockJournal(3);
    insertBox(karmaBox(alice, 100n, 3));
    finishBlockJournal();
    beginBlockJournal(9);
    insertBox(karmaBox(bob, 100n, 9));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toEqual({ lastActivityBlock: 3, lastDecayBlock: 0 });
    expect(getIdentityRecord(bob)).toEqual({ lastActivityBlock: 9, lastDecayBlock: 0 });
  });

  it('the bump is journaled, after the box insert it followed', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { identityRecordKey } = await importRecordsFresh();
    initDb(':memory:');

    // Order matters: `revertBlock` replays in reverse, so the record inverse
    // must run before the box that caused it is deleted.
    const alice = owner('alice');
    const box = karmaBox(alice, 100n, 4);
    beginBlockJournal(4);
    insertBox(box);
    const journal = finishBlockJournal();

    expect(journal.mutations).toEqual([
      { kind: 'box', op: 'insert', boxId: box.id, box },
      {
        kind: 'record',
        key: identityRecordKey(alice),
        identityId: alice,
        record: { lastActivityBlock: 4, lastDecayBlock: 0 },
      },
    ]);
  });

  it('a second bump in the same block journals the value it replaced', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { putIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    putIdentityRecord(alice, { lastActivityBlock: 2, lastDecayBlock: 1 });

    beginBlockJournal(6);
    insertBox(karmaBox(alice, 10n, 6));
    const journal = finishBlockJournal();

    const records = journal.mutations.filter((m) => m.kind === 'record');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      record: { lastActivityBlock: 6, lastDecayBlock: 1 },
      replaced: { lastActivityBlock: 2, lastDecayBlock: 1 },
    });
  });

  it('openBlockJournalHeight tracks the open journal and nothing else', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal, openBlockJournalHeight } =
      await importJournalFresh();
    initDb(':memory:');

    expect(openBlockJournalHeight()).toBeNull();
    beginBlockJournal(17);
    expect(openBlockJournalHeight()).toBe(17);
    finishBlockJournal();
    expect(openBlockJournalHeight()).toBeNull();
  });

  it('height 0 is a height, not "no journal"', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal, openBlockJournalHeight } =
      await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    // A `if (!height)` guard would silently drop the bump at height 0 and leave
    // the identity looking as though it had never been active.
    const alice = owner('alice');
    beginBlockJournal(0);
    expect(openBlockJournalHeight()).toBe(0);
    insertBox(karmaBox(alice, 100n, 0));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toEqual({ lastActivityBlock: 0, lastDecayBlock: 0 });
  });
});
