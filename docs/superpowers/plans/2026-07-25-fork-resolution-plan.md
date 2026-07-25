# Fork Resolution: Chain Scoring, Reorg, and Rollback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect competing chains, compare by cumulative work, and reorg to the heavier chain with full UTXO state rollback via per-block mutation journals.

**Architecture:** A `block_journal` table records undo data per block as `applyOrderingBlock` runs forward. Fork detection compares `prevBlockHash` to our tip. Header sync (`/dagsocial/headers/1`) fetches the competing chain segment. `revertBlock` replays the journal in reverse. `reorg` reverts to the fork point then applies the new chain. Block application moves to a dedicated `block-apply.ts` service module.

**Tech Stack:** TypeScript, Node.js ≥ 22, @dagsocial/types → @dagsocial/validation → @dagsocial/net → @dagsocial/node, better-sqlite3, CBOR (cbor-x), libp2p custom protocols

## Global Constraints

- MAX_REORG_DEPTH = 20 blocks
- Conservative switching: reorg only when competing chain has strictly MORE cumulative work
- Cumulative work: `sum(2^powTargetBits)` using BigInt
- Journal stored as CBOR blob in `block_journal` table, keyed by `block_height`
- Journals older than `currentHeight - 20` are purged on each new block
- Reverted UTXO txs re-inserted to mempool with TTL reset to `currentHeight + 720`
- Reverted sub-blocks re-inserted to mempool
- Header sync protocol: `/dagsocial/headers/1` — CBOR request/response over libp2p stream
- Import paths: `@dagsocial/types` (types), `@dagsocial/validation` (blockHash, verifyOrderingBlockPoW), `@dagsocial/net` (NetNode, sync protocol helpers)
- 379 existing tests must continue passing; new tests added for journal, rollback, reorg, header sync

---

### Task 1: BlockJournal type + cumulativeWork in @dagsocial/types

**Files:**
- Create: `packages/types/src/journal.ts`
- Modify: `packages/types/src/block.ts` (add `cumulativeWork` export helper)
- Modify: `packages/types/src/index.ts`

**Interfaces:**
- Consumes: `BlockHeader` from block.ts
- Produces:
  - `BlockJournal` interface
  - `KarmaMint { userId: Uint8Array; amount: number }` interface
  - `AppliedUtxoTx { txId: string; txCbor: Uint8Array; inputBoxIds: string[]; outputBoxIds: string[] }` interface
  - `cumulativeWork(headers: BlockHeader[]): bigint`

- [ ] **Step 1: Create `packages/types/src/journal.ts`**

```ts
import type { UserId } from './identity.js';

export interface KarmaMint {
  userId: UserId;
  amount: number;
}

export interface AppliedUtxoTx {
  txId: string;
  txCbor: Uint8Array;
  inputBoxIds: string[];
  outputBoxIds: string[];
}

export interface BlockJournal {
  blockHeight: number;
  creditBoxIds: string[];
  confirmedSubBlockIds: string[];
  subBlockCbors: { subBlockId: string; cbor: Uint8Array }[];  // for mempool re-insertion
  talliedLikeBoxIds: string[];
  karmaMints: KarmaMint[];
  appliedUtxoTxs: AppliedUtxoTx[];
}
```

- [ ] **Step 2: Add `cumulativeWork` to `packages/types/src/block.ts`**

Append after the `EMPTY_STATE_ROOT` export:

```ts
import type { BlockHeader } from './block.js' — no, this is the same file. Just append:

/** Sum of expected hashes over a chain segment = sum(2^targetBits). */
export function cumulativeWork(headers: BlockHeader[]): bigint {
  return headers.reduce((sum, h) => sum + (1n << BigInt(h.powTargetBits)), 0n);
}
```

- [ ] **Step 3: Update `packages/types/src/index.ts`**

Add journal type and value exports:

```ts
export type { BlockJournal, KarmaMint, AppliedUtxoTx } from './journal.js';
```

Add `cumulativeWork` to the block exports:

```ts
export { EMPTY_STATE_ROOT, cumulativeWork } from './block.js';
```

- [ ] **Step 4: Run types tests**

```bash
pnpm --filter @dagsocial/types test
```

Expected: 96 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/journal.ts packages/types/src/block.ts packages/types/src/index.ts
git commit -m "feat: add BlockJournal types and cumulativeWork helper

