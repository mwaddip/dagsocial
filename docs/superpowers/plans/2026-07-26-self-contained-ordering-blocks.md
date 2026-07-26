# Self-Contained Ordering Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed sub-block and UTXO tx CBOR directly in ordering blocks so every node can apply any block without external mempool lookups.

**Architecture:** Two new typed array fields on the block body sections (`SubBlockTree.subBlocks`, `UtxoTxTree.utxoTxs`), indexed in lockstep with the existing ID arrays. The block creator populates them; block application decodes from them. Merkle roots unchanged. Gossip unchanged. Sync machine drops the now-unnecessary `MODIFIER_SUB_BLOCK` handling.

**Tech Stack:** TypeScript, `cbor-x`, `@dagsocial/types`, `@dagsocial/node`, `@dagsocial/net`

## Global Constraints

- Node.js ≥ 22
- `pnpm build && pnpm typecheck` must pass with zero errors
- All existing tests must pass (1 pre-existing e2e failure exempted: `decay-full-pipeline`)
- `subBlockRefs[i]` ↔ `subBlocks[i]` alignment (same index, same sub-block)
- `utxoTxIds[i]` ↔ `utxoTxs[i]` alignment (same index, same transaction)
- Merkle root computation unchanged — only hashes IDs, not CBOR
- Spec: `docs/superpowers/specs/2026-07-26-subblock-fetch-design.md`
- Contract: `contracts/SUBBLOCK_INTERFACE.md`

---

### Task 1: Add CBOR fields to SubBlockTree and UtxoTxTree types

**Files:**
- Modify: `packages/types/src/block.ts:78-88`

**Interfaces:**
- Produces: `SubBlockTree.subBlocks: Uint8Array[]`, `UtxoTxTree.utxoTxs: Uint8Array[]`

- [ ] **Step 1: Update SubBlockTree and UtxoTxTree interfaces**

In `packages/types/src/block.ts`, change:

```typescript
export interface SubBlockTree {
  subBlockRefs: PostId[];       // sub-blocks anchored in this block
  stumpIds: StumpId[];          // stumps committed in this block
  subBlocks: Uint8Array[];      // CBOR-encoded SubBlocks (aligned with subBlockRefs)
}

export interface UtxoTxTree {
  utxoTxIds: TxId[];            // UTXO transactions
  utxoTxs: Uint8Array[];        // CBOR-encoded UtxoTransactions (aligned with utxoTxIds)
  likeBoxIds: BoxId[];          // standalone likes (no sub-block to ride)
  coinbaseOutputs: CoinbaseOutput[];
  epochTallyResults?: EpochTally;
}
```

- [ ] **Step 2: Typecheck types package**

```bash
pnpm --filter @dagsocial/types typecheck
```

Expected: PASS.

- [ ] **Step 3: Update all inline SubBlockTree / UtxoTxTree constructions across the codebase**

The new required fields break every inline object literal that constructs these types. Add `subBlocks: []` to every `subBlockTree: {` and `utxoTxs: []` to every `utxoTxTree: {`.

Files and sites (from grep):

| File | # sites | New field to add |
|------|---------|-----------------|
| `packages/net/test/headers.test.ts` | 1 | `subBlocks: []` + `utxoTxs: []` |
| `packages/net/test/integration.test.ts` | 1 | `subBlocks: []` + `utxoTxs: []` |
| `packages/node/test/services/block-apply.test.ts` | 4 | `subBlocks: []` + `utxoTxs: []` |
| `packages/node/test/services/fork-resolution.test.ts` | 2 | `subBlocks: []` + `utxoTxs: []` |
| `packages/node/test/routes/blocks.test.ts` | 1 | `subBlocks: []` + `utxoTxs: []` |
| `packages/node/test/store/ordering.test.ts` | 2 | `subBlocks: []` + `utxoTxs: []` |
| `packages/validation/test/verify.test.ts` | 2 | `subBlocks: []` + `utxoTxs: []` |
| `packages/node/src/routes/blocks.ts` | 1 | `subBlocks: []` + `utxoTxs: []` |

