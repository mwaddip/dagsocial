# Sub-Block Fetch & Sync Integration

**Date:** 2026-07-26
**Protocol version:** 2
**Status:** design

## Overview

Wire the two remaining gaps in sub-block propagation:

1. **Sub-blocks delivered via sync are dropped.** `LazySyncStore.appendBlocks()` decodes everything as `OrderingBlock` — sub-blocks from `ModifierResponse(type=102)` fail to decode and are discarded.
2. **Nodes applying foreign ordering blocks may be missing referenced sub-blocks.** When Node A mines a block referencing sub-blocks Node B never received, Node B's `applyOrderingBlock()` skips those refs (posts don't confirm, UTXO txs don't apply). Node B needs a way to fetch those sub-blocks on demand.

Both are fixable with the existing delegation pattern in `LazySyncStore` and the existing `GetSubBlock`/`SubBlockResponse` message codes (6/7) on the sync stream.

## Non-Goals

- **Sub-block backfill during historical sync.** When syncing from genesis, a node may apply blocks referencing sub-blocks from months ago that no connected peer still has. Those sub-blocks are permanently missing. Backfill (batch requesting all missing sub-blocks for a block range via `ModifierRequest(type=102)`) is deferred. The gap is noted in `SESSION_CONTEXT.md`.
- **Chain commitment or anchored confirmation tier.** The mempool provides eventual consistency without them. See `SUBBLOCK_INTERFACE.md`.
- **INV-based sub-block announcements.** Full-body gossip is sufficient for current scale.

## Design

### 1. LazySyncStore — separate sub-block delegation

Two delegation slots, following the existing `_getOrderingBlock` / `_getSubBlock` pattern:

```
_blocksHandler: (block: OrderingBlock) => void     // added in bridge fix
_subBlocksHandler: (sb: SubBlock) => void           // new
```

`appendBlocks(blocks)` — decodes each item as `OrderingBlock`, forwards to `_blocksHandler`. Existing.

`appendSubBlocks(subBlocks)` — decodes each item as `SubBlock`, forwards to `_subBlocksHandler`. New. Same shape: null check, loop, instanceof guard, decode, callback invocation, error catch.

Two separate methods, not a combined type-dispatched function. The sync machine already branches on `typeId` at the call site; the methods are clearly named for their payload; each is independently testable. The ~10 lines of boilerplate shared between them is not worth the cognitive overhead of a discriminator parameter.

### 2. SyncMachine — route sub-blocks to the right method

`handleModifierResponse` already branches on `typeId`:

- `MODIFIER_ORDERING_BLOCK` (101) → `store.appendBlocks(blocks)` — existing
- `MODIFIER_SUB_BLOCK` (102) → change from `store.appendBlocks(subBlocks)` to `store.appendSubBlocks(subBlocks)`

The sub-block branch also needs `decodeSubBlock` imported in the types package (already exported).

### 3. SyncStore interface

Add `appendSubBlocks(subBlocks: unknown[]): void` to the `SyncStore` interface. Implemented by `LazySyncStore`, used by `SyncMachine`.

### 4. NetNode — expose the new handler

Two new public methods on `NetNode`, matching the `setSyncHandler` / `setHeadersHandler` pattern:

- `setBlocksHandler(cb)` — already added in the bridge fix commit
- `setSubBlocksHandler(cb)` — new, wires into `LazySyncStore._subBlocksHandler`

### 5. Node index.ts — register handlers

```typescript
// Blocks received via sync → apply directly
net.setBlocksHandler((block) => {
  applyOrderingBlock(block);
});

// Sub-blocks received via sync → same validation + insert as gossip path
net.setSubBlocksHandler((sb) => {
  const result = verifyPostForRelay(
    { getActiveChallenge: () => null, getKarmaBoxes, getPost },
    sb.post,
    0,
  );
  if (!result.valid) {
    console.warn(`Synced sub-block rejected: ${result.error}`);
    return;
  }
  insertPost(sb.post, encodePost(sb.post));
  const currentHeight = getCurrentHeight();
  insertMempoolSubBlock(sb, currentHeight + MEMPOOL_EXPIRY_BLOCKS);
  console.log(`Synced sub-block queued in mempool: ${sb.subBlockId}`);
});
```

The sub-block handler shares the same validation logic as the gossip `onSubBlock` handler. Extract into a shared helper to avoid duplication.

### 6. Missing sub-block fetch (gossip path)

When a node receives an ordering block via gossip, it checks whether all `subBlockRefs` are available locally. Missing refs are fetched from the source peer before applying the block.

```
receive ordering block via gossip (net.onOrderingBlock)
  │
  ├── missing = block.subBlockTree.subBlockRefs
  │     .filter(id => !getPost(id))
  │
  ├── for each missing id:
  │     sb = await net.requestSubBlock(id, sourcePeerId)
  │     if sb → Stage 1 validate → Stage 2 validate → insert post + mempool
  │
  └── applyOrderingBlock(block)
```

`fetchMissingSubBlocks(block, sourcePeerId)` is a standalone async function in `index.ts`. It's called from the gossip `onOrderingBlock` handler before `applyOrderingBlock`.

The function handles partial failures gracefully: if a sub-block can't be fetched (timeout, not-found), the ref is skipped. `applyOrderingBlock` already handles missing refs — they're logged and the post doesn't confirm.

### 7. Sync path — no fetch

The `setBlocksHandler` callback (sync path) does NOT call `fetchMissingSubBlocks`. During historical sync, blocks may reference sub-blocks from the distant past that no connected peer has. The fetch would stall on every missing ref. Missing refs are expected and harmless — the ordering block and its UTXO state transitions are valid without them.

Sub-block backfill during sync is deferred (see Non-Goals).

### 8. Loopback and idempotency

A sub-block arriving via both gossip and sync (or twice via gossip loopback) is handled:
- `insertPost` is idempotent (INSERT OR REPLACE)
- `insertMempoolSubBlock` is idempotent (sub-block ID is the primary key)
- `verifyPostForRelay` is pure — running twice produces the same result

## Files Changed

| File | Change |
|------|--------|
| `packages/net/src/node.ts` | Add `_subBlocksHandler`, `setSubBlocksHandler()`, `appendSubBlocks()` |
| `packages/net/src/sync-machine.ts` | Route `MODIFIER_SUB_BLOCK` to `appendSubBlocks()`, add to `SyncStore` interface |
| `packages/node/src/index.ts` | Extract shared sub-block validation helper, register `setBlocksHandler`, `setSubBlocksHandler`, add `fetchMissingSubBlocks()` to gossip handler |

## Preconditions

- Bridge fix commit (`e81cb31`) applied: `decodeOrderingBlock` import, `_blocksHandler`, `setBlocksHandler`, `appendBlocks` implementation
- `decodeSubBlock` exported from `@dagsocial/types` (already the case)
- `requestSubBlock(id, peerId)` available on `NetNode` (already the case, uses `GetSubBlock`/`SubBlockResponse` codes 6/7)
- `SUBBLOCK_INTERFACE.md` contract is current

## Verification

- `pnpm typecheck` — all packages
- `pnpm test` — all existing tests pass, no regressions
- `sync-machine.test.ts` — verify `appendSubBlocks` is called for `MODIFIER_SUB_BLOCK` type
- Manual: two-node cluster, create post on N1, mine block on N2, verify N1 fetches missing sub-blocks before applying
