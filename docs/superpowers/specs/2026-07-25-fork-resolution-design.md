# Fork Resolution: Chain Scoring, Reorg, and Rollback

**Date:** 2026-07-25
**Status:** design (not yet implemented)
**Protocol version:** 1

## Motivation

With block headers in place, two miners can produce valid blocks at the same
height. Currently the first to arrive via gossip wins; the other is silently
dropped. There's no mechanism to compare competing chains or switch to a
heavier one. This is the last remaining protocol gap before the MVP is fully
correct under multi-miner conditions.

Headers enable cheap chain comparison (~200 bytes per block instead of full
blocks). Fork resolution builds on that: detect competing chains, compare
cumulative work, and reorg to the heavier chain.

## Design

### Scope

- 20-block reorg depth (covers racing miners, bounded storage)
- Cumulative-work chain scoring (`sum 2^targetBits`)
- Conservative switching: only reorg when competing chain is strictly heavier
- Mutation journal per block for reversible application
- Header sync via new libp2p custom protocol
- Reverted transactions re-inserted to mempool

### Cumulative work

```ts
function cumulativeWork(headers: BlockHeader[]): bigint {
  return headers.reduce((sum, h) => sum + (1n << BigInt(h.powTargetBits)), 0n);
}
```

Each increment of `powTargetBits` doubles the expected work. Two chains are
compared by summing work over the diverging segment only — from fork point
to each tip.

### Mutation journal

Each `applyOrderingBlock` writes undo data as it applies the block forward.
The journal is stored per height and purged when blocks beyond depth 20 are
reverted or when the chain advances past the journal horizon.

```ts
interface BlockJournal {
  blockHeight: number;
  creditBoxIds: string[];              // coinbase boxes → delete on revert
  confirmedSubBlockIds: string[];      // posts → unconfirm on revert
  talliedLikeBoxIds: string[];         // like boxes → unconsume on revert
  karmaMints: KarmaMint[];             // minted karma → burn on revert
  appliedUtxoTxs: AppliedUtxoTx[];     // UTXO txs → reverse + re-insert
}

interface KarmaMint {
  userId: Uint8Array;
  amount: number;
}

interface AppliedUtxoTx {
  txId: string;
  txCbor: Uint8Array;     // full CBOR-encoded UtxoTransaction
  inputBoxIds: string[];   // boxes consumed by this tx (for reverse apply)
  outputBoxIds: string[];  // boxes created by this tx (for deletion)
}
```

The journal is stored in a new `block_journal` table, keyed by `block_height`.
Journals for heights beyond 20 below current are deleted on each new block.

### Fork detection

When a block arrives via gossip and passes all structural validation (PoW,
Merkle roots, coinbase), the node checks whether it extends our current tip:

```ts
function extendsOurTip(block: OrderingBlock): boolean {
  const ourTip = getOrderingBlock(getCurrentHeight());
  return block.header.prevBlockHash === blockHash(ourTip.header);
}
```

If yes → normal application (current path, unchanged).
If no → fork detected — the block belongs to a competing chain.

### Header sync

When a fork is detected, the node requests headers from the peer that sent
the competing block. A new libp2p custom protocol carries the request:

```
Protocol: /dagsocial/headers/1

Request:  CBOR { startHeight: number, maxCount: number }
Response: CBOR BlockHeader[] (up to maxCount, newest-first).
         If chain is shorter than maxCount, all available headers
         down to genesis are returned.
```

The node walks back from the competing block's height, requesting headers
until it finds a common ancestor with our chain (matching `blockHash`) or
hits the 20-block depth limit.

`findForkPoint()` walks our chain back from tip, collecting header hashes
into a Set. Then walks the peer's chain back from the competing block's
height, checking each hash against our set. Returns the fork height (common
ancestor) or null if none found within 20 blocks.

### Chain comparison

Once the fork point is known, cumulative work is computed over the
diverging segments:

```
ourSegment    = headers[forkHeight+1 .. ourTip]
theirSegment  = headers[forkHeight+1 .. theirTip]

if cumulativeWork(theirSegment) <= cumulativeWork(ourSegment):
    ignore block (competing chain not heavier)
else:
    reorg to competing chain
```

