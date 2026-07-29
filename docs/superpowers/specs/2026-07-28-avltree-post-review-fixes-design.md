# AVL State Root — Post-Review Fixes

**Date:** 2026-07-28
**Status:** design
**Scope:** Fixes for final whole-branch review findings

## Fix 1: Fork Resolution AVL Rollback (Critical)

**Problem:** `reorg()` in `fork-resolution.ts` reverts UTXO state block-by-block
but never rolls back the AVL prover. When the new chain is applied in Phase 3,
`applyOrderingBlock` calls `applyBlockMutations` on the prover from the old
(invalid) tip height, producing a permanently divergent state root.

**Fix:** After Phase 1 (revert blocks) and before Phase 3 (apply new chain),
roll back the prover to the fork-point version:

```ts
const avlHandle = tryGetAvlProver();
if (avlHandle) {
  const version = avlHandle.storage.versionAtOrBeforeHeight(forkHeight);
  if (version) avlHandle.prover.rollback(version);
}
```

Uses `tryGetAvlProver()` (not `getAvlProver()`) for graceful degradation when
the prover isn't initialized. Uses `versionAtOrBeforeHeight` (renamed from
`versionAtHeight` per issue 6 below) to find the version at the fork point.

## Fix 2: Prover Rollback on stateRoot Verification Failure (Important)

**Problem:** In `applyOrderingBlock`, `applyBlockMutations()` mutates the
prover before the `verifyStateRoot` check. If verification is enabled and
detects a mismatch, the function returns `false` but the prover is left in
a corrupted state.

**Fix:** Snapshot the pre-mutation digest, rollback on failure:

```ts
const preMutationDigest = handle.prover.digest();
const computedDigest = applyBlockMutations(handle.prover, [...allConsumed], allCreated);

if (config.verifyStateRoot) {
  const expectedHex = Buffer.from(computedDigest).toString('hex');
  if (block.header.stateRoot !== expectedHex) {
    console.warn(`stateRoot mismatch at height ${block.header.height}`);
    handle.prover.rollback(preMutationDigest!);
    currentJournal = null;
    return false;
  }
}
```

## Fix 3: maxProofHistory Version Pruning (Important)

**Problem:** `maxProofHistory` config is parsed (default 1440) but never
consumed. AVL versions accumulate without bound in `avl_tree_versions`
and `avl_tree_nodes`.

**Fix:** After checkpointing a new version, prune versions older than the
retention window:

```ts
// In checkpointProver(), after generateProofAndUpdateStorage:
const cutoff = height - config.maxProofHistory;
if (cutoff > 0) {
  handle.storage.pruneVersionsBefore(cutoff);
}
```

Add `pruneVersionsBefore(cutoffHeight: number): void` to `SqliteAvlStorage`:
```sql
DELETE FROM avl_tree_nodes WHERE version IN (
  SELECT version FROM avl_tree_versions WHERE height < ?
);
DELETE FROM avl_tree_versions WHERE height < ?;
```

Two-step delete to handle FK cascade explicitly (better-sqlite3 requires it).
No orphaned nodes remain because all nodes for pruned versions are deleted first.

## Minor Cleanup

1. **Duplicate import** — remove line 13 `SqliteAvlStorage` import in `avl-prover.test.ts`
2. **Rename `versionAtHeight`** → `versionAtOrBeforeHeight` in `avl-storage.ts` and callers
3. **Validate `atHeight`** — add `Number.isInteger(atHeight) && atHeight >= 0` guard in endpoint, return 400 on invalid
4. **Remove unused fields** — drop `keyLength`/`valueLengthOpt` from `SqliteAvlStorage` constructor (interface `VersionedAVLStorage` doesn't require them)
5. **Warn on proof endpoint skip** — add `console.warn('AVL prover not initialized, /proof endpoint unavailable')` when `tryGetAvlProver()` returns null in server.ts

## Out of Scope

- Adding unit tests for `bootstrapAvlProver`, `encodeHeight`, `getAvlProver` (deferred — exercised by integration tests)
- `hexToBytes` input validation (all callers pass known-valid hex)
- `version[32]!` length guard (digest format is stable)
