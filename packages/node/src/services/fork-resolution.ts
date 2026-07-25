import { blockHash } from '@dagsocial/validation';
import type { BlockHeader, OrderingBlock, BlockJournal } from '@dagsocial/types';
import { decodeTx, decodeSubBlock } from '@dagsocial/types';
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
} from '../store/index.js';
import { getDb } from '../store/db.js';
import { applyOrderingBlock } from './block-apply.js';

const MAX_REORG_DEPTH = 20;

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

  // 2. Burn minted karma (delete karma boxes created by mints at this height)
  if (journal.karmaMints.length > 0) {
    // mintKarma creates karma boxes with proofSource = `block:${height}`.
    // Delete any karma box created by this block — avoids needing to
    // reverse-engineer the mintKarma logic.
    getDb().prepare(
      `DELETE FROM utxo_boxes WHERE proof_source = ?`,
    ).run(`block:${height}`);
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
export function reorg(forkHeight: number, newBlocks: OrderingBlock[]): void {
  const currentHeight = getCurrentHeight();

  // Phase 1: revert our blocks, collecting journals for re-insertion
  const revertedJournals: BlockJournal[] = [];
  for (let h = currentHeight; h > forkHeight; h--) {
    const journal = getBlockJournal(h);
    if (journal) revertedJournals.push(journal);
    revertBlock(h);
  }

  // Phase 2: re-insert reverted txs and sub-blocks to mempool
  const newTipHeight = forkHeight + newBlocks.length;
  const mempoolExpiry = newTipHeight + 720;
  for (const journal of revertedJournals) {
    // Re-insert UTXO txs
    for (const txRecord of journal.appliedUtxoTxs) {
      const tx = decodeTx(txRecord.txCbor);
      insertUtxoTx(tx, null, mempoolExpiry);
    }
    // Re-insert sub-blocks
    for (const { cbor } of journal.subBlockCbors) {
      const sb = decodeSubBlock(cbor);
      insertMempoolSubBlock(sb, mempoolExpiry);
    }
  }

  // Phase 3: apply new chain
  for (const block of newBlocks) {
    applyOrderingBlock(block);
  }
}
