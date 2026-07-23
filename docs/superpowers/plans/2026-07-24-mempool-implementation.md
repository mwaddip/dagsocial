# Unified Mempool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all direct UTXO state mutations with a unified mempool — every state-changing operation queues through the pool and is committed atomically when an ordering block lands.

**Architecture:** New `store/mempool.ts` with a single SQLite table (type discriminator for subblock vs utxo_tx). UTXO engine split into `validateTx` (read-only), `revalidateTxInContext` (lightweight staleness check), `applyTx` (write). Block creator polls mempool, resolves batches, populates `utxoTxIds`. HTTP routes validate → insert into pool → broadcast → return pending. Old `sub_blocks` table removed at the end.

**Tech Stack:** TypeScript, better-sqlite3, Node.js ≥ 22, vitest

## Global Constraints

- Post content: 1–300 UTF-8 bytes (`MAX_CONTENT_BYTES`)
- Parent refs: 0–8 per post
- Signatures: raw Ed25519 (64 bytes), base64 on wire. Verified with `crypto.verify(null, ...)` using a KeyObject.
- Hashing: `blake2b512` with `.subarray(0, 32)` for all 32-byte outputs
- Secret keys never in API responses or DTOs
- Protocol version on every post and block (`PROTOCOL_VERSION = 1`)
- No migration concerns — fresh DB per iteration
- TDD: write failing test first, then implementation
- Frequent commits: one per task

---

### Task 1: Create mempool store

**Files:**
- Create: `packages/node/src/store/mempool.ts`
- Create: `packages/node/test/store/mempool.test.ts`
- Modify: `packages/node/src/store/db.ts` (add mempool table to MIGRATIONS)

**Interfaces:**
- Produces: `insertSubBlock`, `insertUtxoTx`, `getPendingEntries`, `purgeExpired`, `removeEntry`, `removeBatch` — consumed by Tasks 4-9.

**PoolEntry type (store/mempool.ts):**
```typescript
export interface PoolEntry {
  rowid: number;
  entryType: 'subblock' | 'utxo_tx';
  subblockCbor: Uint8Array | null;
  utxoTxCbor: Uint8Array | null;
  batchId: string | null;
  expiresAtHeight: number;
  createdAt: string;
}
```

**SQL schema to add to `MIGRATIONS` in `db.ts` (after the sub_blocks table, which stays for now):**
```sql
CREATE TABLE IF NOT EXISTS mempool (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_type TEXT NOT NULL CHECK(entry_type IN ('subblock', 'utxo_tx')),
  subblock_cbor BLOB,
  utxo_tx_cbor BLOB,
  batch_id TEXT,
  expires_at_height INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 1: Add mempool table to MIGRATIONS in db.ts**

In `packages/node/src/store/db.ts`, add the mempool CREATE TABLE to the `MIGRATIONS` array after the `sub_blocks` table definition. The old `sub_blocks` table stays for now — it will be removed in Task 10.

- [ ] **Step 2: Write failing test for insertSubBlock and getPendingEntries**

Create `packages/node/test/store/mempool.test.ts`. Use the dynamic-import pattern (Pattern B from existing store tests — `vi.resetModules()` in beforeEach, dynamic imports of `initDb`/`getDb` and mempool functions).

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { encodeSubBlock } from '@dagsocial/types';
import type { SubBlock } from '@dagsocial/types';

// Dynamic import pattern — fresh modules per test
async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod;
}
async function importMempoolFresh() {
  const mod = await import('../../src/store/mempool.js');
  return mod;
}

function makeSubBlock(overrides?: Partial<SubBlock>): SubBlock {
  return {
    subBlockId: 'sb_test1',
    post: {
      id: 'post_test1',
      content: 'hello',
      author: new Uint8Array(32).fill(1),
      parentRefs: [],
      challenge: new Uint8Array(32).fill(2),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: Date.now(),
      signature: new Uint8Array(64),
    },
    likeBoxes: [],
    producerId: new Uint8Array(32).fill(3),
    protocolVersion: 1,
    ...overrides,
  };
}

describe('mempool store', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await importDbFresh();
    db.initDb(':memory:');
  });

  afterEach(async () => {
    const db = await importDbFresh();
    db.closeDb();
  });

  it('inserts a subblock and retrieves it via getPendingEntries', async () => {
    const { insertSubBlock, getPendingEntries } = await importMempoolFresh();
    const sb = makeSubBlock();

    const rowid = insertSubBlock(sb, 100); // expires at height 100
    const entries = getPendingEntries(10);

    expect(entries).toHaveLength(1);
    expect(entries[0].rowid).toBe(rowid);
    expect(entries[0].entryType).toBe('subblock');
    expect(entries[0].subblockCbor).toBeInstanceOf(Uint8Array);
    expect(entries[0].batchId).toBeNull();
    expect(entries[0].expiresAtHeight).toBe(100);
  });

  it('inserts a UTXO transaction and retrieves it', async () => {
    const { insertUtxoTx, getPendingEntries } = await importMempoolFresh();
    // Construct a minimal UtxoTransaction
    const { encodeTx } = await import('@dagsocial/types');
    const tx = {
      inputs: ['box1'],
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    };
    const txCbor = encodeTx(tx as any);

    const rowid = insertUtxoTx(tx as any, null, 200);
    const entries = getPendingEntries(10);

    expect(entries).toHaveLength(1);
    expect(entries[0].entryType).toBe('utxo_tx');
    expect(entries[0].utxoTxCbor).toBeInstanceOf(Uint8Array);
    expect(entries[0].expiresAtHeight).toBe(200);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm --filter @dagsocial/node exec vitest run test/store/mempool.test.ts
```
Expected: FAIL — module not found or functions not exported.

