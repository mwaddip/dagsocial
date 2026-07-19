import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/store/db.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-db.sqlite';

describe('database', () => {
  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch {}
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('creates all required tables', () => {
    initDb(TEST_DB);
    const db = getDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map(t => t.name).sort();
    for (const expected of ['identities', 'slots', 'posts', 'post_parents', 'blocks', 'block_posts']) {
      expect(names).toContain(expected);
    }
  });

  it('enables WAL mode', () => {
    const result = getDb().prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(result.journal_mode).toBe('wal');
  });

  it('initDb is idempotent', () => {
    initDb(TEST_DB);
  });

  it('throws if getDb called before init', () => {
    closeDb();
    expect(() => getDb()).toThrow('Database not initialized');
    initDb(TEST_DB);
  });
});
