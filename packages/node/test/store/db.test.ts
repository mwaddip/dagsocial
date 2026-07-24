import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';

// Module-level state in db.ts requires reset between tests.
async function importFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database;
    closeDb: () => void;
  };
}

const EXPECTED_TABLES = [
  'identities',
  'challenges',
  'dag_posts',
  'dag_parent_refs',
  'dag_stumps',
  'utxo_boxes',
  'dag_likes',
  'mempool',
  'ordering_blocks',
];

describe('db lifecycle', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('getDb throws if not initialized', async () => {
    const { getDb } = await importFresh();
    expect(() => getDb()).toThrow(/not initialized/i);
  });

  it('initDb initializes and getDb returns a usable handle', async () => {
    const { initDb, getDb } = await importFresh();
    initDb(':memory:');
    const db = getDb();
    expect(db).toBeDefined();
    // Verify the handle is usable by running a query
    const row = db.prepare('SELECT 1 AS n').get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('closeDb closes and getDb throws again', async () => {
    const { initDb, getDb, closeDb } = await importFresh();
    initDb(':memory:');
    closeDb();
    expect(() => getDb()).toThrow(/not initialized/i);
  });

  it('initDb creates a database file on disk', async () => {
    const tmpDir = os.tmpdir();
    const dbPath = path.join(tmpDir, `dagsocial-test-${Date.now()}.db`);
    try {
      const { initDb, closeDb } = await importFresh();
      initDb(dbPath);
      expect(fs.existsSync(dbPath)).toBe(true);
      closeDb();
    } finally {
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
      try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
    }
  });

  it('second initDb is idempotent (does not throw)', async () => {
    const { initDb } = await importFresh();
    initDb(':memory:');
    // Second call on the same module should not throw — CREATE IF NOT EXISTS
    expect(() => initDb(':memory:')).not.toThrow();
  });

  it('all expected tables exist after init', async () => {
    const { initDb, getDb } = await importFresh();
    initDb(':memory:');
    const db = getDb();

    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = rows.map((r) => r.name);

    for (const expected of EXPECTED_TABLES) {
      expect(tableNames).toContain(expected);
    }
  });

  it('each table has the expected columns', async () => {
    const { initDb, getDb } = await importFresh();
    initDb(':memory:');
    const db = getDb();

    // Spot-check a few tables for key columns

    // identities
    const identityCols = db.pragma('table_info(identities)') as Array<{ name: string }>;
    const identityNames = identityCols.map((c) => c.name);
    expect(identityNames).toContain('user_id');
    expect(identityNames).toContain('public_key');
    expect(identityNames).toContain('created_at');
    // Phase 2 schema must NOT have secret_key
    expect(identityNames).not.toContain('secret_key');

    // challenges
    const challengeCols = db.pragma('table_info(challenges)') as Array<{ name: string }>;
    const challengeNames = challengeCols.map((c) => c.name);
    expect(challengeNames).toContain('user_id');
    expect(challengeNames).toContain('challenge');
    expect(challengeNames).toContain('expires_at_block');

    // dag_posts
    const dagPostsCols = db.pragma('table_info(dag_posts)') as Array<{ name: string }>;
    const dagPostsNames = dagPostsCols.map((c) => c.name);
    expect(dagPostsNames).toContain('id');
    expect(dagPostsNames).toContain('content');
    expect(dagPostsNames).toContain('parent_refs');
    expect(dagPostsNames).toContain('raw_cbor');
    expect(dagPostsNames).toContain('status');
    expect(dagPostsNames).toContain('block_height');

    // ordering_blocks (blob-based from Phase 2 block-header split)
    const orderCols = db.pragma('table_info(ordering_blocks)') as Array<{ name: string }>;
    const orderNames = orderCols.map((c) => c.name);
    expect(orderNames).toContain('height');
    expect(orderNames).toContain('header_cbor');
    expect(orderNames).toContain('subblock_tree_cbor');
    expect(orderNames).toContain('utxotx_tree_cbor');
    expect(orderNames).toContain('validator_signature');
    expect(orderNames).toContain('created_at');
  });
});
