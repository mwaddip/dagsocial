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
  getPendingEntries,
  insertUtxoTx,
} from '../store/index.js';
import { decodeTx } from '@dagsocial/types';
import { validateTx } from './utxo-engine.js';
import type { UtxoEngineDeps } from './utxo-engine.js';

// ---------------------------------------------------------------------------
// MemPool helpers
// ---------------------------------------------------------------------------

/**
 * Check if there is a pending like transaction in the mempool for the given
 * target post and liker.  This prevents double-likes during the window between
 * mempool insertion and block confirmation.
 */
function hasPendingLike(targetPostId: string, likerId: Uint8Array): boolean {
  const entries = getPendingEntries(1000);
  for (const entry of entries) {
    if (entry.entryType !== 'utxo_tx' || !entry.utxoTxCbor) continue;
    const tx = decodeTx(entry.utxoTxCbor);
    for (const output of tx.outputs) {
      if (output.boxType === 'like') {
        const likeOut = output as LikeBox;
        if (
          likeOut.targetPostId === targetPostId &&
          Buffer.from(likeOut.likerId).equals(Buffer.from(likerId))
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

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
    throw new Error('Transaction must contain a LikeBox output');
  }
  const { targetPostId, likerId } = likeOutput;

  // ---- 2. Verify target post exists and is live ----
  const post = getPost(targetPostId);
  if (!post) {
    throw new Error(`Post not found: ${targetPostId}`);
  }
  if ('subtreeMerkleRoot' in post) {
    throw new Error('Cannot like a pruned post');
  }

  // ---- 3. Verify not already liked (DB + mempool) ----
  if (hasLiked(targetPostId, likerId)) {
    throw new Error('Already liked this post');
  }
  if (hasPendingLike(targetPostId, likerId)) {
    throw new Error('Already liked this post');
  }

  // ---- 4. Check total like count ----
  const { locked, free } = getLikeCount(targetPostId);
  const total = locked + free;
  const freeThreshold = LIKE_FREE_THRESHOLD * LIKE_THRESHOLD; // 50

  if (total >= freeThreshold) {
    // Post qualifies for free liking — a locked transaction is inappropriate.
    throw new Error(
      'Post has sufficient likes for free liking — do not submit a locked transaction',
    );
  }

  // ---- 5. Validate transaction (guards, transitions, decay) ----
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new Error(`Invalid like transaction: ${result.error}`);
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
    throw new Error('Transaction does not consume a LikeBox');
  }

  // Verify the LikeBox belongs to the signer
  const signerHex = Object.keys(tx.signatures)[0];
  if (!signerHex || Buffer.from(likerId).toString('hex') !== signerHex) {
    throw new Error('LikeBox does not belong to signer');
  }

  // ---- 2. Verify target post exists and is live ----
  const post = getPost(targetPostId);
  if (!post) {
    throw new Error(`Post not found: ${targetPostId}`);
  }
  if ('subtreeMerkleRoot' in post) {
    throw new Error('Cannot unlike a pruned post');
  }

  // ---- 3. Validate transaction (guards, transitions, decay) ----
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new Error(`Invalid unlike transaction: ${result.error}`);
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
