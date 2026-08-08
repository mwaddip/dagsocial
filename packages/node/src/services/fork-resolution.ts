import { blockHash } from '@dagsocial/validation';
import type { BlockHeader, OrderingBlock, PruneEntry } from '@dagsocial/types';
import { decodeTx, MEMPOOL_EXPIRY_BLOCKS, computePruneEntryId } from '@dagsocial/types';
import {
  getOrderingBlock,
  getCurrentHeight,
  getBlockJournal,
  deleteBlockJournal,
  deleteOrderingBlock,
  unconsumeBox,
  deleteBox,
  unconfirmPost,
  deleteLikeRecord,
  restoreLikeRecord,
  insertUtxoTx,
  insertMempoolSubBlock,
  insertMempoolPrune,
  removeMempoolPrunes,
  rollbackBlockTopology,
  MempoolFullError,
} from '../store/index.js';
import { getDb } from '../store/db.js';
import { isBlockJournalOpen, type BlockJournal } from '../store/journal.js';
import { deleteVouchCooldown, insertVouchCooldown } from '../store/vouch-cooldowns.js';
import { putIdentityRecord, deleteIdentityRecord } from '../store/identity-records.js';
import { tryGetAvlProver } from '../state/avl-prover.js';
import { applyOrderingBlock } from './block-apply.js';
import type { DagService } from './dag-service.js';

export const MAX_REORG_DEPTH = 20;

/**
 * Does this block extend our current canonical tip?
 */
export function extendsOurTip(block: OrderingBlock): boolean {
  const ourTip = getOrderingBlock(getCurrentHeight());
  if (!ourTip) return false;
  return block.header.prevBlockHash === blockHash(ourTip.header);
}

/**
 * Walk both chains back to find the common ancestor.
 * theirHeaders is newest-first (tip at index 0).
 * Returns fork height or null if deeper than MAX_REORG_DEPTH.
 */
export function findForkPoint(
  ourTip: BlockHeader,
  theirHeaders: BlockHeader[],
): number | null {
  // Collect our chain hashes: height -> hash
  const ourHashes = new Map<string, number>();
  let cursor = getOrderingBlock(ourTip.height);
  if (!cursor || blockHash(cursor.header) !== blockHash(ourTip)) {
    return null; // ourTip is stale — a reorg happened since caller fetched it
  }
  let depth = 0;
  while (cursor && depth < MAX_REORG_DEPTH) {
    ourHashes.set(blockHash(cursor.header), cursor.header.height);
    cursor = getOrderingBlock(cursor.header.height - 1);
    depth++;
  }

  // Walk their chain, check for match
  for (const header of theirHeaders) {
    const h = blockHash(header);
    const matchHeight = ourHashes.get(h);
    if (matchHeight !== undefined) return matchHeight;
  }

  return null; // no common ancestor within MAX_REORG_DEPTH
}

/**
 * Reverse all mutations from a single block using its journal.
 * Returns the PruneEntry array from the reverted block so callers can
 * re-insert them into the mempool without relying on read-before-delete
 * ordering.
 */