- [ ] **Step 4: Implement insertSubBlock and getPendingEntries in store/mempool.ts**

```typescript
import { getDb } from './db.js';
import type { SubBlock, UtxoTransaction } from '@dagsocial/types';
import { encodeSubBlock, encodeTx } from '@dagsocial/types';

export interface PoolEntry {
  rowid: number;
  entryType: 'subblock' | 'utxo_tx';
  subblockCbor: Uint8Array | null;
  utxoTxCbor: Uint8Array | null;
  batchId: string | null;
  expiresAtHeight: number;
  createdAt: string;
}

interface MempoolRow {
  rowid: number;
  entry_type: string;
  subblock_cbor: Buffer | null;
  utxo_tx_cbor: Buffer | null;
  batch_id: string | null;
  expires_at_height: number;
  created_at: string;
}

function rowToEntry(row: MempoolRow): PoolEntry {
  return {
    rowid: row.rowid,
    entryType: row.entry_type as 'subblock' | 'utxo_tx',
    subblockCbor: row.subblock_cbor ? new Uint8Array(row.subblock_cbor) : null,
    utxoTxCbor: row.utxo_tx_cbor ? new Uint8Array(row.utxo_tx_cbor) : null,
    batchId: row.batch_id,
    expiresAtHeight: row.expires_at_height,
    createdAt: row.created_at,
  };
}

export function insertSubBlock(
  subBlock: SubBlock,
  expiresAtHeight: number,
  batchId: string | null = null,
): number {
  const db = getDb();
  const cbor = encodeSubBlock(subBlock);
  const result = db.prepare(
    `INSERT INTO mempool (entry_type, subblock_cbor, batch_id, expires_at_height)
     VALUES ('subblock', ?, ?, ?)`,
  ).run(Buffer.from(cbor), batchId, expiresAtHeight);
  return Number(result.lastInsertRowid);
}

export function insertUtxoTx(
  tx: UtxoTransaction,
  batchId: string | null,
  expiresAtHeight: number,
): number {
  const db = getDb();
  const cbor = encodeTx(tx);
  const result = db.prepare(
    `INSERT INTO mempool (entry_type, utxo_tx_cbor, batch_id, expires_at_height)
     VALUES ('utxo_tx', ?, ?, ?)`,
  ).run(Buffer.from(cbor), batchId, expiresAtHeight);
  return Number(result.lastInsertRowid);
}

export function getPendingEntries(limit: number): PoolEntry[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT rowid, entry_type, subblock_cbor, utxo_tx_cbor, batch_id,
            expires_at_height, created_at
     FROM mempool
     ORDER BY rowid ASC
     LIMIT ?`,
  ).all(limit) as MempoolRow[];
  return rows.map(rowToEntry);
}

export function purgeExpired(currentHeight: number): number {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM mempool WHERE expires_at_height < ?',
  ).run(currentHeight);
  return result.changes;
}

export function removeEntry(rowid: number): void {
  const db = getDb();
  db.prepare('DELETE FROM mempool WHERE rowid = ?').run(rowid);
}

export function removeBatch(batchId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM mempool WHERE batch_id = ?').run(batchId);
}
```

Note: `encodeSubBlock` and `encodeTx` must exist in `@dagsocial/types`. Check if `encodeSubBlock` exists — if not, add a thin wrapper that CBOR-encodes the sub-block (same pattern as `encodeTx` and `encodePost`).

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @dagsocial/node exec vitest run test/store/mempool.test.ts
```
Expected: 2 tests PASS.

- [ ] **Step 6: Write additional tests for remaining API surface**

Add tests for:
- `insertSubBlock` with `batchId` — retrieved entry has matching batchId
- `insertUtxoTx` with `batchId` — same
- `getPendingEntries` with limit — returns at most N entries
- `getPendingEntries` ordering — FIFO by rowid
- `purgeExpired` — removes entries with `expires_at_height < currentHeight`, leaves others
- `removeEntry` — removes specific row
- `removeBatch` — removes all entries with given batchId
- Multiple entries — insert 3, get 3, verify order
- Mixed types — subblock and utxo_tx in the same pool

- [ ] **Step 7: Run full test suite for the new tests**

```bash
pnpm --filter @dagsocial/node exec vitest run test/store/mempool.test.ts
```
Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/node/src/store/mempool.ts packages/node/src/store/db.ts packages/node/test/store/mempool.test.ts
git commit -m "feat: add mempool store with unified subblock/UTXO pool

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Export mempool from store index

**Files:**
- Modify: `packages/node/src/store/index.ts`

**Interfaces:**
- Produces: mempool exports available via `store/index.ts` — consumed by Tasks 4-9.

- [ ] **Step 1: Add mempool re-exports to store/index.ts**

Add at the end of the existing re-exports:
```typescript
export {
  insertSubBlock,
  insertUtxoTx,
  getPendingEntries,
  purgeExpired,
  removeEntry,
  removeBatch,
} from './mempool.js';
export type { PoolEntry } from './mempool.js';
```

- [ ] **Step 2: Verify typecheck passes**