BlockJournal records per-block undo data for fork rollback.
cumulativeWork sums 2^targetBits over a chain segment.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: block_journal store + rollback store functions

**Files:**
- Create: `packages/node/src/store/journal.ts`
- Modify: `packages/node/src/store/db.ts` (add block_journal table)
- Modify: `packages/node/src/store/index.ts`
- Modify: `packages/node/src/store/utxo.ts` (add `unconsumeBox`, `deleteBox`)
- Modify: `packages/node/src/store/posts.ts` (add `unconfirmPost`)
- Modify: `packages/node/src/store/ordering.ts` (add `deleteOrderingBlock`)

**Interfaces:**
- Consumes: `BlockJournal` from types; existing `getDb`
- Produces:
  - `insertBlockJournal(journal: BlockJournal): void`
  - `getBlockJournal(height: number): BlockJournal | null`
  - `deleteBlockJournal(height: number): void`
  - `purgeOldJournals(belowHeight: number): void`
  - `unconsumeBox(boxId: string): void`
  - `deleteBox(boxId: string): void`
  - `unconfirmPost(subBlockId: string): void`
  - `deleteOrderingBlock(height: number): void`

- [ ] **Step 1: Add `block_journal` table to `packages/node/src/store/db.ts`**

In the MIGRATIONS array, add after the `ordering_blocks` CREATE TABLE:

```ts
  `CREATE TABLE IF NOT EXISTS block_journal (
    block_height INTEGER PRIMARY KEY,
    journal_cbor BLOB NOT NULL
  )`,
```

Also add to the DROP list at the top:
```ts
  'DROP TABLE IF EXISTS block_journal',
```

- [ ] **Step 2: Create `packages/node/src/store/journal.ts`**

```ts
import { getDb } from './db.js';
import { encode } from 'cbor-x';
import type { BlockJournal } from '@dagsocial/types';

function toBuffer(data: unknown): Buffer {
  return Buffer.from(encode(data) as unknown as Uint8Array);
}

export function insertBlockJournal(journal: BlockJournal): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO block_journal (block_height, journal_cbor) VALUES (?, ?)`,
  ).run(journal.blockHeight, toBuffer(journal));
}

export function getBlockJournal(height: number): BlockJournal | null {
  const db = getDb();
  const row = db.prepare('SELECT journal_cbor FROM block_journal WHERE block_height = ?')
    .get(height) as { journal_cbor: Buffer } | undefined;
  if (!row) return null;
  const { decode } = require('cbor-x');
  return decode(row.journal_cbor) as BlockJournal;
}

export function deleteBlockJournal(height: number): void {
  getDb().prepare('DELETE FROM block_journal WHERE block_height = ?').run(height);
}

export function purgeOldJournals(belowHeight: number): void {
  getDb().prepare('DELETE FROM block_journal WHERE block_height < ?').run(belowHeight);
}
```

- [ ] **Step 3: Add `unconsumeBox` and `deleteBox` to `packages/node/src/store/utxo.ts`**

```ts
export function unconsumeBox(boxId: string): void {
  getDb().prepare('UPDATE utxo_boxes SET spent_at = NULL WHERE id = ?').run(boxId);
}

export function deleteBox(boxId: string): void {
  getDb().prepare('DELETE FROM utxo_boxes WHERE id = ?').run(boxId);
}
```

- [ ] **Step 4: Add `unconfirmPost` to `packages/node/src/store/posts.ts`**

```ts
export function unconfirmPost(subBlockId: string): void {
  getDb().prepare(
    `UPDATE dag_posts SET status = 'pending', confirmed_at_height = NULL WHERE id = ?`,
  ).run(subBlockId);
}
```

- [ ] **Step 5: Add `deleteOrderingBlock` to `packages/node/src/store/ordering.ts`**

```ts
export function deleteOrderingBlock(height: number): void {
  getDb().prepare('DELETE FROM ordering_blocks WHERE height = ?').run(height);
}
```

- [ ] **Step 6: Update `packages/node/src/store/index.ts`**

Add exports for all new functions:

```ts
export {
  insertBlockJournal,
  getBlockJournal,
  deleteBlockJournal,
  purgeOldJournals,
} from './journal.js';
```

Add `unconsumeBox`, `deleteBox` to existing utxo exports. Add `unconfirmPost` to posts exports. Add `deleteOrderingBlock` to ordering exports.

- [ ] **Step 7: Run store tests**

```bash
pnpm --filter @dagsocial/node test -- --reporter verbose 2>&1 | grep -E "store|PASS|FAIL|Tests"
```

Expected: store tests pass (db, utxo, ordering, posts, journal — journal test will be added in Task 8).

- [ ] **Step 8: Commit**

```bash
git add packages/node/src/store/
git commit -m "feat: add block_journal store + UTXO/post rollback functions