export function revertBlock(height: number): PruneEntry[] {
  // Revert must never run while a journal is recording: the mutation replay
  // uses the never-recording inverses, but the vouch-cooldown restores below
  // go through recording primitives and would journal themselves into the
  // open block's log.
  if (isBlockJournalOpen()) {
    throw new Error(`revertBlock(${height}): a block journal is open`);
  }
  const journal = getBlockJournal(height);
  if (!journal) {
    throw new Error(`No journal for height ${height} — cannot revert`);
  }

  // Collect prune entries before the block is deleted
  const block = getOrderingBlock(height);
  const pruneEntries: PruneEntry[] = block?.subBlockTree.pruneEntries ?? [];

  // 1. Replay the primitive mutation log in reverse: box/insert → deleteBox,
  // box/remove → unconsumeBox, record → restore `replaced` or delete. This
  // restores the exact pre-block committed state for every mutation class —
  // including the pre-existing boxes merge-consumed inside
  // mintKarma/mintCredits, tallied like boxes, prune settlement, and identity
  // records.
  //
  // Reverse order is what makes a record written **more than once in one block**
  // (activity bump then decay, at the same height) revert correctly: each
  // inverse undoes one write, and the last one replayed is the *first* write's
  // `replaced` — the true pre-block value. A per-key single restore keeping the
  // last `replaced` would restore an intra-block intermediate instead.
  //
  // `putIdentityRecord` is itself a recording primitive, exactly like the
  // `insertVouchCooldown` restore two loops below. That is safe only because
  // this function refuses to run while a journal is open (the guard at the top);
  // the guard is the mechanism, not a non-recording variant.
  for (let i = journal.mutations.length - 1; i >= 0; i--) {
    const m = journal.mutations[i]!;
    if (m.kind === 'record') {
      if (m.replaced !== undefined) {
        putIdentityRecord(m.identityId, m.replaced);
      } else {
        deleteIdentityRecord(m.identityId);
      }
    } else if (m.op === 'insert') {
      deleteBox(m.boxId);
    } else {
      unconsumeBox(m.boxId);
    }
  }

  // 2. Side-record inverses
  for (const subBlockId of journal.confirmedSubBlockIds) {
    unconfirmPost(subBlockId);
  }
  // Like-record inverses (P2-D). Order between the two arrays is immaterial:
  // a record cannot be both inserted and prune-deleted in one block — the
  // same-block exclusion (prune settles before embedded txs, so a like on a
  // post the block also prunes finds a stump and the block is rejected) —
  // so the two sets are disjoint by construction.
  for (const ins of journal.likeRecordInsertions) {
    deleteLikeRecord(ins.targetPostId, ins.likerId);
  }
  for (const del of journal.likeRecordDeletions) {
    restoreLikeRecord(del.targetPostId, del.likerId, del.appliedAtBlock);
  }
  for (const ins of journal.vouchCooldownInsertions) {
    deleteVouchCooldown(ins.voucherId, ins.targetId);
    // insertVouchCooldown is INSERT OR REPLACE — restore the row it overwrote
    if (ins.replaced) {
      insertVouchCooldown(
        ins.voucherId,
        ins.targetId,
        ins.replaced.releaseAtBlock,
        ins.replaced.karmaAmount,
      );
    }
  }
  // Restore escrow rows the block's cooldown mints deleted (H-7)
  for (const del of journal.vouchCooldownDeletions) {
    insertVouchCooldown(del.voucherId, del.targetId, del.releaseAtBlock, del.karmaAmount);
  }

  // 3. Roll back block_topology entries, delete block + journal + the
  // height's AVL version rows. The version rows are per-block derived state
  // exactly like the block and journal rows: left behind, they make
  // versionAtOrBeforeHeight resolve rolled-back state, and re-applying a
  // block at this height (reorg back to a previously-reverted chain) would
  // re-insert the same content-addressed version and trip its PRIMARY KEY —
  // the funnel's totality catch would then reject every re-applied block.
  rollbackBlockTopology(height);
  deleteOrderingBlock(height);
  deleteBlockJournal(height);
  tryGetAvlProver()?.storage.deleteVersionAtHeight(height);

  return pruneEntries;
}

/**
 * Return a reverted entry to the mempool, tolerating a full pool.
 *
 * Re-insertion is bookkeeping — it gives txs from the losing chain a chance to
 * be re-mined. A `MempoolFullError` here must not abort the reorg: that would
 * turn mempool pressure into a consensus-liveness failure, leaving the node
 * stuck on the lighter chain (the whole reorg runs in one SQLite transaction,
 * so a throw rolls back the chain switch too). Dropped entries are lost from
 * the local pool only; the ledger state is already reverted, and peers still
 * hold the txs.
 */
