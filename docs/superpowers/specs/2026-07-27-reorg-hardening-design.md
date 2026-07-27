# Reorg Hardening — Design

**Date:** 2026-07-27
**Status:** approved
**Scope:** `DagService` in `@dagsocial/node`

Three deferred items from Phase 4 foundation hardening, all confined to
`packages/node/src/services/dag-service.ts` and its tests.

## 1. Journal Event — `dag_reorg` Emission

`emitDagReorg()` already exists in `journal.ts` with signature:
`(forkPoint: string, demoted: number, oldTip: string, newTip: string) => void`.

`switchToBranch()` calls it after the transaction commits, only for actual
reorgs (`forkPoint !== null`). The initial plan (no prior canonical branch) is
not a reorg and does not emit this event.

- `forkPoint`: from `plan.forkPoint`
- `demoted`: `plan.toUnconfirm.length`
- `oldTip`: queried before the transaction (current tip at method entry)
- `newTip`: last entry in `plan.toConfirm`, or `plan.forkPoint` if `toConfirm` is empty

## 2. `toUnconfirm` Cross-Check

`buildReorgPlan()` computes `toUnconfirm` as an explicit list via
`getBranchAbove(forkDepth)`. `switchToBranch()` currently ignores it and does
`DELETE FROM canonical_branch WHERE depth > forkDepth`.

**New behavior:** `switchToBranch()` uses `plan.toUnconfirm` as the deletion
source of truth, with the depth-based query as a verification oracle.

Algorithm:
1. Query `getBranchAbove(forkDepth)` — this is what depth-based deletion would remove.
2. Compare the two sets (order-independent). Throw if they diverge (length mismatch
   or ID mismatch).
3. Delete using explicit IDs: `DELETE FROM canonical_branch WHERE post_id = ?`
   for each entry in `plan.toUnconfirm`.

All three steps happen inside the existing `db.transaction()`.

If the sets diverge, the error message includes both lists so the operator can
diagnose the corruption.

## 3. Reorg Floor

**Storage:** New key `reorg_floor` in `dag_meta`, stored as a decimal string
(consistent with `schema_version`). Defaults to `0` (no floor).

**Read helper:** `getReorgFloor()` in `meta.ts` — reads the key, parses as
integer, returns `0` if absent.

**Check in `buildReorgPlan()`:** After finding the fork point and its depth,
if `forkDepth < reorgFloor`, return null. The reorg is silently rejected
(the new branch's tip sits in the DAG but never becomes canonical).

**Check in `switchToBranch()`:** Same gate as a second line of defense.
Throws if `forkDepth < reorgFloor` (shouldn't happen if `buildReorgPlan`
already checked, but this is defense-in-depth).

**Initial plan bypass:** When `forkPoint === null` (no canonical branch
exists), the floor is not checked — this is genesis, not a reorg.

**Future:** Snapshot infrastructure will set a non-zero `reorg_floor` when
the node bootstraps from a snapshot at depth D. That work is deferred to a
separate session.

## What Doesn't Change

- `buildReorgPlan()` already computes `toUnconfirm` correctly via `getBranchAbove()`.
- `emitDagReorg()` already has the right signature.
- `dag_meta` already supports arbitrary key-value pairs.
- No new tables, no schema migration.
- `DagService` still has zero production call sites — this is infrastructure
  hardening for when the reorg path gets wired into block processing.

## Test Plan

All changes are in `DagService` methods; tests go in `dag-service.test.ts`.

- **Journal:** Verify `emitDagReorg` is called on reorg (mock or spy on
  journal import). Verify not called for initial plan.
- **toUnconfirm cross-check:** Test that depth-based and list-based agree
  (existing reorg tests cover this implicitly). Add a test where they
  diverge — manually corrupt `canonical_branch` before `switchToBranch`,
  verify it throws.
- **Reorg floor:** Test rejection when `forkDepth < reorgFloor`. Test
  acceptance when `forkDepth >= reorgFloor`. Test that initial plan
  bypasses the floor. Test default (no key set) allows all reorgs.
- **meta.ts:** Test `getReorgFloor()` with set, unset, and non-numeric values.
