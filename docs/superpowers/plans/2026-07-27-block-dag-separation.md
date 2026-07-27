# Block/DAG Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove inline post CBOR from blocks. Blocks carry topology (`subBlockEntries: { postId, parentRefs }[]`) and stump IDs. Content is DAG-side only.

**Architecture:** Five tasks across three packages. Types change first (upstream), then validation, then node core (mempool + block pipeline), then node wiring (sync/routes/interfaces), then full test suite fix. Each task produces a buildable, testable state.

**Tech Stack:** TypeScript, better-sqlite3, vitest, cbor-x

## Global Constraints

- `SubBlockTree.subBlocks: Uint8Array[]` removed. `subBlockEntries: SubBlockEntry[]` added where `SubBlockEntry = { postId: string, parentRefs: string[] }`
- `BlockJournal.subBlockCbors` removed. `confirmedSubBlockIds` already covers the use case.
- Merkle root `computeSubBlockRoot` commits `subBlockEntries + stumpIds` (was `subBlockRefs + stumpIds`). Each entry hashed as `leafHash('subblock', JSON.stringify({ postId, parentRefs }))`
- Mempool `subblock_cbor BLOB` → `subblock_id TEXT NOT NULL`. `insertSubBlock` takes a post ID, not a SubBlock.
- `applyOrderingBlock` no longer calls `insertPost`. Creates placeholder rows for missing posts.
- `verifyOrderingBlockStructure` validates `subBlockEntries` array, drops `subBlocks` alignment check.
- No protocol version bump. Wire format version stays locked until stable.
- All test files referencing changed types/interfaces must be updated.
- **Deferred:** On-chain prune commit queuing (spec §7). `stumpIds` remains `[]` in the block creator. The `SubBlockTree.stumpIds` field and Merkle root computation over stumps are unchanged and ready — the queuing mechanism that populates non-empty `stumpIds` is a follow-up session (needs `pending_stumps` queue, gossip path for Stump objects, and block application of committed stumps).

---

### Task 1: Types Package — SubBlockTree and BlockJournal

**Files:**
- Modify: `packages/types/src/block.ts`
- Modify: `packages/types/src/journal.ts`
- Modify: `packages/types/src/serialization.ts`
- Modify: `packages/types/src/index.ts`
- Modify: `packages/types/test/` (serialization tests)

**Interfaces:**
- Consumes: nothing (upstream)
- Produces: `SubBlockEntry`, updated `SubBlockTree`, updated `BlockJournal`, updated `encodeSubBlockTree`/`decodeSubBlockTree`

- [ ] **Step 1: Add `SubBlockEntry` and update `SubBlockTree`**

In `packages/types/src/block.ts`, replace the `SubBlockTree` interface:

```typescript
export interface SubBlockEntry {
  postId: string;        // hex-encoded 32-byte post ID
  parentRefs: string[];  // hex-encoded parent post IDs (0–8 entries)
}

export interface SubBlockTree {
  subBlockRefs: PostId[];           // derived from subBlockEntries, kept for ordering
  subBlockEntries: SubBlockEntry[]; // topology committed in the block
  stumpIds: StumpId[];              // stumps committed in this block
}
```

- [ ] **Step 2: Remove `subBlockCbors` from `BlockJournal`**

In `packages/types/src/journal.ts`, remove the `subBlockCbors` field from `BlockJournal`:

```typescript
export interface BlockJournal {
  blockHeight: number;
  creditBoxIds: string[];
  confirmedSubBlockIds: string[];
  talliedLikeBoxIds: string[];
  karmaMints: KarmaMint[];
  appliedUtxoTxs: AppliedUtxoTx[];
  decayBurns: DecayJournalEntry[];
}
```

- [ ] **Step 3: Update exports**

In `packages/types/src/index.ts`, add `SubBlockEntry` to exports:

```typescript
export type { SubBlockEntry } from './block.js';
```

- [ ] **Step 4: Update serialization tests**

`encodeSubBlockTree`/`decodeSubBlockTree` use `toBuffer`/`fromBuffer` (cbor-x), which handles the new field automatically. Verify by adding a roundtrip test in `packages/types/test/`:

```typescript
it('roundtrips SubBlockTree with subBlockEntries', () => {
  const tree: SubBlockTree = {
    subBlockRefs: ['aa'.repeat(32), 'bb'.repeat(32)],
    subBlockEntries: [
      { postId: 'aa'.repeat(32), parentRefs: [] },
      { postId: 'bb'.repeat(32), parentRefs: ['aa'.repeat(32)] },
    ],
    stumpIds: [],
  };
  const encoded = encodeSubBlockTree(tree);
  const decoded = decodeSubBlockTree(encoded);
  expect(decoded.subBlockEntries).toEqual(tree.subBlockEntries);
  expect(decoded.subBlockRefs).toEqual(tree.subBlockRefs);
  expect(decoded.stumpIds).toEqual(tree.stumpIds);
});
```