Pattern — before:
```typescript
subBlockTree: { subBlockRefs: [...], stumpIds: [] },
utxoTxTree: { utxoTxIds: [...], likeBoxIds: [...], coinbaseOutputs: [...] },
```

After:
```typescript
subBlockTree: { subBlockRefs: [...], stumpIds: [], subBlocks: [] },
utxoTxTree: { utxoTxIds: [...], utxoTxs: [], likeBoxIds: [...], coinbaseOutputs: [...] },
```

No need to populate with actual CBOR — these are test stubs with empty arrays. The fields exist but carry no data. Tests that need actual CBOR (block-creator, serialization) are handled in Tasks 2 and 3.

- [ ] **Step 4: Build types package**

The CBOR encode/decode in `serialization.ts` delegates to `toBuffer`/`fromBuffer` from cbor-x — the new fields are automatically handled. No serialization code changes needed.

```bash
pnpm --filter @dagsocial/types build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/block.ts
# Add all mechanically-updated files from Step 3
git add packages/net/test/headers.test.ts
git add packages/net/test/integration.test.ts
git add packages/node/test/services/block-apply.test.ts
git add packages/node/test/services/fork-resolution.test.ts
git add packages/node/test/routes/blocks.test.ts
git add packages/node/test/store/ordering.test.ts
git add packages/validation/test/verify.test.ts
git add packages/node/src/routes/blocks.ts
git commit -m "feat(types): add subBlocks and utxoTxs CBOR fields to block tree types"
```

---

### Task 2: Update test factories to include new fields

**Files:**
- Modify: `packages/types/test/serialization.test.ts:93-115`

**Interfaces:**
- Consumes: `SubBlockTree.subBlocks`, `UtxoTxTree.utxoTxs` from Task 1

- [ ] **Step 1: Add CBOR stubs to makeSubBlockTree**

```typescript
function makeSubBlockTree(): SubBlockTree {
  // Create a minimal valid sub-block CBOR for testing
  const dummySubBlock: SubBlock = {
    subBlockId: 'd'.repeat(64),
    post: {
      content: 'test',
      author: new Uint8Array(32).fill(0xbb),
      parentRefs: [],
      challenge: new Uint8Array(32).fill(0xcc),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: 1,
      signature: new Uint8Array(64).fill(0xdd),
    },
    likeBoxes: [],
    producerId: new Uint8Array(32).fill(0xbb),
    protocolVersion: 1,
  };
  return {
    subBlockRefs: ['d'.repeat(64)],
    stumpIds: [],
    subBlocks: [encodeSubBlock(dummySubBlock)],
  };
}

function makeUtxoTxTree(): UtxoTxTree {
  // Create a minimal valid UTXO tx CBOR for testing
  const dummyTx: UtxoTransaction = {
    inputs: [],
    outputs: [],
    signatures: [],
  };
  return {
    utxoTxIds: ['f'.repeat(64)],
    utxoTxs: [encodeTx(dummyTx)],
    likeBoxIds: ['e'.repeat(64)],
    coinbaseOutputs: [],
  };
}
```

Update imports at the top of the file to include the needed types and functions:

```typescript
import {
  // ... existing imports ...
  encodeSubBlock,
  encodeTx,
} from '../src/index.js';
import type {
  // ... existing imports ...
  SubBlock,
  UtxoTransaction,
} from '../src/index.js';
```

- [ ] **Step 2: Run serialization tests**

```bash
pnpm --filter @dagsocial/types test
```

Expected: 106 tests pass (the existing `SubBlockTree` and `UtxoTxTree` round-trip tests will now exercise the new fields).

- [ ] **Step 3: Commit**

```bash
git add packages/types/test/serialization.test.ts
git commit -m "test(types): include subBlocks and utxoTxs in serialization test factories"
```

---

### Task 3: Populate new fields in block creator

**Files:**
- Modify: `packages/node/src/services/block-creator.ts:474-482`

**Interfaces:**
- Consumes: `SubBlockTree.subBlocks`, `UtxoTxTree.utxoTxs` from Task 1
- Consumes: `encodeSubBlock`, `encodeTx`, `decodeTx`, `computeTxId` from `@dagsocial/types`

