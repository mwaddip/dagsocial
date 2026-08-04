import {
  getPostLockBox,
  getUnspentLikeBoxes,
  consumeBox,
  getKarmaBoxes,
} from '../store/index.js';
import { mintKarma } from './karma.js';
import type { BlockJournal } from '@dagsocial/types';

/**
 * Deterministic UTXO settlement for a pruned subtree.
 *
 * Consumes all PostLockBoxes and unspent LikeBoxes for the given post IDs,
 * then mints refund karma to authors and likers for the locked amounts.
 *
 * Key properties:
 * - Deterministic: given the same postIds and UTXO state, produces the
 *   same set of consumed/created boxes every time.
 * - No DAG walk: uses only the postId list (already verified against
 *   block_topology by the caller).
 * - Journal records all consumed and created box IDs for AVL state root
 *   computation and fork-resolution rollback.
 */
export function settlePruneUtxo(
  postIds: string[],
  blockHeight: number,
  journal: BlockJournal,
): void {
  const authorRefunds = new Map<string, bigint>();
  const likerRefunds = new Map<string, bigint>();

  for (const postId of postIds) {
    // Consume PostLockBox (author's locked karma)
    const lockBox = getPostLockBox(postId);
    if (lockBox && lockBox.value > 0n) {
      const key = Buffer.from(lockBox.owner).toString('hex');
      authorRefunds.set(key, (authorRefunds.get(key) ?? 0n) + lockBox.value);
      consumeBox(lockBox.id!, blockHeight);
      journal.consumedBoxIds.push(lockBox.id!);
    }

    // Consume unspent LikeBoxes (likers' locked karma)
    const likeBoxes = getUnspentLikeBoxes(postId);
    for (const likeBox of likeBoxes) {
      if (likeBox.value > 0n) {
        const key = Buffer.from(likeBox.likerId).toString('hex');
        likerRefunds.set(key, (likerRefunds.get(key) ?? 0n) + likeBox.value);
        consumeBox(likeBox.id!, blockHeight);
        journal.consumedBoxIds.push(likeBox.id!);
      }
    }
  }

  // Mint refund karma for authors
  for (const [hexUserId, amount] of authorRefunds) {
    const userId = new Uint8Array(Buffer.from(hexUserId, 'hex'));
    const existingKarma = getKarmaBoxes(userId);
    for (const kb of existingKarma) {
      if (kb.id) journal.consumedBoxIds.push(kb.id);
    }
    const newBoxId = mintKarma(userId, amount, blockHeight);
    if (newBoxId) journal.createdBoxIds.push(newBoxId);
  }

  // Mint refund karma for likers
  for (const [hexUserId, amount] of likerRefunds) {
    const userId = new Uint8Array(Buffer.from(hexUserId, 'hex'));
    const existingKarma = getKarmaBoxes(userId);
    for (const kb of existingKarma) {
      if (kb.id) journal.consumedBoxIds.push(kb.id);
    }
    const newBoxId = mintKarma(userId, amount, blockHeight);
    if (newBoxId) journal.createdBoxIds.push(newBoxId);
  }
}
