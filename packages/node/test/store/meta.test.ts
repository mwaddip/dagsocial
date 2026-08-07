import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDb, closeDb } from '../../src/store/db.js';
import { metaGet, metaPut, schemaVersion, getReorgFloor, setReorgFloor, CURRENT_SCHEMA_VERSION } from '../../src/store/meta.js';

describe('dag_meta', () => {
  const dbPath = ':memory:';

  beforeEach(() => {
    initDb(dbPath);
    // Ensure schema version is written on fresh DB
    if (schemaVersion() === 0) {
      metaPut('schema_version', new Uint8Array(
        new Uint32Array([CURRENT_SCHEMA_VERSION]).buffer
      ));
    }
  });

  afterEach(() => {
    closeDb();
  });

  it('stores and retrieves a metadata key', () => {
    const key = 'test_key';
    const value = new Uint8Array([1, 2, 3, 4]);
    metaPut(key, value);
    const result = metaGet(key);
    expect(result).not.toBeNull();
    expect(result!).toEqual(value);
  });

  it('returns null for unknown keys', () => {
    expect(metaGet('nonexistent')).toBeNull();
  });

  it('overwrites existing keys', () => {
    metaPut('test_key', new Uint8Array([1, 2, 3]));
    metaPut('test_key', new Uint8Array([4, 5, 6]));
    const result = metaGet('test_key');
    expect(result!).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('reports schema version on fresh database', () => {
    expect(schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('accepts non-negative schema version', () => {
    const version = schemaVersion();
    expect(version).toBeGreaterThanOrEqual(0);
  });
});

import { writeSchemaVersion, ensureSchemaVersion, CURRENT_SCHEMA_VERSION } from '../../src/store/meta.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('schema version startup', () => {
  const dbPath = ':memory:';

  it('writes schema version on fresh database', () => {
    initDb(dbPath);
    // After initDb, writeSchemaVersion should succeed
    writeSchemaVersion(CURRENT_SCHEMA_VERSION);
    expect(schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    closeDb();
  });

  it('survives schema version rewrite (idempotent)', () => {
    initDb(dbPath);
    writeSchemaVersion(1);
    writeSchemaVersion(1); // same value, idempotent
    expect(schemaVersion()).toBe(1);
    closeDb();
  });
});

describe('ensureSchemaVersion — the startup gate (P2-D N2a)', () => {
  afterEach(() => {
    closeDb();
  });

  it('the current schema version is 2 (like_records + identity_records.like_carry)', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
  });

  it('stamps a fresh database with the current version', () => {
    initDb(':memory:');
    expect(schemaVersion()).toBe(0);
    ensureSchemaVersion();
    expect(schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('is a no-op at the current version', () => {
    initDb(':memory:');
    ensureSchemaVersion();
    expect(() => ensureSchemaVersion()).not.toThrow();
    expect(schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('REFUSES a v1-stamped database instead of silently adopting it', () => {
    initDb(':memory:');
    writeSchemaVersion(1);
    // No migration path exists — the previous behaviour ("running
    // migrations..." then stamp) would leave a v1 identity_records with no
    // like_carry column running until the first record read.
    expect(() => ensureSchemaVersion()).toThrow(/schema version is 1/i);
    // And it did NOT stamp on the way out.
    expect(schemaVersion()).toBe(1);
  });

  it('refuses a v1-stamped database FILE across a close/reopen — the real startup shape', () => {
    const dbPath = path.join(os.tmpdir(), `dagsocial-v1-gate-${process.pid}-${Date.now()}.db`);
    try {
      // A node stamped this file v1 and shut down…
      initDb(dbPath);
      writeSchemaVersion(1);
      closeDb();

      // …and a v2 build starts against it.
      initDb(dbPath);
      expect(() => ensureSchemaVersion()).toThrow(/expects 2/i);
    } finally {
      closeDb();
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
      }
    }
  });

  it('refuses a database stamped NEWER than this build (downgrade)', () => {
    initDb(':memory:');
    writeSchemaVersion(CURRENT_SCHEMA_VERSION + 1);
    expect(() => ensureSchemaVersion()).toThrow(/schema version/i);
  });
});

describe('reorg floor', () => {
  const dbPath = ':memory:';

  beforeEach(() => {
    initDb(dbPath);
  });

  afterEach(() => {
    closeDb();
  });

  it('returns 0 when not set (default)', () => {
    expect(getReorgFloor()).toBe(0);
  });

  it('stores and retrieves a non-zero floor', () => {
    setReorgFloor(42);
    expect(getReorgFloor()).toBe(42);
  });

  it('overwrites existing floor', () => {
    setReorgFloor(10);
    setReorgFloor(20);
    expect(getReorgFloor()).toBe(20);
  });

  it('handles zero explicitly (disables floor)', () => {
    setReorgFloor(100);
    expect(getReorgFloor()).toBe(100);
    setReorgFloor(0);
    expect(getReorgFloor()).toBe(0);
  });
});
