import { createPublicKey, verify as cryptoVerify } from 'crypto';
import { signingHash, PROTOCOL_VERSION, MAX_CONTENT_BYTES } from '@dagsocial/types';
import type { Post } from '@dagsocial/types';
import { verifyPoW } from './pow.js';
import { getValidSlot, consumeSlot } from '../store/slots.js';
import { getDb } from '../store/db.js';
import { config } from '../config.js';

export interface VerificationResult {
  valid: boolean;
  error?: string;
}

export function verifyPost(post: Post, currentBlockHeight: number): VerificationResult {
  // 1. Verify slot token
  const slot = getValidSlot(post.author, post.slotHash);
  if (!slot) {
    return { valid: false, error: 'Slot token not found or already consumed' };
  }
  if (slot.expiresAtBlock < currentBlockHeight) {
    consumeSlot(post.author, post.slotHash);
    return { valid: false, error: 'Slot token expired' };
  }

  // Protocol version check
  if (post.protocolVersion !== PROTOCOL_VERSION) {
    return { valid: false, error: 'Unsupported protocol version' };
  }

  // Content limit check
  if (post.content.length > MAX_CONTENT_BYTES) {
    return { valid: false, error: 'Content exceeds max length' };
  }

  // 2. Verify Phase 2 PoW
  const powInput = `${post.content}${post.author}${post.parentRefs.join('')}${post.slotHash}${post.timestamp}`;
  if (!verifyPoW(powInput, post.powNonce, config.pow.submitTargetBits)) {
    return { valid: false, error: 'Phase 2 PoW invalid' };
  }

  // 3. Verify signature (raw Ed25519 — browsers produce raw, not DER)
  const hash = signingHash(post);

  const row = getDb().prepare(
    'SELECT public_key FROM identities WHERE user_id = ?'
  ).get(post.author) as { public_key: Buffer } | undefined;
  if (!row) {
    return { valid: false, error: 'Author identity not found' };
  }

  const pubKeyDer = wrapEd25519Spki(row.public_key);
  const pubKeyObj = createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });
  const sigBuf = Buffer.from(post.signature, 'base64');
  if (!cryptoVerify(null, hash, pubKeyObj, sigBuf)) {
    return { valid: false, error: 'Signature invalid' };
  }

  // 4. Verify parent refs (skip for genesis posts)
  if (post.parentRefs.length > 0) {
    const db = getDb();
    for (const parentId of post.parentRefs) {
      const parent = db.prepare(
        "SELECT id FROM posts WHERE id = ? AND status = 'confirmed'"
      ).get(parentId);
      if (!parent) {
        return { valid: false, error: `Parent post not found: ${parentId}` };
      }
    }
  }

  return { valid: true };
}

function wrapEd25519Spki(raw: Buffer): Buffer {
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  return Buffer.concat([spkiPrefix, raw]);
}
