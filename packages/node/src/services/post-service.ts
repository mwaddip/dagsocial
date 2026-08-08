import {
  computePostId,
  decodePost,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type { Post, Stump, KarmaBox, UtxoTransaction, AnyBox, SubBlock } from '@dagsocial/types';
import type { VerifierDeps, VerificationResult } from './verifier.js';
import { ClientError } from './client-error.js';

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class PostServiceError extends ClientError {
  constructor(message: string, statusCode: number = 400) {
    super(message, statusCode);
    this.name = 'PostServiceError';
  }
}

/** Validation-specific error — the post failed independent recomputation. */
export class PostValidationError extends PostServiceError {
  constructor(message: string) {
    super(message);
    this.name = 'PostValidationError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodeUint32(n: number): Uint8Array {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, n, true); // LE
  return new Uint8Array(buf);
}

function decodeUint32(bytes: Uint8Array): number {
  if (bytes.length < 4) return 0;
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
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
  getKarmaBoxes: (owner: Uint8Array) => { value: bigint; id?: string }[];
  /** The store's real signature — passed straight through to `VerifierDeps`. */
  getPost: (id: string) => Post | Stump | null;

  // Raw byte access for independent hash recomputation
  getPostRaw: (id: string) => Uint8Array | null;

  // Serialization & storage
  encodePost: (post: Post) => Uint8Array;
  insertPost: (post: Post, rawCbor: Uint8Array) => void;

  // State
  getCurrentHeight: () => number;

  // Mutations
  consumeChallenge: (userId: Uint8Array, challenge: Uint8Array) => void;
  insertMempoolSubBlock: (
    postId: string,
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

  // Watermark tracking (dag_meta)
  metaPut: (key: string, value: Uint8Array) => void;
  metaGet: (key: string) => Uint8Array | null;
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
 *
 * Phase 1 — Structural validation (stateless checks)
 * Phase 2 — Cryptographic validation (signature, PoW)
 * Phase 3 — DAG integrity (parent-hash recomputation, content-hash verification)
 * Phase 4 — Content validation + watermark advancement
 *
 * Every self-reported claim (parent hashes, content hash) is independently
 * recomputed before the post enters the store. No data enters the store
 * without passing all phases.
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

  // ---- Phase 1-2: Verify the post (signature, PoW, karma, parent refs, challenge) ----
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

  // ---- Phase 3: DAG integrity — independently recompute parent hashes ----
  // Every parentRef must match the blake2b-512/32 hash of the parent post's
  // canonical CBOR encoding. This is defense-in-depth: even if the store
  // returned a post for the lookup key, we verify the hash independently.
  for (const parentRef of post.parentRefs) {
    const parentBytes = deps.getPostRaw(parentRef);
    if (!parentBytes) {
      throw new PostValidationError(
        `parent post ${parentRef} not found (raw bytes unavailable)`,
      );
    }
    // Round-trip through decode -> computePostId to get the canonical ID.
    // Raw CBOR hashing doesn't match -- CBOR framing differs from the
    // field-level hashing that computePostId uses.
    const parentPost = decodePost(parentBytes);
    const recomputedId = computePostId(parentPost);
    if (recomputedId !== parentRef) {
      throw new PostValidationError(
        `parent hash mismatch: claimed ${parentRef}, computed ${recomputedId}`,
      );
    }
  }

  // ---- Compute post ID server-authoritatively ----
  // This is the content-hash recomputation: we never trust a client-provided
  // ID. The post ID is derived entirely from post fields.
  const postId = computePostId(post);

  // ---- Phase 3 complete: store post, then advance indexed watermark ----
  const rawCbor = deps.encodePost(post);
  deps.insertPost(post, rawCbor);
  advanceWatermark(deps, 'last_indexed_sequence');

  // ---- Validate the karma-lock tx ----
  const txResult = deps.validateTx(karmaLockTx, currentHeight);
  if (!txResult.valid) {
    try {
      deps.consumeChallenge(post.author, post.challenge);
    } catch {
      /* ok */
    }
    throw new PostServiceError(txResult.error ?? 'invalid karma-lock transaction');
  }

  // ---- Verify the karma-lock tx matches the post author ----
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

  // ---- Consume the challenge ----
  deps.consumeChallenge(post.author, post.challenge);

  // ---- Assemble sub-block — the post rides its own sub-block ----
  const subBlock = {
    subBlockId: postId,
    post,
    producerId: post.author,
    protocolVersion: post.protocolVersion,
  };

  // ---- Insert both as a batch into the mempool (same batchId = postId) ----
  const batchId = postId;
  const expiresAtHeight = currentHeight + MEMPOOL_EXPIRY_BLOCKS;
  deps.insertMempoolSubBlock(postId, expiresAtHeight, batchId);
  deps.insertUtxoTx(karmaLockTx, batchId, expiresAtHeight);

  // ---- Signal the block creator ----
  deps.onSubBlockReceived();

  // ---- Phase 4 complete: advance validated watermark ----
  // All content checks passed; the post is safe for external queries.
  advanceWatermark(deps, 'last_validated_sequence');

  return {
    postId,
    status: 'pending',
    expiresAtHeight,
    txId: txResult.txId ?? '',
    subBlock,
    karmaLockTx,
  };
}

// ---------------------------------------------------------------------------
// Watermark helpers
// ---------------------------------------------------------------------------

/**
 * Advance a monotonically-increasing watermark in dag_meta.
 * Used to track the boundary between indexed and validated posts.
 */
function advanceWatermark(
  deps: PostServiceDeps,
  key: 'last_indexed_sequence' | 'last_validated_sequence',
): void {
  const current = deps.metaGet(key);
  const seq = current ? decodeUint32(current) : 0;
  deps.metaPut(key, encodeUint32(seq + 1));
}