- [ ] **Step 5: Verify types package builds**

```bash
pnpm --filter @dagsocial/types build
pnpm --filter @dagsocial/types test
```
Expected: build clean, all types tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/types/
git commit -m "feat(types): replace SubBlockTree.subBlocks with subBlockEntries, remove BlockJournal.subBlockCbors"
```

---

### Task 2: Validation Package — Update Block Structure Checks

**Files:**
- Modify: `packages/validation/src/verify.ts`
- Modify: `packages/validation/test/` (validation tests)

**Interfaces:**
- Consumes: `SubBlockTree.subBlockEntries` from Task 1
- Produces: updated `verifyOrderingBlockStructure`

- [ ] **Step 1: Update `verifyOrderingBlockStructure`**

In `packages/validation/src/verify.ts`, replace the `subBlocks` alignment check with a `subBlockEntries` check:

```typescript
// Replace lines 170-172 (subBlocks alignment check) with:
if (!Array.isArray(block.subBlockTree.subBlockEntries) ||
    block.subBlockTree.subBlockEntries.length !== block.subBlockTree.subBlockRefs.length) {
  return { valid: false, error: 'Ordering block subBlockEntries must align with subBlockRefs' };
}
// Validate each entry
for (const entry of block.subBlockTree.subBlockEntries) {
  if (typeof entry.postId !== 'string' || entry.postId.length !== 64) {
    return { valid: false, error: 'Ordering block subBlockEntry has invalid postId' };
  }
  if (!Array.isArray(entry.parentRefs) || entry.parentRefs.length > 8) {
    return { valid: false, error: 'Ordering block subBlockEntry has invalid parentRefs' };
  }
  for (const ref of entry.parentRefs) {
    if (typeof ref !== 'string' || ref.length !== 64) {
      return { valid: false, error: 'Ordering block subBlockEntry parentRef must be 64-char hex' };
    }
  }
}
```

- [ ] **Step 2: Update validation tests**

Update tests that construct `SubBlockTree` to include `subBlockEntries`. Add a test for invalid entries:

```typescript
it('rejects subBlockEntries with invalid postId', () => {
  const block = makeValidBlock();
  block.subBlockTree.subBlockEntries = [{ postId: 'too-short', parentRefs: [] }];
  const result = verifyOrderingBlockStructure(block);
  expect(result.valid).toBe(false);
  expect(result.error).toContain('invalid postId');
});
```

- [ ] **Step 3: Verify validation package builds and tests pass**

```bash
pnpm --filter @dagsocial/validation build
pnpm --filter @dagsocial/validation test
```
Expected: build clean, all validation tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/validation/
git commit -m "feat(validation): update block structure checks for subBlockEntries"
```

---

### Task 3: Node Core — Mempool, Block Creator, Block Application

**Files:**
- Modify: `packages/node/src/store/db.ts` (mempool schema)
- Modify: `packages/node/src/store/mempool.ts` (ID-based storage)
- Modify: `packages/node/src/services/block-creator.ts` (computeSubBlockRoot, createOrderingBlock)
- Modify: `packages/node/src/services/block-apply.ts` (remove insertPost, placeholder rows, journal)
- Modify: `packages/node/src/store/index.ts` (re-export update)

**Interfaces:**
- Consumes: `SubBlockEntry`, updated `SubBlockTree` from Task 1
- Produces: `insertSubBlock(postId, expiresAtHeight, batchId?)`, updated `computeSubBlockRoot`, updated `createOrderingBlock`, updated `applyOrderingBlock`

- [ ] **Step 1: Update mempool DB schema**

In `packages/node/src/store/db.ts`, change the mempool table:

```sql
CREATE TABLE IF NOT EXISTS mempool (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_type TEXT NOT NULL CHECK(entry_type IN ('subblock', 'utxo_tx')),
  subblock_id TEXT,
  utxo_tx_cbor BLOB,
  batch_id TEXT,
  expires_at_height INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

Note: existing databases with the old schema will fail. Since this is pre-stable, a DB reset is acceptable. Add a migration note in the commit message.

- [ ] **Step 2: Update mempool store**

In `packages/node/src/store/mempool.ts`:

```typescript
export interface PoolEntry {
  rowid: number;
  entryType: 'subblock' | 'utxo_tx';
  subblockId: string | null;
  utxoTxCbor: Uint8Array | null;
  batchId: string | null;
  expiresAtHeight: number;
  createdAt: string;
}

