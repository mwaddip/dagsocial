# Unified Mempool Design

**Date:** 2026-07-24
**Status:** Approved

## Overview

Replace immediate UTXO state mutation with a unified mempool. Every state-changing
operation (posts, likes, invites, faucet, credit transfers) produces a pool entry
that queues for inclusion in the next ordering block. State is only committed when
the block lands. Zero bypass paths.

Currently, four HTTP routes apply UTXO state immediately — `POST /posts` (karma
lock), `POST /likes`, `POST /invites`, and `POST /faucet` — and gossip-relayed
transactions are applied on arrival. The `utxoTxIds` field on `OrderingBlock` is
always `[]`. This design makes every mutation flow through pool → block inclusion
→ block application.

## Pool Structure

Single SQLite table `mempool` with a type discriminator. Unified FIFO ordering
across sub-blocks and UTXO transactions.

| Column | Type | Purpose |
|--------|------|---------|
| `rowid` | integer | FIFO ordering (SQLite implicit) |
| `entry_type` | text | `'subblock'` or `'utxo_tx'` |
| `subblock_cbor` | blob | CBOR-encoded SubBlock (nullable) |
| `utxo_tx_cbor` | blob | CBOR-encoded UtxoTransaction (nullable) |
| `batch_id` | text | Groups sub-block with its UTXO payload; null for standalone |
| `expires_at_height` | integer | Insert height + 720 blocks (~12h) |
| `created_at` | text | ISO 8601 timestamp |

### Store API (`store/mempool.ts`)

```
insertSubBlock(subBlock, likeBoxes) → rowid
insertUtxoTx(tx, batchId?) → rowid
getPendingEntries(limit) → PoolEntry[]
purgeExpired(currentHeight) → removed count
removeEntry(rowid)
removeBatch(batchId)
```

`getPendingEntries` returns entries ordered by `rowid ASC`, respecting batch
grouping: all entries in a batch appear consecutively, sub-block first.

## Sub-block as UTXO Carrier

Sub-blocks already carry `likeBoxes` as sidecars. This design extends that
pattern:

- A post's karma lock is a **separate `utxo_tx` pool entry** sharing the same
  `batch_id` as the sub-block. It is NOT embedded in the sub-block CBOR. The
  sub-block structure is unchanged.
- A sub-block and its batch-linked UTXO transactions confirm or reject together.
  The block creator includes the full batch or skips it.
- `POST /posts` inserts the sub-block and its karma-lock transaction as a batch
  (two rows, same `batch_id`). `POST /likes` always inserts a standalone
  `utxo_tx` entry — no batch, no attachment at submission time.

### Like attachment at block assembly

At block assembly time, the block creator scans standalone like transactions in
the pool and attaches them to matching sub-blocks:

1. For each pending `utxo_tx` that is a like transaction, extract the target
   post ID.
2. If a pending sub-block's post ID matches, remove the like's pool entry,
   add the like's output box IDs to that sub-block's `likeBoxes` array, and
   include a corresponding `UtxoTransaction` in the batch (same `batch_id`)
   for the like's UTXO effects (karma lock reduction).
3. If no matching sub-block is pending, the like stays as a standalone
   `utxo_tx` entry and goes into the block's `utxoTxIds`.

This means a `likeBoxes` array on a sub-block is populated incrementally:
partially at submission (likes submitted alongside the post by the same
author), and partially at assembly (standalone likes from other users that
arrived while the post was pending).

## UTXO Engine Refactoring

Split `validateAndApplyTx` into three functions:

### `validateTx(deps, tx, currentHeight)` — read-only

Called at pool entry. Checks:
- Box existence and unspent status
- Guard satisfaction (signatures, preimage hashes)
- Value conservation (with karma decay and bond burning)
- Legal box transitions (`checkTransitions`)
- Karma decay calculation

Returns a validated transaction with computed output IDs. Does not write.

### `revalidateTxInContext(deps, tx, currentHeight)` — lightweight

Called at block application. Only checks:
- Are all inputs still unspent? (could have been consumed by a prior block)
- Has karma decay expired? (height advanced past the grace period)

Skips signature verification (already done in `validateTx`). Catches stale state.

### `applyTx(deps, tx, currentHeight)` — write

Called during block finalization. Consumes all inputs, inserts all outputs,
within a SQLite transaction (shared with the block application transaction).

## Validation Flow

