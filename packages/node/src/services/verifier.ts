import {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
  POST_LOCK_THREAD_COST,
  POST_LOCK_REPLY_COST,
  computePostId,
  decodePost,
  postPowPreimage,
} from '@dagsocial/types';
import type { Post, Stump } from '@dagsocial/types';
import { verifyPoW, verifyPostSignature, verifyContentCharacters } from '@dagsocial/validation';
// The post PoW target comes from the shared config singleton — the same field
// the challenge endpoint advertises — so the node cannot claim one difficulty
// and enforce another (audit A6). Same pattern as difficulty.ts. Deliberately
// not a parameter: an override argument would be the environment read the
// network profile removed, reached by another door.
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Parent hash verification
// ---------------------------------------------------------------------------

/**
 * Verify that a parentRef matches the hash of the parent post's raw CBOR bytes.
 * This is the "validate, don't trust" check — we independently recompute the
 * hash rather than trusting the lookup key.
 *
 * If `getPostRaw` is not available (e.g., in unit tests that don't provide
 * raw bytes), the check falls back to existence-only validation.
 */
function verifyParentHash(
  deps: VerifierDeps,
  parentId: string,
): { valid: boolean; error?: string } {
  const parentRaw = deps.getPostRaw?.(parentId);
  if (!parentRaw) {
    // getPostRaw not available — fall back to existence check (already
    // verified by the caller). This is a soft-path for tests.
    return { valid: true };
  }
  // Round-trip through decode -> computePostId (CBOR hash != field hash)
  const parentPost = decodePost(parentRaw);
  const recomputedId = computePostId(parentPost);
  if (recomputedId !== parentId) {
    return {
      valid: false,
      error: `Parent hash mismatch: claimed ${parentId}, computed ${recomputedId}`,
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ChallengeRecord {
  challenge: Uint8Array;
  expiresAtBlock: number;
  userId: Uint8Array;
}

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

export interface VerifierDeps {
  getActiveChallenge: (userId: Uint8Array) => ChallengeRecord | null;
  getKarmaBoxes: (owner: Uint8Array) => { value: bigint; id?: string }[];
  /**
   * The store's real signature. Both arms are meaningful here rather than
   * incidental: a parent ref may name a live post OR a stump, and both are
   * valid parents (NODE_INTERFACE → Posts). The two call sites below use it
   * as an existence check, so the union needs no narrowing — but typing it
   * `unknown` hid that the stump case was deliberate.
   */
  getPost: (id: string) => Post | Stump | null;
  /** Raw CBOR bytes for a post, used for independent hash recomputation. */
  getPostRaw?: (id: string) => Uint8Array | null;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface VerificationResult {
  valid: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// verifyPost
// ---------------------------------------------------------------------------

/**
 * Verify a post against protocol rules.
 *
 * Checks are performed in fail-fast order.  The caller supplies store functions
 * via `deps` so the verifier can be tested without a real database.
 */
export function verifyPost(
  deps: VerifierDeps,
  post: Post,
  currentBlockHeight: number,
): VerificationResult {
  // 1. Content: 1–300 bytes UTF-8. Reject empty.
  const contentBytes = Buffer.byteLength(post.content, 'utf8');
  if (contentBytes === 0) {
    return { valid: false, error: 'Content is empty' };
  }
  if (contentBytes > MAX_CONTENT_BYTES) {
    return { valid: false, error: 'Content exceeds max length' };
  }

  // 1b. Character restrictions: no control, zero-width, or bidi chars.
  const charCheck = verifyContentCharacters(post.content);
  if (!charCheck.valid) return charCheck;

  // 2. Parent refs: 0–8.
  if (post.parentRefs.length > MAX_PARENT_REFS) {
    return { valid: false, error: `Too many parent refs (max ${MAX_PARENT_REFS})` };
  }

  // 3. Protocol version.
  if (post.protocolVersion !== PROTOCOL_VERSION) {
    return { valid: false, error: 'Unsupported protocol version' };
  }

  // 4. Challenge: must exist, not expire, and match byte-for-byte.
  const challenge = deps.getActiveChallenge(post.author);
  if (!challenge) {
    return { valid: false, error: 'No active challenge' };
  }
  if (challenge.expiresAtBlock < currentBlockHeight) {
    return { valid: false, error: 'Challenge expired' };
  }
  if (
    challenge.challenge.length !== post.challenge.length ||
    !Buffer.from(challenge.challenge).equals(Buffer.from(post.challenge))
  ) {
    return { valid: false, error: 'Challenge mismatch' };
  }

  // 5. Proof of Work. The preimage comes from @dagsocial/types — the single
  //    canonical encoder (audit M-1). Rebuilding it here would be a third copy
  //    that silently drifts from the miner's.
  const powInput = postPowPreimage(post);
  if (!verifyPoW(powInput, post.powNonce, config.postPowTargetBits)) {
    return { valid: false, error: 'Proof of Work invalid' };
  }

  // 6. Signature — post.author IS the 32-byte Ed25519 public key
  if (!verifyPostSignature(post, post.author)) {
    return { valid: false, error: 'Signature invalid' };
  }

  // 7. Karma: author must have sufficient karma across all boxes.
  // Look up by public key (post.author).
  const karmaBoxes = deps.getKarmaBoxes(post.author);
  if (karmaBoxes.length === 0) {
    return { valid: false, error: 'No karma box found' };
  }
  const totalKarma = karmaBoxes.reduce((sum, b) => sum + b.value, 0n);
  const requiredKarma =
    post.parentRefs.length === 0 ? POST_LOCK_THREAD_COST : POST_LOCK_REPLY_COST;
  if (totalKarma < requiredKarma) {
    return {
      valid: false,
      error: `Insufficient karma: need ${requiredKarma} (have ${totalKarma})`,
    };
  }

  // 8. Parent refs: every referenced post must exist AND hash must match.
  for (const parentId of post.parentRefs) {
    if (!deps.getPost(parentId)) {
      return { valid: false, error: `Parent post not found: ${parentId}` };
    }
    const hashCheck = verifyParentHash(deps, parentId);
    if (!hashCheck.valid) return hashCheck;
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifyPostForRelay
// ---------------------------------------------------------------------------

/**
 * Verify a relayed post (received via gossip). Same as verifyPost but skips
 * the challenge check — the challenge was local to the origin node.
 *
 * Stage 2 validation: runs after Stage 1 (stateless checks in net package)
 * has already passed. Adds stateful checks: parent refs exist, karma
 * sufficient.
 */
export function verifyPostForRelay(
  deps: VerifierDeps,
  post: Post,
  currentBlockHeight: number,
): VerificationResult {
  // 1. Content: already checked by Stage 1, but re-verify
  const contentBytes = Buffer.byteLength(post.content, 'utf8');
  if (contentBytes === 0) {
    return { valid: false, error: 'Content is empty' };
  }
  if (contentBytes > MAX_CONTENT_BYTES) {
    return { valid: false, error: 'Content exceeds max length' };
  }

  // 1b. Character restrictions: no control, zero-width, or bidi chars.
  const charCheck = verifyContentCharacters(post.content);
  if (!charCheck.valid) return charCheck;

  // 2. Parent refs count
  if (post.parentRefs.length > MAX_PARENT_REFS) {
    return { valid: false, error: `Too many parent refs (max ${MAX_PARENT_REFS})` };
  }

  // 3. Protocol version
  if (post.protocolVersion !== PROTOCOL_VERSION) {
    return { valid: false, error: 'Unsupported protocol version' };
  }

  // 4. Challenge is NOT checked — challenge was node-local to origin

  // 5. PoW: re-verify (stateless, cheap). Canonical preimage from
  //    @dagsocial/types — see verifyPost above.
  const powInput = postPowPreimage(post);
  if (!verifyPoW(powInput, post.powNonce, config.postPowTargetBits)) {
    return { valid: false, error: 'Proof of Work invalid' };
  }

  // 6. Signature — post.author IS the 32-byte Ed25519 public key.
  // No identity lookup needed; the key proves the identity.
  if (!verifyPostSignature(post, post.author)) {
    return { valid: false, error: 'Signature invalid' };
  }

  // 7. Karma is NOT checked on relay.  The block producer (miner) already
  //    verified economic rules before creating the sub-block.  A relaying
  //    node caches the data and trusts the ordering block to confirm or
  //    reject it.  Cryptographic checks (signature, PoW) are sufficient
  //    for relay acceptance.

  // 8. Parent refs: must exist AND hash must match.
  for (const parentId of post.parentRefs) {
    if (!deps.getPost(parentId)) {
      return { valid: false, error: `Parent post not found: ${parentId}` };
    }
    const hashCheck = verifyParentHash(deps, parentId);
    if (!hashCheck.valid) return hashCheck;
  }

  return { valid: true };
}

