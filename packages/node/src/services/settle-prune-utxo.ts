import {
  getPostLockBox,
  getUnspentLikeBoxes,
  consumeBox,
} from '../store/index.js';
import { mintKarma } from './karma.js';

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
 * ⚠ **Both mints below pass a `null` MintContext, so the boxes they create
 * carry no provenance.** This is the one box producer Spec G phase C cannot
 * complete, and it is a contract gap rather than a deferral:
 * `NODE_INTERFACE.md`'s reason/subject table, Spec G §3.2's table and §4's
 * blast radius all omit this file, and `MintReason` in `@dagsocial/types` is a
 * closed union with no member that fits. Node may not add one.
 *
 * No existing reason can be reused. Refunds are **aggregated per user across
 * the whole pruned subtree** before minting, so the subject cannot be a single
 * postId — the natural encoding is the raw 32-byte owner, which would make
 * `postlock-unlock`/`liker-refund` carry two different subject widths and break
 * the fixed-length rule those reasons exist to satisfy. Two new reasons
 * (author-side and liker-side prune refunds, subject = raw owner) is the
 * shape that fits, and adding them belongs to types + the contract.
 *
 * Harmless during the migration window — `txId`/`index` are optional on
 * `BoxBase` until phase G, so these boxes are in the state every box is in
 * today. Phase G makes the columns `NOT NULL`, at which point this becomes a
 * hard failure. It must be resolved before then.
 */
export function settlePruneUtxo(postIds: string[], blockHeight: number): void {
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
    mintKarma(userId, amount, blockHeight, null);
  }

  // Mint refund karma for likers
  for (const [hexUserId, amount] of likerRefunds) {
    const userId = new Uint8Array(Buffer.from(hexUserId, 'hex'));
    mintKarma(userId, amount, blockHeight, null);
  }
}
