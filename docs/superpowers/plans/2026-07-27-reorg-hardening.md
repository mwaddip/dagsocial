# Reorg Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden DagService reorg path: emit journal events, cross-check toUnconfirm against depth-based deletion, implement reorg floor.

**Architecture:** Three self-contained changes to existing files. `meta.ts` gains reorg floor read/write helpers (binary uint32, matching `schema_version`). `buildReorgPlan()` rejects reorgs below the floor. `switchToBranch()` cross-checks `toUnconfirm` against depth-based query, emits `dag_reorg` on actual reorgs, and has a second floor gate.

**Tech Stack:** TypeScript, better-sqlite3, vitest

## Global Constraints

- All changes confined to `packages/node/src/store/meta.ts`, `packages/node/src/services/dag-service.ts`, and their test files
- `reorg_floor` stored as 4-byte LE uint32 BLOB in `dag_meta` (same encoding as `schema_version`)
- Reorg floor defaults to `0` (no floor) when key is absent
- Initial plans (`forkPoint === null`) bypass the floor — only actual reorgs are gated
- `switchToBranch` must remain atomic (single `db.transaction()`)
- No new tables, no schema version bump

---

### Task 1: Reorg Floor Storage Helpers in meta.ts

**Files:**
- Modify: `packages/node/src/store/meta.ts`
- Modify: `packages/node/test/store/meta.test.ts`

**Interfaces:**
- Consumes: `metaGet`, `metaPut` (already defined in meta.ts), `getDb` (from db.ts)
- Produces: `getReorgFloor(): number`, `setReorgFloor(depth: number): void`

- [ ] **Step 1: Add `getReorgFloor()` and `setReorgFloor()` to `meta.ts`**

Add after the `writeSchemaVersion` function (line 61):

```typescript
/**
 * Read the reorg floor from dag_meta. Returns 0 if not set.
 * Encoded as 4-byte LE uint32, same as schema_version.
 */
export function getReorgFloor(): number {
  const bytes = metaGet('reorg_floor');
  if (!bytes || bytes.length < 4) return 0;
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
}

/**
 * Write the reorg floor to dag_meta. Set to 0 to disable.
 */
export function setReorgFloor(depth: number): void {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, depth, true);
  metaPut('reorg_floor', new Uint8Array(buf));
}
```

- [ ] **Step 2: Write tests in `meta.test.ts`**

Add a new `describe('reorg floor', () => { ... })` block after the existing `describe('schema version startup', ...)` block. The tests need to import `getReorgFloor` and `setReorgFloor`.

```typescript
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
```

Update the import line at the top of the file to include `getReorgFloor` and `setReorgFloor`:

```typescript
import { metaGet, metaPut, schemaVersion, getReorgFloor, setReorgFloor, CURRENT_SCHEMA_VERSION } from '../../src/store/meta.js';
```

- [ ] **Step 3: Run tests to verify**

```bash
pnpm --filter @dagsocial/node test -- --run test/store/meta.test.ts
```
Expected: 9 tests pass (5 existing + 4 new).

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/store/meta.ts packages/node/test/store/meta.test.ts
git commit -m "feat(node): add reorg floor storage helpers to meta.ts"
```

---

### Task 2: Reorg Floor Check in buildReorgPlan

**Files:**
- Modify: `packages/node/src/services/dag-service.ts`
- Modify: `packages/node/test/services/dag-service.test.ts`

**Interfaces:**
- Consumes: `getReorgFloor()` from `meta.ts` (Task 1), `DagService.buildReorgPlan()`, `DagService.getCurrentTip()`, `DagService.findForkPoint()`, `DagService.getCanonicalDepth()`
- Produces: Updated `buildReorgPlan()` that returns `null` when `forkDepth < reorgFloor`

- [ ] **Step 1: Add floor check to `buildReorgPlan()`**

In `dag-service.ts`, add the import at the top:

```typescript
import { getReorgFloor } from '../store/meta.js';
```

In `buildReorgPlan()`, after the fork depth lookup (line 278, after `if (forkDepth === null) return null`), add:

```typescript
    // Reorg floor: reject reorgs below the floor depth
    const floor = getReorgFloor();
    if (forkDepth < floor) {
      return null;
    }
