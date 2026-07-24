import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  computeBoxId,
  computeTxId,
  LIKE_COST,
  LIKE_THRESHOLD,
  LIKE_FREE_THRESHOLD,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { KarmaBox, LikeBox, UtxoTransaction } from '@dagsocial/types';
import {
  getPost,
  getKarmaBox,
  getIdentity,
  insertLike,
  hasLiked,
  getLikeCount,
  getFreeLike,
  deleteFreeLike,
  getUnspentLikeForLiker,
  getPendingEntries,
  insertUtxoTx,
} from '../store/index.js';
import { decodeTx } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Ed25519 helpers
// ---------------------------------------------------------------------------

const ED25519_SPKI_PREFIX = Buffer.from(
  '302a300506032b6570032100',
  'hex',
);

function publicKeyToKeyObject(pubKey: Uint8Array): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pubKey)]),
    format: 'der',
    type: 'spki',
  });
}

/** Verify an Ed25519 signature over a pre-hashed message. */
function verifySignature(
  message: Uint8Array,
  signature: Uint8Array,
  pubKey: Uint8Array,
): boolean {
  try {
    const keyObj = publicKeyToKeyObject(pubKey);
    const hash = createHash('blake2b512')
      .update(Buffer.from(message))
      .digest()
      .subarray(0, 32);
    return Boolean(cryptoVerify(null, hash, keyObj, Buffer.from(signature)));
  } catch {
    return false;
  }
}

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
 * If the post has >= LIKE_FREE_THRESHOLD * LIKE_THRESHOLD (50) total likes,
 * the like is free (no karma lock, recorded in dag_likes).
 *
 * Otherwise, LIKE_COST karma is locked in a LikeBox (UTXO, epoch_tally guard).
 * The UTXO transaction is inserted into the mempool and applied when the next
 * ordering block is confirmed — the like is **pending** until then.
 *
 * For locked likes, the signature must cover
 * JSON.stringify({ targetPostId, likerId }) where likerId is the hex-encoded
 * public key.
 *
 * @returns `{ castLikeResult: 'pending', txId, expiresAtHeight }` for locked
 *          likes, or `{ castLikeResult: 'free', likeId }` for free likes.
 */
export function castLike(
  targetPostId: string,
  likerId: Uint8Array,
  signature: Uint8Array,
  currentBlockHeight: number,
): { castLikeResult: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction }
 | { castLikeResult: 'free'; likeId: string } {
  // ---- 1. Verify target post exists and is live ----
  const post = getPost(targetPostId);
  if (!post) {
    throw new Error(`Post not found: ${targetPostId}`);
  }
  if ('subtreeMerkleRoot' in post) {
    throw new Error('Cannot like a pruned post');
  }

  // ---- 2. Verify not already liked (DB + mempool) ----
  if (hasLiked(targetPostId, likerId)) {
    throw new Error('Already liked this post');
  }
  if (hasPendingLike(targetPostId, likerId)) {
    throw new Error('Already liked this post');
  }

  // ---- 3. Get total like count ----
  const { locked, free } = getLikeCount(targetPostId);
  const total = locked + free;
  const freeThreshold = LIKE_FREE_THRESHOLD * LIKE_THRESHOLD; // 50

  // Get liker's identity (needed for both paths)
  const identity = getIdentity(likerId);
  if (!identity) {
    throw new Error(`Liker identity not found: ${Buffer.from(likerId).toString('hex')}`);
  }

  // ---- 4a. Free like (>= 50 total likes) ----
  if (total >= freeThreshold) {
    const karmaBox = getKarmaBox(identity.publicKey);
    if (!karmaBox || karmaBox.value <= 0) {
      throw new Error('Insufficient karma (need > 0 for free like)');
    }

    const likeId = insertLike(targetPostId, likerId);
    return { castLikeResult: 'free', likeId };
  }

  // ---- 4b. Locked like (< 50 total likes) → mempool ----

  // Verify karma >= LIKE_COST
  const karmaBox = getKarmaBox(identity.publicKey);
  if (!karmaBox || karmaBox.value < LIKE_COST) {
    throw new Error(`Insufficient karma: need ${LIKE_COST}, have ${karmaBox?.value ?? 0}`);
  }

  // Verify signature over { targetPostId, likerId }
  const likerIdHex = Buffer.from(likerId).toString('hex');
  const signData = JSON.stringify({ targetPostId, likerId: likerIdHex });

  if (!verifySignature(Buffer.from(signData), signature, identity.publicKey)) {
    throw new Error('Invalid like signature');
  }

  // Build UTXO: consume karma box → new karma (balance - LIKE_COST) + like box
  const remainingKarma = karmaBox.value - LIKE_COST;

  const newKarmaBox: KarmaBox = {
    boxType: 'karma',
    value: remainingKarma,
    createdAtBlock: currentBlockHeight,
    owner: identity.publicKey,
    guard: 'owner_signature',
    proofSource: `like:${targetPostId}`,
    lastTouchBlock: currentBlockHeight,
  };

  const likeBox: LikeBox = {
    boxType: 'like',
    value: LIKE_COST,
    createdAtBlock: currentBlockHeight,
    likerId,
    targetPostId,
    guard: 'epoch_tally',
  };

  // Build UtxoTransaction
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!],
    outputs: [newKarmaBox, likeBox],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };

  // Insert into mempool
  const expiresAtHeight = currentBlockHeight + 720;
  insertUtxoTx(tx, null, expiresAtHeight);

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
 * - Locked like: consume the like box, refund LIKE_COST (2) karma to liker,
 *   then deduct 1 karma.  netKarma = +1.
 * - Free like: delete the dag_likes row, deduct 1 karma from liker.
 *   netKarma = -1.
 * - Neither: throw (404).
 *
 * UTXO changes go through the mempool and are applied on the next block
 * confirmation.  Non-UTXO side-effects (dag_likes row deletion for free
 * likes) are applied immediately.
 *
 * The signature must cover
 * JSON.stringify({ targetPostId, likerId, action: "unlike" }) where likerId
 * is the hex-encoded public key.
 *
 * @returns `{ removeLikeResult: 'pending', txId, expiresAtHeight }`
 */