block_journal table stores CBOR-encoded undo data per block.
unconsumeBox, deleteBox, unconfirmPost, deleteOrderingBlock
enable reversing forward block application.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Refactor applyOrderingBlock to block-apply.ts with journal

**Files:**
- Create: `packages/node/src/services/block-apply.ts`
- Modify: `packages/node/src/index.ts` (extract applyOrderingBlock, import from block-apply.ts)

**Interfaces:**
- Consumes: All store functions, `BlockJournal`, `mintKarma`, `mintCredits`, `computeBlockReward`, `computeSubBlockRoot`, `computeUtxoTxRoot`, validation functions
- Produces: `applyOrderingBlock(block: OrderingBlock): boolean` — returns true on success, false on rejection. Records journal entries during application.

- [ ] **Step 1: Create `packages/node/src/services/block-apply.ts`**

Move the entire `applyOrderingBlock` function from `index.ts` into this new file. Add journal recording. The function signature changes to return `boolean`.

Key changes during the move:

**a) Add module-level journal variable:**

```ts
import type { BlockJournal } from '@dagsocial/types';
import { insertBlockJournal, purgeOldJournals } from '../store/journal.js';

let currentJournal: BlockJournal | null = null;

export function getCurrentJournal(): BlockJournal | null {
  return currentJournal;
}
```

**b) At the top of `applyOrderingBlock`, initialize the journal:**

```ts
export function applyOrderingBlock(block: OrderingBlock): boolean {
  const currentHeight = getCurrentHeight();

  currentJournal = {
    blockHeight: block.header.height,
    creditBoxIds: [],
    confirmedSubBlockIds: [...block.subBlockTree.subBlockRefs],
    subBlockCbors: [],  // populated below from mempool entries
    talliedLikeBoxIds: [...block.utxoTxTree.likeBoxIds],
    karmaMints: [],
    appliedUtxoTxs: [],
  };

  // ... existing validation checks — return false on rejection ...

  // After storeCreateOrderingBlock:
  storeCreateOrderingBlock(block);

  // After clearTemplate:
  clearTemplate();

  // On coinbase mint — record box IDs:
  for (const out of block.utxoTxTree.coinbaseOutputs) {
    const boxId = mintCredits(out.owner, out.value, block.header.height, out.lockedUntilBlock);
    currentJournal.creditBoxIds.push(boxId);
  }

  // ... confirm posts, tally likes, apply epoch ...

  // After all operations, persist journal:
  insertBlockJournal(currentJournal);
  purgeOldJournals(block.header.height - 20);
  currentJournal = null;

  return true;
}
```

**c) Wrap `mintKarma` calls to record in journal:**

All calls to `mintKarma(userId, amount, height)` in the epoch tally section are preceded by:
```ts
currentJournal!.karmaMints.push({ userId, amount });
```

**d) Record UTXO tx applications:**

In the UTXO tx apply loop, after `applyTx(...)`:
```ts
currentJournal!.appliedUtxoTxs.push({
  txId,
  txCbor: encodeTx(tx),
  inputBoxIds: tx.inputs,
  outputBoxIds: computedOutputs.map(o => o.id!),
});
```

need to import `encodeTx` from `@dagsocial/types`.

**e) Reject path cleanup:** If any validation check fails and the function returns `false`, set `currentJournal = null` before returning.

- [ ] **Step 2: Update `packages/node/src/index.ts`**

Replace the inline `applyOrderingBlock` function with an import:

```ts
import { applyOrderingBlock } from './services/block-apply.js';
```

Remove lines 151-312 (the entire function body). The `net.onOrderingBlock` handler at line 91-93 stays unchanged — it still calls `applyOrderingBlock(block)`.

