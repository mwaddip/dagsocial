import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { randomBytes, createHash } from 'node:crypto';
import { IDENTITY_KEY_DOMAIN } from '@dagsocial/types';
import type { UserId } from '@dagsocial/types';
import type { BlockJournal, RecordMutation } from '../../src/store/journal.js';
import type { IdentityRecord } from '../../src/store/identity-records.js';

/**
 * Spec G phase B2 — identity records in the block journal, and their rollback.
 *
 * `putIdentityRecord` is a recording primitive at the store choke point: while
 * a journal is open it captures the row it replaces before writing. Rollback
 * replays `mutations` in reverse, which is what makes a record written twice in
 * one block revert to the pre-block value rather than an intra-block
 * intermediate.
 */

async function importDbFresh() {
  return (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
  };
}

async function importJournalFresh() {
  return (await import('../../src/store/journal.js')) as {
    beginBlockJournal: (height: number) => void;
    finishBlockJournal: () => BlockJournal;
    abortBlockJournal: () => void;
    isBlockJournalOpen: () => boolean;
    insertBlockJournal: (j: BlockJournal) => void;
    getBlockJournal: (h: number) => BlockJournal | null;
  };
}

async function importRecordsFresh() {
  return (await import('../../src/store/identity-records.js')) as {
    getIdentityRecord: (id: UserId) => IdentityRecord | null;
    putIdentityRecord: (id: UserId, r: IdentityRecord) => void;
    deleteIdentityRecord: (id: UserId) => void;
    identityRecordKey: (id: UserId) => string;
  };
}

function uidBytes(): UserId {
  return new Uint8Array(randomBytes(32));
}

/** Reverse-order replay of the record arm — the revertBlock discipline. */
function revertRecords(
  journal: BlockJournal,
  put: (id: UserId, r: IdentityRecord) => void,
  del: (id: UserId) => void,
): void {
  for (let i = journal.mutations.length - 1; i >= 0; i--) {
    const m = journal.mutations[i]!;
    if (m.kind !== 'record') continue;
    if (m.replaced !== undefined) put(m.identityId, m.replaced);
    else del(m.identityId);
  }
}

