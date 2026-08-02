# SUBBLOCK Interface Contract

**Component:** `@dagsocial/types` (structure), `@dagsocial/node` (lifecycle),
`@dagsocial/net` (propagation)
**Protocol version:** 2
**Last updated:** 2026-07-26

## Scope

Sub-blocks are the unit of content propagation in DAGsocial. Each sub-block
carries a single post, its associated like sidecars, and the post author's
PoW solution. They are user-produced, gossiped independently, collected into
a miner's mempool, and confirmed in batches by ordering blocks.

This contract defines sub-block identity, lifecycle, propagation, the
relationship to ordering blocks, and missing-sub-block resolution.

Sub-blocks are best understood as **pre-confirmation stubs** — they bundle a
post with associated UTXO operations (karma lock, likes) and a proof-of-work.
They propagate via gossip so nodes can display pending content, but they are
not part of the permanent chain. Once a miner includes them in an ordering
block, the sub-blocks' authoritative representation is inside that block.
The mempool is purely local staging for the miner.

---

## Relationship to Ergo Sub-Blocks

Ergo's sub-blocks (EIP-15, kushti, 2023) are **miner-produced weak blocks**
generated at T/64 difficulty, forming a linear chain between ordering blocks.
DAGsocial's sub-blocks are **user-produced post bundles** — each carries one
post, its like sidecars, and the author's PoW. The post author's PoW IS the
sub-block proof.

DAGsocial borrows the **dual-block architecture** (sub-blocks + ordering
blocks) and the **pull-based fetch for unknown sub-blocks** (INV → request
model), but intentionally does not adopt:

| Ergo concept | Why not applicable |
|-------------|-------------------|
| Miner-produced sub-block chain | Sub-blocks are produced by users concurrently — no single producer, no natural linear order |
| Sub-block chain commitment in ordering block | Not needed: sub-blocks that miss one ordering block survive in the mempool and land in the next. The mempool provides eventual consistency without a chain commitment. |
| T/64 difficulty ratio | Sub-blocks carry independent post-level PoW at `POST_POW_TARGET_BITS`, not block-level PoW |
| Weak confirmation tier | The ordering block interval is ~60s, not 2min; the pending→confirmed latency is already tight |
| Merge-mined sidechain incentives | No sidechains; users are incentivized by social propagation, not miner rewards |

---

## Sub-Block Structure

```typescript
interface SubBlock {
  subBlockId: string        // === postId (invariant: they cannot diverge)
  post: Post                // the post being published
  likeBoxes: LikeBox[]      // pending likes attached as sidecars
  producerId: UserId        // post author (user who solved the PoW)
  protocolVersion: number   // protocol version at creation time
}
```

### Invariants

- `subBlockId === computePostId(post)` — the sub-block IS the post. These
  identifiers cannot diverge.
- A sub-block carries exactly one post. No multi-post sub-blocks.
- `likeBoxes` contains pending likes queued at assembly time. These are
  UTXO-layer objects — the ordering block deduplicates likes that appear in
  both a sub-block sidecar and a standalone mempool UTXO entry.
- `producerId` matches `post.author`.
- Sub-blocks are **not** validators of other sub-blocks. A sub-block's PoW
  proves the post author did work, not that they endorse any other sub-block.
- A user cannot produce two sub-blocks concurrently that reference the same
  UTXO state. The second sub-block's UTXO transaction (karma lock) would
  reference a karma box already consumed by the first — it would fail
  revalidation at block application time and never confirm. This is inherent:
  a user whose first post hasn't confirmed yet is posting against stale UTXO
  state. Normal users don't do this; the protocol doesn't need to fix it.

### Serialization

CBOR-encoded for wire transmission. Encoding/decoding in `@dagsocial/types`:

```typescript
encodeSubBlock(sb: SubBlock): Uint8Array
decodeSubBlock(bytes: Uint8Array): SubBlock
```

---

## Sub-Block Lifecycle

```
                   ┌──────────┐
                   │  Created  │  User submits post → node assembles sub-block
                   └────┬─────┘
                        │
                        ▼
              ┌───────────────────┐
              │  Mempool (pending) │  Inserted with TTL = currentHeight + MEMPOOL_EXPIRY_BLOCKS
              └────────┬──────────┘
                       │
            ┌──────────┼──────────┐
            ▼                     ▼
   ┌─────────────────┐   ┌──────────────────┐
   │  Gossiped to    │   │  Collected by     │
   │  mesh peers     │   │  block creator    │
   └────────┬────────┘   └────────┬─────────┘
            │                     │
            │                     ▼
            │            ┌──────────────────┐
            │            │  Included in      │
            │            │  ordering block   │
            │            │  subBlockRefs     │
            │            └────────┬─────────┘
            │                     │
            │                     ▼
            │            ┌──────────────────┐
            │            │  Confirmed        │  Post status → confirmed
            │            │  UTXO txs applied │  Removed from mempool
            │            └──────────────────┘
            │
            ▼
   ┌─────────────────┐
   │  Expired         │  TTL exceeded before confirmation → purged
   │  (never confirmed)│
   └─────────────────┘
```

