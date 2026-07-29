# Verifiable Prune — Block-Level Authorization and Settlement

**Date:** 2026-07-28
**Status:** design
**Packages:** `@dagsocial/types`, `@dagsocial/node`

## Summary

Move prune authorization and settlement data from DAG-side stumps into the
ordering block, making settlement deterministically verifiable from the block
chain and UTXO set alone. Replace the HTTP challenge-response auth flow with a
self-contained Ed25519 signed PruneIntent that travels in the block and is
verifiable by any node. Add a `block_topology` table for efficient post-ID
subtree verification without DAG content.

## Motivation

Three gaps in the current system:

1. **Authorization gap** — `pruneSignature` on the Stump is 64 zero bytes. The
   proof that the author authorized the delete exists only at the originating
   node's HTTP layer (challenge-response `verifyAuthorSignature`). No
   cryptographic proof travels with the prune to other nodes.

2. **Content integrity gap** — `computeStumpId` covers `rootPostHash`,
   `compactedAtBlockHeight`, and `authorId`, but not `subtreeMerkleRoot` or
   `karmaDeltas`. A node receiving a stump via gossip cannot verify the deltas
   are correct for the committed Merkle root.

3. **Settlement gap** — `applyOrderingBlock` settles PostLockBoxes and like
   refunds by walking the DAG (`getSubtree`, `getPostLockBox`,
   `getLockedLikeBoxes`). A node syncing UTXO-first (no DAG content yet) skips
   settlement because `getStump()` returns null and `getSubtree()` returns
   empty. The node's `stateRoot` permanently diverges from the canonical chain.

These are not separate bugs — they trace to a single design flaw: prune data
lives DAG-side, but settlement requires it at the UTXO layer.

## Design

### Prune entry moves to the block

The `SubBlockTree` currently carries `stumpIds: StumpId[]` — opaque references
to DAG-side stumps. Replace with a structured prune entry that carries all data
needed for authorization verification and deterministic settlement:

```typescript
// In SubBlockTree:
export interface SubBlockTree {
  subBlockRefs: PostId[];
  subBlockEntries: SubBlockEntry[];
  pruneEntries: PruneEntry[];  // replaces stumpIds
}

export interface PruneEntry {
  rootPostHash: PostId;          // post being deleted
  subtreePostIds: PostId[];      // all post IDs in the reply subtree
  subtreeMerkleRoot: Uint8Array; // Merkle root over leafHash('stump', postId) for each postId
  authorId: UserId;              // Ed25519 public key of root post author
  authorSignature: Uint8Array;   // Ed25519 signature over (rootPostHash, subtreeMerkleRoot)
  trigger: 'author' | 'storage_prune';
}
```

`PruneEntry` is committed into `subBlockRoot` via:

```typescript
function computeSubBlockRoot(tree: SubBlockTree): string {
  const leaves = [
    ...tree.subBlockEntries.map(entry => leafHash('subblock', ...)),
    ...tree.pruneEntries.map(entry =>
      leafHash('prune', serializePruneEntry(entry))),
  ];
  return buildMerkleRoot(leaves);
}
```

### Authorization model

The client signs `blake2b512(rootPostHash ++ subtreeMerkleRoot).subarray(0, 32)`
with their Ed25519 key. The signature is self-contained — any node can verify
`Ed25519.verify(authorId, payload, authorSignature)` without contacting the
originating node.

The HTTP challenge-response flow (`verifyAuthorSignature`) is removed. The
`DELETE /posts/:id` endpoint becomes: client computes the subtree (reply
walk), builds the Merkle root, signs `(rootPostHash, subtreeMerkleRoot)`,
submits the signed `PruneEntry` via a `POST /prune` endpoint. The node
broadcasts the entry to peers and inserts it into the mempool for block
inclusion.

No `drep` trigger — governance-free design. `storage_prune` is a placeholder
for future archive-node auto-pruning (no author signature — node-runner
initiated, verified differently).

### Deterministic settlement

During `applyOrderingBlock`, for each `PruneEntry`:

1. **Verify authorization:** `Ed25519.verify(entry.authorId, hash(entry.rootPostHash, entry.subtreeMerkleRoot), entry.authorSignature)` — reject block if invalid.

2. **Verify postId set:** Walk `block_topology` table (postId → parentRefs) from
   `entry.rootPostHash` using a recursive CTE. The computed set of descendant
   post IDs must equal `entry.subtreePostIds`. Reject block if not.

3. **Verify Merkle root:** Compute `leafHash('stump', postId)` for each postId
   in the entry, build the Merkle tree, verify root matches
   `entry.subtreeMerkleRoot`. Reject block if not.

4. **Settle UTXO:** For each `postId` in `entry.subtreePostIds`:
   - Find all unspent `PostLockBox` entries where `targetPostId = postId`
   - Find all `LikeBox` entries where `targetPostId = postId` (regardless of spent status — the UTXO set at apply time is authoritative)
   - Consume each box, accumulate refund amounts per author
   - Mint karma refund boxes for each author

   The root post itself is included in the subtree — its PostLockBox and
   LikeBoxes are refunded along with all descendants.

