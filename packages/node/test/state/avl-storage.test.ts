import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BatchAVLProver, PersistentBatchAVLProver } from '@ergots/avltree';
import { SqliteAvlStorage } from '../../src/state/avl-storage.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE avl_tree_versions (
      version BLOB PRIMARY KEY,
      height INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE avl_tree_nodes (
      version BLOB NOT NULL REFERENCES avl_tree_versions(version),
      label BLOB NOT NULL,
      node_data BLOB NOT NULL,
      PRIMARY KEY (version, label)
    );
  `);
  return db;
}

const HEIGHT_SENTINEL = new Uint8Array(32); // all zeros

/** Storage codec config -- must match each test's BatchAVLProver key length. */
const AVL_CONFIG = { keyLength: 32, valueLengthOpt: null };

describe('SqliteAvlStorage', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('version() returns null on empty storage', () => {
    const storage = new SqliteAvlStorage(db, AVL_CONFIG);
    expect(storage.version()).toBeNull();
  });

  it('update() then version() returns the digest', () => {
    const storage = new SqliteAvlStorage(db, AVL_CONFIG);
    const prover = new BatchAVLProver(32, null);

    // Insert a single key-value pair
    const key = new Uint8Array(32);
    key[0] = 0x01;
    const value = new Uint8Array([0xaa, 0xbb]);
    prover.performOneOperation({ tag: 'Insert', key, value });

    const digest = prover.digest()!;
    storage.update(prover, [[HEIGHT_SENTINEL, encodeHeight(1)]]);

    expect(storage.version()).toEqual(digest);
  });

  it('update() -> rollback() roundtrip with single insert', () => {
    const storage = new SqliteAvlStorage(db, AVL_CONFIG);
    const prover = new BatchAVLProver(32, null);

    const key = new Uint8Array(32);
    key[0] = 0x01;
    const value = new Uint8Array([0xaa, 0xbb]);
    prover.performOneOperation({ tag: 'Insert', key, value });

    const digestBefore = prover.digest()!;
    storage.update(prover, [[HEIGHT_SENTINEL, encodeHeight(1)]]);

    // Create fresh prover and rollback
    const prover2 = new BatchAVLProver(32, null);
    const persisted = new PersistentBatchAVLProver(prover2, storage, [[HEIGHT_SENTINEL, encodeHeight(1)]]);
    expect(persisted.digest()).toEqual(digestBefore);
    expect(persisted.unauthenticatedLookup(key)).toEqual(value);
  });

  it('update() -> rollback() roundtrip with 100 inserts', () => {
    const storage = new SqliteAvlStorage(db, AVL_CONFIG);
    const prover = new BatchAVLProver(32, null);

    // Start at 1 to avoid all-zeros key (AVL negative-infinity sentinel).
    const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
    for (let i = 1; i <= 100; i++) {
      const key = new Uint8Array(32);
      key[0] = (i >> 8) & 0xff;
      key[1] = i & 0xff;
      const value = new Uint8Array([i & 0xff]);
      prover.performOneOperation({ tag: 'Insert', key, value });
      entries.push({ key, value });
    }

    const digestBefore = prover.digest()!;
    storage.update(prover, [[HEIGHT_SENTINEL, encodeHeight(1)]]);

    // Rollback fresh prover
    const prover2 = new BatchAVLProver(32, null);
    const persisted = new PersistentBatchAVLProver(prover2, storage, [[HEIGHT_SENTINEL, encodeHeight(1)]]);
    expect(persisted.digest()).toEqual(digestBefore);

    for (const { key, value } of entries) {
      expect(persisted.unauthenticatedLookup(key)).toEqual(value);
    }
  });

  it('pruneVersionsBefore() deletes old versions and their nodes', () => {
    const storage = new SqliteAvlStorage(db, AVL_CONFIG);
    const prover = new BatchAVLProver(32, null);

    // Create 5 versions
    for (let h = 1; h <= 5; h++) {
      const key = new Uint8Array(32);
      key[0] = h;
      prover.performOneOperation({ tag: 'Insert', key, value: new Uint8Array([h]) });
      storage.update(prover, [[HEIGHT_SENTINEL, encodeHeight(h)]]);
    }

    expect(storage.rollbackVersions().length).toBe(5);

    // Prune versions before height 3
    storage.pruneVersionsBefore(3);
    const remaining = storage.rollbackVersions();
    expect(remaining.length).toBe(3); // heights 3, 4, 5 remain

    // Verify pruned versions don't have orphaned nodes
    const orphanCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM avl_tree_nodes WHERE version NOT IN (SELECT version FROM avl_tree_versions)',
    ).get() as { cnt: number };
    expect(orphanCount.cnt).toBe(0);
  });

  it('rollbackVersions() returns all versions', () => {
    const storage = new SqliteAvlStorage(db, AVL_CONFIG);

    // Insert at version 1
    const prover1 = new BatchAVLProver(32, null);
    const key1 = new Uint8Array(32);
    key1[0] = 0x01;
    prover1.performOneOperation({ tag: 'Insert', key: key1, value: new Uint8Array([1]) });
    storage.update(prover1, [[HEIGHT_SENTINEL, encodeHeight(1)]]);
    const v1 = storage.version()!;

    // Insert a different key at version 2 (byte 0 = 0x02, not 0x01)
    const key2 = new Uint8Array(32);
    key2[0] = 0x02;
    prover1.performOneOperation({ tag: 'Insert', key: key2, value: new Uint8Array([2]) });
    storage.update(prover1, [[HEIGHT_SENTINEL, encodeHeight(2)]]);
    const v2 = storage.version()!;

    const versions = storage.rollbackVersions();
    expect(versions.length).toBe(2);
    expect(versions.map(v => Buffer.from(v).toString('hex')).sort()).toEqual(
      [v1, v2].map(v => Buffer.from(v).toString('hex')).sort()
    );
  });
});

function encodeHeight(h: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, h, false); // BE
  return buf;
}