interface MempoolRow {
  rowid: number;
  entry_type: string;
  subblock_id: string | null;
  utxo_tx_cbor: Buffer | null;
  batch_id: string | null;
  expires_at_height: number;
  created_at: string;
}

function rowToEntry(row: MempoolRow): PoolEntry {
  return {
    rowid: row.rowid,
    entryType: row.entry_type as 'subblock' | 'utxo_tx',
    subblockId: row.subblock_id,
    utxoTxCbor: row.utxo_tx_cbor ? new Uint8Array(row.utxo_tx_cbor) : null,
    batchId: row.batch_id,
    expiresAtHeight: row.expires_at_height,
    createdAt: row.created_at,
  };
}

export function insertSubBlock(
  postId: string,
  expiresAtHeight: number,
  batchId: string | null = null,
): number {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO mempool (entry_type, subblock_id, batch_id, expires_at_height)
     VALUES ('subblock', ?, ?, ?)`,
  ).run(postId, batchId, expiresAtHeight);
  return Number(result.lastInsertRowid);
}

export function getPendingEntries(limit: number): PoolEntry[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT rowid, entry_type, subblock_id, utxo_tx_cbor, batch_id,
            expires_at_height, created_at
     FROM mempool
     ORDER BY rowid ASC
     LIMIT ?`,
  ).all(limit) as MempoolRow[];
  return rows.map(rowToEntry);
}
```

(Keep `insertUtxoTx`, `purgeExpired`, `removeEntry` unchanged.)

- [ ] **Step 3: Update store re-exports**

In `packages/node/src/store/index.ts`, update the `insertMempoolSubBlock` alias:

```typescript
import {
  insertSubBlock as insertMempoolSubBlock,
  insertUtxoTx,
  getPendingEntries,
  purgeExpired,
  removeEntry,
} from './mempool.js';
```

The function signature changed from `(subBlock: SubBlock, ...)` to `(postId: string, ...)`. This will cause type errors in callers — those are fixed in Tasks 3 and 4.

- [ ] **Step 4: Update `computeSubBlockRoot`**

In `packages/node/src/services/block-creator.ts`, replace the function:

```typescript
export function computeSubBlockRoot(tree: SubBlockTree): string {
  const leaves = [
    ...tree.subBlockEntries.map((entry) =>
      leafHash('subblock', Buffer.from(JSON.stringify({
        postId: entry.postId,
        parentRefs: entry.parentRefs,
      })))),
    ...tree.stumpIds.map((id) =>
      leafHash('stump', hexToBuf(id))),
  ];
  return Buffer.from(buildMerkleRoot(leaves)).toString('hex');
}
```

- [ ] **Step 5: Update `createOrderingBlock`**

Replace the sub-block processing section (steps 3-4, lines 349-357) with ID-based logic:

```typescript
// 3. Get pending entries from mempool
const entries = getPendingEntries(config.maxSubBlocksPerBlock);

// 4. Separate sub-blocks and standalone UTXO transactions
const subBlockEntries = entries.filter((e) => e.entryType === 'subblock');
const standaloneUtxoTxs = entries.filter(
  (e) => e.entryType === 'utxo_tx' && e.batchId === null,
);

// 5. Resolve sub-block metadata from dag_posts
const resolvedSubBlocks: Array<{ subBlockId: string; post: Post; likeBoxes: LikeBox[] }> = [];
for (const entry of subBlockEntries) {
  if (!entry.subblockId) continue;
  const post = getPost(entry.subblockId);
  if (!post || !('author' in post)) continue; // skip if content not yet arrived
  resolvedSubBlocks.push({
    subBlockId: entry.subblockId,
    post,
    likeBoxes: [],
  });
}
```

Replace the like-matching loop (step 6, lines 368-384) to use `resolvedSubBlocks` instead of decoded sub-blocks:

```typescript
// 6. Attach standalone likes to matching sub-blocks by targetPostId
const matchedUtxoRowids = new Set<number>();
for (const entry of standaloneUtxoTxs) {
  const tx = decodeTx(entry.utxoTxCbor!);
  const targetPostId = extractLikeTarget(tx);
  if (targetPostId) {
    const matchingSb = resolvedSubBlocks.find((sb) => sb.subBlockId === targetPostId);
    if (matchingSb) {
      for (const output of tx.outputs) {
        if (output.boxType === 'like') {
          matchingSb.likeBoxes.push(output as LikeBox);
        }
      }
      matchedUtxoRowids.add(entry.rowid);
    }
  }
}
```

Replace the subBlockRefs/subBlockCbors construction (lines 473-507) with:

```typescript
const subBlockRefs = resolvedSubBlocks.map((sb) => sb.subBlockId);