describe('identity records in the block journal (Spec G phase B2)', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  // --- recording ------------------------------------------------------------

  it('a put with no journal open records nothing', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { putIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    // Bootstrap / non-block path: writes, records nothing.
    putIdentityRecord(uidBytes(), { lastActivityBlock: 1, lastDecayBlock: 0 });

    beginBlockJournal(1);
    expect(finishBlockJournal().mutations).toEqual([]);
  });

  it('a first put is journaled with no `replaced`', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { putIdentityRecord, identityRecordKey } = await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    beginBlockJournal(1);
    putIdentityRecord(id, { lastActivityBlock: 10, lastDecayBlock: 0 });
    const j = finishBlockJournal();

    expect(j.mutations).toHaveLength(1);
    const m = j.mutations[0] as RecordMutation;
    expect(m.kind).toBe('record');
    expect(m.key).toBe(identityRecordKey(id));
    expect(Buffer.from(m.identityId).equals(Buffer.from(id))).toBe(true);
    expect(m.record).toEqual({ lastActivityBlock: 10, lastDecayBlock: 0 });
    // Absent, not undefined — the key did not exist.
    expect('replaced' in m).toBe(false);
  });

  it('a put over an existing record is journaled with its `replaced` value', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { putIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    // Pre-block state, written outside the journal.
    putIdentityRecord(id, { lastActivityBlock: 5, lastDecayBlock: 2 });

    beginBlockJournal(1);
    putIdentityRecord(id, { lastActivityBlock: 40, lastDecayBlock: 2 });
    const j = finishBlockJournal();

    const m = j.mutations[0] as RecordMutation;
    expect(m.record).toEqual({ lastActivityBlock: 40, lastDecayBlock: 2 });
    expect(m.replaced).toEqual({ lastActivityBlock: 5, lastDecayBlock: 2 });
  });

  it('the AVL key is the domain-tagged hash, not the raw identity bytes', async () => {
    const { initDb } = await importDbFresh();
    const { identityRecordKey } = await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    const expected = createHash('blake2b512')
      .update(IDENTITY_KEY_DOMAIN)
      .update(id)
      .digest()
      .subarray(0, 32)
      .toString('hex');

    expect(identityRecordKey(id)).toBe(expected);
    // Raw bytes would let an attacker grind a pubkey colliding with a box id.
    expect(identityRecordKey(id)).not.toBe(Buffer.from(id).toString('hex'));
    expect(identityRecordKey(id)).toHaveLength(64);
  });

  it('deleteIdentityRecord never records, even with a journal open', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { putIdentityRecord, deleteIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    putIdentityRecord(id, { lastActivityBlock: 1, lastDecayBlock: 1 });

    beginBlockJournal(1);
    deleteIdentityRecord(id);
    expect(finishBlockJournal().mutations).toEqual([]);
  });

  it('record and box mutations share one ordered log', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { putIdentityRecord } = await importRecordsFresh();
    const { insertBox } = (await import('../../src/store/utxo.js')) as {
      insertBox: (b: never) => void;
    };
    initDb(':memory:');

    beginBlockJournal(1);
    insertBox({
      id: 'ab'.repeat(32), boxType: 'karma', value: 5n, createdAtBlock: 1,
      owner: uidBytes(), guard: 'owner_signature', proofSource: 'x', lastTouchBlock: 1,
    } as never);
    putIdentityRecord(uidBytes(), { lastActivityBlock: 1, lastDecayBlock: 0 });
    const j = finishBlockJournal();

    // One log, not parallel arrays: application order is preserved across kinds.
    expect(j.mutations.map((m) => m.kind)).toEqual(['box', 'record']);
  });

  it('the journal round-trips a record mutation through CBOR', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal, insertBlockJournal, getBlockJournal } =
      await importJournalFresh();
    const { putIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    putIdentityRecord(id, { lastActivityBlock: 3, lastDecayBlock: 1 });

    beginBlockJournal(7);
    putIdentityRecord(id, { lastActivityBlock: 9, lastDecayBlock: 1 });
    insertBlockJournal(finishBlockJournal());

    const loaded = getBlockJournal(7)!;
    const m = loaded.mutations[0] as RecordMutation;
    expect(m.kind).toBe('record');
    expect(m.record).toEqual({ lastActivityBlock: 9, lastDecayBlock: 1 });
    expect(m.replaced).toEqual({ lastActivityBlock: 3, lastDecayBlock: 1 });
    // identityId must survive as addressable bytes for the SQL row.
    expect(Buffer.from(m.identityId).equals(Buffer.from(id))).toBe(true);
  });

  // --- rollback -------------------------------------------------------------

  it('revert of a first put deletes the row', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { putIdentityRecord, getIdentityRecord, deleteIdentityRecord } =
      await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    beginBlockJournal(1);
    putIdentityRecord(id, { lastActivityBlock: 10, lastDecayBlock: 0 });
    const j = finishBlockJournal();

    expect(getIdentityRecord(id)).not.toBeNull();
    revertRecords(j, putIdentityRecord, deleteIdentityRecord);
    expect(getIdentityRecord(id)).toBeNull();
  });

  it('revert restores the exact prior record', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { putIdentityRecord, getIdentityRecord, deleteIdentityRecord } =
      await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    const pre: IdentityRecord = { lastActivityBlock: 5, lastDecayBlock: 2 };
    putIdentityRecord(id, pre);

    beginBlockJournal(1);
    putIdentityRecord(id, { lastActivityBlock: 40, lastDecayBlock: 2 });
    const j = finishBlockJournal();

    revertRecords(j, putIdentityRecord, deleteIdentityRecord);
    expect(getIdentityRecord(id)).toEqual(pre);
  });

  it('two puts to the same key in one block revert to the PRE-BLOCK value', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { putIdentityRecord, getIdentityRecord, deleteIdentityRecord } =
      await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    const preBlock: IdentityRecord = { lastActivityBlock: 5, lastDecayBlock: 2 };
    putIdentityRecord(id, preBlock);

    // The load-bearing case: activity bump then decay, at the same height.
    beginBlockJournal(1);
    putIdentityRecord(id, { lastActivityBlock: 40, lastDecayBlock: 2 });   // write 1
    putIdentityRecord(id, { lastActivityBlock: 40, lastDecayBlock: 40 });  // write 2
    const j = finishBlockJournal();

    expect(j.mutations).toHaveLength(2);
    // Both entries are kept — the first one's `replaced` is the true pre-block
    // value, and collapsing per key would lose it.
    expect((j.mutations[0] as RecordMutation).replaced).toEqual(preBlock);
    expect((j.mutations[1] as RecordMutation).replaced).toEqual({
      lastActivityBlock: 40, lastDecayBlock: 2,
    });

    revertRecords(j, putIdentityRecord, deleteIdentityRecord);

    // Reverse replay lands on the pre-block value, NOT the intra-block
    // intermediate {40, 2} that a last-`replaced`-wins restore would leave.
    expect(getIdentityRecord(id)).toEqual(preBlock);
  });

  it('two puts to a key that did not exist pre-block revert to absent', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { putIdentityRecord, getIdentityRecord, deleteIdentityRecord } =
      await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    beginBlockJournal(1);
    putIdentityRecord(id, { lastActivityBlock: 4, lastDecayBlock: 0 });
    putIdentityRecord(id, { lastActivityBlock: 4, lastDecayBlock: 4 });
    const j = finishBlockJournal();

    revertRecords(j, putIdentityRecord, deleteIdentityRecord);
    expect(getIdentityRecord(id)).toBeNull();
  });

  it('revert of interleaved writes to two identities restores both', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { putIdentityRecord, getIdentityRecord, deleteIdentityRecord } =
      await importRecordsFresh();
    initDb(':memory:');

    const a = uidBytes();
    const b = uidBytes();
    const preA: IdentityRecord = { lastActivityBlock: 1, lastDecayBlock: 1 };
    putIdentityRecord(a, preA);
    // b has no pre-block record.

    beginBlockJournal(1);
    putIdentityRecord(a, { lastActivityBlock: 20, lastDecayBlock: 1 });
    putIdentityRecord(b, { lastActivityBlock: 21, lastDecayBlock: 0 });
    putIdentityRecord(a, { lastActivityBlock: 20, lastDecayBlock: 20 });
    const j = finishBlockJournal();

    revertRecords(j, putIdentityRecord, deleteIdentityRecord);
    expect(getIdentityRecord(a)).toEqual(preA);
    expect(getIdentityRecord(b)).toBeNull();
  });

  // --- rollback through the REAL revertBlock --------------------------------
  //
  // The helper above replicates the discipline; these drive
  // services/fork-resolution.ts itself, so a regression in the shipped record
  // arm cannot hide behind a test-local reimplementation.

  it('revertBlock restores the pre-block record for a twice-written key', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal, insertBlockJournal } =
      await importJournalFresh();
    const { putIdentityRecord, getIdentityRecord } = await importRecordsFresh();
    const { revertBlock } = (await import('../../src/services/fork-resolution.js')) as {
      revertBlock: (height: number) => unknown;
    };
    initDb(':memory:');

    const id = uidBytes();
    const preBlock: IdentityRecord = { lastActivityBlock: 5, lastDecayBlock: 2 };
    putIdentityRecord(id, preBlock);

    beginBlockJournal(1);
    putIdentityRecord(id, { lastActivityBlock: 40, lastDecayBlock: 2 });
    putIdentityRecord(id, { lastActivityBlock: 40, lastDecayBlock: 40 });
    insertBlockJournal(finishBlockJournal());

    revertBlock(1);

    // {40, 2} is the intra-block intermediate a last-`replaced`-wins restore
    // would leave behind.
    expect(getIdentityRecord(id)).toEqual(preBlock);
  });

  it('revertBlock deletes a record the block created', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal, insertBlockJournal } =
      await importJournalFresh();
    const { putIdentityRecord, getIdentityRecord } = await importRecordsFresh();
    const { revertBlock } = (await import('../../src/services/fork-resolution.js')) as {
      revertBlock: (height: number) => unknown;
    };
    initDb(':memory:');

    const id = uidBytes();
    beginBlockJournal(1);
    putIdentityRecord(id, { lastActivityBlock: 10, lastDecayBlock: 0 });
    insertBlockJournal(finishBlockJournal());

    revertBlock(1);
    expect(getIdentityRecord(id)).toBeNull();
  });

  it('revertBlock restores the exact prior record for a single overwrite', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal, insertBlockJournal } =
      await importJournalFresh();
    const { putIdentityRecord, getIdentityRecord } = await importRecordsFresh();
    const { revertBlock } = (await import('../../src/services/fork-resolution.js')) as {
      revertBlock: (height: number) => unknown;
    };
    initDb(':memory:');

    const id = uidBytes();
    const pre: IdentityRecord = { lastActivityBlock: 7, lastDecayBlock: 3 };
    putIdentityRecord(id, pre);

    beginBlockJournal(1);
    putIdentityRecord(id, { lastActivityBlock: 99, lastDecayBlock: 3 });
    insertBlockJournal(finishBlockJournal());

    revertBlock(1);
    expect(getIdentityRecord(id)).toEqual(pre);
  });

  it('revertBlock restores two identities written interleaved in one block', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal, insertBlockJournal } =
      await importJournalFresh();
    const { putIdentityRecord, getIdentityRecord } = await importRecordsFresh();
    const { revertBlock } = (await import('../../src/services/fork-resolution.js')) as {
      revertBlock: (height: number) => unknown;
    };
    initDb(':memory:');

    const a = uidBytes();
    const b = uidBytes();
    const preA: IdentityRecord = { lastActivityBlock: 1, lastDecayBlock: 1 };
    putIdentityRecord(a, preA);

    beginBlockJournal(1);
    putIdentityRecord(a, { lastActivityBlock: 20, lastDecayBlock: 1 });
    putIdentityRecord(b, { lastActivityBlock: 21, lastDecayBlock: 0 });
    putIdentityRecord(a, { lastActivityBlock: 20, lastDecayBlock: 20 });
    insertBlockJournal(finishBlockJournal());

    revertBlock(1);
    expect(getIdentityRecord(a)).toEqual(preA);
    expect(getIdentityRecord(b)).toBeNull();
  });

  it('revertBlock leaves no record mutations journaled behind it', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal, insertBlockJournal, isBlockJournalOpen } =
      await importJournalFresh();
    const { putIdentityRecord } = await importRecordsFresh();
    const { revertBlock } = (await import('../../src/services/fork-resolution.js')) as {
      revertBlock: (height: number) => unknown;
    };
    initDb(':memory:');

    const id = uidBytes();
    putIdentityRecord(id, { lastActivityBlock: 1, lastDecayBlock: 1 });
    beginBlockJournal(1);
    putIdentityRecord(id, { lastActivityBlock: 2, lastDecayBlock: 1 });
    insertBlockJournal(finishBlockJournal());

    revertBlock(1);

    // The restore path calls putIdentityRecord, which IS a recording primitive.
    // That is safe only because revertBlock refuses to run while a journal is
    // open — the guard is the mechanism.
    expect(isBlockJournalOpen()).toBe(false);
    beginBlockJournal(2);
    expect(finishBlockJournal().mutations).toEqual([]);
  });

  it('a revert-path put does not journal itself (the open-journal guard)', async () => {
    const { initDb } = await importDbFresh();
    const { isBlockJournalOpen, beginBlockJournal, finishBlockJournal } =
      await importJournalFresh();
    const { putIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    putIdentityRecord(id, { lastActivityBlock: 1, lastDecayBlock: 1 });
    beginBlockJournal(1);
    putIdentityRecord(id, { lastActivityBlock: 2, lastDecayBlock: 1 });
    const j = finishBlockJournal();

    // revertBlock refuses to run while a journal is open; that guard is what
    // makes it safe for the restore path to call the recording primitive.
    expect(isBlockJournalOpen()).toBe(false);
    putIdentityRecord(id, j.mutations[0] && (j.mutations[0] as RecordMutation).replaced!);

    beginBlockJournal(2);
    expect(finishBlockJournal().mutations).toEqual([]);
  });
});
