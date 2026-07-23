import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
} from '@dagsocial/types';
import { signingHash } from '@dagsocial/types';
import type { Post, SubBlock, OrderingBlock, UtxoTransaction } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// SPKI wrapper (same as node's verifier)
// ---------------------------------------------------------------------------

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function wrapSpki(raw: Uint8Array): Buffer {
  return Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]);
}

// ---------------------------------------------------------------------------
// verifyPoW
// ---------------------------------------------------------------------------

export function verifyPoW(input: Uint8Array, nonce: number, targetBits: number): boolean {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));
  const buf = Buffer.concat([Buffer.from(input), nonceBuf]);
  const hash = createHash('blake2b512').update(buf).digest().subarray(0, 32);
  for (let i = 0; i < targetBits; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    if ((hash[byteIdx]! & (1 << bitIdx)) !== 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// verifyPostSignature
// ---------------------------------------------------------------------------

export function verifyPostSignature(post: Post, publicKey: Uint8Array): boolean {
  const pubDer = wrapSpki(publicKey);
  const pubKeyObj = createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
  const sigBuf = Buffer.from(post.signature);
  return cryptoVerify(null, signingHash(post), pubKeyObj, sigBuf);
}

// ---------------------------------------------------------------------------
// verifyProtocolVersion
// ---------------------------------------------------------------------------

export function verifyProtocolVersion(version: number): boolean {
  return version === PROTOCOL_VERSION;
}

// ---------------------------------------------------------------------------
// verifyContentLimits
// ---------------------------------------------------------------------------

export function verifyContentLimits(content: string): { valid: boolean; error?: string } {
  const byteLen = Buffer.byteLength(content, 'utf8');
  if (byteLen === 0) return { valid: false, error: 'Content is empty' };
  if (byteLen > MAX_CONTENT_BYTES) return { valid: false, error: 'Content exceeds max length' };
  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifyParentRefsCount
// ---------------------------------------------------------------------------

export function verifyParentRefsCount(refs: string[]): { valid: boolean; error?: string } {
  if (refs.length > MAX_PARENT_REFS) {
    return { valid: false, error: `Too many parent refs (max ${MAX_PARENT_REFS})` };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifySubBlockStructure
// ---------------------------------------------------------------------------

export function verifySubBlockStructure(sb: SubBlock): { valid: boolean; error?: string } {
  if (!sb.post) return { valid: false, error: 'Sub-block missing post' };
  if (!sb.subBlockId) return { valid: false, error: 'Sub-block missing subBlockId' };
  if (!Array.isArray(sb.likeBoxes)) return { valid: false, error: 'Sub-block likeBoxes must be an array' };
  if (typeof sb.protocolVersion !== 'number') return { valid: false, error: 'Sub-block missing protocolVersion' };
  if (!sb.producerId) return { valid: false, error: 'Sub-block missing producerId' };
  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifyTxStructure
// ---------------------------------------------------------------------------

export function verifyTxStructure(tx: UtxoTransaction): { valid: boolean; error?: string } {
  if (!Array.isArray(tx.inputs) || tx.inputs.length === 0) {
    return { valid: false, error: 'Transaction must have at least one input' };
  }
  if (!Array.isArray(tx.outputs) || tx.outputs.length === 0) {
    return { valid: false, error: 'Transaction must have at least one output' };
  }
  // Check for duplicate inputs
  const seen = new Set<string>();
  for (const input of tx.inputs) {
    if (seen.has(input)) return { valid: false, error: 'Duplicate input in transaction' };
    seen.add(input);
  }
  if (typeof tx.protocolVersion !== 'number') {
    return { valid: false, error: 'Transaction missing protocolVersion' };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifyOrderingBlockStructure
// ---------------------------------------------------------------------------

export function verifyOrderingBlockStructure(
  block: OrderingBlock,
): { valid: boolean; error?: string } {
  if (!block.prevBlockHash) return { valid: false, error: 'Ordering block missing prevBlockHash' };
  if (!Array.isArray(block.subBlockRefs)) return { valid: false, error: 'Ordering block missing subBlockRefs' };
  if (!block.validatorSignature || block.validatorSignature.length !== 64) {
    return { valid: false, error: 'Ordering block missing or invalid validatorSignature' };
  }
  if (typeof block.height !== 'number' || block.height < 1) {
    return { valid: false, error: 'Ordering block invalid height' };
  }
  if (typeof block.protocolVersion !== 'number') {
    return { valid: false, error: 'Ordering block missing protocolVersion' };
  }
  if (!block.hash) return { valid: false, error: 'Ordering block missing hash' };
  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifyBlockChainLink
// ---------------------------------------------------------------------------

export function verifyBlockChainLink(
  block: OrderingBlock,
  prevBlock: OrderingBlock,
): boolean {
  return block.prevBlockHash === prevBlock.hash && block.height === prevBlock.height + 1;
}
