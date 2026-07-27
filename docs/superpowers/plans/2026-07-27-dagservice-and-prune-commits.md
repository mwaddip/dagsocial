# DagService Integration & On-Chain Prune Commits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire DagService into block application so DAG scores populate and reorgs execute. Then implement on-chain prune commits — queue stump IDs into mempool, include them in blocks, replay prunes during block application, and propagate Stump objects via gossip + content sweep.

**Architecture:** Gap 1 (DagService) touches 3 files: `block-apply.ts` gains a DagService parameter and a score+reorg step; `index.ts` instantiates and threads it. Gap 2 (prune commits) touches 10 files across 3 packages: mempool schema extended for stumps, block creator drains queued stump IDs, block application replays them, stump-engine enqueues+broadcasts, content-sweep backfills missing stumps, and the net layer gains a gossip topic + two framed stream messages.

**Tech Stack:** TypeScript, Node.js ≥ 22, SQLite (better-sqlite3), CBOR (cbor-x), libp2p gossipsub, vitest

## Global Constraints

- Post content: 1–300 UTF-8 bytes (`MAX_CONTENT_BYTES`). Parent refs: 0–8 per post
- Signatures: raw Ed25519 (64 bytes), base64 on wire. Verified with `crypto.verify(null, ...)` using a KeyObject
- Hashing: `blake2b512` with `.subarray(0, 32)` for all 32-byte outputs
- Wire format: CBOR (`cbor-x`). HTTP API: JSON
- Secret keys never in API responses or DTOs
- Protocol version on every post and block (`PROTOCOL_VERSION = 1`)
- All tests must pass; typecheck must be clean; build must be clean
- `ownWork = 1` for DagService scoring (uniform per-post weight)
- `MAX_STUMPS_PER_BLOCK = 32`
- Max 100 IDs per `GetStumps` request. Validated via `/^[0-9a-f]{64}$/` regex

---

## GAP 1: DagService Integration

### Task 1: Add DagService parameter to applyOrderingBlock

**Files:**
- Modify: `packages/node/src/services/block-apply.ts`

**Interfaces:**
- Consumes: `DagService` class from `./dag-service.js`
- Produces: `applyOrderingBlock(block: OrderingBlock, dagService?: DagService): boolean`

- [ ] **Step 1: Add import**

At line 7, after the existing `computeEpochTally` import, add:

```typescript
import { DagService } from './dag-service.js';
```

- [ ] **Step 2: Add dagService parameter**

Change the function signature at line 43 from:

```typescript
export function applyOrderingBlock(block: OrderingBlock): boolean {
```

To:

```typescript
export function applyOrderingBlock(block: OrderingBlock, dagService?: DagService): boolean {
```

- [ ] **Step 3: Verify it compiles**

```bash
cd packages/node && npx tsc --noEmit src/services/block-apply.ts 2>&1 | head -20
```

Expected: no new errors (may show project-level errors unrelated to this change).

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/services/block-apply.ts
git commit -m "feat(block-apply): add optional DagService parameter

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Add score computation and reorg evaluation step

**Files:**
- Modify: `packages/node/src/services/block-apply.ts`

**Interfaces:**
- Consumes: `dagService.saveScore(postId, score)`, `dagService.getScore(postId)`, `dagService.buildReorgPlan(tipId, tipScore)`, `dagService.switchToBranch(plan)`
- Produces: Step 11 in applyOrderingBlock — computes scores, evaluates tip, triggers reorg

- [ ] **Step 1: Insert score + reorg step**

After the mempool cleanup loop (lines 177–188 — the `entriesAfter` block that removes confirmed sub-blocks from local mempool) and before the epoch tally comment (line 190 — `// 8. Standalone like boxes are tallied...`), insert:

```typescript
  // 8. Compute DAG scores and evaluate canonical tip
  if (dagService) {
    let bestScore = 0;
    let bestId: string | null = null;

    for (const entry of block.subBlockTree.subBlockEntries) {
      let maxParent = 0;
      for (const pid of entry.parentRefs) {
        const ps = dagService.getScore(pid);
        if (ps !== null && ps > maxParent) {
          maxParent = ps;
        }
      }
      const score = maxParent + 1; // uniform weight: ownWork = 1
      dagService.saveScore(entry.postId, score);

      if (score > bestScore) {
        bestScore = score;
        bestId = entry.postId;
      }
    }

    if (bestId !== null) {
      try {
        const plan = dagService.buildReorgPlan(bestId, bestScore);
        if (plan) {
          dagService.switchToBranch(plan);
        }
      } catch (err) {
        console.error(`DagService reorg evaluation failed: ${String(err)}`);
      }
    }
  }
```

- [ ] **Step 2: Re-number existing comments**

