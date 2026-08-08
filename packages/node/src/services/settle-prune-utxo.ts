import type { PostId } from '@dagsocial/types';
import {
  getPostLockBox,
  consumeBox,
  deleteLikeRecordsForPosts,
} from '../store/index.js';
import { mintKarma } from './karma.js';
import { pruneRefundAuthorContext } from '../mint-provenance.js';

/**
 * Deterministic settlement for a pruned subtree.
 *
 * Consumes the subtree's PostLockBoxes, mints refund karma to their authors,
 * and deletes the subtree's like-records. There is no liker leg: a like burns
 * its karma at cast and the burn is deliberately unrecoverable, so a prune
 * has nothing to refund a liker (P2-D).
 *
 * Key properties:
 * - Deterministic: given the same postIds, UTXO state, and like-records,
 *   produces the same set of consumed/created boxes and deleted records
 *   every time.
 * - No DAG walk: uses only the postId list (already verified against
 *   block_topology by the caller).
 * - Every mutation — the settlement consumes, the merge-consumes and inserts
 *   inside mintKarma, and the like-record deletions — is recorded by the
 *   store choke point while the caller's block journal is open. A reverted
 *   prune replays `likeRecordDeletions` through `restoreLikeRecord`, so the
 *   subtree's records come back exactly.
 *
 * The refund mint carries provenance under `prune-refund-author`
 * (`NODE_INTERFACE.md` → "Box Identity and Mint Provenance"). Settlement has
 * **one reason**: only authors are minted to, so the author/liker mint-id
 * collision the retired second reason existed to prevent cannot arise (the
 * retired string stays reserved in types' MintReason tombstone).
 *
 * **The subject still names the prune entry, not the post.** Refunds are
 * aggregated per author across the whole subtree, so no single postId is
 * available — and the bare owner is not enough either. This function runs
 * **once per prune entry** (`block-apply.ts`, inside the loop over
 * `pruneEntries`), so a block carrying two entries calls it twice at one
 * height; an author with refunds in both subtrees would derive the same
 * `mintTxId` twice at `index` 0, trip `UNIQUE(tx_id, output_index)`, and a
 * legitimate block would be rejected. `rootPostHash` is what separates the
 * two calls.
 */
export function settlePruneUtxo(
  rootPostHash: PostId,
  postIds: PostId[],
  blockHeight: number,
): void {
  const authorRefunds = new Map<string, bigint>();

  for (const postId of postIds) {
    // Consume PostLockBox (author's locked karma)
    const lockBox = getPostLockBox(postId);
    if (lockBox && lockBox.value > 0n) {
      const key = Buffer.from(lockBox.owner).toString('hex');
      authorRefunds.set(key, (authorRefunds.get(key) ?? 0n) + lockBox.value);
      consumeBox(lockBox.id!, blockHeight);
    }
  }

  // The subtree's like-records die with the prune. The store choke point
  // captures every doomed row as a `likeRecordDeletions` side-record before
  // deleting, so a reverted prune restores them exactly. Runs after the
  // consume loop so the deletion never races a box read within this call.
  deleteLikeRecordsForPosts(postIds);

  // Mint refund karma for authors
  for (const [hexUserId, amount] of authorRefunds) {
    const userId = new Uint8Array(Buffer.from(hexUserId, 'hex'));
    mintKarma(userId, amount, blockHeight, pruneRefundAuthorContext(rootPostHash, userId));
  }
}