Remove unused imports that were only used by the old inline function (they're now in `block-apply.ts`):
- `mintKarma` import can stay if used elsewhere in index.ts (check — only used in applyOrderingBlock). Remove from index.ts imports.
- `mintCredits` — same, only used in applyOrderingBlock. Remove from index.ts.
- `computeBlockReward`, `computeSubBlockRoot`, `computeUtxoTxRoot` — only used in applyOrderingBlock. Remove from index.ts.
- Keep `validation` import (used in fork detection later).

- [ ] **Step 3: Run node tests**

```bash
pnpm --filter @dagsocial/node test 2>&1 | tail -10
```

Expected: 219 pass (same as before — no behavioral change, just moved code).

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/services/block-apply.ts packages/node/src/index.ts
git commit -m "refactor: extract applyOrderingBlock to block-apply.ts with journal

applyOrderingBlock now records per-block mutation journal during
forward application. Module-level currentJournal tracks undo data.
index.ts delegates to new module.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: fork-resolution.ts — core reorg logic

**Files:**
- Create: `packages/node/src/services/fork-resolution.ts`
- Modify: `packages/node/src/index.ts` (import from fork-resolution, no behavior change yet)

**Interfaces:**
- Consumes: `BlockHeader`, `OrderingBlock`, `BlockJournal`, `cumulativeWork` from types; `blockHash` from validation; store functions; `applyOrderingBlock` from block-apply.ts
- Produces:
  - `extendsOurTip(block: OrderingBlock): boolean`
  - `findForkPoint(ourTip: BlockHeader, theirHeaders: BlockHeader[]): number | null`
  - `revertBlock(height: number): void`
  - `reorg(forkHeight: number, newBlocks: OrderingBlock[]): void`

- [ ] **Step 1: Create `packages/node/src/services/fork-resolution.ts`**

```ts
import { blockHash } from '@dagsocial/validation';
import { cumulativeWork } from '@dagsocial/types';
import type { BlockHeader, OrderingBlock, BlockJournal } from '@dagsocial/types';
import { decodeTx } from '@dagsocial/types';
import {
  getOrderingBlock,
  getCurrentHeight,
  getBlockJournal,
  deleteBlockJournal,
  deleteOrderingBlock,
  unconsumeBox,
  deleteBox,
  unconfirmPost,
  insertUtxoTx,
  insertMempoolSubBlock,
} from '../store/index.js';
import { applyOrderingBlock } from './block-apply.js';

const MAX_REORG_DEPTH = 20;

/**
 * Does this block extend our current canonical tip?
 */
export function extendsOurTip(block: OrderingBlock): boolean {
  const ourTip = getOrderingBlock(getCurrentHeight());
  if (!ourTip) return false;
  return block.header.prevBlockHash === blockHash(ourTip.header);
}

/**
 * Walk both chains back to find the common ancestor.
 * theirHeaders is newest-first (tip at index 0).
 * Returns fork height or null if deeper than MAX_REORG_DEPTH.
 */
export function findForkPoint(
  ourTip: BlockHeader,
  theirHeaders: BlockHeader[],
): number | null {
  // Collect our chain hashes: height → hash
  const ourHashes = new Map<string, number>();
  let cursor = getOrderingBlock(ourTip.height);
  let depth = 0;
  while (cursor && depth < MAX_REORG_DEPTH) {
    ourHashes.set(blockHash(cursor.header), cursor.header.height);
    cursor = getOrderingBlock(cursor.header.height - 1);
    depth++;
  }

  // Walk their chain, check for match
  for (const header of theirHeaders) {
    const h = blockHash(header);
    const matchHeight = ourHashes.get(h);
    if (matchHeight !== undefined) return matchHeight;
  }

  return null; // no common ancestor within MAX_REORG_DEPTH
}

/**
 * Reverse all mutations from a single block using its journal.
 */
export function revertBlock(height: number): void {
  const journal = getBlockJournal(height);
  if (!journal) {
    throw new Error(`No journal for height ${height} — cannot revert`);
  }

  // 1. Reverse UTXO txs (reverse order)
  for (let i = journal.appliedUtxoTxs.length - 1; i >= 0; i--) {
    const txRecord = journal.appliedUtxoTxs[i]!;
    for (const boxId of txRecord.outputBoxIds) {
      deleteBox(boxId);
    }
    for (const boxId of txRecord.inputBoxIds) {
      unconsumeBox(boxId);
    }
  }

  // 2. Burn minted karma (delete karma boxes created by mints)
  for (const mint of journal.karmaMints) {
    // mintKarma creates a new karma box. We delete the boxes it created.
    // The karma boxes created by mintKarma during block application have
    // proofSource = `block:${height}` — we delete any karma box with that source.
    const { getDb } = require('../store/db.js');
    getDb().prepare(
      `DELETE FROM utxo_boxes WHERE proof_source = ?`,
    ).run(`block:${height}`);
  }

  // 3. Unspend tallied like boxes
  for (const boxId of journal.talliedLikeBoxIds) {
    unconsumeBox(boxId);
  }

  // 4. Delete coinbase credit boxes
  for (const boxId of journal.creditBoxIds) {
    deleteBox(boxId);
  }

  // 5. Unconfirm posts
  for (const subBlockId of journal.confirmedSubBlockIds) {
    unconfirmPost(subBlockId);
  }

  // 6. Delete block + journal
  deleteOrderingBlock(height);
  deleteBlockJournal(height);
}

/**
 * Reorg: revert our chain from currentHeight down to forkHeight+1,
 * then apply the competing chain forward.
 */
export function reorg(forkHeight: number, newBlocks: OrderingBlock[]): void {
  const currentHeight = getCurrentHeight();

  // Phase 1: revert our blocks, collecting journals for re-insertion
  const revertedJournals: BlockJournal[] = [];
  for (let h = currentHeight; h > forkHeight; h--) {
    const journal = getBlockJournal(h);
    if (journal) revertedJournals.push(journal);
    revertBlock(h);
  }

  // Phase 2: re-insert reverted txs and sub-blocks to mempool
  const newTipHeight = forkHeight + newBlocks.length;
  const mempoolExpiry = newTipHeight + 720;
  for (const journal of revertedJournals) {
    // Re-insert UTXO txs
    for (const txRecord of journal.appliedUtxoTxs) {
      const tx = decodeTx(txRecord.txCbor);
      insertUtxoTx(tx, null, mempoolExpiry);
    }
    // Re-insert sub-blocks
    for (const { subBlockId, cbor } of journal.subBlockCbors) {
      const sb = decodeSubBlock(cbor);
      insertMempoolSubBlock(sb, mempoolExpiry);
    }
  }

  // Phase 3: apply new chain
  for (const block of newBlocks) {
    applyOrderingBlock(block);
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck 2>&1
```

Expected: clean (no callers yet — functions are exported but unused).

- [ ] **Step 3: Commit**

```bash
git add packages/node/src/services/fork-resolution.ts
git commit -m "feat: fork resolution — extendsOurTip, findForkPoint, revertBlock, reorg

Cumulative work chain scoring. 20-block reorg depth.
revertBlock replays mutation journal in reverse.
reorg reverts to fork point, re-inserts txs, applies new chain.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Wire fork detection into index.ts gossip handler

**Files:**
- Modify: `packages/node/src/index.ts`

**Interfaces:**
- Consumes: `extendsOurTip`, `findForkPoint`, `reorg` from fork-resolution.ts; `blockHash` from validation; `requestHeaders` from NetNode
- Produces: updated `net.onOrderingBlock` handler with fork detection and reorg

- [ ] **Step 1: Update imports in `packages/node/src/index.ts`**

Add:
```ts
import { extendsOurTip, findForkPoint, reorg } from './services/fork-resolution.js';
import { blockHash } from '@dagsocial/validation';
import { cumulativeWork } from '@dagsocial/types';
```

- [ ] **Step 2: Update the `net.onOrderingBlock` handler**

Replace lines 91-93:
```ts
net.onOrderingBlock((block) => {
  applyOrderingBlock(block);
});
```

With:
```ts
net.onOrderingBlock((block) => {
  const currentHeight = getCurrentHeight();

  // Genesis always applied
  if (currentHeight === 0) {
    applyOrderingBlock(block);
    return;
  }

  // Normal case: extends our tip
  if (extendsOurTip(block)) {
    applyOrderingBlock(block);
    return;
  }

  // Fork detected — block doesn't extend our tip
  console.info(`Fork detected at height=${block.header.height}`);

  // Request competing chain headers from the source peer
  // The source peer ID is not directly available from the gossip handler.
  // For MVP, request from any connected peer that has the block.
  // The NetNode API exposes requestHeaders (added in Task 6).
  const peerId = net.peers()[0]?.id;
  if (!peerId) {
    console.warn('No peers available for header sync, rejecting fork');
    return;
  }

  net.requestHeaders(block.header.height - 1, 20, peerId)
    .then((theirHeaders) => {
      const ourTip = getOrderingBlock(currentHeight);
      if (!ourTip) return;

      const forkHeight = findForkPoint(ourTip.header, [block.header, ...theirHeaders]);
      if (forkHeight === null) {
        console.warn(`Fork too deep (>20 blocks), ignoring competing chain`);
        return;
      }

      // Compare cumulative work
      const ourSegment = []; // headers from forkHeight+1 to currentHeight
      for (let h = forkHeight + 1; h <= currentHeight; h++) {
        const b = getOrderingBlock(h);
        if (b) ourSegment.push(b.header);
      }
      const theirSegment = [block.header, ...theirHeaders]
        .filter(h => h.height > forkHeight && h.height <= block.header.height);

      const ourWork = cumulativeWork(ourSegment);
      const theirWork = cumulativeWork(theirSegment);

      if (theirWork <= ourWork) {
        console.info(`Competing chain not heavier (ours=${ourWork}, theirs=${theirWork}), ignoring`);
        return;
      }

      console.info(`Switching to heavier chain (ours=${ourWork}, theirs=${theirWork})`);

      // Request full blocks from forkHeight+1 to block.header.height
      net.requestBlocks(forkHeight + 1, block.header.height, peerId)
        .then((newBlocks) => {
          reorg(forkHeight, newBlocks);
        })
        .catch((err) => {
          console.warn(`Failed to fetch competing blocks: ${err.message}`);
        });
    })
    .catch((err) => {
      console.warn(`Header sync failed: ${err.message}`);
    });
});
```

- [ ] **Step 3: Commit**

```bash
git add packages/node/src/index.ts
git commit -m "feat: wire fork detection into gossip handler

Competing blocks trigger header sync, cumulative work comparison,
and reorg when the competing chain is strictly heavier.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Net headers sync protocol

**Files:**
- Create: `packages/net/src/headers.ts`
- Modify: `packages/net/src/node.ts` (add requestHeaders, requestBlocks APIs)
- Modify: `packages/net/src/index.ts` (export HEADERS_PROTOCOL)

**Interfaces:**
- Consumes: `BlockHeader`, `OrderingBlock` types; `encodeHeader`, `decodeHeader`, `encodeOrderingBlock`, `decodeOrderingBlock` serialization
- Produces:
  - `HEADERS_PROTOCOL = '/dagsocial/headers/1'`
  - `requestHeaders(libp2p, startHeight, maxCount, peerId, config): Promise<BlockHeader[]>`
  - `registerHeadersHandler(libp2p, getOrderingBlock): void`
  - `NetNode.requestHeaders(startHeight, maxCount, peerId): Promise<BlockHeader[]>`
  - `NetNode.requestBlocks(startHeight, endHeight, peerId): Promise<OrderingBlock[]>`

- [ ] **Step 1: Create `packages/net/src/headers.ts`**

Follow the same pattern as `sync.ts`:

```ts
import { encodeHeader, decodeHeader, encodeOrderingBlock, decodeOrderingBlock } from '@dagsocial/types';
import { encode, decode } from 'cbor-x';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import type { NetConfig } from './types.js';

export const HEADERS_PROTOCOL = '/dagsocial/headers/1';

function mergeUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Request headers from a peer, starting at startHeight and going down.
 * Returns newest-first.
 */
export async function requestHeaders(
  libp2p: Libp2p,
  startHeight: number,
  maxCount: number,
  peerId: string,
  config: NetConfig,
): Promise<BlockHeader[]> {
  const peer = libp2p.getPeers().find(p => p.toString() === peerId);
  if (!peer) throw new Error(`Peer ${peerId} not connected`);

  let stream: Stream | undefined;
  try {
    stream = await libp2p.dialProtocol(peer, HEADERS_PROTOCOL, {
      signal: AbortSignal.timeout(config.syncRequestTimeoutMs),
    });

    const request = { startHeight, maxCount };
    await stream.sink([Buffer.from(encode(request) as unknown as Uint8Array)]);

    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.source) {
      chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
    }

    if (chunks.length === 0) return [];
    return decode(mergeUint8Arrays(chunks)) as BlockHeader[];
  } finally {
    if (stream) await stream.close();
  }
}

/**
 * Request full ordering blocks from startHeight to endHeight (inclusive).
 */
export async function requestBlocks(
  libp2p: Libp2p,
  startHeight: number,
  endHeight: number,
  peerId: string,
  config: NetConfig,
): Promise<OrderingBlock[]> {
  const peer = libp2p.getPeers().find(p => p.toString() === peerId);
  if (!peer) throw new Error(`Peer ${peerId} not connected`);

  let stream: Stream | undefined;
  try {
    stream = await libp2p.dialProtocol(peer, HEADERS_PROTOCOL, {
      signal: AbortSignal.timeout(config.syncRequestTimeoutMs * 5), // blocks are bigger
    });

    const request = { startHeight, endHeight, mode: 'blocks' };
    await stream.sink([Buffer.from(encode(request) as unknown as Uint8Array)]);

    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.source) {
      chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
    }

    if (chunks.length === 0) return [];
    const response = decode(mergeUint8Arrays(chunks)) as { blocks: OrderingBlock[] };
    return response.blocks;
  } finally {
    if (stream) await stream.close();
  }
}

/**
 * Register handler for header and block requests.
 */
export function registerHeadersHandler(
  libp2p: Libp2p,
  getOrderingBlock: (height: number) => OrderingBlock | null,
): void {
  libp2p.handle(HEADERS_PROTOCOL, async ({ stream }) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream.source) {
        chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
      }
      if (chunks.length === 0) {
        await stream.sink([new Uint8Array(0)]);
        return;
      }

      const request = decode(mergeUint8Arrays(chunks)) as {
        startHeight: number;
        maxCount?: number;
        endHeight?: number;
        mode?: string;
      };

      if (request.mode === 'blocks') {
        // Return full blocks
        const blocks: OrderingBlock[] = [];
        for (let h = request.startHeight; h <= request.endHeight!; h++) {
          const block = getOrderingBlock(h);
          if (block) blocks.push(block);
        }
        await stream.sink([Buffer.from(encode({ blocks }) as unknown as Uint8Array)]);
      } else {
        // Return headers only
        const headers: BlockHeader[] = [];
        for (let h = request.startHeight; h > 0 && headers.length < (request.maxCount || 20); h--) {
          const block = getOrderingBlock(h);
          if (block) headers.push(block.header);
          else break; // gap — stop
        }
        await stream.sink([Buffer.from(encode(headers) as unknown as Uint8Array)]);
      }
    } catch {
      await stream.sink([new Uint8Array(0)]);
    }
  });
}
```

- [ ] **Step 2: Add APIs to `packages/net/src/node.ts`**

```ts
import { requestHeaders, requestBlocks } from './headers.js';

// In the NetNode class, after requestSubBlock:

async requestHeaders(startHeight: number, maxCount: number, peerId: string): Promise<BlockHeader[]> {
  if (!this.libp2p) throw new Error('NetNode not started');
  return requestHeaders(this.libp2p, startHeight, maxCount, peerId, this.config);
}

async requestBlocks(startHeight: number, endHeight: number, peerId: string): Promise<OrderingBlock[]> {
  if (!this.libp2p) throw new Error('NetNode not started');
  return requestBlocks(this.libp2p, startHeight, endHeight, peerId, this.config);
}
```

Also import `BlockHeader`, `OrderingBlock` at the top of node.ts.

- [ ] **Step 3: Update `packages/net/src/index.ts`**

```ts
export { HEADERS_PROTOCOL } from './headers.js';
```

- [ ] **Step 4: Run net tests**

```bash
pnpm --filter @dagsocial/net test
```

Expected: 28 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/net/src/headers.ts packages/net/src/node.ts packages/net/src/index.ts
git commit -m "feat: add headers sync protocol /dagsocial/headers/1

requestHeaders fetches up to 20 BlockHeaders from a peer.
requestBlocks fetches full OrderingBlocks by height range.
Handler registered during start(). CBOR request/response over libp2p stream.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Register headers handler in index.ts

**Files:**
- Modify: `packages/node/src/index.ts`

- [ ] **Step 1: Register the headers sync handler after net.start()**

In `index.ts`, after the `net.setSyncHandler(...)` block (line 130), add:

```ts
// Register headers handler for fork resolution sync
net.getHeadersHandler(getOrderingBlock);
```

Wait — the headers handler pattern is different from the sub-block sync handler. The sub-block handler uses `setSyncHandler` with a callback. For headers, we need a different pattern — the handler is registered inside `registerHeadersHandler` which takes `libp2p` and a `getOrderingBlock` callback.

Since `NetNode` wraps libp2p, we should add a method to expose the handler registration. Let me add it to `NetNode`:

In `packages/net/src/node.ts`, add after `setSyncHandler`:
```ts
setHeadersHandler(getBlock: (height: number) => OrderingBlock | null): void {
  if (!this.libp2p) throw new Error('NetNode not started');
  registerHeadersHandler(this.libp2p, getBlock);
}
```

Then in `index.ts`:
```ts
net.setHeadersHandler(getOrderingBlock);
```

- [ ] **Step 2: Build and typecheck**

```bash
pnpm build && pnpm typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/node/src/index.ts packages/net/src/node.ts
git commit -m "feat: register headers sync handler on startup

setHeadersHandler exposes the /dagsocial/headers/1 protocol handler
through NetNode. Node registers it with its store-backed getOrderingBlock.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Tests — block-apply journal recording

**Files:**
- Create: `packages/node/test/services/block-apply.test.ts`

- [ ] **Step 1: Write tests**

Test that `applyOrderingBlock` records journal entries:
- Coinbase mint → `creditBoxIds` populated
- Post confirm → `confirmedSubBlockIds` populated
- Like tally → `talliedLikeBoxIds` populated
- Epoch tally karma mints → `karmaMints` populated
- UTXO tx apply → `appliedUtxoTxs` populated

Test that a rejected block (invalid PoW, wrong height, etc.) does NOT leave a journal.

Use the existing test infrastructure (in-memory SQLite, helper to create valid blocks).

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @dagsocial/node test -- --reporter verbose 2>&1 | grep "block-apply"
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add packages/node/test/services/block-apply.test.ts
git commit -m "test: block-apply journal recording

Tests verify journal entries for coinbase, post confirm, like tally,
epoch karma mints, UTXO tx apply. Rejection path leaves no journal.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Tests — fork resolution (detection, comparison, reorg)

**Files:**
- Create: `packages/node/test/services/fork-resolution.test.ts`

- [ ] **Step 1: Write tests**

Test `extendsOurTip`: true for matching prevBlockHash, false for mismatch.

Test `cumulativeWork`: equal targets → same work. Higher target → double work per increment.

Test `findForkPoint`: common ancestor at height 1, no common ancestor, depth limit exceeded.

Test `revertBlock`: journal entries are reversed (credit boxes deleted, karma burned, posts unconfirmed, like boxes unspent, UTXO txs reversed).

Test `reorg`: 2-block reorg fully reverses old chain and applies new chain. State matches new chain after reorg.

Test mempool re-insertion: UTXO txs from reverted blocks appear in mempool after reorg.

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @dagsocial/node test -- --reporter verbose 2>&1 | grep "fork-resolution"
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add packages/node/test/services/fork-resolution.test.ts
git commit -m "test: fork resolution — detection, scoring, rollback, reorg

Tests cover extendsOurTip, cumulativeWork, findForkPoint, revertBlock
per-mutation reversal, full reorg, and mempool re-insertion.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Tests — net headers protocol

**Files:**
- Modify: `packages/net/test/gossip.test.ts` (or create `packages/net/test/headers.test.ts`)

- [ ] **Step 1: Write tests**

Test `requestHeaders` returns headers newest-first, limited by maxCount.
Test `requestHeaders` returns empty when peer has no blocks at requested height.
Test `requestBlocks` returns full blocks for a height range.
Test handler serves headers from store-backed data.

- [ ] **Step 2: Run net tests**

```bash
pnpm --filter @dagsocial/net test
```

Expected: all pass (28 + new tests).

- [ ] **Step 3: Commit**

```bash
git add packages/net/test/
git commit -m "test: headers sync protocol request/response

Tests cover header request with maxCount limit, empty response,
block request by height range, and handler serving store data.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: Build, typecheck, full test run

**Files:**
- None (verification only)

- [ ] **Step 1: Full build**

```bash
pnpm build 2>&1
```

Expected: all 4 packages build.

- [ ] **Step 2: Full typecheck**

```bash
pnpm typecheck 2>&1
```

Expected: clean.

- [ ] **Step 3: Full test run**

```bash
pnpm test 2>&1
```

Expected: all tests pass (379 existing + new tests from Tasks 8-10).

- [ ] **Step 4: Commit any final fixes**

```bash
git add -A
git diff --cached --stat
git commit -m "chore: final build/typecheck fixes for fork resolution"
```
