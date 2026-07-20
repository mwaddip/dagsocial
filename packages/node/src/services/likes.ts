import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  computeBoxId,
  LIKE_COST,
  LIKE_THRESHOLD,
  LIKE_FREE_THRESHOLD,
} from '@dagsocial/types';
import type { KarmaBox, LikeBox } from '@dagsocial/types';
import {
  getPost,
  getKarmaBox,
  getIdentity,
  insertLike,
  hasLiked,
  getLikeCount,
  insertBox,
  consumeBox,
  getDb,
} from '../store/index.js';

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
// Public API
// ---------------------------------------------------------------------------

/**
 * Cast a like on a target post.
 *
 * If the post has >= LIKE_FREE_THRESHOLD * LIKE_THRESHOLD (50) total likes,
 * the like is free (no karma lock, recorded in dag_likes). Otherwise, LIKE_COST
 * karma is locked in a LikeBox (UTXO, epoch_tally guard).
 *
 * For locked likes, the signature must cover JSON.stringify({ targetPostId, likerId }).
 *
 * @returns The like ID and whether it was a 'locked' or 'free' like.
 */
export function castLike(
  targetPostId: string,
  likerId: string,
  signature: Uint8Array,
  currentBlockHeight: number,
): { likeId: string; type: 'locked' | 'free' } {
  // ---- 1. Verify target post exists and is live ----
  const post = getPost(targetPostId);
  if (!post) {
    throw new Error(`Post not found: ${targetPostId}`);
  }
  if ('subtreeMerkleRoot' in post) {
    throw new Error('Cannot like a pruned post');
  }

  // ---- 2. Verify not already liked ----
  if (hasLiked(targetPostId, likerId)) {
    throw new Error('Already liked this post');
  }

  // ---- 3. Get total like count ----
  const { locked, free } = getLikeCount(targetPostId);
  const total = locked + free;
  const freeThreshold = LIKE_FREE_THRESHOLD * LIKE_THRESHOLD; // 50

  // Get liker's identity (needed for both paths)
  const identity = getIdentity(likerId);
  if (!identity) {
    throw new Error(`Liker identity not found: ${likerId}`);
  }

  // ---- 4a. Free like (>= 50 total likes) ----
  if (total >= freeThreshold) {
    const karmaBox = getKarmaBox(identity.publicKey);
    if (!karmaBox || karmaBox.value <= 0) {
      throw new Error('Insufficient karma (need > 0 for free like)');
    }

    const likeId = insertLike(targetPostId, likerId);
    return { likeId, type: 'free' };
  }

  // ---- 4b. Locked like (< 50 total likes) ----

  // Verify karma >= LIKE_COST
  const karmaBox = getKarmaBox(identity.publicKey);
  if (!karmaBox || karmaBox.value < LIKE_COST) {
    throw new Error(`Insufficient karma: need ${LIKE_COST}, have ${karmaBox?.value ?? 0}`);
  }

  // Verify signature over { targetPostId, likerId }
  const signData = JSON.stringify({ targetPostId, likerId });

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

  const newKarmaId = computeBoxId(newKarmaBox);
  const likeBoxId = computeBoxId(likeBox);

  // Apply in transaction
  const db = getDb();
  const txFn = db.transaction(() => {
    consumeBox(karmaBox.id!, currentBlockHeight);
    insertBox({ ...newKarmaBox, id: newKarmaId });
    insertBox({ ...likeBox, id: likeBoxId });
  });
  txFn();

  return { likeId: likeBoxId, type: 'locked' };
}
