import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { UserId } from '@dagsocial/types';
import type { IdentityRecord } from '../../src/store/identity-records.js';

/**
 * Spec G phase B — the identity record store (the per-identity decay clock).
 *
 * Phase B builds the entity and does not populate it: no producer calls
 * `putIdentityRecord` until phase D. These tests exercise the primitive
 * directly. Journal recording is wired in B2.
 */

async function importDbFresh() {
  return (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importRecordsFresh() {
  return (await import('../../src/store/identity-records.js')) as {
    getIdentityRecord: (id: UserId) => IdentityRecord | null;
    putIdentityRecord: (id: UserId, record: IdentityRecord) => void;
    deleteIdentityRecord: (id: UserId) => void;
  };
}

function uidBytes(): UserId {
  return new Uint8Array(randomBytes(32));
}

describe('identity records store (Spec G phase B)', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('get on a missing identity returns null', async () => {
    const { initDb } = await importDbFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    expect(getIdentityRecord(uidBytes())).toBeNull();
  });

  it('put then get round-trips the record', async () => {
    const { initDb } = await importDbFresh();
    const { putIdentityRecord, getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    putIdentityRecord(id, { lastActivityBlock: 42, lastDecayBlock: 7, likeCarry: 0n });

    expect(getIdentityRecord(id)).toEqual({ lastActivityBlock: 42, lastDecayBlock: 7, likeCarry: 0n });
  });

  it('heights come back as numbers, not bigints', async () => {
    const { initDb } = await importDbFresh();
    const { putIdentityRecord, getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    putIdentityRecord(id, { lastActivityBlock: 5, lastDecayBlock: 0, likeCarry: 0n });

    const got = getIdentityRecord(id)!;
    expect(typeof got.lastActivityBlock).toBe('number');
    expect(typeof got.lastDecayBlock).toBe('number');
  });

  it('put over an existing key upserts rather than throwing or duplicating', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { putIdentityRecord, getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    putIdentityRecord(id, { lastActivityBlock: 10, lastDecayBlock: 1, likeCarry: 0n });
    putIdentityRecord(id, { lastActivityBlock: 20, lastDecayBlock: 2, likeCarry: 0n });

    expect(getIdentityRecord(id)).toEqual({ lastActivityBlock: 20, lastDecayBlock: 2, likeCarry: 0n });

    const { cnt } = getDb()
      .prepare('SELECT COUNT(*) AS cnt FROM identity_records')
      .get() as { cnt: number };
    expect(cnt).toBe(1);
  });

  it('records for different identities are independent', async () => {
    const { initDb } = await importDbFresh();
    const { putIdentityRecord, getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const a = uidBytes();
    const b = uidBytes();
    putIdentityRecord(a, { lastActivityBlock: 1, lastDecayBlock: 1, likeCarry: 0n });
    putIdentityRecord(b, { lastActivityBlock: 2, lastDecayBlock: 2, likeCarry: 0n });

    expect(getIdentityRecord(a)).toEqual({ lastActivityBlock: 1, lastDecayBlock: 1, likeCarry: 0n });
    expect(getIdentityRecord(b)).toEqual({ lastActivityBlock: 2, lastDecayBlock: 2, likeCarry: 0n });
  });

  it('the key is the identity bytes, not the identity object', async () => {
    const { initDb } = await importDbFresh();
    const { putIdentityRecord, getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    putIdentityRecord(id, { lastActivityBlock: 9, lastDecayBlock: 3, likeCarry: 0n });

    // A distinct Uint8Array with identical bytes must resolve the same row.
    expect(getIdentityRecord(new Uint8Array(id))).toEqual({
      lastActivityBlock: 9,
      lastDecayBlock: 3,
      likeCarry: 0n,
    });
  });

  it('delete removes the record', async () => {
    const { initDb } = await importDbFresh();
    const { putIdentityRecord, getIdentityRecord, deleteIdentityRecord } =
      await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    putIdentityRecord(id, { lastActivityBlock: 3, lastDecayBlock: 3, likeCarry: 0n });
    deleteIdentityRecord(id);

    expect(getIdentityRecord(id)).toBeNull();
  });

  it('delete of a nonexistent record is a no-op, not a throw', async () => {
    const { initDb } = await importDbFresh();
    const { deleteIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    expect(() => deleteIdentityRecord(uidBytes())).not.toThrow();
  });

  it('delete targets only the named identity', async () => {
    const { initDb } = await importDbFresh();
    const { putIdentityRecord, getIdentityRecord, deleteIdentityRecord } =
      await importRecordsFresh();
    initDb(':memory:');

    const a = uidBytes();
    const b = uidBytes();
    putIdentityRecord(a, { lastActivityBlock: 1, lastDecayBlock: 1, likeCarry: 0n });
    putIdentityRecord(b, { lastActivityBlock: 2, lastDecayBlock: 2, likeCarry: 0n });
    deleteIdentityRecord(a);

    expect(getIdentityRecord(a)).toBeNull();
    expect(getIdentityRecord(b)).toEqual({ lastActivityBlock: 2, lastDecayBlock: 2, likeCarry: 0n });
  });

  it('a zero clock is stored and read back as zero, not treated as absent', async () => {
    const { initDb } = await importDbFresh();
    const { putIdentityRecord, getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    putIdentityRecord(id, { lastActivityBlock: 0, lastDecayBlock: 0, likeCarry: 0n });

    expect(getIdentityRecord(id)).toEqual({ lastActivityBlock: 0, lastDecayBlock: 0, likeCarry: 0n });
  });
});

/**
 * Spec G phase D — the full-set read that feeds `bootstrapAvlProver`.
 *
 * A node rebuilding its tree from the store has to see every record, or it
 * computes a `stateRoot` a node that stayed up does not.
 */
describe('getAllIdentityRecords (Spec G phase D)', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  async function importAllFresh() {
    return (await import('../../src/store/identity-records.js')) as {
      putIdentityRecord: (id: UserId, r: IdentityRecord) => void;
      getAllIdentityRecords: () => Array<{ identityId: UserId; record: IdentityRecord }>;
    };
  }

  it('returns nothing on an empty store', async () => {
    const { initDb } = await importDbFresh();
    const { getAllIdentityRecords } = await importAllFresh();
    initDb(':memory:');

    expect(getAllIdentityRecords()).toEqual([]);
  });

  it('returns every record, with its identity bytes and clock intact', async () => {
    const { initDb } = await importDbFresh();
    const { putIdentityRecord, getAllIdentityRecords } = await importAllFresh();
    initDb(':memory:');

    const a = uidBytes();
    const b = uidBytes();
    putIdentityRecord(a, { lastActivityBlock: 3, lastDecayBlock: 1, likeCarry: 0n });
    putIdentityRecord(b, { lastActivityBlock: 9, lastDecayBlock: 0, likeCarry: 0n });

    const all = getAllIdentityRecords();
    expect(all).toHaveLength(2);
    // The identity is the key the AVL key is derived from, so it must survive
    // as raw bytes rather than as a Buffer or a hex string.
    for (const entry of all) {
      expect(entry.identityId).toBeInstanceOf(Uint8Array);
      expect(entry.identityId).toHaveLength(32);
    }
    const byHex = new Map(
      all.map((e) => [Buffer.from(e.identityId).toString('hex'), e.record]),
    );
    expect(byHex.get(Buffer.from(a).toString('hex'))).toEqual({
      lastActivityBlock: 3,
      lastDecayBlock: 1,
      likeCarry: 0n,
    });
    expect(byHex.get(Buffer.from(b).toString('hex'))).toEqual({
      lastActivityBlock: 9,
      lastDecayBlock: 0,
      likeCarry: 0n,
    });
  });

  it('reads heights back as numbers, not bigints', async () => {
    const { initDb } = await importDbFresh();
    const { putIdentityRecord, getAllIdentityRecords } = await importAllFresh();
    initDb(':memory:');

    // `.safeIntegers()` hands back bigints; a bigint reaching `serializeIdentityRecord`
    // would CBOR-encode differently and move the digest.
    putIdentityRecord(uidBytes(), { lastActivityBlock: 5, lastDecayBlock: 2, likeCarry: 0n });

    const [entry] = getAllIdentityRecords();
    expect(typeof entry!.record.lastActivityBlock).toBe('number');
    expect(typeof entry!.record.lastDecayBlock).toBe('number');
  });

  it('an upserted record appears once, at its latest value', async () => {
    const { initDb } = await importDbFresh();
    const { putIdentityRecord, getAllIdentityRecords } = await importAllFresh();
    initDb(':memory:');

    const id = uidBytes();
    putIdentityRecord(id, { lastActivityBlock: 1, lastDecayBlock: 0, likeCarry: 0n });
    putIdentityRecord(id, { lastActivityBlock: 8, lastDecayBlock: 4, likeCarry: 0n });

    expect(getAllIdentityRecords()).toEqual([
      { identityId: id, record: { lastActivityBlock: 8, lastDecayBlock: 4, likeCarry: 0n } },
    ]);
  });
});

/**
 * P2-D N2a — `likeCarry` at the row boundary: SQLite INTEGER in, bigint out.
 * Heights stay numbers; the carry stays bigint end-to-end so no `Number()`
 * coercion can appear in a consensus path.
 */
describe('likeCarry at the row boundary (P2-D N2a)', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('a non-zero carry round-trips through put/get as bigint', async () => {
    const { initDb } = await importDbFresh();
    const { putIdentityRecord, getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    putIdentityRecord(id, { lastActivityBlock: 10, lastDecayBlock: 2, likeCarry: 4n });

    const got = getIdentityRecord(id)!;
    expect(got).toEqual({ lastActivityBlock: 10, lastDecayBlock: 2, likeCarry: 4n });
    expect(typeof got.likeCarry).toBe('bigint');
    expect(typeof got.lastActivityBlock).toBe('number');
  });

  it('a zero carry reads back as 0n, and the full-set read agrees', async () => {
    const { initDb } = await importDbFresh();
    const records = (await import('../../src/store/identity-records.js')) as {
      putIdentityRecord: (id: UserId, r: IdentityRecord) => void;
      getAllIdentityRecords: () => Array<{ identityId: UserId; record: IdentityRecord }>;
    };
    initDb(':memory:');

    records.putIdentityRecord(uidBytes(), { lastActivityBlock: 5, lastDecayBlock: 0, likeCarry: 0n });

    const [entry] = records.getAllIdentityRecords();
    expect(entry!.record.likeCarry).toBe(0n);
    expect(typeof entry!.record.likeCarry).toBe('bigint');
  });

  it('an update can change ONLY the carry and the other fields hold', async () => {
    const { initDb } = await importDbFresh();
    const { putIdentityRecord, getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    putIdentityRecord(id, { lastActivityBlock: 7, lastDecayBlock: 3, likeCarry: 0n });
    putIdentityRecord(id, { lastActivityBlock: 7, lastDecayBlock: 3, likeCarry: 3n });

    expect(getIdentityRecord(id)).toEqual({
      lastActivityBlock: 7,
      lastDecayBlock: 3,
      likeCarry: 3n,
    });
  });
});