function reinsert(insert: () => void, label: string): void {
  try {
    insert();
  } catch (err) {
    if (err instanceof MempoolFullError) {
      console.warn(`Reorg re-insertion dropped, mempool full: ${label}`);
      return;
    }
    throw err;
  }
}

/**
 * Reorg: revert our chain from currentHeight down to forkHeight+1,
 * then apply the competing chain forward.
 */
export function reorg(forkHeight: number, newBlocks: OrderingBlock[], dagService?: DagService): void {
  // A failed reorg rolls the whole transaction back — DB and AVL storage rows
  // live in the same SQLite file — but SQLite rollback cannot reach the
  // prover's in-memory state: the per-block funnel restore only covers the
  // failing block, not the fork-point rollback plus the applied prefix. So the
  // reorg snapshots the digest before anything is reverted and restores it on
  // abort (mirrors the apply funnel's restoreProver).
  const avlHandle = tryGetAvlProver();
  const preDigest = avlHandle ? avlHandle.prover.digest() : null;
  const restoreProver = (): void => {
    if (!avlHandle || !preDigest) return;
    const current = avlHandle.prover.digest();
    if (current && Buffer.from(current).equals(Buffer.from(preDigest))) return;
    avlHandle.prover.rollback(preDigest);
  };
  try {
    getDb().transaction(() => {
  const currentHeight = getCurrentHeight();

  // Phase 1: revert our blocks, collecting journals and prune entries for re-insertion
  const revertedJournals: BlockJournal[] = [];
  const revertedPruneEntries: PruneEntry[] = [];
  for (let h = currentHeight; h > forkHeight; h--) {
    const journal = getBlockJournal(h);
    if (journal) revertedJournals.push(journal);
    // revertBlock() returns prune entries from the deleted block — no implicit
    // read-before-delete ordering dependency between caller and callee
    revertedPruneEntries.push(...revertBlock(h));
  }

  // Phase 1b: roll back AVL prover to fork point
  if (avlHandle) {
    const version = avlHandle.storage.versionAtOrBeforeHeight(forkHeight);
    if (version) {
      avlHandle.prover.rollback(version);
    }
  }

  // Phase 2: re-insert reverted txs and sub-blocks to mempool
  const newTipHeight = forkHeight + newBlocks.length;
  const mempoolExpiry = newTipHeight + MEMPOOL_EXPIRY_BLOCKS;
  for (const journal of revertedJournals) {
    // Re-insert UTXO txs
    for (const txRecord of journal.appliedUtxoTxs) {
      const tx = decodeTx(txRecord.txCbor);
      reinsert(() => insertUtxoTx(tx, null, mempoolExpiry), `tx ${txRecord.txId}`);
    }
    // Re-insert sub-blocks by ID (content is in dag_posts)
    for (const subBlockId of journal.confirmedSubBlockIds) {
      reinsert(() => insertMempoolSubBlock(subBlockId, mempoolExpiry), `sub-block ${subBlockId}`);
    }
  }

  // Re-insert prune entries from reverted blocks
  if (revertedPruneEntries.length > 0) {
    const entryIds = revertedPruneEntries.map(e => computePruneEntryId(e));
    removeMempoolPrunes(entryIds);
    for (const entry of revertedPruneEntries) {
      reinsert(() => insertMempoolPrune(entry, mempoolExpiry), `prune entry ${entry.rootPostHash}`);
    }
  }

  // Phase 3: apply new chain
  for (const block of newBlocks) {
    if (!applyOrderingBlock(block, dagService)) {
      throw new Error(`reorg failed: block at height ${block.header.height} rejected`);
    }
  }
    })();
  } catch (err) {
    // better-sqlite3 has already rolled the transaction back (chain, boxes,
    // AVL storage rows — the pre-reorg version row this restore targets is
    // back in place). Restore the in-memory prover, then rethrow: callers'
    // error semantics are unchanged.
    restoreProver();
    throw err;
  }
}
