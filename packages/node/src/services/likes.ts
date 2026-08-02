import {
  computeTxId,
  LIKE_THRESHOLD,
  LIKE_FREE_THRESHOLD,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type { LikeBox, UtxoTransaction } from '@dagsocial/types';
import {
  getPost,
  hasLiked,
  getLikeCount,
  hasPendingLike,
  insertUtxoTx,
} from '../store/index.js';
import { validateTx } from './utxo-engine.js';
import type { UtxoEngineDeps } from './utxo-engine.js';
import { ClientError } from './client-error.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Cast a like on a target post.
 *
 * Receives a pre-built, signed UtxoTransaction from the client.  The
 * transaction must contain exactly one LikeBox output.  The client is
 * responsible for constructing the correct consumed karma box and signature.
 *
 * If the post has >= LIKE_FREE_THRESHOLD * LIKE_THRESHOLD (50) total likes,
 * the like should have been submitted as a free like — a locked transaction
 * is rejected.
 *
 * @returns `{ castLikeResult: 'pending', txId, expiresAtHeight }` for locked
 *          likes, or `{ castLikeResult: 'free', likeId }` for free likes.
 */
export function castLike(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): { castLikeResult: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction }
 | { castLikeResult: 'free'; likeId: string } {
  // ---- 1. Extract targetPostId and likerId from the LikeBox output ----
  const likeOutput = tx.outputs.find((o): o is LikeBox => o.boxType === 'like');
  if (!likeOutput) {
    throw new ClientError('Transaction must contain a LikeBox output');
  }
  const { targetPostId, likerId } = likeOutput;

  // ---- 2. Verify target post exists and is live ----
  const post = getPost(targetPostId);
  if (!post) {
    throw new ClientError(`Post not found: ${targetPostId}`);
  }
  if ('subtreeMerkleRoot' in post) {
    throw new ClientError('Cannot like a pruned post');
  }

  // ---- 3. Verify not already liked (DB + mempool) ----
  // The mempool gate is SQL over the gate-metadata columns — every pending
  // entry, not the first 1000 (audit M-8).
  if (hasLiked(targetPostId, likerId)) {
    throw new ClientError('Already liked this post');
  }
  if (hasPendingLike(targetPostId, Buffer.from(likerId).toString('hex'))) {
    throw new ClientError('Already liked this post');
  }

  // ---- 4. Check total like count ----
  const { locked, free } = getLikeCount(targetPostId);
  const total = locked + free;
  const freeThreshold = LIKE_FREE_THRESHOLD * LIKE_THRESHOLD; // 50

  if (total >= freeThreshold) {
    // Post qualifies for free liking — a locked transaction is inappropriate.
    throw new ClientError(
      'Post has sufficient likes for free liking — do not submit a locked transaction',
    );
  }

  // ---- 5. Validate transaction (guards, transitions, decay) ----
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid like transaction: ${result.error}`);
  }

  // ---- 6. Insert into mempool ----
  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  insertUtxoTx(tx, null, expiresAtHeight);

  // ---- 7. Return pending result ----
  const txId = computeTxId(tx);
  return {
    castLikeResult: 'pending',
    txId,
    expiresAtHeight,
    tx,
  };
}

/**
 * Remove a previously cast like on a target post.
 *
 * Receives a pre-built, signed UtxoTransaction from the client.  One of the
 * inputs must be a LikeBox that identifies the like being removed.  The
 * client handles both locked and free-like removal by constructing the
 * appropriate inputs and outputs.
 *
 * @returns `{ removeLikeResult: 'pending', txId, expiresAtHeight }`
 */
export function removeLike(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): { removeLikeResult: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction } {
  // ---- 1. Extract targetPostId and likerId from the consumed LikeBox ----
  let targetPostId: string | undefined;
  let likerId: Uint8Array | undefined;

  for (const inputId of tx.inputs) {
    const box = deps.getBox(inputId);
    if (box && box.boxType === 'like') {
      const likeBox = box as LikeBox;
      targetPostId = likeBox.targetPostId;
      likerId = likeBox.likerId;
      break;
    }
  }

  if (!targetPostId || !likerId) {
    throw new ClientError('Transaction does not consume a LikeBox');
  }

  // Verify the LikeBox belongs to the signer
  const signerHex = Object.keys(tx.signatures)[0];
  if (!signerHex || Buffer.from(likerId).toString('hex') !== signerHex) {
    throw new ClientError('LikeBox does not belong to signer');
  }

  // ---- 2. Verify target post exists and is live ----
  const post = getPost(targetPostId);
  if (!post) {
    throw new ClientError(`Post not found: ${targetPostId}`);
  }
  if ('subtreeMerkleRoot' in post) {
    throw new ClientError('Cannot unlike a pruned post');
  }

  // ---- 3. Validate transaction (guards, transitions, decay) ----
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid unlike transaction: ${result.error}`);
  }

  // ---- 4. Insert into mempool ----
  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  insertUtxoTx(tx, null, expiresAtHeight);

  // ---- 5. Return pending result ----
  const txId = computeTxId(tx);
  return {
    removeLikeResult: 'pending',
    txId,
    expiresAtHeight,
    tx,
  };
}
