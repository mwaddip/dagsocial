# AVL Post-Review Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 3 post-review findings (fork resolution AVL rollback, stateRoot verification rollback, version pruning) plus 5 minor cleanup items from the final whole-branch review.

**Architecture:** Three targeted fixes to existing files: add prover rollback in `reorg()`, add pre-mutation snapshot/restore in `applyOrderingBlock`, add version pruning in `checkpointProver` + `SqliteAvlStorage`. Minor cleanup in test and endpoint files.

**Tech Stack:** TypeScript, `better-sqlite3`, `@ergots/avltree@0.3.1`

## Global Constraints

- All existing tests must pass (839 non-E2E)
- Use `tryGetAvlProver()` (returns null) not `getAvlProver()` (throws) for backward compat
- Follow existing patterns: config via env vars, SQLite via `better-sqlite3`
- No changes to `packages/types`

---

### Task 1: Fork resolution AVL rollback + stateRoot verification rollback

**Files:**
- Modify: `packages/node/src/services/fork-resolution.ts:124-172`
- Modify: `packages/node/src/services/block-apply.ts` — around the AVL prover step added in Task 5

**Interfaces:**
- Consumes: `tryGetAvlProver` from `../state/avl-prover.js`
- Consumes: `versionAtOrBeforeHeight` from `./avl-storage.js` (renamed per Task 4)

- [ ] **Step 1: Add AVL prover rollback in reorg()**

In `packages/node/src/services/fork-resolution.ts`, add import:

```ts
import { tryGetAvlProver } from '../state/avl-prover.js';
```

In `reorg()`, after Phase 1 (line 141, after the `revertBlock(h)` loop closes) and before Phase 2, add:

```ts
// Phase 1b: roll back AVL prover to fork point
const avlHandle = tryGetAvlProver();
if (avlHandle) {
  const version = avlHandle.storage.versionAtOrBeforeHeight(forkHeight);
  if (version) {
    avlHandle.prover.rollback(version);
  }
}
```

- [ ] **Step 2: Add prover rollback on stateRoot verification failure in block-apply.ts**

In `packages/node/src/services/block-apply.ts`, find the AVL prover step added in Task 5 (search for `applyBlockMutations`). Replace the block with:

```ts
// AVL state root update
const handle = tryGetAvlProver();
if (handle) {
  // Snapshot pre-mutation digest for rollback on verification failure
  const preMutationDigest = handle.prover.digest();

  // Collect all consumed box IDs
  const allConsumed = new Set(currentJournal.consumedBoxIds);

  // Collect all created boxes (by box ID, fetch from store)
  const allCreated: AnyBox[] = [];
  for (const boxId of currentJournal.createdBoxIds) {
    const box = getBox(boxId);
    if (box) allCreated.push(box);
  }

  // Apply to prover
  const computedDigest = applyBlockMutations(
    handle.prover,
    [...allConsumed],
    allCreated,
  );

  // Verify against block header (gated)
  if (config.verifyStateRoot) {
    const expectedHex = Buffer.from(computedDigest).toString('hex');
    if (block.header.stateRoot !== expectedHex) {
      console.warn(
        `stateRoot mismatch at height ${block.header.height}: ` +
        `computed=${expectedHex.slice(0, 16)}... ` +
        `header=${block.header.stateRoot.slice(0, 16)}...`,
      );
      // Roll back prover to pre-mutation state
      if (preMutationDigest) {
        handle.prover.rollback(preMutationDigest);
      }
      currentJournal = null;
      return false;
    }
  }

  // Checkpoint
  checkpointProver(handle, block.header.height);
}
```

- [ ] **Step 3: Run tests**

```bash
pnpm build && pnpm test
```

Expected: All 839 non-E2E tests pass. 2 pre-existing E2E flakes unrelated.

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/services/fork-resolution.ts packages/node/src/services/block-apply.ts
git commit -m "fix(state): add AVL prover rollback in fork resolution and stateRoot verification"
```

---

### Task 2: maxProofHistory version pruning

**Files:**
- Modify: `packages/node/src/state/avl-storage.ts` — add `pruneVersionsBefore()`
- Modify: `packages/node/src/state/avl-prover.ts` — call pruning in `checkpointProver()`

**Interfaces:**
- Produces: `SqliteAvlStorage.pruneVersionsBefore(cutoffHeight: number): void`
- Consumes: `config.maxProofHistory` from `../config.js`

- [ ] **Step 1: Add pruneVersionsBefore() to SqliteAvlStorage**

In `packages/node/src/state/avl-storage.ts`, add method to the class:

```ts
pruneVersionsBefore(cutoffHeight: number): void {
  const transaction = this.db.transaction(() => {
    // Delete nodes first (FK to versions)
    this.db.prepare(
      'DELETE FROM avl_tree_nodes WHERE version IN ' +
      '(SELECT version FROM avl_tree_versions WHERE height < ?)',
    ).run(cutoffHeight);
    // Delete versions
    this.db.prepare(
      'DELETE FROM avl_tree_versions WHERE height < ?',
    ).run(cutoffHeight);
  });
  transaction();
}
```

Update the class's public API declaration — add `pruneVersionsBefore` to the visible methods (it's already a class method, just need to ensure it's accessible to callers).

- [ ] **Step 2: Call pruning in checkpointProver()**

In `packages/node/src/state/avl-prover.ts`, modify `checkpointProver()`:

```ts
import { config } from '../config.js';