```

Full context — the method should now read (lines 254-291):

```typescript
  buildReorgPlan(newTipId: string, newTipScore: number): DagReorgPlan | null {
    const currentTip = this.getCurrentTip();
    if (!currentTip) {
      return this.buildInitialPlan(newTipId);
    }

    // Strictly greater score required
    if (newTipScore <= currentTip.score) {
      return null;
    }

    // Find common ancestor
    const forkPoint = this.findForkPoint(currentTip.postId, newTipId);
    if (!forkPoint) {
      return null;
    }

    const forkDepth = this.getCanonicalDepth(forkPoint);
    if (forkDepth === null) {
      return null;
    }

    // Reorg floor: reject reorgs below the floor depth
    const floor = getReorgFloor();
    if (forkDepth < floor) {
      return null;
    }

    // Posts to remove: current canonical branch above fork point
    const toUnconfirm = this.getBranchAbove(forkDepth);

    // Posts to add: walk from newTip back to fork point
    const toConfirm = this.walkToAncestor(newTipId, forkPoint);
    if (toConfirm.length === 0 && newTipId !== forkPoint) {
      return null;
    }

    return { forkPoint, toUnconfirm, toConfirm };
  }
```

- [ ] **Step 2: Add test for floor rejection**

Add a new test inside the `describe('buildReorgPlan', ...)` block in `dag-service.test.ts`, before the closing `});` of that describe block:

```typescript
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
```

Update the import line at the top of `dag-service.test.ts` (line 3) to include `setReorgFloor`:

```typescript
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import { setReorgFloor } from '../../src/store/meta.js';
import { DagService } from '../../src/services/dag-service.js';
import { SqlitePostStore } from '../../src/store/sqlite-store.js';
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @dagsocial/node test -- --run test/services/dag-service.test.ts
```
Expected: 24 tests pass (22 existing + 2 new).

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/services/dag-service.ts packages/node/test/services/dag-service.test.ts
git commit -m "feat(node): add reorg floor check to buildReorgPlan"
```

---

### Task 3: Harden switchToBranch — Cross-Check, Journal, Floor Gate

**Files:**
- Modify: `packages/node/src/services/dag-service.ts`
- Modify: `packages/node/test/services/dag-service.test.ts`

**Interfaces:**
- Consumes: `emitDagReorg` from `journal.ts`, `getReorgFloor` from `meta.ts` (Task 1), `DagReorgPlan`, updated `buildReorgPlan` (Task 2)
- Produces: Updated `switchToBranch()` with cross-check, journal emission, and floor gate

- [ ] **Step 1: Update imports in `dag-service.ts`**

Add journal and floor imports at the top:

```typescript
import { emitDagReorg } from '../journal.js';
import { getReorgFloor } from '../store/meta.js';
```

- [ ] **Step 2: Rewrite `switchToBranch()` with cross-check, floor gate, and journal**

Replace the existing `switchToBranch` method (lines 366-419) with:

