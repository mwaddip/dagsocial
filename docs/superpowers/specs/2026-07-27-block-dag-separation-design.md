# Block/DAG Separation — Design

**Date:** 2026-07-27
**Status:** draft
**Scope:** `@dagsocial/types`, `@dagsocial/validation`, `@dagsocial/node`

Blocks carry topology (which posts exist at what height, how they connect,
which posts were pruned). The DAG carries content. A bootstrapping node
replays the chain to build complete DAG topology, then fills in content via
gossip. UTXO-only nodes follow the chain without ever fetching content.

## 1. Type Changes (`@dagsocial/types`)

### 1.1 SubBlockTree

Remove `subBlocks: Uint8Array[]`. Add `subBlockEntries`:

```typescript
export interface SubBlockEntry {
  postId: string;        // hex-encoded 32-byte post ID
  parentRefs: string[];  // hex-encoded parent post IDs (0–8)
}

export interface SubBlockTree {
  subBlockEntries: SubBlockEntry[];  // aligned with subBlockRefs ordering
  stumpIds: StumpId[];               // unchanged — stumps committed in this block
}
```

`subBlockRefs` is derivable (`entries.map(e => e.postId)`) but kept in the
tree for Merkle root compatibility — the root commits to both entries and
stumps.

### 1.2 BlockJournal

Remove `subBlockCbors`. `confirmedSubBlockIds` already exists and covers the
use case. Fork resolution re-inserts into mempool by ID, not CBOR.

### 1.3 Serialization

`encodeSubBlockTree`/`decodeSubBlockTree` updated for the new field.
`SubBlockEntry` is a CBOR-serializable plain object — no custom encoding
needed beyond what `cbor-x` already handles for `{ postId, parentRefs }`.

`encodeOrderingBlock`/`decodeOrderingBlock` flow through unchanged — they
delegate to `encodeSubBlockTree`.

## 2. Validation (`@dagsocial/validation`)

`verifyOrderingBlockStructure` drops the `subBlocks.length === subBlockRefs.length`
check. Adds:
- `subBlockEntries` is an array
- Each entry has `postId` (64-char hex) and `parentRefs` (array of 64-char hex, 0–8 entries)

## 3. Merkle Root

`computeSubBlockRoot` changes from `hash(subBlockRefs + stumpIds)` to
`hash(subBlockEntries + stumpIds)`. Each `SubBlockEntry` is hashed as
`leafHash('subblock', Buffer.from(JSON.stringify({ postId, parentRefs })))`.
Stumps unchanged: `leafHash('stump', hexToBuf(id))`.

This commits the full topology (post IDs + parent relationships) into the
block header. A node can verify that the topology it derived matches the
committed root.

## 4. Mempool

`PoolEntry.subblockCbor: Uint8Array | null` becomes `subblockId: string`.
`insertSubBlock` takes a post ID and parent refs (not a full SubBlock).

DB schema: `subblock_cbor BLOB` → `subblock_id TEXT NOT NULL`.
`dag_posts` already has the post content and parent refs — the mempool
only needs the ID to know what to include in the next block.

When the block creator pulls entries, it reads `dag_posts` for each
`subblockId` to get parent refs and like boxes. If the post isn't in
`dag_posts` yet (placeholder from a prior block confirmation, content
not yet arrived), it's skipped for this block.

## 5. Block Creator

`createOrderingBlock` changes:
- Decodes sub-blocks from mempool to extract like boxes (attached to
  sub-blocks by targetPostId match)
- Builds `subBlockEntries` from post metadata (ID + parentRefs), not
  from re-encoded CBOR
- `subBlockRefs` derived from entries for backward compat in the tree
- Template no longer carries inline CBOR

Like box extraction still works because the sub-block data is decoded
during block creation from `dag_posts` — it's just not re-encoded into
the block.

## 6. Block Application

`applyOrderingBlock` changes:
- **Removed:** the loop that populates journal `subBlockCbors` from
  block CBOR (lines 60–66)
- **Removed:** `insertPost` call for missing posts (lines 180–197).
  The block no longer carries content.
- **Added:** for each `subBlockEntry`, if the post doesn't exist in
  `dag_posts`, create a placeholder row with the ID, parent refs,
  `status='pending'`, and null/default for all other columns (content,
  author, signature, PoW, CBOR). Content arrives via gossip. If the post
  already exists, `confirmPost` as before.
- **Added:** stump processing — for each `stumpId` in the block, look up
  the full `Stump` object in `dag_stumps` and call `pruneSubtree` with it.
  Stumps are gossiped like post content — the block only commits IDs. A
  node that doesn't have the Stump locally fetches it via gossip before
  applying the prune. During bootstrap, stump fetch is part of the
  content-fill phase after chain replay.

## 7. On-Chain Prune Commits

When an author prunes a subtree:
1. `pruneSubtree` runs locally — marks posts pruned, inserts stump
2. The stump ID is queued for inclusion in the next block
3. Block creator includes queued stump IDs in `SubBlockTree.stumpIds`
4. On replay, every node applies the same prune at the same height —
   deterministic DAG state

The queuing mechanism: `pruneSubtree` inserts the stump into `dag_stumps`
and enqueues the stump ID for the next block (in-memory set, survives
only until the block is created — if the node restarts before the block
is mined, the prune is re-queued from `dag_stumps` on startup). Block
creator drains the queue into `stumpIds`. The full Stump object is
gossiped to peers so they can replay the prune when they process the block.

## 8. Fork Resolution

`revertAndApply` currently re-inserts reverted sub-blocks into mempool
by decoding CBOR from the journal. With CBOR removed, it re-inserts by
ID — the post content is in `dag_posts`. The journal's
`confirmedSubBlockIds` is sufficient.

## 9. Bootstrap / Sync

Chain replay builds DAG topology from `subBlockEntries` across all blocks:
- Every post ID ever confirmed exists in `dag_posts` (as a full post or
  placeholder)
- Every parent relationship is known from `subBlockEntries`
- Every prune is replayed at the correct height from `stumpIds`

After chain replay, the node has complete topology. Content for non-pruned
posts is fetched via gossip using the existing `syncHandler` mechanism.

UTXO-only nodes: skip gossip entirely. They have the full UTXO state from
the chain and a complete DAG topology skeleton. No content storage needed.

## 10. Sync Handler

The sync handler (`index.ts` line 253) currently decodes CBOR from mempool
to find posts by ID. After this change, it reads `dag_posts` directly —
the mempool no longer carries content.

## What Doesn't Change

- Block header structure (protocol version, height, prevBlockHash, roots,
  validatorId, PoW, signature)
- `UtxoTxTree` — UTXO transactions still carry CBOR inline (they're small,
  non-prunable, and needed for UTXO-only nodes)
- Like box processing — extracted during block creation from dag_posts,
  not from block CBOR
- HTTP API — routes already empty `subBlocks` in JSON responses
- `canonical_branch` / `post_scores` — DagService integration is a
  separate session

## Test Plan

- **Types:** serialization roundtrip for new `SubBlockTree`
- **Validation:** structure checks for `subBlockEntries`
- **Mempool:** ID-based insert/retrieve/expire
- **Block creator:** entries built correctly, Merkle root matches
- **Block application:** placeholder creation, confirm flow, stump processing
- **Fork resolution:** ID-based re-insertion
- **Integration:** chain replay builds correct topology, content fetch fills gaps