// Build subBlockEntries for the block
const subBlockEntriesForBlock = resolvedSubBlocks.map((sb) => ({
  postId: sb.subBlockId,
  parentRefs: (sb.post as Post).parentRefs ?? [],
}));

// Build the body tree
const subBlockTree: SubBlockTree = {
  subBlockRefs,
  subBlockEntries: subBlockEntriesForBlock,
  stumpIds: [], // deferred — prune commit queuing is a follow-up session
};
```

- [ ] **Step 6: Update `applyOrderingBlock`**

Remove the journal CBOR population loop (lines 60–66). Replace with nothing — `subBlockCbors` is removed from the type.

Replace the confirm loop (lines 175–205) with:

```typescript
// 7. Confirm sub-blocks — create placeholders if post doesn't exist
for (let i = 0; i < block.subBlockTree.subBlockEntries.length; i++) {
  const entry = block.subBlockTree.subBlockEntries[i]!;
  const subBlockId = entry.postId;

  // Create placeholder row if post doesn't exist yet
  if (!getPost(subBlockId)) {
    insertPostPlaceholder(subBlockId, entry.parentRefs);
  }

  try {
    confirmPost(subBlockId, block.header.height);
  } catch (err) {
    console.warn(`Failed to confirm sub-block ${subBlockId}: ${String(err)}`);
  }
}
```

Update the mempool cleanup loop (lines 207–222) to use `subblockId` instead of decoding CBOR:

```typescript
if (block.subBlockTree.subBlockRefs.length > 0) {
  const entriesAfter = getPendingEntries(1000);
  for (const subBlockId of block.subBlockTree.subBlockRefs) {
    const match = entriesAfter.find((e) =>
      e.entryType === 'subblock' && e.subblockId === subBlockId,
    );
    if (match) {
      removeEntry(match.rowid);
    }
  }
}
```

Remove the journal `subBlockCbors` initialization (line 53) — the field no longer exists on `BlockJournal`.

Add the `insertPostPlaceholder` helper to `packages/node/src/store/posts.ts`:

```typescript
export function insertPostPlaceholder(postId: string, parentRefs: string[]): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO dag_posts
     (id, content, author, parent_refs, challenge, pow_nonce,
      protocol_version, timestamp, signature, raw_cbor, status)
     VALUES (?, '', ?, ?, ?, 0, 1, 0, ?, ?, 'pending')`,
  ).run(
    postId,
    Buffer.alloc(32),                 // author placeholder
    JSON.stringify(parentRefs),
    Buffer.alloc(32),                 // challenge placeholder
    Buffer.alloc(64),                 // signature placeholder
    Buffer.from([]),                  // raw_cbor empty
  );
  // Insert parent refs for DAG walking
  const insertRef = db.prepare(
    'INSERT OR IGNORE INTO dag_parent_refs (post_id, parent_id) VALUES (?, ?)',
  );
  for (const parentId of parentRefs) {
    insertRef.run(postId, parentId);
  }
}
```

Export `insertPostPlaceholder` from `packages/node/src/store/index.ts`.

- [ ] **Step 7: Verify node package builds**

```bash
pnpm --filter @dagsocial/node build
```
Expected: build succeeds (callers in fork-resolution, index.ts, server.ts, post-service.ts will have type errors from the mempool signature change — those are Task 4).

- [ ] **Step 8: Commit**

```bash
git add packages/node/src/store/db.ts packages/node/src/store/mempool.ts \
        packages/node/src/store/posts.ts packages/node/src/store/index.ts \
        packages/node/src/services/block-creator.ts \
        packages/node/src/services/block-apply.ts
git commit -m "feat(node): ID-based mempool, subBlockEntries in blocks, placeholder posts"
```

---

### Task 4: Node Wiring — Fork Resolution, Sync Handler, Routes, Interfaces

**Files:**
- Modify: `packages/node/src/services/fork-resolution.ts`
- Modify: `packages/node/src/index.ts` (sync handler + insertMempoolSubBlock calls)
- Modify: `packages/node/src/routes/blocks.ts`
- Modify: `packages/node/src/routes/mining.ts`
- Modify: `packages/node/src/services/post-service.ts` (mempool interface)
- Modify: `packages/node/src/server.ts` (mempool interface)