Conservative: ties keep our chain.

### Rollback

`revertBlock(height)` reverses everything `applyOrderingBlock` did at
that height, using the journal:

1. **Reverse UTXO transactions** — for each tx in reverse order: the tx's
   output boxes are deleted and input boxes are unspent (marked as unspent
   in `utxo_boxes`). This restores the UTXO set to the state before the
   block was applied.
2. **Burn minted karma** — for each entry in `karmaMints`: consume the
   karma box that was created by the mint. Karma is destroyed (net supply
   deflation back to pre-block state).
3. **Unspend tallied like boxes** — for each `talliedLikeBoxId`: set
   `spent_at = NULL` in `utxo_boxes`. The like box is available again.
4. **Delete coinbase credit boxes** — for each `creditBoxId`: delete the
   row from `utxo_boxes`. Credits are destroyed.
5. **Unconfirm posts** — for each `confirmedSubBlockId`: set post status
   back to `pending`, clear `confirmed_at_height`.
6. **Delete block + journal** — remove from `ordering_blocks` and
   `block_journal`.

### Reorg

`reorg(forkHeight, newBlocks)`:

```
1. Revert our blocks: for h = currentHeight down to forkHeight + 1:
     revertBlock(h)

2. Re-insert reverted transactions to mempool:
     for h = currentHeight down to forkHeight + 1:
       journal = getBlockJournal(h)
       for each tx in journal.appliedUtxoTxs:
         insertUtxoTx(decodeTx(tx.txCbor), null, currentHeight + 720)
       for each subBlockId in journal.confirmedSubBlockIds:
         insertMempoolSubBlock(getSubBlock(subBlockId), currentHeight + 720)

3. Apply new chain: for each block in newBlocks:
     applyOrderingBlock(block)
```

Step 2 re-inserts both UTXO txs and sub-blocks from reverted blocks so
they're picked up in the next block. TTL is reset to `currentHeight + 720`.
Operations that were valid before the reorg should still be valid (they
passed validation at inclusion time; the reorg doesn't change their
correctness).

### Journal during forward application

`applyOrderingBlock` is updated to record journal entries as it applies
the block:

```ts
function applyOrderingBlock(block: OrderingBlock): void {
  const journal: BlockJournal = {
    blockHeight: block.header.height,
    creditBoxIds: [],
    confirmedSubBlockIds: [...block.subBlockTree.subBlockRefs],
    talliedLikeBoxIds: [...block.utxoTxTree.likeBoxIds],
    karmaMints: [],
    appliedUtxoTxs: [],
  };

  // ... existing validation ...

  // On coinbase mint: record box IDs
  for (const out of block.utxoTxTree.coinbaseOutputs) {
    const boxId = mintCredits(out.owner, out.value, block.header.height, out.lockedUntilBlock);
    journal.creditBoxIds.push(boxId);
  }

  // On karma mint: record userId + amount. The journal object is passed
  // through a module-level variable (`currentBlockJournal`) set at the top of
  // applyOrderingBlock and read by mintKarma during block application.
  // After finalization, currentBlockJournal is cleared.

  // On UTXO tx apply: record tx CBOR + consumed/created box IDs
  for (const rowid of confirmedRowids) {
    const tx = ...;
    const result = applyTx(...);
    journal.appliedUtxoTxs.push({
      txId: result.txId,
      txCbor: encodeTx(tx),
      inputBoxIds: tx.inputs,
      outputBoxIds: result.computedOutputs.map(o => o.id!),
    });
  }

  // After all operations:
  insertBlockJournal(journal);
  purgeOldJournals(block.header.height - 20);
}
```

### Store changes

New table:

```sql
CREATE TABLE IF NOT EXISTS block_journal (
  block_height INTEGER PRIMARY KEY,
  journal_cbor BLOB NOT NULL
);
```

New store functions:
- `insertBlockJournal(journal: BlockJournal): void`
- `getBlockJournal(height: number): BlockJournal | null`
- `deleteBlockJournal(height: number): void`