```typescript
  /**
   * Switch the canonical branch atomically.
   *
   * Either the in-memory view AND the store both switch, or neither does.
   * The canonical_branch table is updated inside a single transaction:
   *   1. Cross-check: verify plan.toUnconfirm matches depth-based query
   *   2. Floor gate: reject reorg below reorg_floor
   *   3. Remove old branch entries using plan.toUnconfirm (explicit IDs)
   *   4. Insert new branch entries starting at forkDepth + 1
   *   5. Update dag_tip_hash in dag_meta
   *
   * Emits dag_reorg journal event for actual reorgs (forkPoint !== null).
   *
   * If forkPoint is null (initial plan), the entire branch is inserted from
   * depth 0.
   */
  switchToBranch(plan: DagReorgPlan): void {
    const db = getDb();

    // Snapshot current tip for journal event (before transaction)
    const oldTip = this.getCurrentTip();

    db.transaction(() => {
      if (plan.forkPoint !== null) {
        // Reorg: unwind above fork point, then insert new branch
        const forkDepth = this.getCanonicalDepth(plan.forkPoint);
        if (forkDepth === null) {
          throw new Error(
            `Fork point ${plan.forkPoint} not found in canonical_branch`,
          );
        }

        // Floor gate: second line of defense
        const floor = getReorgFloor();
        if (forkDepth < floor) {
          throw new Error(
            `Reorg rejected: fork depth ${forkDepth} is below reorg floor ${floor}`,
          );
        }

        // Cross-check: verify plan.toUnconfirm matches depth-based query
        const depthBased = this.getBranchAbove(forkDepth);
        const planSet = new Set(plan.toUnconfirm);
        const depthSet = new Set(depthBased);
        if (planSet.size !== depthSet.size) {
          throw new Error(
            `toUnconfirm mismatch: plan has ${plan.toUnconfirm.length} posts, ` +
            `depth-based query has ${depthBased.length} posts. ` +
            `plan: [${plan.toUnconfirm.join(', ')}], ` +
            `depth: [${depthBased.join(', ')}]`,
          );
        }
        for (const id of planSet) {
          if (!depthSet.has(id)) {
            throw new Error(
              `toUnconfirm mismatch: post ${id} in plan but not in depth-based query. ` +
              `plan: [${plan.toUnconfirm.join(', ')}], ` +
              `depth: [${depthBased.join(', ')}]`,
            );
          }
        }

        // 1. Remove old branch entries using explicit IDs from the plan
        const deleteStmt = db.prepare(
          'DELETE FROM canonical_branch WHERE post_id = ?',
        );
        for (const postId of plan.toUnconfirm) {
          deleteStmt.run(postId);
        }

        // 2. Insert new branch entries
        const insertStmt = db.prepare(
          'INSERT OR REPLACE INTO canonical_branch (depth, post_id) VALUES (?, ?)',
        );
        for (let i = 0; i < plan.toConfirm.length; i++) {
          insertStmt.run(forkDepth + 1 + i, plan.toConfirm[i]!);
        }

        // 3. Update dag_tip_hash
        const newTip =
          plan.toConfirm.length > 0
            ? plan.toConfirm[plan.toConfirm.length - 1]!
            : plan.forkPoint!;
        db.prepare(
          'INSERT OR REPLACE INTO dag_meta (key, value) VALUES (?, ?)',
        ).run('dag_tip_hash', Buffer.from(newTip, 'hex'));
      } else {
        // Initial plan: insert from depth 0
        db.prepare('DELETE FROM canonical_branch').run();

        const insertStmt = db.prepare(
          'INSERT OR REPLACE INTO canonical_branch (depth, post_id) VALUES (?, ?)',
        );
        for (let i = 0; i < plan.toConfirm.length; i++) {
          insertStmt.run(i, plan.toConfirm[i]!);
        }

        const newTip = plan.toConfirm[plan.toConfirm.length - 1]!;
        db.prepare(
          'INSERT OR REPLACE INTO dag_meta (key, value) VALUES (?, ?)',
        ).run('dag_tip_hash', Buffer.from(newTip, 'hex'));
      }
    })();

    // Emit journal event after transaction commits (only for actual reorgs)
    if (plan.forkPoint !== null) {
      const newTip =
        plan.toConfirm.length > 0
          ? plan.toConfirm[plan.toConfirm.length - 1]!
          : plan.forkPoint!;
      emitDagReorg(
        plan.forkPoint,
        plan.toUnconfirm.length,
        oldTip?.postId ?? 'unknown',
        newTip,
      );
    }
  }
```

Key changes from the original:
1. `oldTip` is captured before the transaction (for journal).
2. Floor gate added inside the transaction (throws if violated).
3. Cross-check: `getBranchAbove(forkDepth)` compared against `plan.toUnconfirm` as sets — throws on mismatch with both lists in the error message.
4. Deletion uses explicit post IDs (`WHERE post_id = ?`) instead of `WHERE depth > ?`.
5. `emitDagReorg` called after the transaction commits, only for actual reorgs.

- [ ] **Step 3: Update existing tests**

The existing `'is atomic'` test passes a bad plan directly to `switchToBranch` — it should still work since the fork point lookup will throw before reaching the cross-check. No changes needed.