- [ ] **Step 1: Build subBlocks and utxoTxs arrays in createOrderingBlock**

The sub-blocks were already decoded from mempool CBOR at line 354 (`const subBlocks = subBlockEntries.map((e) => decodeSubBlock(e.subblockCbor!))`). We already have the decoded objects. Re-encode them for the block.

At the point where `subBlockTree` and `utxoTxTree` are constructed (around line 474), add the new fields:

```typescript
  const subBlockRefs = subBlocks.map((sb) => sb.subBlockId);

  // Re-encode sub-blocks for inline storage in the ordering block
  const subBlockCbors = subBlocks.map((sb) => encodeSubBlock(sb));

  // Collect UTXO tx CBOR for inline storage
  // We need to track which mempool entries correspond to which utxoTxIds
  const utxoTxCbors: Uint8Array[] = [];

  // Standalone UTXO txs that were not matched to sub-blocks
  for (const entry of remainingUtxoTxs) {
    utxoTxCbors.push(entry.utxoTxCbor!);
  }

  // Matched UTXO entries (attached to sub-blocks)
  for (const entry of standaloneUtxoTxs) {
    if (matchedUtxoRowids.has(entry.rowid)) {
      utxoTxCbors.push(entry.utxoTxCbor!);
    }
  }

  // Batch-linked UTXO entries
  for (const [, batchEntries] of batchMap) {
    for (const entry of batchEntries) {
      if (entry.entryType === 'utxo_tx' && entry.utxoTxCbor) {
        utxoTxCbors.push(entry.utxoTxCbor);
      }
    }
  }

  // 17. Build the body trees
  const subBlockTree: SubBlockTree = {
    subBlockRefs,
    stumpIds: [],
    subBlocks: subBlockCbors,                               // NEW
  };
  const utxoTxTree: UtxoTxTree = {
    utxoTxIds,
    utxoTxs: utxoTxCbors,                                   // NEW
    likeBoxIds: allLikeBoxIds,
    coinbaseOutputs,
  };
```

**Critical:** `utxoTxCbors` must be in the same order as `utxoTxIds`. The existing code builds `utxoTxIds` as:
1. `remainingUtxoTxs.map(e => computeTxId(decodeTx(e.utxoTxCbor!)))` 
2. Then `matchedUtxoRowids` entries
3. Then `batchMap` entries

We must mirror this exact order when building `utxoTxCbors`. The code above does this.

- [ ] **Step 2: Typecheck and build node package**

```bash
pnpm --filter @dagsocial/node typecheck
```

Expected: PASS (the new fields are on the types, and `encodeSubBlock`/`encodeTx` are already imported).

- [ ] **Step 3: Run block creator tests**

```bash
pnpm --filter @dagsocial/node test -- --reporter=verbose test/services/block-creator.test.ts
```

Expected: 13 tests pass. The tests create blocks and inspect their structure — verify the new fields are populated.

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/services/block-creator.ts
git commit -m "feat(node): populate subBlocks and utxoTxs CBOR in ordering blocks"
```

---

### Task 4: Apply blocks from inline CBOR instead of mempool lookups

**Files:**
- Modify: `packages/node/src/services/block-apply.ts:57-77` (journal population)
- Modify: `packages/node/src/services/block-apply.ts:164-189` (confirm sub-blocks)
- Modify: `packages/node/src/services/block-apply.ts:242-274` (apply UTXO txs)

**Interfaces:**
- Consumes: `SubBlockTree.subBlocks`, `UtxoTxTree.utxoTxs` from Task 1
- Consumes: `decodeSubBlock`, `decodeTx` from `@dagsocial/types`

- [ ] **Step 1: Populate journal subBlockCbors from block, not mempool**

Replace lines 57-77 in `block-apply.ts`:

```typescript
  // Populate subBlockCbors from the block itself (self-contained)
  if (block.subBlockTree.subBlockRefs.length > 0) {
    for (let i = 0; i < block.subBlockTree.subBlockRefs.length; i++) {
      const subBlockId = block.subBlockTree.subBlockRefs[i];
      const cbor = block.subBlockTree.subBlocks[i];
      if (cbor) {
        currentJournal.subBlockCbors.push({ subBlockId, cbor });
      }
    }
  }
