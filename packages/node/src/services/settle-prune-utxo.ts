import type { PostId } from '@dagsocial/types';
import {
  getPostLockBox,
  getUnspentLikeBoxes,
  consumeBox,
} from '../store/index.js';
import { mintKarma } from './karma.js';
import {
  pruneRefundAuthorContext,
  pruneRefundLikerContext,
} from '../mint-provenance.js';

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
 * - Every box mutation — the settlement consumes and the merge-consumes
 *   and inserts inside mintKarma — is recorded by the store choke point
 *   while the caller's block journal is open.
 *
 * Both mints carry provenance under the two `prune-refund-*` reasons
 * (`NODE_INTERFACE.md` → "Box Identity and Mint Provenance"). Two decisions
 * behind that shape, both settled rather than open:
 *
 * **Two reasons, not one.** The same user can be both an author and a liker
 * inside one pruned subtree — they replied in a thread they also liked. A
 * single reason would give that user's two mints an identical
 * `(height, reason, subject)`. This mirrors `author-reward` vs `liker-refund`,
 * which are two at epoch tally for exactly this reason.
 *
 * **The subject names the prune entry, not the post.** Refunds are aggregated
 * per user across the whole subtree, so no single postId is available — and the
 * bare owner is not enough either. This function runs **once per prune entry**
 * (`block-apply.ts`, inside the loop over `pruneEntries`), so a block carrying
 * two entries calls it twice at one height; an author with refunds in both
 * subtrees would derive the same `mintTxId` twice at `index` 0, trip
 * `UNIQUE(tx_id, output_index)`, and a legitimate block would be rejected.
 * `rootPostHash` is what separates the two calls.
 */
export function settlePruneUtxo(
  rootPostHash: PostId,
  postIds: PostId[],
  blockHeight: number,
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
    }

    // Consume unspent LikeBoxes (likers' locked karma)
    const likeBoxes = getUnspentLikeBoxes(postId);
    for (const likeBox of likeBoxes) {
      if (likeBox.value > 0n) {
        const key = Buffer.from(likeBox.likerId).toString('hex');
        likerRefunds.set(key, (likerRefunds.get(key) ?? 0n) + likeBox.value);
        consumeBox(likeBox.id!, blockHeight);
      }
    }
  }

  // Mint refund karma for authors
  for (const [hexUserId, amount] of authorRefunds) {
    const userId = new Uint8Array(Buffer.from(hexUserId, 'hex'));
    mintKarma(userId, amount, blockHeight, pruneRefundAuthorContext(rootPostHash, userId));
  }

  // Mint refund karma for likers
  for (const [hexUserId, amount] of likerRefunds) {
    const userId = new Uint8Array(Buffer.from(hexUserId, 'hex'));
    mintKarma(userId, amount, blockHeight, pruneRefundLikerContext(rootPostHash, userId));
  }
}