export function removeLike(
  targetPostId: string,
  likerId: Uint8Array,
  signature: Uint8Array,
  currentBlockHeight: number,
): { removeLikeResult: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction } {
  // ---- 1. Verify target post exists and is live ----
  const post = getPost(targetPostId);
  if (!post) {
    throw new Error(`Post not found: ${targetPostId}`);
  }
  if ('subtreeMerkleRoot' in post) {
    throw new Error('Cannot unlike a pruned post');
  }

  // ---- 2. Get liker's identity ----
  const identity = getIdentity(likerId);
  if (!identity) {
    throw new Error(`Liker identity not found: ${Buffer.from(likerId).toString('hex')}`);
  }

  // ---- 3. Verify signature over { targetPostId, likerId, action: "unlike" } ----
  const likerIdHex = Buffer.from(likerId).toString('hex');
  const signData = JSON.stringify({ targetPostId, likerId: likerIdHex, action: 'unlike' });
  if (!verifySignature(Buffer.from(signData), signature, identity.publicKey)) {
    throw new Error('Invalid unlike signature');
  }

  // ---- 4. Check for locked like box ----
  const lockedLike = getUnspentLikeForLiker(targetPostId, likerId);
  if (lockedLike) {
    // Refund LIKE_COST karma to liker, then deduct 1 (net +1)
    const karmaBox = getKarmaBox(identity.publicKey);
    const currentKarma = karmaBox?.value ?? 0;
    const newKarma = currentKarma + LIKE_COST - 1; // +2 - 1 = +1 net

    const newKarmaBox: KarmaBox = {
      boxType: 'karma',
      value: newKarma,
      createdAtBlock: currentBlockHeight,
      owner: identity.publicKey,
      guard: 'owner_signature',
      proofSource: `unlike:${targetPostId}`,
      lastTouchBlock: currentBlockHeight,
    };

    const inputs = [lockedLike.id!];
    if (karmaBox?.id) {
      inputs.push(karmaBox.id);
    }

    const tx: UtxoTransaction = {
      inputs,
      outputs: [newKarmaBox],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    const expiresAtHeight = currentBlockHeight + 720;
    insertUtxoTx(tx, null, expiresAtHeight);

    const txId = computeTxId(tx);

    return { removeLikeResult: 'pending', txId, expiresAtHeight, tx };
  }

  // ---- 5. Check for free like ----
  const freeLike = getFreeLike(targetPostId, likerId);
  if (freeLike) {
    // Deduct 1 karma from liker (net -1)
    const karmaBox = getKarmaBox(identity.publicKey);
    const currentKarma = karmaBox?.value ?? 0;
    const newKarma = currentKarma - 1;

    if (newKarma < 0) {
      throw new Error('Insufficient karma to undo free like');
    }

    const newKarmaBox: KarmaBox = {
      boxType: 'karma',
      value: newKarma,
      createdAtBlock: currentBlockHeight,
      owner: identity.publicKey,
      guard: 'owner_signature',
      proofSource: `unlike:${targetPostId}`,
      lastTouchBlock: currentBlockHeight,
    };

    const inputs: string[] = [];
    if (karmaBox?.id) {
      inputs.push(karmaBox.id);
    }

    const tx: UtxoTransaction = {
      inputs,
      outputs: [newKarmaBox],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    // Delete the free-like dag_likes row immediately (non-UTXO side-effect)
    deleteFreeLike(targetPostId, likerId);

    const expiresAtHeight = currentBlockHeight + 720;
    insertUtxoTx(tx, null, expiresAtHeight);

    const txId = computeTxId(tx);

    return { removeLikeResult: 'pending', txId, expiresAtHeight, tx };
  }

  // ---- 6. Neither locked nor free ----
  throw new Error('Like not found');
}