```bash
pnpm typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/node/src/store/index.ts
git commit -m "feat: export mempool store from store/index

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Split UTXO engine — validateTx, revalidateTxInContext, applyTx

**Files:**
- Modify: `packages/node/src/services/utxo-engine.ts`
- Modify: `packages/node/test/services/utxo-engine.test.ts`

**Interfaces:**
- Produces: `validateTx(deps, tx, currentHeight) → UtxoResult`, `revalidateTxInContext(deps, tx, currentHeight) → UtxoResult`, `applyTx(deps, tx, currentHeight) → void` — consumed by Tasks 4-8.
- Existing `validateAndApplyTx` stays as a convenience that calls validate + apply (used during block finalization and for backward compat during migration).

**Design:** Extract the validation logic from `validateAndApplyTx` into a standalone `validateTx` that is read-only (does not call `deps.runInTransaction` or mutate state). Then split the application step into `applyTx` (write). Add `revalidateTxInContext` that only checks input liveness and decay expiry — skips signature verification.

The current `validateAndApplyTx` steps (lines 240-402 of utxo-engine.ts):
1. No duplicate input IDs
2. All inputs exist and are unspent
3. All inputs same boxType
4. Value conservation
5. Guard satisfaction (signatures, hashes)
6. Legal box transitions
7. Karma decay calculation
8. Apply (consumeBox + insertBox in transaction)

`validateTx` covers steps 1-7 (read-only, returns result).
`applyTx` covers step 8 (write, inside `runInTransaction`).
`revalidateTxInContext` covers a subset: step 2 (still unspent?) + step 7 (decay not expired?). Skips steps 3-6 (already validated).

- [ ] **Step 1: Write failing test for validateTx returning without applying**

In `test/services/utxo-engine.test.ts`, add a test that calls `validateTx` and verifies no boxes are consumed:

```typescript
it('validateTx checks guards and transitions but does not mutate state', async () => {
  const { validateTx } = await import('../../src/services/utxo-engine.js');
  // Set up: insert a karma box, create a valid transfer tx
  const karmaBox = makeKarmaBox({ id: 'box1', value: 100, owner: alice });
  deps.insertBox(karmaBox);
  const tx = makeTransferTx(karmaBox, bob, 50);

  const result = validateTx(deps, tx, 0);
  expect(result.valid).toBe(true);

  // Box should still exist and be unspent
  const box = deps.getBox('box1');
  expect(box).not.toBeNull();
  expect(box!.spentAtBlock).toBeNull();
  // No new boxes created
  const bobBox = deps.getKarmaBox(bob);
  expect(bobBox).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @dagsocial/node exec vitest run test/services/utxo-engine.test.ts -t "validateTx checks"
```
Expected: FAIL — `validateTx` not exported or not found.

- [ ] **Step 3: Extract validateTx from validateAndApplyTx**

In `utxo-engine.ts`, extract steps 1-7 into a new exported function:

```typescript
export function validateTx(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): UtxoResult {
  // Step 1: No duplicate input IDs
  const inputIds = new Set<string>();
  for (const id of tx.inputs) {
    if (inputIds.has(id)) {
      return { valid: false, error: `Duplicate input: ${id}` };
    }
    inputIds.add(id);
  }

  // Step 2: All inputs exist and are unspent
  const inputBoxes: AnyBox[] = [];
  for (const id of tx.inputs) {
    const box = deps.getBox(id);
    if (!box) return { valid: false, error: `Input box not found: ${id}` };
    if (box.spentAtBlock !== null) {
      return { valid: false, error: `Input box already spent: ${id}` };
    }
    inputBoxes.push(box);
  }

  // Step 3: All inputs same boxType
  const boxType = inputBoxes[0].boxType;
  for (const box of inputBoxes) {
    if (box.boxType !== boxType) {
      return { valid: false, error: 'Mixed box types in inputs' };
    }
  }

  // Step 4: Value conservation (with decay and bond burning)
  const valueCheck = checkValueConservation(inputBoxes, tx.outputs, currentBlockHeight);
  if (!valueCheck.valid) return valueCheck;

  // Step 5: Guard satisfaction
  const guardCheck = checkGuards(deps, tx, inputBoxes);
  if (!guardCheck.valid) return guardCheck;

  // Step 6: Legal box transitions
  const transitionCheck = checkTransitions(inputBoxes, tx.outputs);
  if (!transitionCheck.valid) return transitionCheck;

  // Step 7: Karma decay
  const decayCheck = checkKarmaDecay(inputBoxes, tx.outputs, currentBlockHeight);
  if (!decayCheck.valid) return decayCheck;

  // Compute output IDs
  const outputsWithIds = tx.outputs.map((box) => ({
    ...box,
    id: computeBoxId(box),
  }));

  return {
    valid: true,
    computedOutputs: outputsWithIds,
    txId: computeTxId(tx),
  };
}
```

Note: The internal helper functions (`checkValueConservation`, `checkGuards`, `checkKarmaDecay`) are extracted from the current monolithic `validateAndApplyTx` body (lines 240-402 of `utxo-engine.ts`). Each block of validation logic becomes a named function. No logic changes, only extraction. The `checkKarmaDecay` helper is shared between `validateTx` and `revalidateTxInContext` — extract it once and import from both places.

- [ ] **Step 4: Extract applyTx from validateAndApplyTx**

```typescript
export function applyTx(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  outputsWithIds: AnyBox[],
  currentBlockHeight: number,
): void {
  deps.runInTransaction(() => {
    for (const id of tx.inputs) {
      deps.consumeBox(id, currentBlockHeight);
    }
    for (const box of outputsWithIds) {
      deps.insertBox(box);
    }
  });
}
```

- [ ] **Step 5: Write revalidateTxInContext**

```typescript
export function revalidateTxInContext(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): UtxoResult {
  // Only check liveness — are inputs still unspent?
  for (const id of tx.inputs) {
    const box = deps.getBox(id);
    if (!box) return { valid: false, error: `Input box not found: ${id}` };
    if (box.spentAtBlock !== null) {
      return { valid: false, error: `Input box already spent: ${id}` };
    }
  }

  // Check karma decay hasn't expired (height-dependent)
  const inputBoxes = tx.inputs
    .map((id) => deps.getBox(id)!)
    .filter(Boolean);
  const decayCheck = checkKarmaDecay(inputBoxes, tx.outputs, currentBlockHeight);
  if (!decayCheck.valid) return decayCheck;

  return { valid: true };

  function checkKarmaDecay(
    inputs: AnyBox[],
    outputs: AnyBox[],
    currentHeight: number,
  ): UtxoResult {
    // Only relevant for karma boxes — apply storage rent at current height
    // [reuse existing decay logic but only check, don't apply]
    // If any karma box has decayed past its floor at currentHeight, reject
    const karmaInputs = inputs.filter((b) => b.boxType === 'karma');
    if (karmaInputs.length === 0) return { valid: true };

    // Calculate effective value at current height
    // [extracted from current validateAndApplyTx karma decay section]
    // ...
    return { valid: true };
  }
}
```

Note: The exact karma decay check logic should match what's currently in `validateAndApplyTx`. Extract it into a shared helper used by both `validateTx` and `revalidateTxInContext`.

- [ ] **Step 6: Update validateAndApplyTx to use the new functions**

```typescript
export function validateAndApplyTx(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): UtxoResult {
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) return result;

  applyTx(deps, tx, result.computedOutputs!, currentBlockHeight);
  return result;
}
```

- [ ] **Step 7: Run existing UTXO engine tests to verify no regression**

```bash
pnpm --filter @dagsocial/node exec vitest run test/services/utxo-engine.test.ts
```
Expected: all existing tests PASS (they use `validateAndApplyTx`, which now delegates to the split functions).

- [ ] **Step 8: Run full test suite**

```bash
pnpm test
```
Expected: all 326 tests PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/node/src/services/utxo-engine.ts packages/node/test/services/utxo-engine.test.ts
git commit -m "refactor: split UTXO engine into validateTx, revalidateTxInContext, applyTx

validateAndApplyTx preserved as convenience that delegates to the split functions.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Update block creator to use mempool

**Files:**
- Modify: `packages/node/src/services/block-creator.ts`
- Modify: `packages/node/test/services/block-creator.test.ts`

**Interfaces:**
- Consumes: `getPendingEntries`, `purgeExpired`, `removeEntry`, `removeBatch` from mempool store; `validateTx`, `applyTx` from UTXO engine
- Produces: `createOrderingBlock` now populates `utxoTxIds` from mempool. `finalizeBlock` removes confirmed entries from mempool.

**Key changes:**
1. `createOrderingBlock` replaces `getPendingSubBlocks()` with `getPendingEntries(maxEntries)`.
2. At block assembly, resolve batches: sub-blocks with a `batch_id` get their linked UTXO payloads included.
3. Scan standalone like `utxo_tx` entries — attach to matching sub-blocks by post ID. Remaining standalone entries go into `utxoTxIds`.
4. `utxoTxIds` is no longer `[]` — it's populated from standalone UTXO entries.
5. `finalizeBlock` calls `removeEntry` for each confirmed pool entry.
6. `purgeExpired` is called at the start of `createOrderingBlock`.

- [ ] **Step 1: Write failing test for utxoTxIds population**

In `test/services/block-creator.test.ts`, add a test:

```typescript
it('populates utxoTxIds from mempool standalone UTXO entries', async () => {
  const db = await importDb();
  db.initDb(':memory:');
  const ids = await importIdentities();
  const posts = await importPosts();
  const utxo = await importUtxo();
  const mempool = await importMempoolFresh();
  const bc = await importBlockCreator();

  // Set up: identity, post, sub-block in mempool
  const author = makeTestIdentity();
  ids.insertIdentity(author.userId, author.publicKey);
  const post = makePost({ author: author.userId });
  posts.insertPost(post, encodePost(post));
  const sb = makeSubBlock({ post });
  mempool.insertSubBlock(sb, 1000);

  // Set up: standalone UTXO transaction in mempool (like with no matching post)
  const karmaBox = makeKarmaBox({ id: 'kbox1', owner: author.userId, value: 100 });
  utxo.insertBox(karmaBox);
  const likeTx = makeLikeTx(karmaBox, 'some_post_id_not_matching');
  mempool.insertUtxoTx(likeTx, null, 1000);

  bc.startBlockCreator(testConfig);
  const block = bc.createOrderingBlock();

  expect(block).not.toBeNull();
  expect(block!.utxoTxIds.length).toBeGreaterThan(0);
  // The standalone like should be in utxoTxIds
  expect(block!.utxoTxIds).toContain(computeTxId(likeTx));
  // Confirmed entries removed from mempool
  const remaining = mempool.getPendingEntries(100);
  expect(remaining).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @dagsocial/node exec vitest run test/services/block-creator.test.ts -t "populates utxoTxIds"
```
Expected: FAIL — `utxoTxIds` is still `[]`.

- [ ] **Step 3: Update createOrderingBlock to use mempool**

In `block-creator.ts`, replace the `getPendingSubBlocks(config.maxSubBlocksPerBlock)` call with mempool polling:

```typescript
import {
  getPendingEntries,
  purgeExpired,
  removeEntry,
  removeBatch,
  type PoolEntry,
} from '../store/mempool.js';
import { decodeSubBlock, decodeTx } from '@dagsocial/types';

// Inside createOrderingBlock():
const currentHeight = getCurrentHeight();

// 1. Purge expired
purgeExpired(currentHeight);

// 2. Get pending entries
const entries = getPendingEntries(config.maxSubBlocksPerBlock);
if (entries.length === 0 && config.nodeRole !== 'miner' && currentHeight > 0) {
  return null; // nothing to do (server role, non-genesis)
}

// 3. Separate sub-blocks and standalone UTXO transactions
const subBlockEntries = entries.filter((e) => e.entryType === 'subblock');
const standaloneUtxoTxs = entries.filter((e) => e.entryType === 'utxo_tx' && e.batchId === null);

// 4. Resolve batches — collect batch-linked UTXO payloads for each sub-block
const batchMap = new Map<string, PoolEntry[]>();
for (const e of entries) {
  if (e.batchId) {
    if (!batchMap.has(e.batchId)) batchMap.set(e.batchId, []);
    batchMap.get(e.batchId)!.push(e);
  }
}

// 5. Decode sub-blocks
const subBlocks = subBlockEntries.map((e) => decodeSubBlock(e.subblockCbor!));

// 6. Attach standalone likes to matching sub-blocks
const matchedUtxoRowids = new Set<number>();
for (const entry of standaloneUtxoTxs) {
  const tx = decodeTx(entry.utxoTxCbor!);
  // Check if this like targets a post in a pending sub-block
  const targetPostId = extractLikeTarget(tx); // from extra_data or output guard
  if (targetPostId) {
    const matchingSb = subBlocks.find((sb) => sb.post.id === targetPostId);
    if (matchingSb) {
      // Attach like boxes to the sub-block
      for (const output of tx.outputs) {
        if (output.boxType === 'like') {
          matchingSb.likeBoxes.push(output as LikeBox);
        }
      }
      matchedUtxoRowids.add(entry.rowid);
    }
  }
}

// 7. Remaining standalone UTXO entries → utxoTxIds
const remainingUtxoTxs = standaloneUtxoTxs.filter(
  (e) => !matchedUtxoRowids.has(e.rowid),
);
const utxoTxIds = remainingUtxoTxs.map((e) => {
  const tx = decodeTx(e.utxoTxCbor!);
  return computeTxId(tx);
});

// 8. Deduplicate like boxes (existing logic)
const standaloneLikes = getUnprocessedLockedLikeBoxes();
const sbLikeIds = new Set(subBlocks.flatMap((sb) => sb.likeBoxes.map((lb) => lb.id)));
const filteredStandaloneLikes = standaloneLikes.filter(
  (lb) => !sbLikeIds.has(lb.id),
);

// 9. Collect all like box IDs
const allLikeBoxIds = [
  ...subBlocks.flatMap((sb) => sb.likeBoxes.map((lb) => lb.id!)),
  ...filteredStandaloneLikes.map((lb) => lb.id!),
];

// ... rest of existing logic (epoch tally, coinbase, PoW, etc.) ...
// Replace the placeholder:
//   utxoTxIds: [],
// with:
//   utxoTxIds,
```

Helper to extract like target from a UTXO transaction — add to `block-creator.ts`:
```typescript
function extractLikeTarget(tx: UtxoTransaction): string | null {
  for (const output of tx.outputs) {
    if (output.boxType === 'like') {
      // LikeBox has targetPostId in extra_data (JSON string)
      const extra = typeof output.extra_data === 'string'
        ? JSON.parse(output.extra_data)
        : output.extra_data || {};
      return extra.targetPostId || null;
    }
  }
  return null;
}
```
Check the existing LikeBox `extra_data` field in `packages/types/src/utxo.ts` for the exact field name and shape — adjust the helper accordingly.

- [ ] **Step 4: Update finalizeBlock to remove confirmed entries from mempool**

In `finalizeBlock`, after confirming sub-blocks and applying UTXO state, remove entries from the mempool:

```typescript
// Inside finalizeBlock(), after confirming posts:
for (const ref of block.subBlockRefs) {
  confirmPost(ref, block.height);
}
// Remove confirmed entries from mempool
// Find the rowids that were included — track them from createOrderingBlock
for (const rowid of confirmedRowids) {
  removeEntry(rowid);
}
```

You'll need to track `confirmedRowids` — the set of mempool rowids that were included in the block. Pass them from `createOrderingBlock` (or store them as module-level state alongside the external mining template). The simplest approach: store `confirmedRowids` alongside `currentTemplate` for external mode, or process them inline for internal mode.

- [ ] **Step 5: Run the new test to verify it passes**

```bash
pnpm --filter @dagsocial/node exec vitest run test/services/block-creator.test.ts -t "populates utxoTxIds"
```
Expected: PASS.

- [ ] **Step 6: Run all block-creator tests**

```bash
pnpm --filter @dagsocial/node exec vitest run test/services/block-creator.test.ts
```
Expected: all tests PASS (some may need updates — the existing tests use `getPendingSubBlocks`, which is now replaced by mempool. Update test setup to use `mempool.insertSubBlock` instead of `insertSubBlock` from the old store).

- [ ] **Step 7: Run full test suite**

```bash
pnpm test
```

- [ ] **Step 8: Commit**

```bash
git add packages/node/src/services/block-creator.ts packages/node/test/services/block-creator.test.ts
git commit -m "feat: block creator polls mempool and populates utxoTxIds

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Update index.ts — queue relayed messages into mempool

**Files:**
- Modify: `packages/node/src/index.ts`

**Interfaces:**
- Consumes: `insertSubBlock`, `insertUtxoTx` from mempool; `validateTx` from UTXO engine
- Changes: `onTx` handler queues into mempool instead of applying. `onSubBlock` handler queues into mempool. `applyOrderingBlock` applies `utxoTxIds` entries.

**Key changes:**

1. **onTx handler** (currently lines 83-100): Replace `validateAndApplyTx` with `validateTx` → `insertUtxoTx`. Remove the `runInTransaction` deps — validation is read-only.

2. **onSubBlock handler** (currently lines 55-77): Replace `insertSubBlock(sb)` (old store) with `mempool.insertSubBlock(sb, currentHeight + 720)`. Remove the direct `insertBox` for like boxes — they're part of the sub-block's `likeBoxes` array.

3. **applyOrderingBlock** (lines 133-245): Add processing of `block.utxoTxIds`. For each tx ID in the block, decode the transaction from the block's stored data (or from the mempool before removal), call `revalidateTxInContext` → `applyTx`, then remove from mempool.

Since transactions are stored in the mempool and the block only carries their IDs, `applyOrderingBlock` will need to look them up in the local mempool. If the transaction was already removed (e.g., by a prior block), skip it — it was already applied.

- [ ] **Step 1: Update onTx handler**

```typescript
import { insertUtxoTx, insertSubBlock } from './store/mempool.js';
import { validateTx } from './services/utxo-engine.js';

net.onTx((tx) => {
  const deps = {
    getBox,
    getKarmaBox,
    getIdentity,
    // No insertBox/consumeBox/runInTransaction — validateTx is read-only
  };
  const currentHeight = getCurrentHeight();
  const result = validateTx(deps, tx, currentHeight);
  if (!result.valid) {
    console.warn(`Relayed tx rejected: ${result.error}`);
    return;
  }
  const expiresAtHeight = currentHeight + 720;
  insertUtxoTx(tx, null, expiresAtHeight);
  console.log(`Relayed tx queued in mempool: ${result.txId}`);
});
```

- [ ] **Step 2: Update onSubBlock handler**

```typescript
net.onSubBlock((sb) => {
  const deps = { getPost, getBox, getKarmaBox, getIdentity, getParentRefs };
  const result = verifyPostForRelay(deps, sb.post, 0);
  if (!result.valid) {
    console.warn(`Relayed sub-block rejected: ${result.error}`);
    return;
  }
  insertPost(sb.post, encodePost(sb.post));
  const currentHeight = getCurrentHeight();
  insertSubBlock(sb, currentHeight + 720);
  console.log(`Relayed sub-block queued in mempool: ${sb.subBlockId}`);
});
```

Note: The old code had `insertBox(lb)` for each likeBox in the sub-block. Remove that — likeBoxes are part of the sub-block's stored CBOR and will be applied when the block confirms.

- [ ] **Step 3: Update applyOrderingBlock to process utxoTxIds**

In `applyOrderingBlock`, after the coinbase application and sub-block confirmation, add:

```typescript
// Apply UTXO transactions from the block
for (const txId of block.utxoTxIds) {
  // Look up in local mempool
  const entries = getPendingEntries(1000);
  const entry = entries.find((e) => {
    if (e.entryType !== 'utxo_tx' || !e.utxoTxCbor) return false;
    const tx = decodeTx(e.utxoTxCbor);
    return computeTxId(tx) === txId;
  });
  if (!entry) {
    // Already applied by a prior block or not in our mempool
    continue;
  }
  const tx = decodeTx(entry.utxoTxCbor!);
  const revalResult = revalidateTxInContext(utxoDeps, tx, block.height);
  if (!revalResult.valid) {
    console.warn(`UTXO tx ${txId} failed revalidation: ${revalResult.error}`);
    removeEntry(entry.rowid);
    continue;
  }
  applyTx(utxoDeps, tx, revalResult.computedOutputs!, block.height);
  removeEntry(entry.rowid);
}
```

Where `utxoDeps` is constructed with the real `getBox`, `insertBox`, `consumeBox`, `getKarmaBox`, `getIdentity`, and `runInTransaction` wrapping `db.transaction()`.

- [ ] **Step 4: Run tests**

```bash
pnpm test
```

Some tests may fail because they rely on the old immediate-apply behavior. Note which ones for later tasks but don't fix them yet — the route migrations will update those tests.

- [ ] **Step 5: Commit**

```bash
git add packages/node/src/index.ts
git commit -m "feat: queue relayed messages into mempool instead of applying immediately

onTx and onSubBlock now insert into mempool. applyOrderingBlock processes utxoTxIds.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Migrate likes to mempool

**Files:**
- Modify: `packages/node/src/routes/likes.ts`
- Modify: `packages/node/src/services/likes.ts`
- Modify: `packages/node/test/routes/likes.test.ts`
- Modify: `packages/node/test/services/likes.test.ts`

**Interfaces:**
- Consumes: `insertUtxoTx` from mempool; `validateTx` from UTXO engine
- Changes: `castLike` and `removeLike` build UTXO transactions, validate them, insert into mempool, and broadcast — instead of applying directly.

**Key changes in services/likes.ts — castLike:**

Replace the `db.transaction(() => { consumeBox/insertBox })` block with:
```typescript
// Build UTXO transaction
const tx: UtxoTransaction = {
  inputs: [karmaBox.id!],
  outputs: [newKarmaBox, likeBox],
  signatures: { [pubKeyHex]: signature },
  protocolVersion: PROTOCOL_VERSION,
};

// Validate (read-only)
const validateDeps = { getBox, getKarmaBox, getIdentity };
const result = validateTx(validateDeps, tx, currentBlockHeight);
if (!result.valid) {
  return { castLikeResult: 'rejected' as const, error: result.error };
}

// Insert into mempool
const expiresAtHeight = currentBlockHeight + 720;
insertUtxoTx(tx, null, expiresAtHeight);

return {
  castLikeResult: 'pending' as const,
  txId: result.txId,
  expiresAtHeight,
};
```

Similarly update `removeLike`.

**Key changes in routes/likes.ts:**

The route handler calls `deps.castLike(...)` and returns `{ status: "pending", txId, expiresAtHeight }`.

**Test changes:**

For service tests: update `castLike` tests to assert it returns `{ castLikeResult: 'pending' }` and that the mempool has the transaction, instead of checking karma box balance changes directly. Add a test that verifies the full path: validate → mempool → mine block → state changed.

For route tests: update assertions to check for 200 status with `{ status: "pending" }` instead of checking immediate balance changes.

- [ ] **Step 1: Update services/likes.ts — castLike and removeLike**

Replace direct UTXO mutations with validateTx + mempool insertion. The full changes follow the pattern above.

- [ ] **Step 2: Update routes/likes.ts — POST /likes and POST /likes/remove**

Return `{ status: "pending", txId, expiresAtHeight }` instead of the current response shape.

- [ ] **Step 3: Update service tests**

Rewrite `test/services/likes.test.ts` tests:
- Test that `castLike` with valid inputs returns `pending`
- Test that the mempool contains the expected transaction
- Test that `castLike` with insufficient karma still rejects (validation happens before mempool)
- Test full path: validate → mempool → mine block → state correct

- [ ] **Step 4: Update route tests**

Rewrite `test/routes/likes.test.ts` tests:
- Test that `POST /likes` returns 200 with `{ status: "pending", txId, expiresAtHeight }`
- Test that invalid likes (missing fields, wrong signature) still return errors
- Test that the mempool has the entry after the request

- [ ] **Step 5: Run like tests**

```bash
pnpm --filter @dagsocial/node exec vitest run test/services/likes.test.ts test/routes/likes.test.ts
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/node/src/services/likes.ts packages/node/src/routes/likes.ts \
        packages/node/test/services/likes.test.ts packages/node/test/routes/likes.test.ts
git commit -m "feat: migrate likes to mempool — validate, queue, return pending

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Migrate invites to mempool

**Files:**
- Modify: `packages/node/src/routes/invites.ts`
- Modify: `packages/node/src/services/invites.ts`
- Modify: `packages/node/test/routes/invites.test.ts`
- Modify: `packages/node/test/services/invites.test.ts`

**Interfaces:**
- Consumes: `insertUtxoTx` from mempool; `validateTx` from UTXO engine
- Changes: `createInvite`, `claimInvite`, `cancelInvite` build UTXO transactions instead of applying directly.

Same pattern as Task 6 (likes). Each function replaces its `db.transaction(() => { consumeBox/insertBox })` block with: build `UtxoTransaction` → `validateTx` → `insertUtxoTx` → return pending.

- [ ] **Step 1: Update services/invites.ts**

Replace direct UTXO mutations in `createInvite`, `claimInvite`, `cancelInvite` with validateTx + mempool insertion.

- [ ] **Step 2: Update routes/invites.ts**

Return `{ status: "pending", txId, expiresAtHeight }` for each endpoint.

- [ ] **Step 3: Update service and route tests**

Same pattern as Task 6.

- [ ] **Step 4: Run invite tests**

```bash
pnpm --filter @dagsocial/node exec vitest run test/services/invites.test.ts test/routes/invites.test.ts
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/node/src/services/invites.ts packages/node/src/routes/invites.ts \
        packages/node/test/services/invites.test.ts packages/node/test/routes/invites.test.ts
git commit -m "feat: migrate invites to mempool — validate, queue, return pending

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Migrate posts to mempool

**Files:**
- Modify: `packages/node/src/routes/posts.ts`
- Modify: `packages/node/test/routes/posts.test.ts`

**Interfaces:**
- Consumes: `insertSubBlock`, `insertUtxoTx` from mempool; `validateTx` from UTXO engine
- Changes: `POST /posts` inserts sub-block and batch-linked karma-lock UTXO transaction into mempool instead of calling `consumeBox`/`insertBox` directly.

**Key changes:**

The current `POST /posts` handler (lines 107-209 of posts.ts):
1. Verifies post (PoW, signature, challenge)
2. Locks karma: consumes karma box, inserts new karma box + PostLockBox (lines 180-182)
3. Inserts sub-block via `insertSubBlock(sb)` (old store)
4. Broadcasts sub-block

New flow:
1. Verifies post (same)
2. Builds karma-lock UTXO transaction (inputs: karma box, outputs: reduced karma + PostLockBox)
3. Validates via `validateTx` (read-only)
4. Generates a `batchId` (e.g., post ID or random UUID)
5. Inserts sub-block into mempool via `insertSubBlock(sb, expiresAtHeight, batchId)`
6. Inserts karma-lock UTXO tx into mempool via `insertUtxoTx(tx, batchId, expiresAtHeight)`
7. Broadcasts sub-block + UTXO tx

- [ ] **Step 1: Update routes/posts.ts**

Replace lines 180-182 (direct UTXO) and the subsequent `insertSubBlock` call with mempool batch insertion:

```typescript
// Build karma-lock UTXO transaction
const karmaLockTx: UtxoTransaction = {
  inputs: [karmaBox.id!],
  outputs: [newKarmaBox, postLockBox],
  signatures: { [pubKeyHex]: signature },
  protocolVersion: PROTOCOL_VERSION,
};

// Validate karma lock
const lockResult = validateTx(validateDeps, karmaLockTx, currentHeight);
if (!lockResult.valid) {
  return res.status(400).json({ error: `Karma lock failed: ${lockResult.error}` });
}

// Insert as batch
const batchId = post.id; // post ID serves as batch ID
const expiresAtHeight = currentHeight + 720;
insertSubBlock(subBlock, expiresAtHeight, batchId);
insertUtxoTx(karmaLockTx, batchId, expiresAtHeight);

// Broadcast
broadcastSubBlock(subBlock);
broadcastTx(karmaLockTx);

res.status(200).json({
  postId: post.id,
  status: 'pending',
  expiresAtHeight,
});
```

Remove the old `consumeBox`/`insertBox` calls and the `insertSubBlock` call to the old store.

- [ ] **Step 2: Update route tests**

Rewrite `test/routes/posts.test.ts` tests:
- Test that `POST /posts` returns 200 with `{ postId, status: 'pending', expiresAtHeight }`
- Test that the mempool has both entries (sub-block and UTXO tx) with matching batchId
- Test that invalid posts (bad PoW, wrong signature, missing fields) still return errors
- Test full path: post → mempool → mine block → karma locked + post confirmed

- [ ] **Step 3: Run post tests**

```bash
pnpm --filter @dagsocial/node exec vitest run test/routes/posts.test.ts
```
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/routes/posts.ts packages/node/test/routes/posts.test.ts
git commit -m "feat: migrate posts to mempool — batch-linked subblock + karma lock

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Migrate faucet to mempool

**Files:**
- Modify: `packages/node/src/routes/faucet.ts`
- Modify: `packages/node/test/routes/faucet.test.ts`

**Interfaces:**
- Consumes: `insertUtxoTx` from mempool; `validateTx` from UTXO engine
- Changes: `POST /faucet` builds a UTXO transaction (consume old karma box → insert with increased value) instead of calling `consumeBox`/`insertBox` directly.

Same pattern as Tasks 6-7 but simpler — faucet only does karma box top-up.

- [ ] **Step 1: Update routes/faucet.ts**

Replace direct `consumeBox`/`insertBox` calls with UTXO transaction construction → validateTx → insertUtxoTx → return pending.

- [ ] **Step 2: Update route tests**

Rewrite `test/routes/faucet.test.ts` tests for the pending response pattern.

- [ ] **Step 3: Run faucet tests**

```bash
pnpm --filter @dagsocial/node exec vitest run test/routes/faucet.test.ts
```
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/routes/faucet.ts packages/node/test/routes/faucet.test.ts
git commit -m "feat: migrate faucet to mempool — UTXO transaction instead of direct mutation

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Remove old subblocks store and final verification

**Files:**
- Delete: `packages/node/src/store/subblocks.ts`
- Delete: `packages/node/test/store/subblocks.test.ts`
- Modify: `packages/node/src/store/index.ts` (remove subblocks re-exports)
- Modify: `packages/node/src/store/db.ts` (remove `sub_blocks` table from MIGRATIONS)

**Interfaces:**
- Removes: `insertSubBlock` (old), `getPendingSubBlocks`, `getSubBlock`, `confirmSubBlock` — no remaining consumers after Tasks 4-9 migration.

- [ ] **Step 1: Verify no remaining imports of old subblocks store**

```bash
rtk proxy grep -r "from.*subblocks" packages/node/src/ --include="*.ts"
rtk proxy grep -r "subblocks\." packages/node/src/ --include="*.ts"
```
Expected: no results (all callers migrated to mempool).

- [ ] **Step 2: Remove subblocks.ts and its test**

```bash
rm packages/node/src/store/subblocks.ts
rm packages/node/test/store/subblocks.test.ts
```

- [ ] **Step 3: Remove subblocks re-exports from store/index.ts**

Remove the lines:
```typescript
export { insertSubBlock, getPendingSubBlocks, getSubBlock, confirmSubBlock } from './subblocks.js';
```

- [ ] **Step 4: Remove sub_blocks table from db.ts MIGRATIONS**

Remove the `DROP TABLE IF EXISTS sub_blocks` line and the `CREATE TABLE IF NOT EXISTS sub_blocks (...)` block.

- [ ] **Step 5: Run full test suite**

```bash
pnpm test
```
Expected: all tests PASS. Zero failures.

- [ ] **Step 6: Verify typecheck**

```bash
pnpm typecheck
```
Expected: no errors.

- [ ] **Step 7: Manual smoke test**

```bash
pnpm build
DB_PATH=/tmp/mempool-test.db PORT=3001 NODE_ROLE=miner MINING_MODE=internal node packages/node/dist/index.js &
sleep 3
# Test endpoints return pending status
curl -s http://localhost:3001/status | head -5
# Cleanup
kill %1
```

- [ ] **Step 8: Commit**

```bash
git add packages/node/src/store/subblocks.ts packages/node/test/store/subblocks.test.ts \
        packages/node/src/store/index.ts packages/node/src/store/db.ts
git commit -m "refactor: remove old subblocks store, replaced by unified mempool

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Post-Implementation Verification

After all 10 tasks are complete:

1. **Zero bypass paths:** Run `rtk proxy grep -r "consumeBox\|insertBox" packages/node/src/routes/ --include="*.ts"` — should return zero results (no direct UTXO mutations in HTTP routes).
2. **Block creator populates utxoTxIds:** Verify `createOrderingBlock` no longer sets `utxoTxIds: []`.
3. **Full test pass:** `pnpm test` — all 326+ tests pass.
4. **Typecheck:** `pnpm typecheck` — no errors.
5. **Build:** `pnpm build` — no errors.
