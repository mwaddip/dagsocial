import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import { setReorgFloor } from '../../src/store/meta.js';
import { DagService } from '../../src/services/dag-service.js';
import { SqlitePostStore } from '../../src/store/sqlite-store.js';

// ---------------------------------------------------------------------------
// Post IDs are 64-char hex strings in production (32 bytes as hex). We use
// short even-length hex strings in tests so that Buffer.from(id, 'hex')
// works correctly.
// ---------------------------------------------------------------------------
const G = '00'.repeat(32); // genesis
const A = 'aa'.repeat(32); // post a
const B = 'bb'.repeat(32); // post b
const C = 'cc'.repeat(32); // post c
const D = 'dd'.repeat(32); // post d
const X = '11'.repeat(32); // post x
const Y = '22'.repeat(32); // post y

/**
 * Helper: insert a post into dag_posts with parent refs so that
 * getParentRefs() works for DAG walking in findForkPoint / walkToAncestor.
 */
function insertPost(id: string, parentIds: string[]): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO dag_posts
     (id, content, author, parent_refs, challenge, pow_nonce,
      protocol_version, timestamp, signature, raw_cbor, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(
    id,
    'test content',
    Buffer.alloc(32),
    JSON.stringify(parentIds),
    Buffer.alloc(32),
    0,
    1,
    Date.now(),
    Buffer.alloc(64),
    Buffer.from([1, 2, 3]),
  );

  for (const pid of parentIds) {
    db.prepare(
      'INSERT OR IGNORE INTO dag_parent_refs (post_id, parent_id) VALUES (?, ?)',
    ).run(id, pid);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DagService', () => {
  let service: DagService;

  beforeEach(() => {
    initDb(':memory:');
    service = new DagService(new SqlitePostStore());
  });

  afterEach(() => {
    closeDb();
  });

  // -----------------------------------------------------------------------
  // computeScore
  // -----------------------------------------------------------------------

  describe('computeScore', () => {
    it('adds parent score to own work', () => {
      expect(service.computeScore('child', 100, 25)).toBe(125);
    });

    it('handles zero parent score (genesis)', () => {
      expect(service.computeScore('genesis', 0, 10)).toBe(10);
    });

    it('handles zero own work', () => {
      expect(service.computeScore('post', 50, 0)).toBe(50);
    });
  });

  // -----------------------------------------------------------------------
  // saveScore / getScore
  // -----------------------------------------------------------------------

  describe('saveScore and getScore', () => {
    it('saves and retrieves a score', () => {
      service.saveScore(A, 100);
      expect(service.getScore(A)).toBe(100);
    });

    it('returns null for missing score', () => {
      expect(service.getScore('nonexistent')).toBeNull();
    });

    it('overwrites on conflict', () => {
      service.saveScore(A, 100);
      service.saveScore(A, 200);
      expect(service.getScore(A)).toBe(200);
    });

    it('stores zero score', () => {
      service.saveScore(G, 0);
      expect(service.getScore(G)).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // getCurrentTip
  // -----------------------------------------------------------------------

  describe('getCurrentTip', () => {
    it('returns null when branch is empty', () => {
      expect(service.getCurrentTip()).toBeNull();
    });

    it('returns the highest-depth entry', () => {
      const db = getDb();
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(0, G);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, A);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(2, B);
      service.saveScore(B, 100);

      const tip = service.getCurrentTip();
      expect(tip).not.toBeNull();
      expect(tip!.postId).toBe(B);
      expect(tip!.depth).toBe(2);
      expect(tip!.score).toBe(100);
    });
  });

  // -----------------------------------------------------------------------
  // getCanonicalDepth
  // -----------------------------------------------------------------------

  describe('getCanonicalDepth', () => {
    it('returns depth for a post on the branch', () => {
      const db = getDb();
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(3, X);
      expect(service.getCanonicalDepth(X)).toBe(3);
    });

    it('returns null for a post not on the branch', () => {
      expect(service.getCanonicalDepth('nonexistent')).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // findForkPoint
  // -----------------------------------------------------------------------

  describe('findForkPoint', () => {
    it('finds common ancestor in a simple fork', () => {
      // DAG: G -> A -> B -> C (old tip)
      //               \-> D      (new tip)
      insertPost(G, []);
      insertPost(A, [G]);
      insertPost(B, [A]);
      insertPost(C, [B]);
      insertPost(D, [A]);

      const fork = service.findForkPoint(C, D);
      expect(fork).toBe(A);
    });

    it('returns oldTip itself when it is an ancestor of newTip', () => {
      insertPost(G, []);
      insertPost(A, [G]);
      insertPost(B, [A]);

      // oldTip = A, newTip = B. A is parent of B.
      const fork = service.findForkPoint(A, B);
      expect(fork).toBe(A);
    });

    it('returns newTip itself when newTip is an ancestor of oldTip', () => {
      insertPost(G, []);
      insertPost(A, [G]);
      insertPost(B, [A]);

      // oldTip = B, newTip = A. A is parent of B.
      const fork = service.findForkPoint(B, A);
      expect(fork).toBe(A);
    });

    it('returns genesis when that is the only common ancestor', () => {
      insertPost(G, []);
      insertPost(A, [G]);
      insertPost(B, [G]);
      insertPost(C, [A]);
      insertPost(D, [B]);

      const fork = service.findForkPoint(C, D);
      expect(fork).toBe(G);
    });

    it('returns null for disconnected DAGs', () => {
      insertPost(A, []);
      insertPost(B, []);

      const fork = service.findForkPoint(A, B);
      expect(fork).toBeNull();
    });

    it('returns null when neither tip exists', () => {
      const fork = service.findForkPoint('ee'.repeat(32), 'ff'.repeat(32));
      expect(fork).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // buildReorgPlan
  // -----------------------------------------------------------------------

  describe('buildReorgPlan', () => {
    it('returns null when new score equals current tip score', () => {
      const db = getDb();
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(0, G);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, A);
      service.saveScore(A, 100);

      insertPost(G, []);
      insertPost(A, [G]);
      insertPost(B, [G]);

      service.saveScore(B, 100); // equal score

      const plan = service.buildReorgPlan(B, 100);
      expect(plan).toBeNull();
    });

    it('returns null when new score is lower', () => {
      const db = getDb();
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(0, G);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, A);
      service.saveScore(A, 100);

      insertPost(G, []);
      insertPost(A, [G]);
      insertPost(B, [G]);

      service.saveScore(B, 50); // lower score

      const plan = service.buildReorgPlan(B, 50);
      expect(plan).toBeNull();
    });

    it('builds reorg plan when new score is strictly higher', () => {
      // Current canonical: G -> A -> B (tip, score 100)
      const db = getDb();
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(0, G);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, A);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(2, B);
      service.saveScore(A, 100);
      service.saveScore(B, 100);

      // Competing branch: G -> A -> D (tip, score 150)
      insertPost(G, []);
      insertPost(A, [G]);
      insertPost(B, [A]);
      insertPost(D, [A]);

      service.saveScore(D, 150);

      const plan = service.buildReorgPlan(D, 150);
      expect(plan).not.toBeNull();
      expect(plan!.forkPoint).toBe(A);
      expect(plan!.toUnconfirm).toEqual([B]); // remove B
      expect(plan!.toConfirm).toEqual([D]);   // add D
    });

    it('builds reorg plan with multiple posts to unconfirm and confirm', () => {
      // Current canonical: G -> A -> B -> C (tip, score 100)
      const db = getDb();
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(0, G);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, A);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(2, B);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(3, C);
      service.saveScore(C, 100);

      // Competing: G -> A -> X -> Y (tip, score 200)
      insertPost(G, []);
      insertPost(A, [G]);
      insertPost(B, [A]);
      insertPost(C, [B]);
      insertPost(X, [A]);
      insertPost(Y, [X]);

      service.saveScore(Y, 200);

      const plan = service.buildReorgPlan(Y, 200);
      expect(plan).not.toBeNull();
      expect(plan!.forkPoint).toBe(A);
      expect(plan!.toUnconfirm).toEqual([C, B]); // descending depth order
      expect(plan!.toConfirm).toEqual([X, Y]);   // ascending depth order
    });

    it('returns plan for initial tip when no canonical branch exists', () => {
      insertPost(G, []);
      insertPost(A, [G]);
      insertPost(B, [A]);

      const plan = service.buildReorgPlan(B, 50);
      expect(plan).not.toBeNull();
      expect(plan!.forkPoint).toBeNull(); // initial plan
      expect(plan!.toUnconfirm).toEqual([]);
      expect(plan!.toConfirm).toEqual([G, A, B]); // genesis -> tip
    });

    it('returns null when fork point is below reorg floor', () => {
      const db = getDb();
      // Current canonical: G -> A -> B (tip, score 100)
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(0, G);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, A);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(2, B);
      service.saveScore(B, 100);

      // Competing: G -> A -> D (tip, score 200)
      insertPost(G, []);
      insertPost(A, [G]);
      insertPost(B, [A]);
      insertPost(D, [A]);
      service.saveScore(D, 200);

      // Set reorg floor to depth 2 — fork is at depth 1 (A), which is below floor
      setReorgFloor(2);

      const plan = service.buildReorgPlan(D, 200);
      expect(plan).toBeNull();

      // Cleanup: reset floor
      setReorgFloor(0);
    });

    it('allows reorg when fork point is at or above reorg floor', () => {
      const db = getDb();
      // Current canonical: G -> A -> B (tip, score 100)
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(0, G);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, A);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(2, B);
      service.saveScore(B, 100);

      // Competing: G -> A -> D (tip, score 200)
      insertPost(G, []);
      insertPost(A, [G]);
      insertPost(B, [A]);
      insertPost(D, [A]);
      service.saveScore(D, 200);

      // Set reorg floor to depth 1 — fork is at depth 1 (A), which equals floor
      setReorgFloor(1);

      const plan = service.buildReorgPlan(D, 200);
      expect(plan).not.toBeNull();
      expect(plan!.forkPoint).toBe(A);

      // Cleanup: reset floor
      setReorgFloor(0);
    });
  });

  // -----------------------------------------------------------------------
  // switchToBranch
  // -----------------------------------------------------------------------

  describe('switchToBranch', () => {
    it('inserts initial branch from depth 0', () => {
      insertPost(G, []);
      insertPost(A, [G]);
      insertPost(B, [A]);

      const plan = service.buildReorgPlan(B, 50);
      expect(plan).not.toBeNull();

      service.switchToBranch(plan!);

      const tip = service.getCurrentTip();
      expect(tip).not.toBeNull();
      expect(tip!.postId).toBe(B);
      expect(tip!.depth).toBe(2);

      // Verify all entries
      const db = getDb();
      const rows = db
        .prepare('SELECT depth, post_id FROM canonical_branch ORDER BY depth ASC')
        .all() as Array<{ depth: number; post_id: string }>;
      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual({ depth: 0, post_id: G });
      expect(rows[1]).toEqual({ depth: 1, post_id: A });
      expect(rows[2]).toEqual({ depth: 2, post_id: B });

      // Verify dag_tip_hash — stored as raw bytes decoded from hex post ID
      const meta = db
        .prepare("SELECT value FROM dag_meta WHERE key = 'dag_tip_hash'")
        .get() as { value: Buffer } | undefined;
      expect(meta).toBeDefined();
      expect(meta!.value.toString('hex')).toBe(B);
    });

    it('executes a reorg by removing old branch and inserting new', () => {
      const db = getDb();

      // Set up current canonical: G -> A -> B -> C
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(0, G);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, A);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(2, B);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(3, C);
      service.saveScore(C, 100);

      // DAG with fork: G -> A -> X -> Y (new branch, higher score)
      insertPost(G, []);
      insertPost(A, [G]);
      insertPost(B, [A]);
      insertPost(C, [B]);
      insertPost(X, [A]);
      insertPost(Y, [X]);
      service.saveScore(Y, 200);

      const plan = service.buildReorgPlan(Y, 200);
      expect(plan).not.toBeNull();
      expect(plan!.forkPoint).toBe(A);

      service.switchToBranch(plan!);

      // Verify branch: G -> A -> X -> Y
      const rows = db
        .prepare('SELECT depth, post_id FROM canonical_branch ORDER BY depth ASC')
        .all() as Array<{ depth: number; post_id: string }>;
      expect(rows).toHaveLength(4);
      expect(rows[0]).toEqual({ depth: 0, post_id: G });
      expect(rows[1]).toEqual({ depth: 1, post_id: A });
      expect(rows[2]).toEqual({ depth: 2, post_id: X });
      expect(rows[3]).toEqual({ depth: 3, post_id: Y });

      // B and C are no longer on the canonical branch
      expect(service.getCanonicalDepth(B)).toBeNull();
      expect(service.getCanonicalDepth(C)).toBeNull();

      // dag_tip_hash updated
      const meta = db
        .prepare("SELECT value FROM dag_meta WHERE key = 'dag_tip_hash'")
        .get() as { value: Buffer } | undefined;
      expect(meta).toBeDefined();
      expect(meta!.value.toString('hex')).toBe(Y);
    });

    it('is atomic — partial failure does not leave partial state', () => {
      const db = getDb();
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(0, G);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, A);

      // Plan with forkPoint that is NOT in canonical_branch
      const badPlan = {
        forkPoint: 'ff'.repeat(32),
        toUnconfirm: [A],
        toConfirm: [X],
      };

      expect(() => service.switchToBranch(badPlan)).toThrow();

      // Verify canonical_branch is unchanged
      const rows = db
        .prepare('SELECT depth, post_id FROM canonical_branch ORDER BY depth ASC')
        .all() as Array<{ depth: number; post_id: string }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].post_id).toBe(G);
      expect(rows[1].post_id).toBe(A);
    });
  });
});
