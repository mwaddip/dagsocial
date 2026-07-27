# DagService Integration & On-Chain Prune Commits — Design

**Date:** 2026-07-27
**Status:** draft
**Scope:** `@dagsocial/types`, `@dagsocial/net`, `@dagsocial/node`

Two independent subsystems, designed together because both touch `block-apply.ts`
and `block-creator.ts`.

---

## Gap 1: DagService Integration

### Problem

`DagService` is fully implemented and tested (20+ test cases) but has zero
production call sites. `applyOrderingBlock` confirms sub-blocks but never
computes DAG scores or populates the canonical branch. The `post_scores` and
`canonical_branch` tables exist but are never written to in production. Reorgs
(`buildReorgPlan` / `switchToBranch`) are hardened but never invoked.

### Design

**Score model:** Uniform weight — every confirmed post gets `ownWork = 1`.
Cumulative score = max(parent scores, 0) + 1. A root post (no parents) gets
score = 1. A reply to a root post gets score = 2. The DAG tip with the most
confirmed descendants wins.

**Injection point:** New step in `applyOrderingBlock`, inserted after sub-block
confirmation (existing step 10) and before UTXO processing (existing step 12).
Scores are computed before stump replay (Gap 2c) — a post confirmed in this
block is never pruned in the same block, so ordering doesn't create conflicts,
but the sequence is: confirm sub-blocks → scores + reorg → stump replay → UTXO.

```
for each entry in block.subBlockTree.subBlockEntries:
  parentScores = entry.parentRefs.map(id => dagService.getScore(id)).filter(Boolean)
  maxParent = max(parentScores, 0)
  score = maxParent + 1
  dagService.saveScore(entry.postId, score)
  track highest (score, postId) from this batch

if dagService and bestId:
  plan = dagService.buildReorgPlan(bestId, bestScore)
  if plan: dagService.switchToBranch(plan)
```

**DagService injection:** `applyOrderingBlock` gains a `dagService: DagService |
null` parameter. `null` only in tests. The server's `index.ts` instantiates
`DagService` once with the PostStore and threads it through.

**Why "all of them" as tip candidates:** Every confirmed sub-block gets scored.
The highest-scoring one from the batch is evaluated as the canonical tip
candidate. Non-leaves that briefly become tip are replaced next block when a
child confirms — uniform weight means children always outscore parents, so this
converges to leaves naturally.

### Error Handling

| Scenario | Behavior |
|---|---|
| Parent score missing (placeholder post, content not yet arrived) | `getScore` returns null, filtered out, treated as 0. Post gets score = 1. |
| `buildReorgPlan` returns null | Normal — this branch didn't beat the current tip. Silent. |
| `switchToBranch` throws | Caught, logged at error level. Block confirmation is not rolled back. Reorg retries next block. |
| `saveScore` fails (DB error) | Propagates — this is a structural failure, not a logic error. |

### Files Changed

| File | Change |
|---|---|
| `packages/node/src/services/block-apply.ts` | Import DagService. New step 11 (score + reorg). DagService parameter. |
| `packages/node/src/index.ts` | Instantiate DagService, pass to `applyOrderingBlock`. |
| `packages/node/test/services/block-apply.test.ts` | Test score computation, null-DagService path. |

### What Doesn't Change

- `DagService` class — no changes. All methods, the reorg floor, toUnconfirm
  cross-check, and journal emission are already implemented and tested.
- Block confirmation logic — unchanged. Scores are computed *after* confirmation.
- Fork resolution — unchanged. Re-insertion by ID already works.
- Sync handler — unchanged.

---

## Gap 2: On-Chain Prune Commits

### Problem

`SubBlockTree.stumpIds` is committed in the Merkle root but always empty.
`executePrune` stores stumps in `dag_stumps` but never enqueues them for block
inclusion. Block application ignores `stumpIds`. No gossip path exists for
Stump objects — a syncing node has no way to learn about prunes.

### Design

Four components, matching the post content propagation pattern:

#### 2a. Mempool: Stump Entry Type

Extend the `mempool` table:
- `entry_type` CHECK: `IN ('subblock', 'utxo_tx', 'stump')`
- New column `stump_id TEXT` — NULL for non-stump rows

New store functions in `store/mempool.ts`:
- `insertMempoolStump(stumpId: string, expiresAtHeight: number): void`
- `drainMempoolStumps(limit: number): string[]` — oldest-first by rowid, removes drained rows
- `removeMempoolStumps(stumpIds: string[]): void` — for fork resolution teardown

Hook in `stump-engine.ts` (`executePrune`): after `pruneSubtree` commits inside
its transaction, call `insertMempoolStump(stumpId, currentHeight +
MEMPOOL_EXPIRY_BLOCKS)`.

#### 2b. Block Creator: Drain Stumps

`createOrderingBlock` populates `stumpIds` from the mempool instead of `[]`:

```typescript
stumpIds: drainMempoolStumps(MAX_STUMPS_PER_BLOCK),
```

`MAX_STUMPS_PER_BLOCK = 32` — arm's-length cap (same pattern as sub-blocks per
block). Dedup is inherent — a stump ID enters mempool at most once; if
`executePrune` is called again for the same root post, it fails at the "already
pruned" check before reaching mempool insert.

