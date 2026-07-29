# MEMPOOL Interface Contract

**Component:** `@dagsocial/node` (store subsystem)
**Protocol version:** 1
**Last updated:** 2026-07-29

## Scope

The mempool is a unified pending-entry queue for all state-changing operations.
Nothing applies UTXO state immediately — every mutation is queued as a pool
entry, included in an ordering block, and applied atomically when the block
lands. The mempool is a store subsystem, not a separate process or package.

Located at `packages/node/src/store/mempool.ts`. Replaces the old `sub_blocks`
table (removed).

---

## Schema

Single SQLite table:

```sql
CREATE TABLE mempool (
    entry_type        TEXT NOT NULL CHECK (entry_type IN ('subblock', 'utxo_tx', 'prune')),
    subblock_cbor     BLOB,            -- CBOR-encoded SubBlock (null for non-subblock)
    utxo_tx_cbor      BLOB,            -- CBOR-encoded UtxoTransaction (null for non-utxo_tx)
    prune_entry_cbor  BLOB,            -- CBOR-encoded PruneEntry (null for non-prune)
    batch_id          TEXT,            -- Links sub-block + UTXO payloads from same operation
    expires_at_height INTEGER NOT NULL, -- Block height after which entry is purged
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

No separate `id` column — the SQLite `rowid` is the canonical identifier for
entries.

### PoolEntry (in-memory representation)

```typescript
interface PoolEntry {
  rowid: number;
  entryType: 'subblock' | 'utxo_tx' | 'prune';
  subblockCbor: Uint8Array | null;
  utxoTxCbor: Uint8Array | null;
  pruneEntryCbor: Uint8Array | null;
  batchId: string | null;
  expiresAtHeight: number;
  createdAt: string;
}
```

Entries are decoded from CBOR on read by the consumer (block creator or relay
handler). The mempool store layer does not decode payloads — it stores and
returns raw CBOR.

---

## API Surface

### insertMempoolSubBlock

```
insertMempoolSubBlock(sb: SubBlock, expiresAtHeight: number, batchId?: string | null): number
```

Encodes the sub-block as CBOR and inserts a `subblock` entry. Returns the
SQLite `rowid` of the new row.

- `batchId` is optional. When set (e.g., to `postId`), links this sub-block
  to UTXO transactions in the same batch.
- `expiresAtHeight` is typically `currentHeight + 720` (~12h at 60s blocks).

### insertUtxoTx

```
insertUtxoTx(tx: UtxoTransaction, batchId: string | null, expiresAtHeight: number): number
```

Encodes the UTXO transaction as CBOR and inserts a `utxo_tx` entry. Returns
the SQLite `rowid`.

- `batchId` is null for standalone transactions (likes, invites, faucet).
  Set to a post ID for batch-linked transactions (karma-lock on post creation).
- `expiresAtHeight` is the block height at which the entry becomes invalid.

### insertMempoolPrune

```
insertMempoolPrune(entry: PruneEntry, expiresAtHeight: number): number
```

Encodes the PruneEntry as CBOR and inserts a `prune` entry. Returns the
SQLite `rowid`.

### drainMempoolPrunes

```
drainMempoolPrunes(limit: number): PruneEntry[]
```

Decodes and returns prune entries in FIFO order (`ORDER BY rowid ASC`), up
to `limit`. Returns decoded PruneEntry objects (not raw CBOR).

### removeMempoolPrunes

```
removeMempoolPrunes(entryIds: string[]): void
```

Deletes prune entries by rowid. Called during block finalization for each
confirmed prune entry.

### getPendingEntries

```
getPendingEntries(limit: number): PoolEntry[]
```

Returns pending entries in FIFO order (`ORDER BY rowid ASC`), up to `limit`.
All entries are returned — `subblock`, `utxo_tx`, and `prune` types. The caller
(block creator) is responsible for decoding and organizing entries by type
and batch.

Entries are NOT filtered by expiry here — the caller calls `purgeExpired`
first before fetching.

### purgeExpired

```
purgeExpired(currentHeight: number): number
```

Deletes all entries where `expires_at_height < currentHeight`. Returns the
number of deleted rows.

Called at the start of block creation, before `getPendingEntries`. Ensures
expired entries never make it into a block.

### removeEntry

```
removeEntry(rowid: number): void
```

Deletes a single entry by rowid. Called during block finalization for each
confirmed entry. The block creator tracks which rowids were included in the
block and removes them after the block is stored.

### removeBatch

```
removeBatch(batchId: string): void
```

Deletes all entries with the given `batch_id`. Used to remove linked
sub-block + UTXO payload pairs atomically after block finalization. The
block creator prefers `removeEntry` per-rowid; `removeBatch` is available
for cleanup of partially-included batches.

---

## Lifecycle

```
                   ┌──────────────┐
                   │  API Route   │
                   │  (POST /posts,│
                   │   /likes,     │
                   │   /invites,   │
                   │   /faucet)    │
                   └──────┬───────┘
                          │ insertMempoolSubBlock / insertUtxoTx
                          ▼
                   ┌──────────────┐
                   │   Mempool    │  ← entries sit here, unconfirmed
                   │  (SQLite)    │
                   └──────┬───────┘
                          │
            ┌─────────────┼─────────────┐
            │             │             │
            ▼             ▼             ▼
      ┌──────────┐ ┌──────────┐ ┌──────────┐
      │  Timer   │ │  Sub-blk │ │ External │
      │  fires   │ │  counter │ │  miner   │
      │ (60s)    │ │ >= min   │ │ submits  │
      └────┬─────┘ └────┬─────┘ └────┬─────┘
           │            │            │
           └────────────┼────────────┘
                        │ createOrderingBlock()
                        ▼
                 ┌──────────────┐
                 │ 1. purgeExpired │
                 │ 2. getPending   │
                 │ 3. Assemble     │
                 │    block        │
                 │ 4. Mine / sign  │
                 └──────┬───────┘
                        │ finalizeBlock()
                        ▼
                 ┌──────────────┐
                 │ 1. Store block│
                 │ 2. Apply UTXO │
                 │ 3. Confirm    │
                 │    posts      │
                 │ 4. removeEntry│
                 │    per rowid  │
                 └──────────────┘
