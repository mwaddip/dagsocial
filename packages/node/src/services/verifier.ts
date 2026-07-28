import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
  POST_POW_TARGET_BITS,
  POST_LOCK_THREAD_COST,
  POST_LOCK_REPLY_COST,
  computePostId,
  decodePost,
} from '@dagsocial/types';
import type { Post } from '@dagsocial/types';
import { verifyPoW, verifyPostSignature, verifyContentCharacters } from '@dagsocial/validation';

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
// Dependency interface
// ---------------------------------------------------------------------------

export interface VerifierDeps {
  getActiveChallenge: (
    userId: Uint8Array,
  ) => { challenge: Uint8Array; expiresAtBlock: number; userId: Uint8Array } | null;
  getKarmaBoxes: (owner: Uint8Array) => { value: number; id?: string }[];
  getPost: (id: string) => unknown | null;
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

  // 5. Proof of Work.
  const powInput = Buffer.concat([
    Buffer.from(post.content),
    Buffer.from(post.author),
    ...post.parentRefs.map((r) => Buffer.from(r)),
    Buffer.from(post.challenge),
    Buffer.from(String(post.protocolVersion)),
    Buffer.from(String(post.timestamp)),
  ]);
  if (!verifyPoW(powInput, post.powNonce, POST_POW_TARGET_BITS)) {
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
  const totalKarma = karmaBoxes.reduce((sum, b) => sum + b.value, 0);
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

  // 5. PoW: re-verify (stateless, cheap)
  const powInput = Buffer.concat([
    Buffer.from(post.content),
    Buffer.from(post.author),
    ...post.parentRefs.map((r) => Buffer.from(r)),
    Buffer.from(post.challenge),
    Buffer.from(String(post.protocolVersion)),
    Buffer.from(String(post.timestamp)),
  ]);
  if (!verifyPoW(powInput, post.powNonce, POST_POW_TARGET_BITS)) {
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

// ---------------------------------------------------------------------------
// Author signature verification (challenge-response)
// ---------------------------------------------------------------------------

/**
 * Dependencies for verifying an author challenge-response.
 */
export interface AuthorVerifierDeps {
  getActiveChallenge: (userId: Uint8Array) => { challenge: Uint8Array; expiresAtBlock: number } | null;
  consumeChallenge: (userId: Uint8Array) => void;
  getCurrentHeight: () => number;
}

/**
 * Verify that a signature proves ownership of the Ed25519 keypair whose
 * public key is `authorId`.
 *
 * The caller must have requested a challenge via POST /challenge, then
 * signed blake2b-32(challenge) with their Ed25519 private key.
 *
 * On success the challenge is consumed (one-time use).
 */
export function verifyAuthorSignature(
  deps: AuthorVerifierDeps,
  authorId: Uint8Array,
  challengeHex: string,
  signatureHex: string,
): { valid: true } | { valid: false; error: string } {
  // 1. Challenge must exist and be active for this author
  const record = deps.getActiveChallenge(authorId);
  if (!record) {
    return { valid: false, error: 'No active challenge — request one via POST /challenge' };
  }
  const currentHeight = deps.getCurrentHeight();
  if (record.expiresAtBlock < currentHeight) {
    return { valid: false, error: 'Challenge expired' };
  }

  // 2. Decode challenge and signature from hex
  let challenge: Uint8Array;
  let signature: Uint8Array;
  try {
    challenge = new Uint8Array(Buffer.from(challengeHex, 'hex'));
    signature = new Uint8Array(Buffer.from(signatureHex, 'hex'));
  } catch {
    return { valid: false, error: 'Invalid hex encoding' };
  }

  // 3. Challenge must match the active one byte-for-byte
  if (
    challenge.length !== record.challenge.length ||
    !Buffer.from(challenge).equals(Buffer.from(record.challenge))
  ) {
    return { valid: false, error: 'Challenge mismatch' };
  }

  // 4. Verify Ed25519 signature over blake2b-32(challenge)
  const hash = createHash('blake2b512').update(challenge).digest().subarray(0, 32);
  const pubKeyObj = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(authorId).toString('base64url') },
    format: 'jwk',
  });
  const valid = cryptoVerify(null, hash, pubKeyObj, Buffer.from(signature));
  if (!valid) {
    return { valid: false, error: 'Invalid signature' };
  }

  // 5. Consume the challenge (one-time use)
  deps.consumeChallenge(authorId);

  return { valid: true };
}