**At submission (pool entry):**
1. Structural checks (CBOR parse, field presence, no duplicate inputs) — Stage 1
2. Full UTXO validation via `validateTx` — Stage 2
3. Insert into pool
4. Broadcast via gossipsub

**At block assembly:**
1. `purgeExpired(currentHeight)`
2. `getPendingEntries(limit)`
3. Resolve batches — sub-blocks get their linked UTXO payloads
4. Attach standalone likes to matching sub-blocks by post ID
5. Remaining standalone UTXO entries → `utxoTxIds`
6. Epoch tally runs (block-internal, not pool entries)

**At block application (finalizeBlock):**
1. For each sub-block: confirm post, apply embedded UTXO transactions via
   `revalidateTxInContext` → `applyTx`
2. For each `utxoTxIds` entry: `revalidateTxInContext` → `applyTx`
3. For each `likeBoxIds`: mark as tallied
4. Apply coinbase via `mintCredits`
5. Apply epoch tally results via `applyTx`
6. Remove all confirmed entries from pool

All steps run in a single SQLite transaction.

## Block Creator Changes

`createOrderingBlock()`:
1. Polls mempool instead of `getPendingSubBlocks()`
2. Resolves batch-linked entries
3. Attaches standalone likes to sub-blocks where post IDs match
4. Populates `utxoTxIds` with remaining standalone UTXO entries
5. Runs epoch tally (unchanged — block-internal, not pool entries)
6. Empties pool after `finalizeBlock` confirms

## Epoch Tally

Stays inside the block creator. Results are structured as `UtxoTransaction[]`
inside the block (`epochTallyResults`), applied via the same `applyTx` code
path as user-submitted transactions. Never enters the pool. Same as coinbase —
protocol-level logic, not user-submitted work.

## HTTP Route Changes

Every mutating route changes from "validate → apply immediately → return" to:

1. Construct the entry (sub-block or UTXO transaction)
2. Call `validateTx` (read-only, no state change)
3. Insert into pool via `mempool.insert*`
4. Broadcast via gossipsub (sub-blocks on `/dagsocial/subblock/1`,
   UTXO transactions on `/dagsocial/tx/1`)
5. Return `{ status: "pending", id, expiresAtHeight }`

Affected routes:
- `POST /posts` — inserts sub-block with batch-linked karma-lock UTXO tx
- `POST /likes` — inserts standalone UTXO tx (attachment to sub-block happens
  later, at block assembly time)
- `POST /invites` / `/invites/claim` / `/invites/cancel` — inserts UTXO tx
- `POST /faucet` — inserts UTXO tx

## Gossip Integration

No changes needed. Existing topics and validators remain:

| Topic | Payload | Validator |
|-------|---------|-----------|
| `/dagsocial/subblock/1` | SubBlock (CBOR) | `verifySubBlockStructure` |
| `/dagsocial/tx/1` | UtxoTransaction (CBOR) | `verifyTxStructure` |

On receipt, entries pass Stage 1 (structural), then `validateTx`, then enter
the pool. The `onTx` and `onSubBlock` callbacks insert into the pool instead
of applying state immediately.

## Pool Lifecycle

- **TTL:** 720 blocks (~12 hours at 60s block time). Set at insertion as
  `currentHeight + 720`.
- **Expiry:** Purged at block assembly time via `purgeExpired`. Expired entries
  are silently dropped.
- **No size cap.** The pool self-drains every ~60s when blocks are produced.
- **No replacement semantics** (no fees yet to drive RBF).

## Atomicity Guarantees

- A sub-block and its batch-linked UTXO payloads (karma lock) confirm or
  reject together. The block creator includes the full batch or skips it.
- Standalone UTXO transactions are atomic per-transaction. If any transaction
  in a block fails revalidation (stale inputs), it is skipped and the rest
  proceed.
- Block finalization is a single SQLite transaction — either all state mutations
  in the block land, or none do.

## Migration

No migration needed. Fresh schema per iteration. The `sub_blocks` table is
replaced by the `mempool` table. `getPendingSubBlocks` and related functions
are removed.

## Remaining Gaps Not Addressed

- **Fees & replacement:** No fee market yet. RBF-style replacement deferred.
- **Pool backpressure:** No mechanism to reject entries when the pool is large.
  Acceptable while block production is reliable.
- **Client confirmation UX:** Clients get `{ status: "pending" }` with an expiry
  height. No push notification when a block confirms their entry. Demo UI
  polling is fine for Phase 1.