`computeSubBlockRoot` already hashes `stumpIds` into the Merkle root — no
changes needed there.

#### 2c. Block Application: Replay Prunes

New step in `applyOrderingBlock`, inserted after sub-block confirmation and
before UTXO processing:

```
for each stumpId in block.subBlockTree.stumpIds:
  stump = getStump(stumpId)
  if !stump:
    log warning, continue  // missing locally — backfill via content sweep
  if getPost(stump.rootPostHash)?.status === 'pruned':
    continue  // already pruned — skip duplicate stump
  pruneSubtree(stump.rootPostHash, stump)
```

`pruneSubtree` in `store/posts.ts` already handles the recursive subtree walk,
SQLite transaction boundary, and status updates. No changes needed there.

#### 2d. Gossip + Content Sweep (Push + Pull)

**Gossip (push):** After `executePrune` stores the stump and enqueues the ID,
call `net.broadcastStump(stump)`. New gossip topic for Stump objects.
Message-ID dedup prevents loops; topic validator checks structural validity
(`computeStumpId(stump)` must be a valid hex ID, root post must exist or be
known).

**Content sweep (pull):** Two new framed stream messages (same framing as
existing: `[magic:4][version:1][code:VLQ][length:VLQ][checksum:4][body]`):

| Code | Name | Body |
|---|---|---|
| 0x10 | `GetStumps` | `{ stumpIds: string[] }` |
| 0x11 | `Stumps` | `{ entries: { stumpId: string, stump: Stump }[] }` |

Content-sweep service extended with `sweepStumps(maxRetries)`:
- Query `ordering_blocks` for `stumpIds` referenced in blocks that are not
  present in `dag_stumps` (i.e., a block committed a stump the node hasn't
  received via gossip). Limit to recent blocks (last N heights) to avoid
  scanning the full chain on every sweep.
- Batch-request from peers, verify `computeStumpId(stump) === stumpId`
  before storing via `insertStump`, then replay the prune via `pruneSubtree`
- Triggers on sync-complete and peer-active (same hooks as post content sweep)

Defense:
- Responder validates stump IDs are 64-char hex before querying
- Max 100 IDs per `GetStumps` request
- Requester verifies `computeStumpId(stump) === stumpId` before storing
- Structural validation on gossip ingress (same as relay handler pattern)

#### 2e. Net Layer (`@dagsocial/net`)

New exports:
- `broadcastStump(stump: Stump): Promise<void>`
- `onStump(callback: (stump: Stump) => void): void`
- New gossip topic `dag-stump`
- Two new message codes (0x10, 0x11) in the framed stream protocol

### Files Changed

| File | Change |
|---|---|
| `packages/node/src/store/db.ts` | ALTER TABLE mempool: new CHECK, add stump_id column |
| `packages/node/src/store/mempool.ts` | New functions: insert/drain/remove for stumps |
| `packages/node/src/services/stump-engine.ts` | Hook: `insertMempoolStump` after prune, `broadcastStump` gossip |
| `packages/node/src/services/block-creator.ts` | Drain stumps from mempool, populate `stumpIds` |
| `packages/node/src/services/block-apply.ts` | New step: replay prunes from `stumpIds` |
| `packages/node/src/services/content-sweep.ts` | Extend: `sweepStumps` with `GetStumps`/`Stumps` messages |
| `packages/net/src/` | New gossip topic, `broadcastStump`, message codec entries for 0x10/0x11 |
| `packages/types/src/` | No changes — Stump and StumpId types already exist |

### What Doesn't Change

- `SubBlockTree` interface — `stumpIds` field already exists
- `computeSubBlockRoot` — already hashes `stumpIds`
- `executePrune` / `pruneSubtree` — already complete and tested
- `dag_stumps` table — no schema change
- Block header — no change
- Like box / karma infrastructure — no change

---

## Test Plan

### DagService Integration
- Score computation: 3-sub-block block, each gets `max(parents) + 1`
- Root post (no parents): score = 1
- Placeholder parent: graceful fallback, score = 1
- Highest-scoring post from batch passed to `buildReorgPlan`
- Null DagService: score computation still runs, reorg evaluation skipped
- Integration: two blocks on competing branches, higher-scoring branch wins

### Prune Commits
- Mempool: insert/drain/remove stump IDs, expiry works
- Block creator: stumps drained into `stumpIds`, Merkle root includes them
- Block application: stump replayed, posts marked pruned; missing stump skipped
  gracefully; duplicate stump idempotent
- Gossip: `broadcastStump` called after executePrune; inbound stump validated
  and stored
- Content sweep: `GetStumps`/`Stumps` roundtrip; missing stumps backfilled;
  malformed response entries dropped
- Fork resolution: stumps from reverted blocks removed from mempool
- Integration: N1 prunes a subtree, mines a block. N2 syncs the block, fetches
  the missing Stump via content sweep, applies the prune — both nodes have
  identical DAG state.

### No Regressions
- Full test suite (types, validation, node) must pass
- Typecheck clean across all packages
- Build clean across all packages