The existing `// 8. Standalone like boxes...` comment (line 190) is now step 9 (or leave comments as-is — they're informal labels). No code changes needed, but confirm the flow reads correctly: confirm sub-blocks → scores + reorg → epoch tally → UTXO → karma decay → journal.

- [ ] **Step 3: Verify it compiles**

```bash
cd packages/node && npx tsc --noEmit src/services/block-apply.ts 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/services/block-apply.ts
git commit -m "feat(block-apply): compute DAG scores and evaluate reorg after sub-block confirmation

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Wire DagService in index.ts

**Files:**
- Modify: `packages/node/src/index.ts`

**Interfaces:**
- Consumes: `DagService` from `./services/dag-service.js`, `SqlitePostStore` from `./store/sqlite-store.js`
- Produces: DagService instantiated once, passed to all `applyOrderingBlock` calls

- [ ] **Step 1: Add imports**

At the top of `packages/node/src/index.ts`, add after the existing `applyOrderingBlock` import (line ~20):

```typescript
import { DagService } from './services/dag-service.js';
import { SqlitePostStore } from './store/sqlite-store.js';
```

- [ ] **Step 2: Instantiate DagService**

After the shared deps object (around line 99, after `const deps = { ... }`), add:

```typescript
// DagService — owns canonical branch population and DAG reorg logic
const postStore = new SqlitePostStore();
const dagService = new DagService(postStore);
```

- [ ] **Step 3: Thread to gossip call site**

At line 129 (`applyOrderingBlock(block);` inside `net.onOrderingBlock`), change to:

```typescript
    applyOrderingBlock(block, dagService);
```

- [ ] **Step 4: Thread to sync pull call site**

At line 287 (`applyOrderingBlock(block);` inside `net.setBlocksHandler`), change to:

```typescript
  net.setBlocksHandler((block) => {
    applyOrderingBlock(block, dagService);
  });
```

- [ ] **Step 5: Thread to fork resolution call site**

The `reorg()` function in `fork-resolution.ts` calls `applyOrderingBlock(block)` at line 150. Read `fork-resolution.ts` and update the call to `applyOrderingBlock(block, dagService)`. This requires threading `dagService` into the `reorg()` function — add a `dagService?: DagService` parameter to `reorg()` and pass it through from the call site in `index.ts`.

File: `packages/node/src/services/fork-resolution.ts`:

Change `reorg()` signature at line 121 from:
```typescript
export function reorg(forkHeight: number, newBlocks: OrderingBlock[]): void {
```
To:
```typescript
export function reorg(forkHeight: number, newBlocks: OrderingBlock[], dagService?: DagService): void {
```

Change line 150 from:
```typescript
    if (!applyOrderingBlock(block)) {
```
To:
```typescript
    if (!applyOrderingBlock(block, dagService)) {
```

File: `packages/node/src/index.ts` — update the `reorg()` call at line 218 from:
```typescript
    reorg(forkHeight, newBlocks);
```
To:
```typescript
    reorg(forkHeight, newBlocks, dagService);
```

- [ ] **Step 6: Verify typecheck**

```bash
pnpm typecheck 2>&1
```

Expected: clean (zero errors).

- [ ] **Step 7: Commit**

```bash
git add packages/node/src/index.ts packages/node/src/services/fork-resolution.ts
git commit -m "feat(node): wire DagService into block application and fork resolution

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Run tests and fix regressions

**Files:**
- No new files — verify-only task

- [ ] **Step 1: Run full test suite**

```bash
pnpm test 2>&1
```

Expected: all tests pass (407-408 pass, 1 pre-existing E2E port-conflict flake acceptable).

- [ ] **Step 2: If any test fails due to the new optional dagService parameter**

Tests that call `applyOrderingBlock` without `dagService` should work — the parameter is optional. If a test mocks `applyOrderingBlock` and expects the old 1-parameter signature, update the mock. Check:

```bash
grep -rn "applyOrderingBlock" packages/node/test/
```

Common failure points: `fork-resolution.test.ts` may call `reorg()` — update to pass `dagService` or undefined. The optional parameter means `undefined` is valid.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck 2>&1
```

- [ ] **Step 4: Run build**

```bash
pnpm build 2>&1
```

- [ ] **Step 5: Commit any test fixes**

```bash
git add packages/node/test/ && git commit -m "test: update tests for DagService parameter threading

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## GAP 2: On-Chain Prune Commits

### Task 5: Extend mempool schema for stumps

**Files:**
- Modify: `packages/node/src/store/db.ts`
- Modify: `packages/node/src/store/mempool.ts`

**Interfaces:**
- Consumes: None
- Produces: Mempool supports `entry_type = 'stump'` and `stump_id TEXT` column. `PoolEntry` type updated.

- [ ] **Step 1: Add migration function to db.ts**

In `db.ts`, after the MIGRATIONS array (after line 141), add a helper function:

```typescript
function migrateMempoolForStumps(database: Database.Database): void {
  // Check if migration already applied
  const cols = database.prepare("PRAGMA table_info('mempool')").all() as Array<{ name: string }>;
  if (cols.some(c => c.name === 'stump_id')) return;

  database.exec(`
    ALTER TABLE mempool RENAME TO mempool_old;

    CREATE TABLE mempool (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('subblock', 'utxo_tx', 'stump')),
      subblock_id TEXT,
      utxo_tx_cbor BLOB,
      stump_id TEXT,
      batch_id TEXT,
      expires_at_height INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO mempool (rowid, entry_type, subblock_id, utxo_tx_cbor, batch_id, expires_at_height, created_at)
    SELECT rowid, entry_type, subblock_id, utxo_tx_cbor, batch_id, expires_at_height, created_at
    FROM mempool_old;

    DROP TABLE mempool_old;
  `);
}
```

- [ ] **Step 2: Call migration in initDb**

In `initDb()` at line 143, after the migrations loop (`for (const sql of MIGRATIONS) { db.exec(sql); }`), add:

```typescript
  migrateMempoolForStumps(db);
```

- [ ] **Step 3: Update PoolEntry type in mempool.ts**

In `packages/node/src/store/mempool.ts`, update the `PoolEntry` interface (lines 5-13):

```typescript
export interface PoolEntry {
  rowid: number;
  entryType: 'subblock' | 'utxo_tx' | 'stump';
  subblockId: string | null;
  utxoTxCbor: Uint8Array | null;
  stumpId: string | null;
  batchId: string | null;
  expiresAtHeight: number;
  createdAt: string;
}
```

- [ ] **Step 4: Update MempoolRow interface and rowToEntry**

In the same file, update `MempoolRow`:

```typescript
interface MempoolRow {
  rowid: number;
  entry_type: string;
  subblock_id: string | null;
  utxo_tx_cbor: Buffer | null;
  stump_id: string | null;
  batch_id: string | null;
  expires_at_height: number;
  created_at: string;
}
```

Update `rowToEntry` to include `stumpId`:

```typescript
function rowToEntry(row: MempoolRow): PoolEntry {
  return {
    rowid: row.rowid,
    entryType: row.entry_type as 'subblock' | 'utxo_tx' | 'stump',
    subblockId: row.subblock_id,
    utxoTxCbor: row.utxo_tx_cbor ? new Uint8Array(row.utxo_tx_cbor) : null,
    stumpId: row.stump_id,
    batchId: row.batch_id,
    expiresAtHeight: row.expires_at_height,
    createdAt: row.created_at,
  };
}
```

- [ ] **Step 5: Add stump mempool functions to mempool.ts**

Add at the end of `packages/node/src/store/mempool.ts`:

```typescript
export function insertMempoolStump(
  stumpId: string,
  expiresAtHeight: number,
): number {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO mempool (entry_type, stump_id, expires_at_height)
     VALUES ('stump', ?, ?)`,
  ).run(stumpId, expiresAtHeight);
  return Number(result.lastInsertRowid);
}

export function drainMempoolStumps(limit: number): string[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT rowid, stump_id FROM mempool
     WHERE entry_type = 'stump'
     ORDER BY rowid ASC
     LIMIT ?`,
  ).all(limit) as Array<{ rowid: number; stump_id: string }>;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.stump_id);
  const rowids = rows.map((r) => r.rowid);
  db.prepare(
    `DELETE FROM mempool WHERE rowid IN (${rowids.map(() => '?').join(',')})`,
  ).run(...rowids);
  return ids;
}

export function removeMempoolStumps(stumpIds: string[]): void {
  if (stumpIds.length === 0) return;
  const db = getDb();
  const placeholders = stumpIds.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM mempool WHERE entry_type = 'stump' AND stump_id IN (${placeholders})`,
  ).run(...stumpIds);
}
```

- [ ] **Step 6: Re-export new mempool functions**

In `packages/node/src/store/index.ts`, add the new exports to the mempool re-export block (lines 71-78):

```typescript
export {
  insertSubBlock as insertMempoolSubBlock,
  insertUtxoTx,
  insertMempoolStump,
  getPendingEntries,
  purgeExpired,
  removeEntry,
  drainMempoolStumps,
  removeMempoolStumps,
} from './mempool.js';
```

- [ ] **Step 7: Verify typecheck**

```bash
pnpm typecheck 2>&1
```

- [ ] **Step 8: Commit**

```bash
git add packages/node/src/store/db.ts packages/node/src/store/mempool.ts packages/node/src/store/index.ts
git commit -m "feat(mempool): add stump entry type, column, and drain/insert/remove functions

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Enqueue stumps after executePrune

**Files:**
- Modify: `packages/node/src/services/stump-engine.ts`

**Interfaces:**
- Consumes: `insertMempoolStump` from `../store/mempool.js`, `getCurrentHeight` from `../store/index.js`, `MEMPOOL_EXPIRY_BLOCKS` from `@dagsocial/types`
- Produces: `executePrune` enqueues stump ID after successful prune

- [ ] **Step 1: Add imports**

At the top of `packages/node/src/services/stump-engine.ts`, add:

```typescript
import { MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';
import { insertMempoolStump, getCurrentHeight } from '../store/index.js';
```

Wait — `getCurrentHeight` is already imported. Check the existing imports at lines 10-16. Add only the new ones:

```typescript
import { MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';
```

And in the existing store import, add `insertMempoolStump`:

Change line 10 from:
```typescript
import {
  getPost,
  getSubtree,
  getLockedLikeBoxes,
  pruneSubtree,
  getCurrentHeight,
} from '../store/index.js';
```
To:
```typescript
import {
  getPost,
  getSubtree,
  getLockedLikeBoxes,
  pruneSubtree,
  getCurrentHeight,
  insertMempoolStump,
} from '../store/index.js';
```

- [ ] **Step 2: Enqueue stump after prune**

After `pruneSubtree(intent.rootPostHash, stump)` at line 134, and before `return stump` at line 136, add:

```typescript
  // Enqueue stump for block inclusion
  const currentHeight = getCurrentHeight();
  insertMempoolStump(
    computeStumpId(stump),
    currentHeight + MEMPOOL_EXPIRY_BLOCKS,
  );
```

But `computeStumpId` is already computed — `pruneSubtree` doesn't return it. The stump variable doesn't have an ID yet. Add before the enqueue:

```typescript
  // Enqueue stump for block inclusion
  const stumpId = computeStumpId(stump);
  const ch = getCurrentHeight();
  insertMempoolStump(stumpId, ch + MEMPOOL_EXPIRY_BLOCKS);
```

Note: `computeStumpId` is from `@dagsocial/types` — already available via the existing import.

- [ ] **Step 3: Verify typecheck**

```bash
cd packages/node && npx tsc --noEmit src/services/stump-engine.ts 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/services/stump-engine.ts
git commit -m "feat(stump-engine): enqueue stump ID in mempool after successful prune

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Drain stumps in block creator

**Files:**
- Modify: `packages/node/src/services/block-creator.ts`

**Interfaces:**
- Consumes: `drainMempoolStumps` from `../store/mempool.js`
- Produces: `stumpIds` populated from mempool instead of `[]`

- [ ] **Step 1: Import drainMempoolStumps**

In the existing store import block in `block-creator.ts` (lines 57-79), add `drainMempoolStumps`:

```typescript
import {
  getPendingEntries,
  purgeExpired,
  removeEntry,
  drainMempoolStumps,
  type PoolEntry,
} from '../store/mempool.js';
```

- [ ] **Step 2: Drain stumps before building SubBlockTree**

Before line 515 (`const subBlockTree: SubBlockTree = {`), add the drain call. The best spot: after `confirmedRowids` is built (step 12, around line 444) and before building the tree (step 17, around line 515). Insert at line 513 (before `// 17. Build the body trees`):

```typescript
  // Drain queued stump IDs for block inclusion
  const MAX_STUMPS_PER_BLOCK = 32;
  const stumpIds = drainMempoolStumps(MAX_STUMPS_PER_BLOCK);
```

- [ ] **Step 3: Replace hardcoded [] with drained stumpIds**

Change line 518 from:
```typescript
    stumpIds: [], // deferred — prune commit queuing is a follow-up session
```
To:
```typescript
    stumpIds,
```

- [ ] **Step 4: Verify typecheck**

```bash
cd packages/node && npx tsc --noEmit src/services/block-creator.ts 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add packages/node/src/services/block-creator.ts
git commit -m "feat(block-creator): drain queued stump IDs from mempool into SubBlockTree

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Replay prunes during block application

**Files:**
- Modify: `packages/node/src/services/block-apply.ts`

**Interfaces:**
- Consumes: `getStump` from store, `pruneSubtree` from store, `getPost` from store
- Produces: New step in `applyOrderingBlock` — replays prunes from `block.subBlockTree.stumpIds`

- [ ] **Step 1: Add imports for stump functions**

In `block-apply.ts`, the existing imports at lines 9-25 include `getPost`. Add `getStump` and `pruneSubtree`:

Change the import block to include these (they're from `../store/index.js`):

```typescript
import {
  getKarmaBox,
  getKarmaBoxes,
  getPost,
  getStump,
  insertPostPlaceholder,
  insertBox,
  getBox,
  consumeBox,
  confirmPost,
  pruneSubtree,
  markLikeBoxesTallied,
  markFreeLikesProcessed,
  getCurrentHeight,
  createOrderingBlock as storeCreateOrderingBlock,
  getOrderingBlock,
  getPendingEntries,
  removeEntry,
} from '../store/index.js';
```

- [ ] **Step 2: Insert stump replay step**

After the score + reorg step (inserted in Task 2, before the epoch tally section), and before the `// 8. Standalone like boxes...` comment, insert:

```typescript
  // Replay prune commits from this block's stumpIds
  for (const stumpId of block.subBlockTree.stumpIds) {
    const stump = getStump(stumpId);
    if (!stump) {
      console.warn(`Stump ${stumpId} not found locally — will backfill via content sweep`);
      continue;
    }
    const rootPost = getPost(stump.rootPostHash);
    if (rootPost && 'subtreeMerkleRoot' in rootPost) {
      // Already pruned — skip duplicate stump
      continue;
    }
    try {
      pruneSubtree(stump.rootPostHash, stump);
    } catch (err) {
      console.warn(`Failed to replay prune for stump ${stumpId}: ${String(err)}`);
    }
  }
```

- [ ] **Step 3: Verify typecheck**

```bash
cd packages/node && npx tsc --noEmit src/services/block-apply.ts 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/services/block-apply.ts
git commit -m "feat(block-apply): replay prune commits from block stumpIds

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Add GetStumps/Stumps message types and codec

**Files:**
- Modify: `packages/net/src/types.ts`
- Modify: `packages/net/src/sync-codec.ts`
- Modify: `packages/net/src/index.ts`

**Interfaces:**
- Consumes: `Stump` type from `@dagsocial/types`
- Produces: `MSG_GET_STUMPS = 12`, `MSG_STUMPS = 13`. `GetStumpsMsg`, `StumpsEntry`, `StumpsMsg` types. Encode/decode functions. Re-exports.

- [ ] **Step 1: Add message codes to types.ts**

In `packages/net/src/types.ts`, after line 17 (`export const MSG_POSTS = 11;`), add:

```typescript
export const MSG_GET_STUMPS = 12;
export const MSG_STUMPS = 13;
```

- [ ] **Step 2: Add message types to types.ts**

At the end of `types.ts`, after the existing `PostsMsg` interface (line 168), add:

```typescript
// ---------------------------------------------------------------------------
// GetStumps / Stumps message types
// ---------------------------------------------------------------------------

export interface GetStumpsMsg {
  stumpIds: string[];
}

export interface StumpsEntry {
  stumpId: string;
  stump: import('@dagsocial/types').Stump;
}

export interface StumpsMsg {
  entries: StumpsEntry[];
}
```

- [ ] **Step 3: Add encode/decode to sync-codec.ts**

In `packages/net/src/sync-codec.ts`, add imports for the new types and message codes:

Change line 4 from:
```typescript
import { MSG_SYNC_INFO, MSG_INV, MSG_MODIFIER_REQUEST, MSG_MODIFIER_RESPONSE, MSG_GET_POSTS, MSG_POSTS } from './types.js';
import type { GetPostsMsg, PostsMsg } from './types.js';
```
To:
```typescript
import { MSG_SYNC_INFO, MSG_INV, MSG_MODIFIER_REQUEST, MSG_MODIFIER_RESPONSE, MSG_GET_POSTS, MSG_POSTS, MSG_GET_STUMPS, MSG_STUMPS } from './types.js';
import type { GetPostsMsg, PostsMsg, GetStumpsMsg, StumpsMsg } from './types.js';
```

Add at the end of the file:

```typescript
export function encodeGetStumps(magic: number, msg: GetStumpsMsg): Uint8Array {
  return frameMessage(magic, MSG_GET_STUMPS, msg);
}

export function decodeGetStumps(body: Uint8Array): GetStumpsMsg {
  return decode(body) as GetStumpsMsg;
}

export function encodeStumps(magic: number, msg: StumpsMsg): Uint8Array {
  return frameMessage(magic, MSG_STUMPS, msg);
}

export function decodeStumps(body: Uint8Array): StumpsMsg {
  return decode(body) as StumpsMsg;
}
```

- [ ] **Step 4: Re-export from index.ts**

In `packages/net/src/index.ts`, add `MSG_GET_STUMPS` and `MSG_STUMPS` to the message codes export block (lines 12-24):

```typescript
export {
  MSG_HANDSHAKE,
  MSG_SYNC_INFO,
  MSG_INV,
  MSG_MODIFIER_REQUEST,
  MSG_MODIFIER_RESPONSE,
  MSG_GET_SUB_BLOCK,
  MSG_SUB_BLOCK_RESPONSE,
  MSG_GET_PEERS,
  MSG_PEERS,
  MSG_GET_POSTS,
  MSG_POSTS,
  MSG_GET_STUMPS,
  MSG_STUMPS,
  MODIFIER_ORDERING_BLOCK,
} from './types.js';
```

Add `GetStumpsMsg`, `StumpsEntry`, `StumpsMsg` to the type exports:

```typescript
export type {
  NetConfig,
  NetValidators,
  Peer,
  PeerRecord,
  PenaltyType,
  PenaltyRecord,
  PeerMetadata,
  ControlEvent,
  DataEvent,
  GetPostsMsg,
  PostsEntry,
  PostsMsg,
  GetStumpsMsg,
  StumpsEntry,
  StumpsMsg,
} from './types.js';
```

Add the new codec functions:

```typescript
export {
  encodeSyncInfo, decodeSyncInfo,
  encodeInv, decodeInv,
  encodeModifierRequest, decodeModifierRequest,
  encodeModifierResponse, decodeModifierResponse,
  encodeGetPosts, decodeGetPosts,
  encodePosts, decodePosts,
  encodeGetStumps, decodeGetStumps,
  encodeStumps, decodeStumps,
} from './sync-codec.js';
```

- [ ] **Step 5: Verify typecheck across all packages**

```bash
pnpm typecheck 2>&1
```

- [ ] **Step 6: Commit**

```bash
git add packages/net/src/
git commit -m "feat(net): add GetStumps/Stumps message types and codec

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Add stump gossip topic and broadcast

**Files:**
- Modify: `packages/net/src/gossip.ts`
- Modify: `packages/net/src/node.ts`

**Interfaces:**
- Consumes: `Stump` from `@dagsocial/types`, `encodeStump`/`decodeStump`/`computeStumpId` from `@dagsocial/types`
- Produces: New `dag-stump` gossip topic, `broadcastStump()`, `onStump()`, topic validator

- [ ] **Step 1: Add stump topic and broadcast to gossip.ts**

In `packages/net/src/gossip.ts`, add to TOPICS constant (line 34):

```typescript
export const TOPICS = {
  subblock: '/dagsocial/subblock/1',
  orderingBlock: '/dagsocial/ordering-block/1',
  tx: '/dagsocial/tx/1',
  stump: '/dagsocial/stump/1',
} as const;
```

Add imports at top:
```typescript
import { decodeStump, encodeStump, computeStumpId } from '@dagsocial/types';
import type { Stump } from '@dagsocial/types';
```

Add to `GossipHandlers` interface (line 44):
```typescript
export interface GossipHandlers {
  onSubBlock: (sb: SubBlock) => void;
  onOrderingBlock: (block: OrderingBlock) => void;
  onTx: (tx: UtxoTransaction) => void;
  onStump: (stump: Stump) => void;
}
```

Add topic validator in `subscribeTopics()` (after the tx validator, before the event listener):

```typescript
  gs.topicValidators.set(TOPICS.stump, (_peer, msg) => {
    try {
      const raw = new Uint8Array(msg.data);
      const stump = decodeStump(raw);
      // Structural check: computeStumpId must produce a valid hex ID
      const stumpId = computeStumpId(stump);
      if (!/^[0-9a-f]{64}$/.test(stumpId)) {
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, 'invalid stump ID');
        return TopicValidatorResult.Reject;
      }
      return TopicValidatorResult.Accept;
    } catch (err) {
      peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, _peer.toString(), `malformed stump: ${String(err)}`);
      return TopicValidatorResult.Reject;
    }
  });
```

Add dispatch in the event listener (inside the `gossipsub:message` listener, after the existing topic checks):

```typescript
      } else if (topic === TOPICS.stump) {
        handlers.onStump(decodeStump(raw));
      }
```

Add subscription (after `gs.subscribe(TOPICS.tx)`):
```typescript
  gs.subscribe(TOPICS.stump);
```

Add broadcast function at the end of the file:
```typescript
export async function broadcastStump(libp2p: Libp2pGossip, stump: Stump): Promise<void> {
  const data = encodeStump(stump);
  await libp2p.services.pubsub.publish(TOPICS.stump, data);
}
```

- [ ] **Step 2: Add onStump handler and broadcastStump to NetNode**

In `packages/net/src/node.ts`, add handler storage:

Near line 220 (after `txHandlers`):
```typescript
  private stumpHandlers: Array<(stump: Stump) => void> = [];
```

In the gossip handler registration (where `subscribeTopics` is called), add the stump handler. Find the `subscribeTopics` call in `start()` — it passes `this.subBlockHandlers` etc. Add:

Look for the `subscribeTopics` call and update it to include `onStump`. Find lines like:
```typescript
    subscribeTopics(asGossip(this.libp2p), this.validators, this.peerMgr, handlers);
```

Where `handlers` is defined. Add:
```typescript
      onStump: (stump) => {
        for (const cb of this.stumpHandlers) { try { cb(stump); } catch {} }
      },
```

Add `onStump` method (after `onTx` at line 766):
```typescript
  onStump(cb: (stump: Stump) => void): void {
    this.stumpHandlers.push(cb);
  }
```

Add `broadcastStump` method (after `broadcastTx` at line 751):
```typescript
  async broadcastStump(stump: Stump): Promise<void> {
    if (!this.libp2p) return;
    await broadcastStump(asGossip(this.libp2p), stump);
  }
```

Add import for `broadcastStump` from gossip.ts at the top of node.ts:
```typescript
import { subscribeTopics, broadcastSubBlock, broadcastOrderingBlock, broadcastTx, broadcastStump, handleModifierRequest } from './gossip.js';
```

- [ ] **Step 3: Add requestStumps method to NetNode**

After `requestPosts` (around line 844), add:

```typescript
  async requestStumps(peerId: string, stumpIds: string[]): Promise<StumpsMsg> {
    if (!this.libp2p) return { entries: [] };
    const peer = this.libp2p.getPeers().find(p => p.toString() === peerId);
    if (!peer) {
      console.warn(`[net] requestStumps: peer ${peerId} not found`);
      return { entries: [] };
    }
    const magic = this.config.magic ?? MAGIC_MAINNET;
    const clamped = stumpIds.slice(0, 100);
    const request = encodeGetStumps(magic, { stumpIds: clamped });
    let stream: import('@libp2p/interface').Stream | undefined;
    try {
      stream = await this.libp2p.dialProtocol(peer, SYNC_PROTOCOL);
      await stream.sink([request]);
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream.source) {
        chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
      }
      if (chunks.length === 0) {
        return { entries: [] };
      }
      const data = mergeUint8Arrays(chunks);
      const frame = decodeFrame(magic, data);
      if (frame.code !== MSG_STUMPS) {
        console.warn(`[net] requestStumps: unexpected response code ${frame.code}`);
        return { entries: [] };
      }
      return decodeStumps(frame.body);
    } catch (err) {
      console.warn(`[net] requestStumps failed for peer ${peerId}: ${String(err)}`);
      return { entries: [] };
    } finally {
      if (stream) await stream.close().catch(() => {});
    }
  }
```

Add import for `encodeGetStumps`, `decodeStumps` at top of node.ts:
```typescript
import { encodeGetStumps, decodeStumps } from './sync-codec.js';
```
And add `MSG_STUMPS` and `StumpsMsg` to the types import.

- [ ] **Step 4: Add setStumpsHandler**

After `setPostsHandler` (around line 865), add:

```typescript
  setStumpsHandler(handler: (stumpIds: string[]) => StumpsEntry[]): void {
    this.stumpsHandler = handler;
  }
```

Add the handler storage field near line 220:
```typescript
  private stumpsHandler: ((stumpIds: string[]) => StumpsEntry[]) | null = null;
```

Add handler for MSG_GET_STUMPS in the stream protocol handler. Find the existing handler for MSG_GET_POSTS in the SYNC_PROTOCOL handler (in `start()`). Add alongside it a handler for MSG_GET_STUMPS that calls `this.stumpsHandler`.

- [ ] **Step 5: Verify build**

```bash
pnpm build 2>&1
```

Expected: clean build across all packages.

- [ ] **Step 6: Commit**

```bash
git add packages/net/src/
git commit -m "feat(net): add stump gossip topic, broadcast, onStump handler, requestStumps, setStumpsHandler

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: Register stump gossip handler and stumps responder in index.ts

**Files:**
- Modify: `packages/node/src/index.ts`

**Interfaces:**
- Consumes: `computeStumpId` from `@dagsocial/types`, `insertStump`/`getStump` from store
- Produces: `net.onStump()` registered, `net.setStumpsHandler()` registered

- [ ] **Step 1: Add imports**

At the top of `packages/node/src/index.ts`, add `computeStumpId`, `insertStump`, `getStump`:

```typescript
import { computeStumpId } from '@dagsocial/types';
```

And from the store import, add `insertStump`, `getStump`:

In the existing store import block, add:
```typescript
  insertStump,
  getStump,
```

- [ ] **Step 2: Register onStump handler**

After the `net.onTx(...)` block (around line 252), add:

```typescript
net.onStump((stump) => {
  const stumpId = computeStumpId(stump);
  // Don't re-insert if we already have it
  if (getStump(stumpId)) return;
  insertStump(stump);
  console.log(`Relayed stump stored: ${stumpId}`);
});
```

- [ ] **Step 3: Register setStumpsHandler**

After the `net.setPostsHandler(...)` block (around line 279), add:

```typescript
  // Register stumps handler for GetStumps requests
  net.setStumpsHandler((stumpIds: string[]) => {
    const HEX64 = /^[0-9a-f]{64}$/;
    const entries: Array<{ stumpId: string; stump: Stump }> = [];
    for (const stumpId of stumpIds) {
      if (!HEX64.test(stumpId)) continue;
      const stump = getStump(stumpId);
      if (!stump) continue;
      entries.push({ stumpId, stump });
    }
    return entries;
  });
```

Import `Stump` type:
```typescript
import type { Stump } from '@dagsocial/types';
```

- [ ] **Step 4: Verify typecheck**

```bash
pnpm typecheck 2>&1
```

- [ ] **Step 5: Commit**

```bash
git add packages/node/src/index.ts
git commit -m "feat(node): register stump gossip handler and GetStumps responder

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: Add broadcastStump in executePrune

**Files:**
- Modify: `packages/node/src/services/stump-engine.ts`

**Interfaces:**
- Consumes: `getNet` from `./net-instance.js`
- Produces: `executePrune` broadcasts stump after successful prune

- [ ] **Step 1: Add import for net instance**

At the top of `stump-engine.ts`, add:

```typescript
import { getNet } from './net-instance.js';
```

- [ ] **Step 2: Broadcast after enqueue**

After the mempool enqueue (inserted in Task 6), add the broadcast call. Right before `return stump` at the end of `executePrune`:

```typescript
  // Broadcast stump to peers (gossip push)
  const net = getNet();
  if (net) {
    net.broadcastStump(stump).catch((err: Error) => {
      console.warn(`Failed to broadcast stump ${stumpId}: ${err.message}`);
    });
  }

  return stump;
```

Note: `stumpId` was computed in Task 6 for the mempool enqueue — reuse it. Adjust the Task 6 code if needed so `stumpId` is a local variable.

- [ ] **Step 3: Verify typecheck**

```bash
cd packages/node && npx tsc --noEmit src/services/stump-engine.ts 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/services/stump-engine.ts
git commit -m "feat(stump-engine): broadcast stump to peers after prune

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 13: Add content sweep for stumps

**Files:**
- Modify: `packages/node/src/services/content-sweep.ts`

**Interfaces:**
- Consumes: `NetNode.requestStumps()`, `computeStumpId`, `insertStump`, `pruneSubtree`, `getStump`
- Produces: `sweepStumps()` and `hasMissingStumps()` exported

- [ ] **Step 1: Add imports at top of content-sweep.ts**

```typescript
import { decodeSubBlockTree, computeStumpId } from '@dagsocial/types';
```

- [ ] **Step 2: Add helper to detect missing stumps**

```typescript
/** Check if any stumps referenced in blocks are missing from local dag_stumps. */
export function hasMissingStumps(): boolean {
  const db = getDb();
  const rows = db.prepare(
    `SELECT subblock_tree_cbor FROM ordering_blocks
     ORDER BY height DESC LIMIT 50`,
  ).all() as Array<{ subblock_tree_cbor: Buffer }>;
  for (const row of rows) {
    const tree = decodeSubBlockTree(new Uint8Array(row.subblock_tree_cbor));
    for (const stumpId of tree.stumpIds) {
      const existing = db.prepare('SELECT 1 FROM dag_stumps WHERE id = ?').get(stumpId);
      if (!existing) return true;
    }
  }
  return false;
}

function getMissingStumpIds(): string[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT subblock_tree_cbor FROM ordering_blocks
     ORDER BY height DESC LIMIT 50`,
  ).all() as Array<{ subblock_tree_cbor: Buffer }>;
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const tree = decodeSubBlockTree(new Uint8Array(row.subblock_tree_cbor));
    for (const stumpId of tree.stumpIds) {
      if (seen.has(stumpId)) continue;
      seen.add(stumpId);
      const existing = db.prepare('SELECT 1 FROM dag_stumps WHERE id = ?').get(stumpId);
      if (!existing) missing.push(stumpId);
    }
  }
  return missing;
}
```

- [ ] **Step 3: Add sweepStumps function**

```typescript
/**
 * Fetch missing stumps from peers after block sync.
 */
export async function sweepStumps(
  net: NetNode,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): Promise<SweepResult> {
  let retries = 0;

  while (retries < maxRetries) {
    const missingIds = getMissingStumpIds();
    if (missingIds.length === 0) {
      return { success: true, remaining: 0 };
    }

    const peerIds = net.getConnectedPeers();
    if (peerIds.length === 0) {
      return { success: false, remaining: missingIds.length };
    }

    const batches = chunk(missingIds, BATCH_SIZE);
    for (const batch of batches) {
      const selected = peerIds.slice(0, MAX_PEERS_PER_BATCH);
      const results = await Promise.all(
        selected.map((peerId) =>
          net.requestStumps(peerId, batch).catch(() => ({ entries: [] })),
        ),
      );

      const seen = new Set<string>();
      for (const response of results) {
        for (const entry of response.entries) {
          if (seen.has(entry.stumpId)) continue;
          seen.add(entry.stumpId);

          // Verify stump ID matches
          if (computeStumpId(entry.stump) !== entry.stumpId) {
            console.warn(
              `[content-sweep] stump ID mismatch for claimed ${entry.stumpId}, dropping`,
            );
            continue;
          }

          // Store the stump and replay the prune
          insertStump(entry.stump);
          const rootPost = getPost(entry.stump.rootPostHash);
          if (rootPost && !('subtreeMerkleRoot' in rootPost)) {
            try {
              pruneSubtree(entry.stump.rootPostHash, entry.stump);
            } catch (err) {
              console.warn(
                `[content-sweep] failed to replay prune for stump ${entry.stumpId}: ${String(err)}`,
              );
            }
          }
        }
      }
    }

    const remaining = getMissingStumpIds().length;
    if (remaining === 0) {
      return { success: true, remaining: 0 };
    }

    retries++;
    if (retries < maxRetries) {
      await sleep(BASE_DELAY_MS * retries);
    }
  }

  const remaining = getMissingStumpIds().length;
  return { success: false, remaining };
}
```

**Note:** `insertStump`, `pruneSubtree`, and `getPost` are already imported from `../store/index.js` at the top of the file (add them to the existing store import). `computeStumpId` and `decodeSubBlockTree` are imported in Step 1.

In `packages/node/src/index.ts`, after the existing `sweepPlaceholders` calls in `onSyncComplete` and `onPeerActive`, add `sweepStumps` calls.

In `onSyncComplete` (around line 294), add after the `sweepPlaceholders` block:

```typescript
    if (hasMissingStumps()) {
      console.log('[content-sweep] Sync complete, sweeping missing stumps...');
      sweepStumps(net).then((result) => {
        if (result.success) {
          console.log('[content-sweep] All stumps resolved.');
        } else {
          console.warn(`[content-sweep] Stump sweep incomplete: ${result.remaining} stumps remain.`);
        }
      }).catch((err: Error) => {
        console.error(`[content-sweep] Stump sweep failed: ${err.message}`);
      });
    }
```

In `onPeerActive` (around line 312), add similarly.

Import `sweepStumps`, `hasMissingStumps` at the top of index.ts:
```typescript
import { sweepPlaceholders, hasPlaceholders, sweepStumps, hasMissingStumps } from './services/content-sweep.js';
```

- [ ] **Step 4: Verify typecheck and build**

```bash
pnpm typecheck 2>&1
pnpm build 2>&1
```

- [ ] **Step 5: Commit**

```bash
git add packages/node/src/services/content-sweep.ts packages/node/src/index.ts
git commit -m "feat(content-sweep): add stump backfill with GetStumps/Stumps protocol

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 14: Run full test suite, fix regressions, final commit

**Files:**
- No new files — verify-only task

- [ ] **Step 1: Run full test suite**

```bash
pnpm test 2>&1
```

Expected: all tests pass. Fix any failures.

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck 2>&1
```

- [ ] **Step 3: Run build**

```bash
pnpm build 2>&1
```

- [ ] **Step 4: Fix any regressions**

Common issues:
- Tests that create `SubBlockTree` fixtures with `stumpIds: []` — should still pass (no change needed).
- Mempool tests that check `entry_type` values — may need updating for the new `stump` type.
- `PoolEntry` type assertions in tests — update `entryType` to include `'stump'`.
- `fork-resolution.test.ts` — update `reorg()` calls to include the optional `dagService` parameter.

- [ ] **Step 5: Final commit**

```bash
git add -A && git commit -m "chore: final test fixes and cleanup for DagService + prune commits

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Verification Checklist

- [ ] `pnpm typecheck` — clean
- [ ] `pnpm build` — clean (all 5 packages)
- [ ] `pnpm test` — all tests pass (existing + new, 1 E2E flake acceptable)
- [ ] DagService: scores populate after block confirmation
- [ ] DagService: reorg plan evaluated for highest-scoring sub-block
- [ ] Mempool: stump entries insert, drain, expire, remove
- [ ] Block creator: stumpIds populated from mempool
- [ ] Block application: prunes replayed from block stumpIds
- [ ] Gossip: stump broadcast on prune, inbound stump stored
- [ ] Content sweep: missing stumps backfilled from peers
- [ ] Fork resolution: stumps removed from mempool on reorg