New UTXO store functions for rollback:
- `unconsumeBox(boxId: string): void` — sets `spent_at = NULL`
- `deleteBox(boxId: string): void` — removes row from `utxo_boxes`
- `reverseUtxoTx(tx: UtxoTransaction, inputBoxIds: string[], outputBoxIds: string[]): void` — deletes outputs, unspends inputs

New post store function:
- `unconfirmPost(subBlockId: string): void` — sets status to `pending`, clears `confirmed_at_height`

New ordering store function:
- `deleteOrderingBlock(height: number): void` — deletes from `ordering_blocks`

### Net changes

New libp2p custom protocol: `/dagsocial/headers/1`

Existing sync infrastructure (`@dagsocial/net` already has `requestSubBlock`
as a custom protocol) is extended with:

```ts
// In NetNode:
requestHeaders(startHeight: number, maxCount: number, peerId: string): Promise<BlockHeader[]>
```

The handler is registered during `net.start()` alongside the existing sync
handler. Headers are CBOR-encoded, same codec as existing messages.

Header sync is triggered during fork detection. The peer that sent the
competing block is the target — it has the competing chain.

### applyOrderingBlock refactor

The current `applyOrderingBlock` in `index.ts` grows ~100 lines from journal
recording. To avoid making `index.ts` unwieldy, the block application logic
(verification + apply + journal) moves to a dedicated `block-apply.ts`
service module exported from `@dagsocial/node`.

`index.ts` retains the gossip handler and `extendsOurTip` / `findForkPoint`
/ `reorg` orchestration. The actual per-block work is delegated to
`applyOrderingBlock(block)` from the new module.

### What doesn't change

- Mempool, post creation, likes, invites, pruning, UTXO engine — unchanged
- Block creator — unchanged (miner still builds one block at current tip)
- Gossip topics — unchanged (blocks still flow via `/dagsocial/ordering-block/1`)
- HTTP API — unchanged (clients query the current canonical chain)
- Identity, challenge, faucet — unchanged

### Reorg depth limit

Max depth is 20 blocks, enforced at the `findForkPoint` and `revertBlock`
calls. If a fork requires reverting more than 20 blocks, the competing
chain is rejected. This prevents unbounded rollback from pathological or
malicious chains. For MVP, 20 blocks = ~20 minutes at 60s block time —
more than enough for the racing-miners case.

The depth constant (`MAX_REORG_DEPTH = 20`) is a protocol parameter.

### Edge cases

- **Fork at genesis:** Both chains have `prevBlockHash = 0x00...` at height
  1 from different validators. Fork point is height 0 (pre-genesis), reorg
  rolls back our genesis and applies theirs.

- **Empty blocks:** Coinbase-only blocks still journal credit box IDs.
  Reverting them deletes the coinbase and unconfirms nothing else.

- **Epoch boundary in reverted block:** Epoch tally results (karma mints,
  like box tallies) are fully reversed. The reverting chain's epoch state
  is computed independently from the new chain's perspective — the new
  blocks will re-run epoch tally at their own epoch boundaries.

- **Double-reorg (reorg while reorging):** Shouldn't happen in practice
  (gossip is sequential for ordering blocks), but the journal is
  idempotent: reverting an already-reverted box is a no-op.

- **Journal missing:** If `getBlockJournal(height)` returns null (should
  not happen for blocks we applied), the reorg fails and the competing
  chain is rejected. The node stays on its current chain.

### Test impact

New test scenarios:
- Two blocks at same height, heavier chain wins (unit test for
  `cumulativeWork` comparison)
- Fork detection: block with wrong `prevBlockHash` triggers fork path
- Reorg: revert 1 block, verify state rolled back
- Reorg: revert 2 blocks with UTXO txs, verify txs re-inserted to mempool
- Depth limit: fork deeper than 20 blocks is rejected
- Journal: round-trip encode/decode
- Rollback: each mutation type (coinbase, karma mint, like tally, post
  confirm, UTXO apply) is individually reversed

Existing tests continue to pass — normal block application path is
unchanged (extendsOurTip → same applyOrderingBlock flow).