```

- [ ] **Step 2: Confirm sub-blocks from block CBOR, still remove from mempool**

Replace lines 164-189 in `block-apply.ts`:

```typescript
  // 7. Confirm sub-blocks and their posts — decode from block, not mempool
  for (let i = 0; i < block.subBlockTree.subBlockRefs.length; i++) {
    const subBlockId = block.subBlockTree.subBlockRefs[i];
    const subBlockCbor = block.subBlockTree.subBlocks[i];

    // Insert post if we don't already have it (e.g., from gossip)
    if (subBlockCbor && !getPost(subBlockId)) {
      try {
        const sb = decodeSubBlock(subBlockCbor);
        insertPost(sb.post, encodePost(sb.post));
      } catch (err) {
        console.warn(`Failed to decode sub-block ${subBlockId} from block: ${String(err)}`);
      }
    }

    try {
      confirmPost(subBlockId, block.header.height);
    } catch (err) {
      console.warn(`Failed to confirm sub-block ${subBlockId}: ${String(err)}`);
    }
  }
  // Still remove confirmed entries from local mempool (if we have them)
  if (block.subBlockTree.subBlockRefs.length > 0) {
    const entriesAfter = getPendingEntries(1000);
    for (const subBlockId of block.subBlockTree.subBlockRefs) {
      const match = entriesAfter.find((e) => {
        if (e.entryType !== 'subblock' || !e.subblockCbor) return false;
        try {
          const sb = decodeSubBlock(e.subblockCbor);
          return sb.subBlockId === subBlockId;
        } catch {
          return false;
        }
      });
      if (match) {
        removeEntry(match.rowid);
      }
    }
  }
```

- [ ] **Step 3: Apply UTXO txs from block CBOR**

Replace lines 242-274 in `block-apply.ts` (the `for (const txId of block.utxoTxTree.utxoTxIds)` loop):

```typescript
  // 10. Apply UTXO transactions from the block — decode from block, not mempool
  for (let i = 0; i < block.utxoTxTree.utxoTxIds.length; i++) {
    const txId = block.utxoTxTree.utxoTxIds[i];
    const txCbor = block.utxoTxTree.utxoTxs[i];

    if (!txCbor) {
      console.warn(`UTXO tx ${txId} missing CBOR in block`);
      continue;
    }

    let tx: UtxoTransaction;
    try {
      tx = decodeTx(txCbor);
    } catch (err) {
      console.warn(`Failed to decode UTXO tx ${txId} from block: ${String(err)}`);
      continue;
    }

    const revalResult = revalidateTxInContext(utxoDeps, tx, block.header.height);
    if (!revalResult.valid) {
      console.warn(`UTXO tx ${txId} failed revalidation: ${revalResult.error}`);
      // Remove from local mempool if present (stale entry)
      const entries = getPendingEntries(1000);
      const entry = entries.find((e) => {
        if (e.entryType !== 'utxo_tx' || !e.utxoTxCbor) return false;
        const et = decodeTx(e.utxoTxCbor);
        return computeTxId(et) === txId;
      });
      if (entry) removeEntry(entry.rowid);
      continue;
    }
    const computedOutputs = tx.outputs.map((box) => ({
      ...box,
      id: computeBoxId(box),
    })) as AnyBox[];
    applyTx(utxoDeps, tx, computedOutputs, block.header.height);

    // Remove from local mempool if present
    const entries = getPendingEntries(1000);
    const entry = entries.find((e) => {
      if (e.entryType !== 'utxo_tx' || !e.utxoTxCbor) return false;
      const et = decodeTx(e.utxoTxCbor);
      return computeTxId(et) === txId;
    });
    if (entry) removeEntry(entry.rowid);

    // Record in journal
    currentJournal.appliedUtxoTxs.push({
      txId,
      txCbor: encodeTx(tx),
      inputBoxIds: tx.inputs,
      outputBoxIds: computedOutputs.map((o) => o.id!),
    });
  }
