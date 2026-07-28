import { blockHash } from '@dagsocial/validation';
import type { BlockHeader, OrderingBlock, BlockJournal } from '@dagsocial/types';
import { decodeTx, MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';
import {
  getOrderingBlock,
  getCurrentHeight,
  getBlockJournal,
  deleteBlockJournal,
  deleteOrderingBlock,
  unconsumeBox,
  deleteBox,
  unconfirmPost,
  insertUtxoTx,
  insertMempoolSubBlock,
  insertMempoolStump,
  removeMempoolStumps,
} from '../store/index.js';
import { getDb } from '../store/db.js';
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
 */
export function revertBlock(height: number): void {
  const journal = getBlockJournal(height);
  if (!journal) {
    throw new Error(`No journal for height ${height} — cannot revert`);
  }

  // 1. Reverse UTXO txs (reverse order)
  for (let i = journal.appliedUtxoTxs.length - 1; i >= 0; i--) {
    const txRecord = journal.appliedUtxoTxs[i]!;
    for (const boxId of txRecord.outputBoxIds) {
      deleteBox(boxId);
    }
    for (const boxId of txRecord.inputBoxIds) {
      unconsumeBox(boxId);
    }
  }

  // 2. Burn minted karma (delete karma boxes by box ID from journal)
  for (const mint of journal.karmaMints) {
    if (mint.boxId) {
      deleteBox(mint.boxId);
    }
  }

  // 2b. Reverse decay burns (delete new box, unconsume consumed boxes)
  for (const decay of journal.decayBurns) {
    deleteBox(decay.newBoxId);
    for (const boxId of decay.consumedBoxIds) {
      unconsumeBox(boxId);
    }
  }

  // 3. Unspend tallied like boxes
  for (const boxId of journal.talliedLikeBoxIds) {
    unconsumeBox(boxId);
  }

  // 4. Delete coinbase credit boxes
  for (const boxId of journal.creditBoxIds) {
    deleteBox(boxId);
  }

  // 5. Unconfirm posts
  for (const subBlockId of journal.confirmedSubBlockIds) {
    unconfirmPost(subBlockId);
  }

  // 6. Delete block + journal
  deleteOrderingBlock(height);
  deleteBlockJournal(height);
}

/**
 * Reorg: revert our chain from currentHeight down to forkHeight+1,
 * then apply the competing chain forward.
 */
export function reorg(forkHeight: number, newBlocks: OrderingBlock[], dagService?: DagService): void {
  getDb().transaction(() => {
  const currentHeight = getCurrentHeight();

  // Phase 1: revert our blocks, collecting journals and stump IDs for re-insertion
  const revertedJournals: BlockJournal[] = [];
  const revertedStumpIds: string[] = [];
  for (let h = currentHeight; h > forkHeight; h--) {
    const journal = getBlockJournal(h);
    if (journal) revertedJournals.push(journal);
    // Collect stump IDs before the block is deleted
    const block = getOrderingBlock(h);
    if (block?.subBlockTree.stumpIds.length) {
      revertedStumpIds.push(...block.subBlockTree.stumpIds);
    }
    revertBlock(h);
  }

  // Phase 1b: roll back AVL prover to fork point
  const avlHandle = tryGetAvlProver();
  if (avlHandle) {
    const version = avlHandle.storage.versionAtHeight(forkHeight);
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
      insertUtxoTx(tx, null, mempoolExpiry);
    }
    // Re-insert sub-blocks by ID (content is in dag_posts)
    for (const subBlockId of journal.confirmedSubBlockIds) {
      insertMempoolSubBlock(subBlockId, mempoolExpiry);
    }
  }

  // Re-insert stumps from reverted blocks (defensive cleanup + re-enqueue)
  if (revertedStumpIds.length > 0) {
    removeMempoolStumps(revertedStumpIds);
    for (const stumpId of revertedStumpIds) {
      insertMempoolStump(stumpId, mempoolExpiry);
    }
  }

  // Phase 3: apply new chain
  for (const block of newBlocks) {
    if (!applyOrderingBlock(block, dagService)) {
      throw new Error(`reorg failed: block at height ${block.header.height} rejected`);
    }
  }
  })();
}
