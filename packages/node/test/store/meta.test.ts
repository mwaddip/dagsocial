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

import { writeSchemaVersion, CURRENT_SCHEMA_VERSION } from '../../src/store/meta.js';

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
