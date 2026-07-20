import { createHash } from 'crypto';
import type { UserId } from './identity.js';

export interface SlotToken {
  userId: UserId;
  issuedAtBlock: number;
  expiresAtBlock: number;
  nonce: number;
  hash: string;
}

export interface UnsignedPost {
  content: string;
  author: UserId;
  parentRefs: string[];
  slotHash: string;
  powNonce: number;
  protocolVersion: number;
  timestamp: number;
}

export interface Post extends UnsignedPost {
  id: string;
  signature: string;
  status: 'pending' | 'confirmed';
  blockHeight?: number;
}

export interface Block {
  height: number;
  hash: string;
  postIds: string[];
  postCount: number;
  protocolVersion: number;
  createdAt: number;
}

/**
 * Hash that the author signs. Covers: content, author, parents, slotHash,
 * protocolVersion, timestamp. Excludes powNonce (post-hoc work) and
 * id/signature (not yet set).
 *
 * Uses blake2b512 truncated to 32 bytes (Node.js v22 lacks blake2b256).
 */
export function signingHash(post: UnsignedPost): Buffer {
  const h = createHash('blake2b512');
  h.update(post.content);
  h.update(post.author);
  for (const ref of post.parentRefs) {
    h.update(ref);
  }
  h.update(post.slotHash);
  h.update(String(post.protocolVersion));
  h.update(String(post.timestamp));
  return h.digest().subarray(0, 32);
}

/**
 * Deterministic post ID from unsigned post data. Includes powNonce.
 *
 * Uses blake2b512 truncated to 32 bytes (Node.js v22 lacks blake2b256).
 */
export function computePostId(post: UnsignedPost): string {
  const h = createHash('blake2b512');
  h.update(post.content);
  h.update(post.author);
  for (const ref of post.parentRefs) {
    h.update(ref);
  }
  h.update(post.slotHash);
  h.update(String(post.protocolVersion));
  h.update(String(post.powNonce));
  h.update(String(post.timestamp));
  return h.digest().subarray(0, 32).toString('hex');
}
