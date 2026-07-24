import { createHash } from 'crypto';
import type { UserId } from './identity.js';
import { MAX_CONTENT_BYTES, MAX_PARENT_REFS } from './constants.js';

export type PostId = string;

export interface Post {
  content: string;              // 1–MAX_CONTENT_BYTES UTF-8
  author: UserId;               // 32-byte Ed25519 public key
  parentRefs: PostId[];         // 0–MAX_PARENT_REFS
  challenge: Uint8Array;        // 32 bytes — random nonce from node (anti-precomputation)
  powNonce: number;             // PoW solution against challenge
  protocolVersion: number;
  timestamp: number;            // Unix ms
  signature: Uint8Array;        // 64 bytes — Ed25519 over signingHash(post)
}

/**
 * Hash that the author signs. Covers content, author, parentRefs, challenge,
 * protocolVersion, timestamp. Excludes powNonce (author signs before finding
 * the PoW nonce) and signature (not yet set).
 *
 * Uses blake2b512 truncated to 32 bytes (Node.js v22 lacks blake2b256).
 */
export function signingHash(post: Post): Buffer {
  const h = createHash('blake2b512');
  h.update(post.content);
  h.update(post.author);
  for (const ref of post.parentRefs) {
    h.update(ref);
  }
  h.update(post.challenge);
  h.update(String(post.protocolVersion));
  h.update(String(post.timestamp));
  return h.digest().subarray(0, 32);
}

/**
 * Deterministic post ID. Includes powNonce (excluded from signingHash).
 *
 * Uses blake2b512 truncated to 32 bytes (Node.js v22 lacks blake2b256).
 */
export function computePostId(post: Post): PostId {
  const h = createHash('blake2b512');
  h.update(post.content);
  h.update(post.author);
  for (const ref of post.parentRefs) {
    h.update(ref);
  }
  h.update(post.challenge);
  h.update(String(post.protocolVersion));
  h.update(String(post.powNonce));
  h.update(String(post.timestamp));
  return h.digest().subarray(0, 32).toString('hex');
}

// ---------------------------------------------------------------------------
// Profile post discriminators
// ---------------------------------------------------------------------------

/**
 * Try to extract a profile type discriminator from post content.
 * Returns null for regular posts (content is plain text, not JSON).
 */
export function getPostDiscriminator(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string') {
      return parsed.type;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build profile post content JSON. Embed the type discriminator and any
 * additional fields. The receiver extracts the type via getPostDiscriminator.
 */
export function buildProfileContent(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...extra });
}
