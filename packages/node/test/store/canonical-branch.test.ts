import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../../src/store/db.js';

describe('canonical_branch', () => {
  beforeEach(() => { initDb(':memory:'); });
  afterEach(() => { closeDb(); });

  it('inserts and reads canonical branch entries', () => {
    const db = getDb();
    db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, 'abc123');
    const row = db.prepare('SELECT post_id FROM canonical_branch WHERE depth = 1').get() as any;
    expect(row.post_id).toBe('abc123');
  });

  it('overwrites on conflict (same depth)', () => {
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, 'abc');
    db.prepare('INSERT OR REPLACE INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, 'xyz');
    const row = db.prepare('SELECT post_id FROM canonical_branch WHERE depth = 1').get() as any;
    expect(row.post_id).toBe('xyz');
  });

  it('reads entries in depth order', () => {
    const db = getDb();
    db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(0, 'genesis');
    db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(2, 'third');
    db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, 'second');
    const rows = db.prepare('SELECT depth, post_id FROM canonical_branch ORDER BY depth ASC').all() as any[];
    expect(rows).toHaveLength(3);
    expect(rows[0].post_id).toBe('genesis');
    expect(rows[1].post_id).toBe('second');
    expect(rows[2].post_id).toBe('third');
  });

  it('deletes entries above a depth threshold (reorg unwind)', () => {
    const db = getDb();
    db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(0, 'genesis');
    db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, 'a');
    db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(2, 'b');
    db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(3, 'c');

    // Simulate reorg: delete everything above depth 1 (fork point)
    db.prepare('DELETE FROM canonical_branch WHERE depth > ?').run(1);

    const rows = db.prepare('SELECT depth FROM canonical_branch ORDER BY depth ASC').all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].depth).toBe(0);
    expect(rows[1].depth).toBe(1);
  });

  it('returns null for missing depth', () => {
    const db = getDb();
    const row = db.prepare('SELECT post_id FROM canonical_branch WHERE depth = 999').get();
    expect(row).toBeUndefined();
  });
});

describe('post_scores', () => {
  beforeEach(() => { initDb(':memory:'); });
  afterEach(() => { closeDb(); });

  it('inserts and reads cumulative scores', () => {
    const db = getDb();
    db.prepare('INSERT INTO post_scores (post_id, cumulative_score) VALUES (?, ?)').run('abc', 100);
    const row = db.prepare('SELECT cumulative_score FROM post_scores WHERE post_id = ?').get('abc') as any;
    expect(row.cumulative_score).toBe(100);
  });

  it('overwrites score on conflict', () => {
    const db = getDb();
    db.prepare('INSERT INTO post_scores (post_id, cumulative_score) VALUES (?, ?)').run('abc', 100);
    db.prepare('INSERT OR REPLACE INTO post_scores (post_id, cumulative_score) VALUES (?, ?)').run('abc', 200);
    const row = db.prepare('SELECT cumulative_score FROM post_scores WHERE post_id = ?').get('abc') as any;
    expect(row.cumulative_score).toBe(200);
  });

  it('stores zero scores', () => {
    const db = getDb();
    db.prepare('INSERT INTO post_scores (post_id, cumulative_score) VALUES (?, ?)').run('genesis', 0);
    const row = db.prepare('SELECT cumulative_score FROM post_scores WHERE post_id = ?').get('genesis') as any;
    expect(row.cumulative_score).toBe(0);
  });

  it('resolves strictly greater score wins', () => {
    const db = getDb();
    db.prepare('INSERT INTO post_scores (post_id, cumulative_score) VALUES (?, ?)').run('tip-a', 100);
    db.prepare('INSERT INTO post_scores (post_id, cumulative_score) VALUES (?, ?)').run('tip-b', 150);

    const a = db.prepare('SELECT cumulative_score FROM post_scores WHERE post_id = ?').get('tip-a') as any;
    const b = db.prepare('SELECT cumulative_score FROM post_scores WHERE post_id = ?').get('tip-b') as any;

    // Strictly greater wins: 150 > 100
    expect(b.cumulative_score).toBeGreaterThan(a.cumulative_score);
  });
});
