import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb } from '../../src/store/db.js';
import { SqlitePostStore } from '../../src/store/sqlite-store.js';
import type { PostStore, StoreEntry } from '../../src/store/post-store.js';

describe('PostStore', () => {
  let store: PostStore;
  const dbPath = ':memory:';

  beforeEach(() => {
    initDb(dbPath);
    store = new SqlitePostStore();
  });

  afterEach(() => {
    store.close();
  });

  it('put and get roundtrip', () => {
    const entry: StoreEntry = {
      typeId: 1,
      id: new Uint8Array(32).fill(0xab),
      sequence: 1,
      data: new Uint8Array([1, 2, 3]),
    };
    store.put(entry);
    const result = store.get(1, entry.id);
    expect(result).not.toBeNull();
    expect(result!).toEqual(entry.data);
  });

  it('has returns false for unknown entry', () => {
    expect(store.has(1, new Uint8Array(32).fill(0xff))).toBe(false);
  });

  it('has returns true after put', () => {
    const id = new Uint8Array(32).fill(0xcd);
    store.put({ typeId: 1, id, sequence: 1, data: new Uint8Array([1]) });
    expect(store.has(1, id)).toBe(true);
  });

  it('put is idempotent', () => {
    const id = new Uint8Array(32).fill(0xef);
    const entry: StoreEntry = { typeId: 1, id, sequence: 1, data: new Uint8Array([1, 2]) };
    store.put(entry);
    store.put(entry); // should not throw
    const result = store.get(1, id);
    expect(result!).toEqual(new Uint8Array([1, 2]));
  });

  it('putBatch writes all or nothing', () => {
    const entries: StoreEntry[] = [
      { typeId: 1, id: new Uint8Array(32).fill(1), sequence: 1, data: new Uint8Array([1]) },
      { typeId: 1, id: new Uint8Array(32).fill(2), sequence: 2, data: new Uint8Array([2]) },
    ];
    store.putBatch(entries);
    expect(store.has(1, entries[0].id)).toBe(true);
    expect(store.has(1, entries[1].id)).toBe(true);
  });

  it('schemaVersion returns the current version after init', () => {
    const v = store.schemaVersion();
    expect(v).toBeGreaterThanOrEqual(0);
  });

  it('metaGet and metaPut roundtrip', () => {
    store.metaPut('test', new Uint8Array([7, 8, 9]));
    expect(store.metaGet('test')!).toEqual(new Uint8Array([7, 8, 9]));
  });
});