The existing `'executes a reorg'` test needs no changes — it builds a real plan and switches, which should still work correctly.

- [ ] **Step 4: Add new tests in `dag-service.test.ts`**

Add these tests inside the `describe('switchToBranch', ...)` block:

```typescript
    it('throws when toUnconfirm diverges from depth-based query', () => {
      const db = getDb();
      // Set up current canonical: G -> A -> B -> C
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(0, G);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, A);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(2, B);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(3, C);
      service.saveScore(C, 100);

      // DAG with fork
      insertPost(G, []);
      insertPost(A, [G]);
      insertPost(B, [A]);
      insertPost(C, [B]);
      insertPost(X, [A]);
      insertPost(Y, [X]);
      service.saveScore(Y, 200);

      const plan = service.buildReorgPlan(Y, 200);
      expect(plan).not.toBeNull();

      // Corrupt the plan: add a post that isn't actually above the fork
      const corruptedPlan = {
        ...plan!,
        toUnconfirm: [...plan!.toUnconfirm, 'ff'.repeat(32)],
      };

      expect(() => service.switchToBranch(corruptedPlan)).toThrow(
        /toUnconfirm mismatch/,
      );
    });

    it('throws when reorg floor is violated (second gate)', () => {
      const db = getDb();
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(0, G);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, A);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(2, B);
      service.saveScore(B, 100);

      insertPost(G, []);
      insertPost(A, [G]);
      insertPost(B, [A]);
      insertPost(D, [A]);
      service.saveScore(D, 150);

      // Set floor above fork depth
      setReorgFloor(5);

      // buildReorgPlan should already reject this
      const plan = service.buildReorgPlan(D, 150);
      expect(plan).toBeNull();

      // But if someone calls switchToBranch directly with a plan that
      // violates the floor, it should throw
      const badPlan = {
        forkPoint: A,
        toUnconfirm: [B],
        toConfirm: [D],
      };

      expect(() => service.switchToBranch(badPlan)).toThrow(
        /below reorg floor/,
      );

      // Cleanup
      setReorgFloor(0);
    });
```

- [ ] **Step 5: Add journal emission tests**

Add these tests inside `describe('switchToBranch', ...)`. Add the import at the top of the test file:

```typescript
import { vi } from 'vitest';
import * as journal from '../../src/journal.js';
```

```typescript
    it('emits dag_reorg journal event on reorg', () => {
      const spy = vi.spyOn(journal, 'emitDagReorg');

      const db = getDb();
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(0, G);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, A);
      db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(2, B);
      service.saveScore(B, 100);

      insertPost(G, []);
      insertPost(A, [G]);
      insertPost(B, [A]);
      insertPost(D, [A]);
      service.saveScore(D, 150);

      const plan = service.buildReorgPlan(D, 150);
      expect(plan).not.toBeNull();

      service.switchToBranch(plan!);

      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith(A, 1, B, D);

      spy.mockRestore();
    });

    it('does not emit dag_reorg for initial plan', () => {
      const spy = vi.spyOn(journal, 'emitDagReorg');

      insertPost(G, []);
      insertPost(A, [G]);
      insertPost(B, [A]);

      const plan = service.buildReorgPlan(B, 50);
      expect(plan).not.toBeNull();
      expect(plan!.forkPoint).toBeNull();

      service.switchToBranch(plan!);

      expect(spy).not.toHaveBeenCalled();

      spy.mockRestore();
    });
```

- [ ] **Step 6: Run all dag-service tests**

```bash
pnpm --filter @dagsocial/node test -- --run test/services/dag-service.test.ts
```
Expected: 28 tests pass (24 from Task 2 + 4 new).

- [ ] **Step 7: Run full test suite**

```bash
pnpm test
```
Expected: all 622+ tests pass (1 pre-existing e2e flake may appear).

- [ ] **Step 8: Typecheck**

```bash
pnpm typecheck
```
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add packages/node/src/services/dag-service.ts packages/node/test/services/dag-service.test.ts
git commit -m "feat(node): harden switchToBranch with cross-check, journal emission, and floor gate"
```
