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
    putIdentityRecord(id, { lastActivityBlock: 42, lastDecayBlock: 7 });

    expect(getIdentityRecord(id)).toEqual({ lastActivityBlock: 42, lastDecayBlock: 7 });
  });

  it('heights come back as numbers, not bigints', async () => {
    const { initDb } = await importDbFresh();
    const { putIdentityRecord, getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    putIdentityRecord(id, { lastActivityBlock: 5, lastDecayBlock: 0 });

    const got = getIdentityRecord(id)!;
    expect(typeof got.lastActivityBlock).toBe('number');
    expect(typeof got.lastDecayBlock).toBe('number');
  });

  it('put over an existing key upserts rather than throwing or duplicating', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { putIdentityRecord, getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    putIdentityRecord(id, { lastActivityBlock: 10, lastDecayBlock: 1 });
    putIdentityRecord(id, { lastActivityBlock: 20, lastDecayBlock: 2 });

    expect(getIdentityRecord(id)).toEqual({ lastActivityBlock: 20, lastDecayBlock: 2 });

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
    putIdentityRecord(a, { lastActivityBlock: 1, lastDecayBlock: 1 });
    putIdentityRecord(b, { lastActivityBlock: 2, lastDecayBlock: 2 });

    expect(getIdentityRecord(a)).toEqual({ lastActivityBlock: 1, lastDecayBlock: 1 });
    expect(getIdentityRecord(b)).toEqual({ lastActivityBlock: 2, lastDecayBlock: 2 });
  });

  it('the key is the identity bytes, not the identity object', async () => {
    const { initDb } = await importDbFresh();
    const { putIdentityRecord, getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    putIdentityRecord(id, { lastActivityBlock: 9, lastDecayBlock: 3 });

    // A distinct Uint8Array with identical bytes must resolve the same row.
    expect(getIdentityRecord(new Uint8Array(id))).toEqual({
      lastActivityBlock: 9,
      lastDecayBlock: 3,
    });
  });

  it('delete removes the record', async () => {
    const { initDb } = await importDbFresh();
    const { putIdentityRecord, getIdentityRecord, deleteIdentityRecord } =
      await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    putIdentityRecord(id, { lastActivityBlock: 3, lastDecayBlock: 3 });
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
    putIdentityRecord(a, { lastActivityBlock: 1, lastDecayBlock: 1 });
    putIdentityRecord(b, { lastActivityBlock: 2, lastDecayBlock: 2 });
    deleteIdentityRecord(a);

    expect(getIdentityRecord(a)).toBeNull();
    expect(getIdentityRecord(b)).toEqual({ lastActivityBlock: 2, lastDecayBlock: 2 });
  });

  it('a zero clock is stored and read back as zero, not treated as absent', async () => {
    const { initDb } = await importDbFresh();
    const { putIdentityRecord, getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const id = uidBytes();
    putIdentityRecord(id, { lastActivityBlock: 0, lastDecayBlock: 0 });

    expect(getIdentityRecord(id)).toEqual({ lastActivityBlock: 0, lastDecayBlock: 0 });
  });
});