**Interfaces:**
- Consumes: updated mempool `insertSubBlock(postId, ...)`, updated `SubBlockTree`, updated `BlockJournal`
- Produces: everything compiles, node starts

- [ ] **Step 1: Update fork resolution**

In `packages/node/src/services/fork-resolution.ts`, replace the sub-block re-insertion loop (line 143):

```typescript
// Re-insert sub-blocks by ID (content is in dag_posts)
for (const subBlockId of journal.confirmedSubBlockIds) {
  insertMempoolSubBlock(subBlockId, mempoolExpiry);
}
```

Remove the `decodeSubBlock` import if no longer needed (check other uses in the file).

- [ ] **Step 2: Update sync handler in index.ts**

Replace the sync handler (lines 253–261):

```typescript
net.setSyncHandler((subBlockId: string) => {
  const post = getPost(subBlockId);
  if (!post || !('author' in post)) return null;
  return {
    subBlockId,
    post,
    likeBoxes: [],
    producerId: post.author,
    protocolVersion: post.protocolVersion,
  } as SubBlock;
});
```

Update the `insertMempoolSubBlock` call (line 112):

```typescript
insertMempoolSubBlock(sb.subBlockId, currentHeight + MEMPOOL_EXPIRY_BLOCKS);
```

- [ ] **Step 3: Update routes**

In `packages/node/src/routes/blocks.ts`, update the response:

```typescript
subBlockTree: {
  subBlockRefs: block.subBlockTree.subBlockRefs,
  subBlockEntries: block.subBlockTree.subBlockEntries,
  stumpIds: block.subBlockTree.stumpIds,
},
```

In `packages/node/src/routes/mining.ts`:

```typescript
subBlockRefs: tpl.subBlockTree.subBlockRefs,
subBlockEntries: tpl.subBlockTree.subBlockEntries,
stumpIds: tpl.subBlockTree.stumpIds,
```

- [ ] **Step 4: Update post-service mempool interface**

In `packages/node/src/services/post-service.ts`, update the `PostServiceDeps` interface:

```typescript
insertMempoolSubBlock: (
  postId: string,
  expiresAtHeight: number,
  batchId?: string | null,
) => number;
```

Update the call site (line 253):

```typescript
deps.insertMempoolSubBlock(postId, expiresAtHeight, batchId);
```

- [ ] **Step 5: Update server.ts wiring**

In `packages/node/src/server.ts`, the `insertMempoolSubBlock` is already aliased from the store — verify the DI still type-checks after the signature change.

- [ ] **Step 6: Verify node package builds clean**

```bash
pnpm --filter @dagsocial/node build
```
Expected: build clean, zero type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/node/src/services/fork-resolution.ts \
        packages/node/src/index.ts \
        packages/node/src/routes/blocks.ts \
        packages/node/src/routes/mining.ts \
        packages/node/src/services/post-service.ts \
        packages/node/src/server.ts
git commit -m "feat(node): wire ID-based mempool through fork resolution, sync, routes, and post service"
```

---

### Task 5: Test Fixes and Full Verification

**Files:**
- Modify: all test files referencing old `subBlocks`, `subblockCbor`, `insertMempoolSubBlock` signatures

**Interfaces:**
- Consumes: all changes from Tasks 1–4
- Produces: all tests pass, full build clean, full typecheck clean

- [ ] **Step 1: Find all broken test references**

```bash
grep -rn "subBlocks\|subblockCbor\|subblock_cbor\|subBlockCbor" packages/ --include='*.test.ts'
grep -rn "insertMempoolSubBlock\|insertSubBlock" packages/ --include='*.test.ts'
```

- [ ] **Step 2: Fix each test file**

Common patterns to fix:
- `SubBlockTree` construction: add `subBlockEntries` field
- `PoolEntry.subblockCbor` → `PoolEntry.subblockId`
- `insertMempoolSubBlock(subBlock, ...)` → `insertMempoolSubBlock(postId, ...)`
- `computeSubBlockRoot` tests: update expected hashes (topology now includes parentRefs)
- `verifyOrderingBlockStructure` tests: update for `subBlockEntries`
- `applyOrderingBlock` tests: remove expectations about `insertPost` calls
- `fork-resolution` tests: update journal fixture (no `subBlockCbors`)

- [ ] **Step 3: Run full test suite**

```bash
pnpm test
```
Expected: all tests pass (the pre-existing e2e port-conflict flake may appear — that's unrelated).

- [ ] **Step 4: Full build and typecheck**

```bash
pnpm build
pnpm typecheck
```
Expected: all packages build clean, zero type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/
git commit -m "test: fix all tests for block/DAG separation"
```
