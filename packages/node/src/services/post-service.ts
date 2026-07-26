import {
  computePostId,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type { Post, KarmaBox, UtxoTransaction, AnyBox, SubBlock, LikeBox } from '@dagsocial/types';
import type { VerifierDeps, VerificationResult } from './verifier.js';

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class PostServiceError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = 'PostServiceError';
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface PostServiceDeps {
  // Validation
  verifyPost: (
    deps: VerifierDeps,
    post: Post,
    currentBlockHeight: number,
  ) => VerificationResult;
  getActiveChallenge: (
    userId: Uint8Array,
  ) => { challenge: Uint8Array; expiresAtBlock: number; userId: Uint8Array } | null;
  getKarmaBoxes: (owner: Uint8Array) => { value: number; id?: string }[];
  getPost: (id: string) => unknown | null;

  // Serialization & storage
  encodePost: (post: Post) => Uint8Array;
  insertPost: (post: Post, rawCbor: Uint8Array) => void;

  // State
  getCurrentHeight: () => number;

  // Mutations
  consumeChallenge: (userId: Uint8Array, challenge: Uint8Array) => void;
  insertMempoolSubBlock: (
    subBlock: SubBlock,
    expiresAtHeight: number,
    batchId?: string | null,
  ) => number;
  insertUtxoTx: (
    tx: UtxoTransaction,
    batchId: string | null,
    expiresAtHeight: number,
  ) => number;

  // UTXO validation
  validateTx: (
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ) => { valid: boolean; error?: string; computedOutputs?: AnyBox[]; txId?: string };
  getBox: (id: string) => AnyBox | null;

  // Notification
  onSubBlockReceived: () => void;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface PostCreateResult {
  postId: string;
  status: 'pending';
  expiresAtHeight: number;
  txId: string;
  subBlock: SubBlock;
  karmaLockTx: UtxoTransaction;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Post creation service. Encapsulates the full post submission pipeline:
 * validation, challenge consumption, karma-lock tx verification, sub-block
 * assembly, and mempool insertion.
 *
 * Broadcasting is handled by the route layer (follows the same pattern as
 * invites and likes services).
 */
export function createPost(
  deps: PostServiceDeps,
  post: Post,
  karmaLockTx: UtxoTransaction,
): PostCreateResult {
  const currentHeight = deps.getCurrentHeight();

  // ---- 1. Verify the post (signature, PoW, karma, parent refs, challenge) ----
  const verifierDeps: VerifierDeps = {
    getActiveChallenge: deps.getActiveChallenge,
    getKarmaBoxes: deps.getKarmaBoxes,
    getPost: deps.getPost,
  };
  const result = deps.verifyPost(verifierDeps, post, currentHeight);
  if (!result.valid) {
    // Consume challenge on failure so the user can request a fresh one.
    // Swallow errors: the challenge may be malformed or already consumed.
    try {
      deps.consumeChallenge(post.author, post.challenge);
    } catch {
      /* ok */
    }
    throw new PostServiceError(result.error ?? 'validation failed');
  }

  // ---- 2. Compute post ID server-authoritatively ----
  const postId = computePostId(post);

  // ---- 3. Serialize and store post in dag_posts ----
  const rawCbor = deps.encodePost(post);
  deps.insertPost(post, rawCbor);

  // ---- 4. Validate the karma-lock tx ----
  const txResult = deps.validateTx(karmaLockTx, currentHeight);
  if (!txResult.valid) {
    try {
      deps.consumeChallenge(post.author, post.challenge);
    } catch {
      /* ok */
    }
    throw new PostServiceError(txResult.error ?? 'invalid karma-lock transaction');
  }

  // ---- 5. Verify the karma-lock tx matches the post author ----
  if (!karmaLockTx.inputs[0]) {
    try {
      deps.consumeChallenge(post.author, post.challenge);
    } catch {
      /* ok */
    }
    throw new PostServiceError('karmaLockTx has no inputs');
  }
  const karmaInput = deps.getBox(karmaLockTx.inputs[0]);
  if (!karmaInput || karmaInput.boxType !== 'karma') {
    try {
      deps.consumeChallenge(post.author, post.challenge);
    } catch {
      /* ok */
    }
    throw new PostServiceError('karmaLockTx first input must be a karma box');
  }
  const karmaOwner = (karmaInput as KarmaBox).owner;
  if (!karmaOwner || karmaOwner.length !== 32) {
    try {
      deps.consumeChallenge(post.author, post.challenge);
    } catch {
      /* ok */
    }
    throw new PostServiceError('Karma box has invalid owner');
  }
  if (!Buffer.from(post.author).equals(Buffer.from(karmaOwner))) {
    try {
      deps.consumeChallenge(post.author, post.challenge);
    } catch {
      /* ok */
    }
    throw new PostServiceError('karmaLockTx does not belong to post author');
  }

  // ---- 6. Consume the challenge ----
  deps.consumeChallenge(post.author, post.challenge);

  // ---- 7. Assemble sub-block — the post rides its own sub-block ----
  const subBlock = {
    subBlockId: postId,
    post,
    likeBoxes: [] as LikeBox[],
    producerId: post.author,
    protocolVersion: post.protocolVersion,
  };

  // ---- 8. Insert both as a batch into the mempool (same batchId = postId) ----
  const batchId = postId;
  const expiresAtHeight = currentHeight + MEMPOOL_EXPIRY_BLOCKS;
  deps.insertMempoolSubBlock(subBlock, expiresAtHeight, batchId);
  deps.insertUtxoTx(karmaLockTx, batchId, expiresAtHeight);

  // ---- 9. Signal the block creator ----
  deps.onSubBlockReceived();

  return {
    postId,
    status: 'pending',
    expiresAtHeight,
    txId: txResult.txId ?? '',
    subBlock,
    karmaLockTx,
  };
}