```

The key change: decode from `block.utxoTxTree.utxoTxs[i]` instead of looking up `entry.utxoTxCbor` in the mempool. Mempool cleanup still happens (remove local entries if present), but it's now optional — the block provides the authoritative CBOR.

- [ ] **Step 4: Typecheck node package**

```bash
pnpm --filter @dagsocial/node typecheck
```

Expected: PASS.

- [ ] **Step 5: Run block-apply tests**

```bash
pnpm --filter @dagsocial/node test -- --reporter=verbose test/services/block-apply.test.ts
```

Expected: 11 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/node/src/services/block-apply.ts
git commit -m "feat(node): apply ordering blocks from inline CBOR, not mempool lookups"
```

---

### Task 5: Remove MODIFIER_SUB_BLOCK sync path

**Files:**
- Modify: `packages/net/src/sync-machine.ts:241,319-331`

**Interfaces:**
- Removes: `MODIFIER_SUB_BLOCK` handling in `handleInv` and `handleModifierResponse`

- [ ] **Step 1: Remove MODIFIER_SUB_BLOCK branch from handleInv**

In `handleInv` (line 237-244), remove the sub-block filter:

```typescript
  private handleInv(_peerId: string, inv: Inv): void {
    if (this.state.phase !== 'syncing' || !this.state.syncPeerId) return;

    // Filter out IDs we already know about
    const missing = inv.ids.filter((id) => {
      if (inv.typeId === MODIFIER_ORDERING_BLOCK) {
        return !this.store.hasOrderingBlockHeader(id);
      }
      // MODIFIER_SUB_BLOCK — dropped. Sub-blocks are carried inline in ordering blocks.
      return false;
    });

    if (missing.length === 0) return;

    const req: ModifierRequest = { typeId: inv.typeId, ids: missing };
    this.sendToPeer(this.state.syncPeerId, encodeModifierRequest(this.magic, req));
  }
```

- [ ] **Step 2: Remove MODIFIER_SUB_BLOCK branch from handleModifierResponse**

Replace lines 319-331 in `handleModifierResponse`:

```typescript
    } else if (resp.typeId === MODIFIER_SUB_BLOCK) {
      // Sub-blocks are now carried inline in ordering blocks. Peers still on
      // the old protocol may send these — silently ignore.
    }
```

Or remove the branch entirely. The silent ignore preserves forward-compat if an old peer sends a `MODIFIER_SUB_BLOCK` response.

- [ ] **Step 3: Typecheck net package**

```bash
pnpm --filter @dagsocial/net typecheck
```

Expected: PASS.

- [ ] **Step 4: Run sync machine tests**

```bash
pnpm --filter @dagsocial/net test -- --reporter=verbose test/sync-machine.test.ts
```

Expected: 50 tests pass, 2 tests updated (see below).

Two tests directly exercise the `MODIFIER_SUB_BLOCK` path and must be updated:

**Test 1 (around line 379):** "requests unknown non-header modifiers from the sync peer for sub-blocks" — currently sends a `MODIFIER_SUB_BLOCK` Inv and expects a ModifierRequest to be sent. After the change, `MODIFIER_SUB_BLOCK` is ignored (same as unknown typeId 999). Update:

```typescript
// Before:
const inv: Inv = { typeId: MODIFIER_SUB_BLOCK, ids: ['sb1', 'sb2'] };
sendInv(machine, 'peer1', inv);
expect(sent.length).toBe(1);

// After — sub-blocks are inline in ordering blocks, no longer requested independently:
const inv: Inv = { typeId: MODIFIER_SUB_BLOCK, ids: ['sb1', 'sb2'] };
sendInv(machine, 'peer1', inv);
expect(sent.length).toBe(0); // MODIFIER_SUB_BLOCK is ignored
```

**Test 2 (around line 447):** "calls appendBlocks for sub-block responses" — currently sends a `MODIFIER_SUB_BLOCK` ModifierResponse and expects `appendBlocks` to be called. After the change, `MODIFIER_SUB_BLOCK` responses are silently ignored:

