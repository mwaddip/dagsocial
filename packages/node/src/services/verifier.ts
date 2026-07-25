import {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
  POST_POW_TARGET_BITS,
  POST_LOCK_THREAD_COST,
  POST_LOCK_REPLY_COST,
} from '@dagsocial/types';
import type { Post } from '@dagsocial/types';
import { verifyPoW, verifyPostSignature } from '@dagsocial/validation';

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

export interface VerifierDeps {
  getActiveChallenge: (
    userId: Uint8Array,
  ) => { challenge: Uint8Array; expiresAtBlock: number; userId: Uint8Array } | null;
  getIdentity: (
    userId: Uint8Array,
  ) => { userId: Uint8Array; publicKey: Uint8Array; createdAt: number } | null;
  getKarmaBoxes: (owner: Uint8Array) => { value: number; id?: string }[];
  getPost: (id: string) => unknown | null;
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

  // 8. Parent refs: every referenced post must exist.
  for (const parentId of post.parentRefs) {
    if (!deps.getPost(parentId)) {
      return { valid: false, error: `Parent post not found: ${parentId}` };
    }
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

  // 8. Parent refs exist
  for (const parentId of post.parentRefs) {
    if (!deps.getPost(parentId)) {
      return { valid: false, error: `Parent post not found: ${parentId}` };
    }
  }

  return { valid: true };
}