### States

| State | Meaning | Post status | UTXO txs |
|-------|---------|-------------|----------|
| **pending** | In mempool, gossiped, not yet confirmed | `pending` | Unapplied |
| **confirmed** | Referenced in an applied ordering block's `subBlockRefs` | `confirmed` | Applied |
| **expired** | TTL exceeded before confirmation | N/A (purged) | Purged |

A sub-block that is not included in one ordering block **remains in the
mempool** and is eligible for inclusion in the next block. The block
application code only removes entries that ARE in `subBlockRefs` —
unreferenced sub-blocks survive. This provides eventual consistency without
any chain commitment or ordering metadata: sub-blocks stay in the mempool
until they're either confirmed or they expire.

The linked UTXO transaction (karma lock) for a sub-block also stays in the
mempool. At the next block, it is revalidated in context
(`revalidateTxInContext`). If the karma box it references was consumed by a
prior block, revalidation fails and the sub-block's post never confirms.
This only happens for same-author concurrent posts — a natural consequence
of posting against stale UTXO state, not a protocol defect.

---

## Sub-Block Propagation

### Push path (gossip — implemented)

1. Node assembles sub-block → `broadcastSubBlock(sb)` → gossipsub topic
   `/dagsocial/subblock/1`
2. Receiving peers run Stage 1 validation (CBOR structure, protocol version,
   PoW, signature) via `@dagsocial/validation`
3. On pass: forward to mesh peers, deliver to Stage 2 handler
4. Stage 2 handler (`verifyPostForRelay`): content limits, parent refs,
   karma sufficiency. On pass: insert post into DAG store, insert sub-block
   CBOR into mempool (`insertMempoolSubBlock`)
5. On failure: penalize source peer (MisbehaviorPenalty, score 100)

The gossip path carries the **full sub-block CBOR**. Loopback is harmless —
the mempool insert is idempotent (sub-block ID is the primary key), and
`verifyPostForRelay` skips the challenge check (the challenge was node-local
to the origin node).

### Pull path — content is best-effort, topology is consensus

Sub-blocks travel via gossip. The sync protocol ships **ordering blocks
only** — a block commits to sub-block *topology* (`subBlockEntries`), never to
post content. A node applying a block for a post it has not seen inserts a
**placeholder** row and confirms it; the content-sweep hooks
(`setSyncHandler` / `onSyncComplete` / `onPeerActive`, see `NODE_INTERFACE.md`)
backfill placeholders best-effort when a peer still holds the content. Pruned
content is gone network-wide by design, so backfill can never be a consensus
dependency.

---

## Ordering Block Relationship

Ordering blocks do NOT carry sub-block or post content. `subBlockTree`
contains `subBlockRefs` (IDs, for ordering), `subBlockEntries` (committed
topology — `{ postId, parentRefs, author }`, aligned 1:1 with
`subBlockRefs`), and `pruneEntries`. The entries are committed under
`subBlockRoot` (the `'subblock'` leaf serializes `{ postId, parentRefs,
author }`, JSON, exactly this key order), so topology and authorship are
consensus data on every node even when content never arrives (audit H-3).

### Block creation (miner)

1. Pull pending sub-blocks from mempool
2. Decode, attach standalone like UTXO txs, deduplicate likes
3. `subBlockRefs` = ordered list of sub-block IDs (FIFO)
4. `subBlockEntries` = `{ postId, parentRefs, author }` per sub-block, filled
   from the resolved post itself (same order; never from a client claim)
5. Build `subBlockRoot` = Merkle root over the sub-block entry leaves plus
   prune-entry leaves
6. Sub-blocks beyond `maxSubBlocksPerBlock` stay in mempool

### Block application (all nodes)

1. For each sub-block entry:
   - If the post is locally present with real content: REJECT the block
     unless `entry.author` and `entry.parentRefs` (exact ordered sequence)
     match the post — content-holders keep lying entries out of the chain
   - If the post is absent: insert a placeholder row from the entry
   - `confirmPost(entry.postId, blockHeight)`; record
     `(postId, parentRefs, author)` in `block_topology`
