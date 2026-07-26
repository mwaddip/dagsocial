# Self-Contained Ordering Blocks

**Date:** 2026-07-26
**Protocol version:** 2
**Status:** design

## Overview

Ordering blocks currently carry only references (`subBlockRefs`, `utxoTxIds`) —
pointers to ephemeral mempool state. This creates a dependency problem: a node
applying another miner's block may not have the referenced sub-blocks or UTXO
transactions. The mempool entries are purged after confirmation, so even the
originating node can't serve them after the block is applied.

The fix: ordering blocks carry the actual CBOR data inline. The chain becomes
self-contained. Sub-blocks remain pre-confirmation stubs (gossiped so nodes
can display pending content), but once a block is mined, the sub-blocks'
authoritative representation is inside the block.

This eliminates the fetch path, the backfill problem, and the need for
sub-blocks to travel independently through the sync protocol.

## Design

### 1. OrderingBlock structure change

```
// Before (Phase 2)
OrderingBlock {
  header: BlockHeader
  subBlockTree: {
    subBlockRefs: string[]           // just IDs
  }
  utxoTxTree: {
    utxoTxIds: string[]
    likeBoxIds: string[]
    coinbaseOutputs: CoinbaseOutput[]
    epochTallyResults?: EpochTallyResults
  }
  validatorSig: bytes
}

// After
OrderingBlock {
  header: BlockHeader
  subBlockTree: {
    subBlockRefs: string[]           // IDs (still needed for Merkle ordering)
    subBlocks: Uint8Array[]          // CBOR-encoded SubBlocks (same order)
  }
  utxoTxTree: {
    utxoTxIds: string[]
    utxoTxs: Uint8Array[]            // CBOR-encoded UtxoTransactions (same order)
    likeBoxIds: string[]
    coinbaseOutputs: CoinbaseOutput[]
    epochTallyResults?: EpochTallyResults
  }
  validatorSig: bytes
}
```

`subBlockRefs[i]` corresponds to `subBlocks[i]` — same index, same order.
`utxoTxIds[i]` corresponds to `utxoTxs[i]` — same index, same order.

### 2. Merkle roots

`subBlockRoot` and `utxoTxRoot` already exist as Merkle commitments over the
IDs. They continue to work as-is — the Merkle tree is built over `subBlockRefs`
and `utxoTxIds` respectively, same as before. The CBOR data is not hashed into
the Merkle root (the ID already uniquely identifies the content).

Rationale: the Merkle root's purpose is to commit to which sub-blocks and txs
are included, not to verify their content. Content integrity is guaranteed by
the post ID (hash of post content) and transaction ID (hash of tx content).
Adding CBOR to the Merkle tree would be redundant.

### 3. Block creation (miner)

```typescript
function createOrderingBlock(): OrderingBlock {
  const entries = getPendingEntries(config.maxSubBlocksPerBlock);

  // Decode sub-blocks from mempool CBOR
  const subBlocks = entries
    .filter(e => e.entryType === 'subblock')
    .map(e => decodeSubBlock(e.subblockCbor!));

  // Collect linked + standalone UTXO txs
  const utxoTxEntries = resolveUtxoTxs(entries, subBlocks);
  const utxoTxs = utxoTxEntries.map(e => e.utxoTxCbor!);

  const subBlockRefs = subBlocks.map(sb => sb.subBlockId);
  const utxoTxIds = utxoTxEntries.map(e => computeTxId(decodeTx(e.utxoTxCbor!)));

  return {
    header: buildHeader(subBlockRoot(subBlockRefs), utxoTxRoot(utxoTxIds), ...),
    subBlockTree: {
      subBlockRefs,
      subBlocks: subBlocks.map(sb => encodeSubBlock(sb)),   // NEW
    },
    utxoTxTree: {
      utxoTxIds,
      utxoTxs: utxoTxs,                                      // NEW
      likeBoxIds,
      coinbaseOutputs,
      epochTallyResults,
    },
    ...
  };
}
```

### 4. Block application (all nodes)

`applyOrderingBlock` no longer looks up sub-blocks and UTXO txs in the local
mempool. It decodes them from the block itself:

```typescript
function applyOrderingBlock(block: OrderingBlock): boolean {
  // Validate header, chain-link, PoW, Merkle roots (unchanged)

  // Store the block (unchanged)

  // Confirm sub-blocks — decode from block, not mempool
  for (let i = 0; i < block.subBlockTree.subBlockRefs.length; i++) {
    const subBlockId = block.subBlockTree.subBlockRefs[i];
    const subBlockCbor = block.subBlockTree.subBlocks[i];

    // Insert post if we don't already have it
    if (!getPost(subBlockId)) {
      const sb = decodeSubBlock(subBlockCbor);
      insertPost(sb.post, encodePost(sb.post));
    }
    confirmPost(subBlockId, block.header.height);
  }

  // Apply UTXO txs — decode from block, not mempool
  for (let i = 0; i < block.utxoTxTree.utxoTxIds.length; i++) {
    const txId = block.utxoTxTree.utxoTxIds[i];
    const txCbor = block.utxoTxTree.utxoTxs[i];
    const tx = decodeTx(txCbor);

    const revalResult = revalidateTxInContext(deps, tx, block.header.height);
    if (!revalResult.valid) {
      console.warn(`UTXO tx ${txId} failed revalidation: ${revalResult.error}`);
      continue;
    }
    applyTx(deps, tx, computeOutputsWithIds(tx), block.header.height);
  }

  // Remove confirmed entries from local mempool
  // (we still have the entries locally if we're the miner)
  for (const subBlockId of block.subBlockTree.subBlockRefs) {
    removeMempoolEntry(subBlockId);
  }

  // Coinbase, epoch tally, karma decay (unchanged)
}
```

### 5. Benefits

| Before | After |
|--------|-------|
| Block references sub-blocks by ID → must find them in mempool | Block carries sub-block CBOR → always available |
| UTXO txs must exist in local mempool to be applied | UTXO tx CBOR is in the block → always available |
| Missing sub-blocks → need fetch path | No fetch path needed |
| Historical sync → sub-blocks permanently missing | Historical sync → every block is self-contained |
| Sub-blocks must survive in mempool until all peers have the block | Sub-blocks in mempool are purely local staging |

### 6. What goes away

- `fetchMissingSubBlocks` — not needed, blocks carry everything
- `appendSubBlocks` / `setSubBlocksHandler` — sub-blocks don't travel via sync independently
- `MODIFIER_SUB_BLOCK` (type 102) path in sync machine — sub-blocks are inside blocks
- `GetSubBlock` / `SubBlockResponse` (codes 6/7) — can be removed or deprecated
- Sub-block backfill problem — doesn't exist anymore

### 7. Gossip — unchanged

Sub-blocks still propagate via gossipsub (`/dagsocial/subblock/1`). The gossip
path gives nodes early visibility of pending content. When a block is mined, the
sub-blocks inside it are the canonical copies. If a node already has a sub-block
from gossip, the block's copy is redundant (but harmless — `insertPost` is
idempotent).

### 8. Serialization

`encodeOrderingBlock` / `decodeOrderingBlock` in `@dagsocial/types` gain the
new CBOR array fields. The binary format grows by the size of the included
sub-blocks and UTXO txs. For a block with 100 sub-blocks averaging ~500 bytes
each, that's ~50KB of sub-block data plus ~10KB of UTXO tx data — within
acceptable range for a 60-second block interval.

### 9. Journal

Block journal currently records `subBlockCbors` by looking them up in the
mempool. With inline CBOR, the journal reads directly from the block —
simpler and not dependent on local mempool state.

## Files Changed

| File | Change |
|------|--------|
| `packages/types/src/ordering-block.ts` | Add `subBlocks` to `SubBlockTree`, `utxoTxs` to `UtxoTxTree` |
| `packages/types/src/serialization.ts` | Encode/decode new CBOR array fields |
| `packages/node/src/services/block-creator.ts` | Encode sub-blocks and UTXO txs into block |
| `packages/node/src/services/block-apply.ts` | Decode from block instead of mempool lookup |
| `packages/node/src/store/journal.ts` | Read CBOR from block, not mempool |
| `packages/net/src/sync-machine.ts` | Remove `MODIFIER_SUB_BLOCK` handling (sub-blocks are in blocks) |
| `packages/net/src/sync-types.ts` | Remove `MODIFIER_SUB_BLOCK` constant or deprecate |
| `packages/net/src/node.ts` | Remove `setSubBlocksHandler` (not needed) |

## Preconditions

- Bridge fix commit (`e81cb31`) applied
- `SUBBLOCK_INTERFACE.md` contract is current
- `encodeSubBlock` / `decodeSubBlock` / `encodeTx` / `decodeTx` exported from `@dagsocial/types`

## Verification

- `pnpm typecheck` — all packages
- `pnpm test` — all existing tests pass, no regressions
- Block creator tests: verify new fields populated
- Block apply tests: verify sub-blocks and UTXO txs decoded from block
- Serialization round-trip: `decodeOrderingBlock(encodeOrderingBlock(block))` equality
- Manual: two-node cluster, create post on N1, mine block on N2, verify N2 applies block fully
- Historical sync: N2 catches up from genesis — all posts confirm, all UTXO state matches