```typescript
// Before — test name: 'calls appendBlocks for sub-block responses'
// After — rename test and update assertion:
it('ignores sub-block modifier responses (sub-blocks are inline in blocks)', () => {
  const appended: unknown[] = [];
  const { machine } = makeMachine({
    store: {
      chainHeight: () => 0,
      appendBlocks: (blocks: unknown[]) => { appended.push(...blocks); },
    },
  });
  const body = new Uint8Array(
    encode({
      typeId: MODIFIER_SUB_BLOCK,
      modifiers: [{ id: 'sb1', data: new Uint8Array([10]) }],
    }),
  );
  machine.handleMessage('peer1', MSG_MODIFIER_RESPONSE, body);
  expect(appended.length).toBe(0); // silently ignored
});
```

- [ ] **Step 5: Commit**

```bash
git add packages/net/src/sync-machine.ts
git commit -m "refactor(net): remove MODIFIER_SUB_BLOCK sync path (sub-blocks are inline in blocks)"
```

---

### Task 6: Update block-creator and block-apply tests for new fields

**Files:**
- Modify: `packages/node/test/services/block-creator.test.ts`
- Modify: `packages/node/test/services/block-apply.test.ts`

**Interfaces:**
- Consumes: `SubBlockTree.subBlocks`, `UtxoTxTree.utxoTxs` from Task 1

- [ ] **Step 1: Add assertions for new fields in block-creator tests**

In `block-creator.test.ts`, after a block is created, add assertions that verify the new fields:

```typescript
// Verify inline CBOR fields
expect(block.subBlockTree.subBlocks).toBeDefined();
expect(block.subBlockTree.subBlocks.length).toBe(block.subBlockTree.subBlockRefs.length);
// Each sub-block CBOR decodes correctly
for (let i = 0; i < block.subBlockTree.subBlocks.length; i++) {
  const sb = decodeSubBlock(block.subBlockTree.subBlocks[i]);
  expect(sb.subBlockId).toBe(block.subBlockTree.subBlockRefs[i]);
}

expect(block.utxoTxTree.utxoTxs).toBeDefined();
expect(block.utxoTxTree.utxoTxs.length).toBe(block.utxoTxTree.utxoTxIds.length);
// Each UTXO tx CBOR decodes correctly
for (let i = 0; i < block.utxoTxTree.utxoTxs.length; i++) {
  const tx = decodeTx(block.utxoTxTree.utxoTxs[i]);
  expect(computeTxId(tx)).toBe(block.utxoTxTree.utxoTxIds[i]);
}
```

Add imports: `decodeSubBlock`, `decodeTx`, `computeTxId` from `@dagsocial/types`.

- [ ] **Step 2: Add assertions for inline decode in block-apply tests**

In `block-apply.test.ts`, verify that `applyOrderingBlock` successfully decodes and confirms sub-blocks from the block CBOR:

```typescript
// The test creates a block with sub-blocks and applies it.
// After application, verify the sub-blocks were decoded from block CBOR:
expect(getPost(subBlockId)?.status).toBe('confirmed');
```

(The existing tests already verify this — they just need the block construction to include the new fields, which Task 3 handles.)

- [ ] **Step 3: Run node tests**

```bash
pnpm --filter @dagsocial/node test
```

Expected: 83 tests pass (same as before, no regressions).

- [ ] **Step 4: Commit**

```bash
git add packages/node/test/services/block-creator.test.ts packages/node/test/services/block-apply.test.ts
git commit -m "test(node): verify inline CBOR fields in block-creator and block-apply"
```

---

### Task 7: Full build, typecheck, and test suite

**Files:**
- None (verification only)

- [ ] **Step 1: Full build**

```bash
pnpm build
```

Expected: All 5 packages build clean.

- [ ] **Step 2: Full typecheck**

```bash
pnpm typecheck
```

Expected: All 5 packages pass.

- [ ] **Step 3: Full test suite**

```bash
pnpm test
```

Expected: 275 tests pass, 1 pre-existing failure (`decay-full-pipeline` e2e).

- [ ] **Step 4: Commit any remaining changes**

```bash
git status
git add -A
git diff --cached --stat  # Verify only expected files changed
git commit -m "chore: final verification — build, typecheck, test suite all pass"
```