```

### Entry states

| State | How entered | How exited |
|-------|------------|------------|
| **Pending** | `insertMempoolSubBlock` / `insertUtxoTx` | Included in block → `removeEntry`; or `purgeExpired` |
| **Confirmed** | Block finalization (`removeEntry`) | Gone from mempool; state now in ledger |
| **Expired** | `purgeExpired` during block assembly | Gone from mempool; state never applied |

### Expiry

- **TTL:** 720 blocks (~12h at 60s block time)
- **Expiry check:** at block assembly time (`purgeExpired`), not on a timer
- **Expired entries** are silently dropped — the API already returned
  `{ status: "pending" }` to the client; the client should re-submit if their
  operation times out

---

## Batch Linking

Operations that produce multiple pool entries (sub-block + UTXO payloads) are
linked via `batch_id`. This ensures the block creator processes them atomically.

### Current batch-linked operations

| Operation | Sub-block | UTXO payloads | batch_id |
|-----------|-----------|---------------|----------|
| `POST /posts` | 1 sub-block | 1 karma-lock tx | `postId` |

The block creator resolves batches during assembly: for each batch_id, it
includes the sub-block and all linked UTXO entries in the same block.

### Standalone (non-batched) operations

| Operation | Pool entry type | batch_id |
|-----------|----------------|----------|
| `POST /likes` (locked) | `utxo_tx` | null |
| `POST /likes/remove` | `utxo_tx` | null |
| `POST /invites` | `utxo_tx` | null |
| `POST /invites/claim` | `utxo_tx` | null |
| `POST /invites/cancel` | `utxo_tx` | null |
| `POST /faucet` | `utxo_tx` | null |
| Relay: inbound sub-block | `subblock` | null |
| Relay: inbound UTXO tx | `utxo_tx` | null |

---

## Block Creator Integration

The block creator (`services/block-creator.ts`) is the sole consumer of
pending entries:

1. Calls `purgeExpired(currentHeight)` — drops stale entries
2. Calls `getPendingEntries(maxSubBlocksPerBlock)` — fetches FIFO batch
3. Separates entries by `entryType`:
   - `subblock` entries → decoded, included as `subBlockRefs`
   - `utxo_tx` entries with `batch_id = null` → either attached to matching
     sub-blocks (likes by targetPostId) or listed as standalone `utxoTxIds`
   - `utxo_tx` entries with `batch_id ≠ null` → resolved against their batch's
     sub-block, included as `utxoTxIds`
   - `prune` entries → decoded via `drainMempoolPrunes`, included as
     `pruneEntries`
4. Tracks `confirmedRowids` (set of rowids included in the block)
5. After block finalization: `removeEntry(rowid)` for each confirmed rowid,
   `removeMempoolPrunes(entryIds)` for confirmed prune entries

### Like attachment during assembly

Standalone like UTXO transactions (batch_id = null, outputs contain a LikeBox)
are matched to sub-blocks by `targetPostId`. If a matching sub-block exists in
the same pending batch, the like box is attached to the sub-block's `likeBoxes`
array and the UTXO entry is consumed (not listed separately). If no matching
sub-block exists, the like goes as a standalone `likeBoxId`.

---

## Relay Integration

Inbound relay handlers insert into the mempool rather than applying state:

- **`onSubBlock(sb)`**: validate (read-only) → `insertMempoolSubBlock(sb, expiresAtHeight)`
- **`onTx(tx)`**: `validateTx` (read-only) → `insertUtxoTx(tx, null, expiresAtHeight)`

State is applied later when an ordering block containing these entries is
received and applied.

### Relay: ordering block application

When an ordering block is received from gossip:

1. Full validation (structure, chain-link, PoW, signature)
2. For each `utxoTxId`: decode from mempool or reconstruct, call
   `revalidateTxInContext` (liveness only), then `applyTx`
3. Confirm sub-blocks and their posts
4. Remove confirmed entries from mempool

---

## Design Decisions

### No size cap

No limit on mempool size. Rationale: no fees yet, so no economic pressure to
fill the pool. A cap with eviction would require fee-based prioritization,
which is deferred.

### No replacement semantics

Entries are never replaced or updated. If a user submits a new operation that
supersedes an old one (e.g., cancel an invite), the old entry still exists in
the pool. The block creator processes entries in FIFO order — if the cancel
arrives after the invite, both are in the pool and the cancel will fail at
apply time (invite already consumed). This is acceptable for now; replacement
semantics (RBF) require fees and are deferred.

### FIFO ordering

Entries are ordered by `rowid ASC` (insertion order). No priority queue.
Without fees, there's no basis for prioritization beyond arrival time.

### CBOR storage

Entries are stored as CBOR blobs rather than parsed columns. This avoids
double-parsing (CBOR on wire → JSON for SQLite → CBOR for broadcast) and
keeps the mempool schema agnostic to entry structure. The block creator
decodes CBOR when assembling blocks.

### No separate tables

A single table with a type discriminator rather than separate `sub_blocks`
and `utxo_txs` tables. This gives unified FIFO ordering, simpler expiry,
and simpler batch resolution (shared `batch_id` column). The old `sub_blocks`
table was removed during the mempool migration.

---

## Invariants

- All state mutations flow through the mempool — no direct `consumeBox` or
  `insertBox` calls in HTTP routes or relay handlers
- Mempool entries are CBOR blobs — the store layer does not parse them
- Expiry is checked at block assembly time, not on a background timer
- Batch-linked entries share a `batch_id` and are included atomically in
  the same ordering block
- Confirmed entries are removed by rowid after block finalization
- FIFO ordering (by insertion) — no priority, no reordering
- No size cap, no replacement, no fee-based eviction
- Mempool is a node-local data structure — it is NOT gossiped