2. For each index `i` in `utxoTxIds`:
   - Decode `utxoTxs[i]` via `decodeTx`
   - Revalidate in context, apply
3. Remove confirmed entries from local mempool

The block is self-contained for *state transition* purposes (UTXO, topology,
authorship); post content is supplementary and arrives via gossip or sweep.

---

## Confirmation Model

| Level | Trigger | Latency | API status |
|-------|---------|---------|------------|
| **Pending** | Sub-block in mempool, gossiped | Immediate | `"pending"` |
| **Confirmed** | Included in applied ordering block's `subBlockRefs` | One block interval (~60s) | `"confirmed"` |

Two tiers. No intermediate "anchored" tier — the block interval is short
enough that pending→confirmed latency is acceptable without it.

---

## Integration Points

### Net package

- `broadcastSubBlock(sb)`: push to mesh peers via gossipsub
- `onSubBlock(callback)`: register Stage 2 handler for inbound sub-blocks
- Sync: the sync protocol ships ordering blocks (topology only). Sub-block
  content travels via gossip and the best-effort content sweep.

### Node package

- `insertMempoolSubBlock(sb, expiresAtHeight, batchId?)`: queue sub-block
- `getPendingEntries(limit)`: retrieve FIFO-ordered pending entries
- `confirmPost(postId, blockHeight)`: mark post confirmed
- Block creator: snapshots mempool, builds `subBlockRefs` +
  `subBlockEntries` (`{ postId, parentRefs, author }` from the resolved
  posts) + `subBlockRoot`, attaches linked UTXO txs, deduplicates likes
- Block apply: confirms referenced sub-blocks, removes them from mempool.
  Unreferenced sub-blocks survive for the next block.

### Validation package

- Stage 1 (stateless, `@dagsocial/validation`): CBOR, protocol version,
  content limits, PoW, signature
- Stage 2 (stateful, `@dagsocial/node`): parent refs, karma sufficiency.
  Challenge check skipped for relayed sub-blocks.

---

## Preconditions

- `@dagsocial/types` provides `SubBlock`, `encodeSubBlock`, `decodeSubBlock`,
  `computePostId`
- `@dagsocial/validation` provides Stage 1 stateless checks
- `@dagsocial/net` provides gossipsub topic `/dagsocial/subblock/1` and
  framed sync protocol with `GetSubBlock` (code 6) / `SubBlockResponse` (code 7)
- `@dagsocial/node` provides mempool (`insertMempoolSubBlock`) and post
  store (`insertPost`, `confirmPost`, `getPost`)
- Node.js ≥ 22

## Postconditions

- Sub-blocks propagate to mesh peers within one gossip heartbeat
- Sub-blocks pass Stage 1 + Stage 2 validation before mempool insertion
- Sub-blocks not confirmed in one ordering block survive in the mempool for
  the next block (eventual consistency)
- Ordering blocks carry sub-block topology (`subBlockEntries`, including
  `author`) — every node can apply every block's state transitions without
  external data; content is supplementary (placeholder + sweep)
- Confirmed sub-blocks have their posts transitioned to `confirmed` and their
  UTXO transactions applied

## Invariants

- `subBlockId === computePostId(post)` — always, everywhere
- A sub-block carries exactly one post
- Sub-blocks are user-produced, carrying post-level PoW
- The ordering block is the sole authority on which sub-blocks get confirmed
- `subBlockRefs.length ≤ maxSubBlocksPerBlock`
- `subBlockRefs[i]` corresponds to `subBlockEntries[i]` — same index, same
  sub-block
- Sub-block gossip is stateless at Stage 1 — verification depends only on
  the sub-block's own content
- Sub-blocks not referenced by an ordering block remain in the mempool
  (not discarded) until they expire or are confirmed by a later block
- Ordering blocks are self-contained — they carry all data needed to apply
  their state transitions

---

## Future

### INV-based sub-block announcements

Replace full-body re-gossip with ID-first announcements: `Inv(type=102, ids=...)`
followed by peer-requested body delivery. Peers that already have the sub-block
(from the origin node's broadcast) skip the body download. Borrowed from Ergo's
sub-block propagation model.

### Transaction class separation

First-class transactions (posts — deterministic, sub-block-only) vs second-class
transactions (miner-dependent, ordering-block-only). Currently everything is
first-class. When miner-dependent features land, the distinction becomes
relevant.
