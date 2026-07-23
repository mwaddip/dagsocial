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
    userId: string,
  ) => { challenge: Uint8Array; expiresAtBlock: number; userId: string } | null;
  getIdentity: (
    userId: string,
  ) => { userId: string; publicKey: Uint8Array; createdAt: number } | null;
  getKarmaBox: (owner: Uint8Array) => { value: number; id?: string } | null;
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

  // 6. Signature.
  const identity = deps.getIdentity(post.author);
  if (!identity) {
    return { valid: false, error: 'Author identity not found' };
  }

  if (!verifyPostSignature(post, identity.publicKey)) {
    return { valid: false, error: 'Signature invalid' };
  }

  // 7. Karma: author must have a karma box with sufficient value.
  const karmaBox = deps.getKarmaBox(identity.publicKey);
  if (!karmaBox) {
    return { valid: false, error: 'No karma box found' };
  }
  const requiredKarma =
    post.parentRefs.length === 0 ? POST_LOCK_THREAD_COST : POST_LOCK_REPLY_COST;
  if (karmaBox.value < requiredKarma) {
    return {
      valid: false,
      error: `Insufficient karma: need ${requiredKarma} (have ${karmaBox.value})`,
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