export function checkpointProver(
  handle: AvlProverHandle,
  height: number,
): void {
  handle.prover.generateProofAndUpdateStorage([
    [HEIGHT_SENTINEL, encodeHeight(height)],
  ]);

  // Prune versions older than the retention window
  const cutoff = height - config.maxProofHistory;
  if (cutoff > 0) {
    handle.storage.pruneVersionsBefore(cutoff);
  }
}
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @dagsocial/node test -- test/state/avl-storage.test.ts test/state/avl-prover.test.ts
```

Expected: All AVL tests pass. No regressions.

- [ ] **Step 4: Add pruning test**

Add to `packages/node/test/state/avl-storage.test.ts`:

```ts
it('pruneVersionsBefore() deletes old versions and their nodes', () => {
  const storage = new SqliteAvlStorage(db, 32, null);
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
  const db = (storage as any).db as Database.Database;
  const orphanCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM avl_tree_nodes WHERE version NOT IN (SELECT version FROM avl_tree_versions)',
  ).get() as { cnt: number };
  expect(orphanCount.cnt).toBe(0);
});
```

- [ ] **Step 5: Commit**

```bash
git add packages/node/src/state/avl-storage.ts packages/node/src/state/avl-prover.ts packages/node/test/state/avl-storage.test.ts
git commit -m "feat(state): add maxProofHistory version pruning to AVL storage"
```

---

### Task 3: Minor cleanup (imports, names, validation)

**Files:**
- Modify: `packages/node/test/state/avl-prover.test.ts` — remove duplicate import
- Modify: `packages/node/src/state/avl-storage.ts` — rename `versionAtHeight` → `versionAtOrBeforeHeight`
- Modify: `packages/node/src/state/avl-endpoint.ts` — validate `atHeight`, rename call
- Modify: `packages/node/src/server.ts` — add warn when prover is null

**Interfaces:**
- Produces: `versionAtOrBeforeHeight(maxHeight: number): Uint8Array | null` (renamed from `versionAtHeight`)

- [ ] **Step 1: Remove duplicate import**

In `packages/node/test/state/avl-prover.test.ts`, delete line with the second `import { SqliteAvlStorage }` (search for duplicate — line ~13 in the diff from Task 5).

- [ ] **Step 2: Rename versionAtHeight → versionAtOrBeforeHeight**

In `packages/node/src/state/avl-storage.ts`, rename the method and update the JSDoc:

```ts
/**
 * Return the version digest at or before the given block height.
 * Returns the version with the highest height <= maxHeight, or null if none.
 */
versionAtOrBeforeHeight(maxHeight: number): Uint8Array | null {
  const row = this.db
    .prepare('SELECT version FROM avl_tree_versions WHERE height <= ? ORDER BY height DESC LIMIT 1')
    .get(maxHeight) as { version: Buffer } | undefined;
  return row ? new Uint8Array(row.version) : null;
}
```

Update the call site in `packages/node/src/state/avl-endpoint.ts` — change `versionAtHeight` to `versionAtOrBeforeHeight` in the historical proof lookup path.

- [ ] **Step 3: Validate atHeight in proof endpoint**

In `packages/node/src/state/avl-endpoint.ts`, after parsing `atHeight`:

```ts
const atHeight = req.query['atHeight']
  ? parseInt(req.query['atHeight'] as string, 10)
  : null;

// Validate atHeight if provided
if (atHeight !== null && (!Number.isInteger(atHeight) || atHeight < 0)) {
  res.status(400).json({ error: 'atHeight must be a non-negative integer' });
  return;
}
```

- [ ] **Step 4: Add warn when proof endpoint is skipped**

In `packages/node/src/server.ts`, where the proof endpoint is conditionally registered:

```ts
const proverHandle = tryGetAvlProver();
if (proverHandle) {
  registerProofEndpoint(app, proverHandle);
} else {
  console.warn('AVL prover not initialized — /api/v1/proof endpoint unavailable');
}
```

- [ ] **Step 5: Remove unused keyLength/valueLengthOpt fields from SqliteAvlStorage**

In `packages/node/src/state/avl-storage.ts`, remove the `keyLength` and `valueLengthOpt` fields from the class body and constructor (lines ~15-16, ~26-28). They're stored but never read. The `VersionedAVLStorage` interface doesn't require them.

- [ ] **Step 6: Run tests**

```bash
pnpm build && pnpm test
```

Expected: All 839 non-E2E tests pass. Typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/node/test/state/avl-prover.test.ts packages/node/src/state/avl-storage.ts packages/node/src/state/avl-endpoint.ts packages/node/src/server.ts
git commit -m "chore(state): minor AVL cleanup — rename, validate, remove dead code"
```