5. **Prune DAG content** (when present): Mark posts as `pruned` in `dag_posts`,
   insert the `Stump` row into `dag_stumps` for gossip/historical purposes. The
   DAG-side `Stump` no longer carries `karmaDeltas` — it's a historical record,
   not a settlement authority.

### block_topology table

A lightweight index of post topology derived from block data, maintained during
`applyOrderingBlock`:

```sql
CREATE TABLE block_topology (
  post_id TEXT PRIMARY KEY,
  parent_refs TEXT NOT NULL,  -- JSON array of parent post IDs
  block_height INTEGER NOT NULL
);
```

Populated from each block's `subBlockEntries`: for each entry, insert
`(postId, JSON.stringify(parentRefs), blockHeight)`. Grows linearly with the
chain (~100 bytes per post). Enables efficient subtree computation via
recursive CTE without DAG content.

This table is part of the UTXO layer (not the DAG layer) — it stays in sync
with block application and rollback.

### Type changes

**`@dagsocial/types`:**

- `SubBlockTree.stumpIds` removed, replaced by `pruneEntries: PruneEntry[]`
- New `PruneEntry` type as above
- `Stump` type simplified: `karmaDeltas` removed, `pruneSignature` removed,
  `trigger` drops `'drep'`, `compactedAtBlockHeight` remains for historical
  record
- `PruneIntent` keeps `rootPostHash`, `trigger`, `authorId`; gains
  `subtreeMerkleRoot` and `subtreePostIds`; `signature` becomes the actual
  Ed25519 signature (not a placeholder)
- `computeStumpId` removed (stump ID is now `computePruneEntryId` or simply the
  hash of the PruneEntry)

**`@dagsocial/node`:**

- `stump-engine.ts`: `executePrune` refactored to build `PruneEntry` instead of
  `Stump`; signature is client-supplied and verified
- `block-apply.ts`: settlement rewritten from DAG-walk to UTXO-driven
  deterministic settlement using `PruneEntry`
- `block-creator.ts`: drains prune entries from mempool instead of stump IDs
- `block-validate.ts` (if separate): add `PruneEntry` verification steps
- `mempool.ts`: stump entry type replaced with prune entry type
- `routes/delete.ts` and `routes/pruning.ts`: replace challenge-response with
  signed PruneEntry submission
- `verifier.ts`: `verifyAuthorSignature` removed (no longer needed)
- `store/posts.ts`: `pruneSubtree` simplified — DAG pruning only, no settlement
  logic
- New migration: create `block_topology` table, alter mempool schema

### Stump as historical artifact

The DAG-side `Stump` retains these fields for gossip and archival purposes:

```typescript
export interface Stump {
  rootPostHash: PostId;
  authorId: UserId;
  replyCount: number;
  upvoteCount: number;
  trigger: 'author' | 'storage_prune';
  protocolVersion: number;
  compactedAtBlockHeight: number;
}
```

It no longer carries `subtreeMerkleRoot`, `karmaDeltas`, or `pruneSignature`
— those are block-level fields now. Stumps are still gossiped so peers can discover
historical prunes, but settlement authority is always the block entry.

If a node receives a stump for a post it hasn't pruned yet (backfill), it
looks up the corresponding block to find the PruneEntry and replays settlement
from that — no trust in the gossip-level Stump content.

### Verification summary

| Step | What's verified | Without DAG content? |
|------|----------------|---------------------|
| Ed25519 signature | Author authorized this prune | Yes |
| block_topology CTE | `subtreePostIds` = actual reply tree | Yes |
| Merkle root | Post ID list integrity | Yes |
| UTXO queries | Boxes exist, amounts are correct | Yes |
| DAG prune | Mark posts pruned, store Stump | No (skipped gracefully) |

The entire settlement is deterministically verifiable from the block chain +
UTXO set. No DAG content required. No trust in the miner beyond PoW.

## Deferred

- **`storage_prune` authorization:** When implemented, this trigger type will
  use a different auth path (node-runner key, not post author). Left as
  placeholder for now.
- **`subtreePostIds` size cap:** No explicit cap proposed. Reply depth is
  naturally bounded by `MAX_PARENT_REFS = 8` and practical thread sizes. A cap
  can be added later if needed.
- **`block_topology` pruning:** The table grows with the chain. Future: entries
  older than some depth (after DAG content is backfilled) could be pruned. Not
  needed for correctness.

## Migration

Protocol version stays at 1 (not locked, no production deployment). No
backward compatibility needed. Nodes must resync from genesis after this
change (SubBlockTree format changes).

## Testing

- Unit: Ed25519 signature round-trip on PruneEntry
- Unit: Merkle root verification of `subtreePostIds`
- Unit: block_topology CTE subtree computation
- Unit: deterministic settlement from mock UTXO state
- Integration: full prune lifecycle (post → reply → like → delete → block
  apply → karma refund verification)
- Integration: UTXO-only node syncs past a prune, verifies settlement without
  DAG content
- Deletion of existing challenge-response tests
