import { computeTxId, MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import {
  getPost,
  hasLikeRecord,
  hasPendingLike,
  insertUtxoTx,
} from '../store/index.js';
import { validateTx } from './utxo-engine.js';
import type { UtxoEngineDeps } from './utxo-engine.js';
import { ClientError } from './client-error.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** A like target is a post id: 64 lowercase hex characters. */
const LIKE_TARGET_RE = /^[0-9a-f]{64}$/;

/**
 * Cast a like on a target post (P2-D: the like is a burn transaction).
 *
 * Receives a pre-built, signed UtxoTransaction from the client with
 * `likeTarget` set. The engine enforces the biconditional like shape — karma
 * inputs with one owner, exactly one karma output with that same owner, and a
 * deficit of exactly `LIKE_KARMA_COST`. There is no free tier, no refund
 * schedule, and no unlike: one like per `(liker, post)`, forever.
 *
 * These gateway checks are courtesy; the consensus checks run again at block
 * application. The liker is the karma inputs' owner — no separate liker field
 * exists anywhere.
 *
 * Dedup matches apply since N4a: `hasLikeRecord` reads the same
 * like-record the consensus dedup checks at block application, and
 * `hasPendingLike` covers the mempool. A re-like of an already-recorded
 * `(liker, post)` is rejected here, not just at apply.
 *
 * @returns `{ castLikeResult: 'pending', txId, expiresAtHeight, tx }`
 */
export function castLike(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): { castLikeResult: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction } {
  // ---- 1. Extract and validate likeTarget ----
  const likeTarget = tx.likeTarget;
  if (likeTarget === undefined || !LIKE_TARGET_RE.test(likeTarget)) {
    throw new ClientError(
      'likeTarget missing or malformed: expected a 64-char hex post id',
    );
  }

  // ---- 2. Verify the target post exists and is live ----
  const post = getPost(likeTarget);
  if (!post) {
    throw new ClientError(`Post not found: ${likeTarget}`);
  }
  // A stump has no `content`; a live Post always does. (The previous check
  // tested `'subtreeMerkleRoot' in post`, a field no Stump ever carried — it
  // could never fire. The same dead check was removed from feed-service and
  // stump-engine in the NX follow-up.)
  if (!('content' in post)) {
    throw new ClientError('Cannot like a pruned post');
  }

  // ---- 3. Verify not already liked (DB + mempool) ----
  // The liker is the karma inputs' owner, which for a well-formed like tx is
  // the single signing key — enforced here so the mempool gate's single-key
  // derivation (`like_liker`) is exact for every entry this path inserts, and
  // so a spare signature cannot pin someone else's `(liker, target)` pair.
  const signerHexes = Object.keys(tx.signatures);
  if (signerHexes.length !== 1) {
    throw new ClientError(
      'A like transaction must carry exactly one signature (the liker)',
    );
  }
  const likerHex = signerHexes[0]!;
  if (hasLikeRecord(likeTarget, Buffer.from(likerHex, 'hex'))) {
    throw new ClientError('Already liked this post');
  }
  if (hasPendingLike(likeTarget, likerHex)) {
    throw new ClientError('Already liked this post');
  }

  // ---- 4. Validate transaction (conservation carve, guards, transitions) ----
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid like transaction: ${result.error}`);
  }

  // ---- 5. Insert into mempool ----
  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  insertUtxoTx(tx, null, expiresAtHeight);

  // ---- 6. Return pending result ----
  return {
    castLikeResult: 'pending',
    txId: computeTxId(tx),
    expiresAtHeight,
    tx,
  };
}
