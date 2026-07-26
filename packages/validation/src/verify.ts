import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  ED25519_SPKI_PREFIX,
} from '@dagsocial/types';
import { signingHash } from '@dagsocial/types';
import { encodeHeader } from '@dagsocial/types';
import type { Post, SubBlock, BlockHeader, OrderingBlock, UtxoTransaction } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Standard blake2b-512/32 hash. Returns the first 32 bytes of blake2b512(data).
 * Used for content-addressed storage: every post, stump, box ID, and Merkle
 * node derives from this function or a structured-field variant.
 *
 * Node.js v22 lacks blake2b256; blake2b-512 with truncation is the project
 * standard for all 32-byte outputs.
 */
export function blake2b32(data: Uint8Array): Uint8Array {
  return createHash('blake2b512').update(data).digest().subarray(0, 32);
}

// ---------------------------------------------------------------------------
// Ed25519 SPKI helpers
// ---------------------------------------------------------------------------

const ED25519_SPKI_BUF = Buffer.from(ED25519_SPKI_PREFIX, 'hex');

function wrapSpki(raw: Uint8Array): Buffer {
  return Buffer.concat([ED25519_SPKI_BUF, Buffer.from(raw)]);
}

/** Wrap a raw 32-byte Ed25519 public key as an SPKI DER KeyObject. */
export function ed25519PublicKeyToKeyObject(rawKey: Uint8Array): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: wrapSpki(rawKey),
    format: 'der',
    type: 'spki',
  });
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
// verifyContentCharacters
// ---------------------------------------------------------------------------

const CONTENT_CHAR_REGEX = /^[\P{C}\n]*$/u;

export function verifyContentCharacters(content: string): { valid: boolean; error?: string } {
  if (!CONTENT_CHAR_REGEX.test(content)) {
    return { valid: false, error: 'Content contains disallowed characters (control, zero-width, or bidi override)' };
  }
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
  const h = block.header;
  if (!h) return { valid: false, error: 'Ordering block missing header' };
  if (!h.prevBlockHash || h.prevBlockHash.length !== 64) {
    return { valid: false, error: 'Ordering block header missing or invalid prevBlockHash' };
  }
  if (!Array.isArray(block.subBlockTree?.subBlockRefs)) {
    return { valid: false, error: 'Ordering block missing subBlockTree.subBlockRefs' };
  }
  if (!Array.isArray(block.subBlockTree.subBlocks) ||
      block.subBlockTree.subBlocks.length !== block.subBlockTree.subBlockRefs.length) {
    return { valid: false, error: 'Ordering block subBlocks must align with subBlockRefs' };
  }
  if (!block.validatorSignature || block.validatorSignature.length !== 64) {
    return { valid: false, error: 'Ordering block missing or invalid validatorSignature' };
  }
  if (typeof h.height !== 'number' || h.height < 1) {
    return { valid: false, error: 'Ordering block invalid height' };
  }
  if (typeof h.protocolVersion !== 'number') {
    return { valid: false, error: 'Ordering block header missing protocolVersion' };
  }
  if (!h.validatorId || h.validatorId.length !== 32) {
    return { valid: false, error: 'Ordering block header missing or invalid validatorId' };
  }
  if (typeof h.powNonce !== 'number' || h.powNonce < 0) {
    return { valid: false, error: 'Ordering block missing or invalid powNonce' };
  }
  if (typeof h.powTargetBits !== 'number' || h.powTargetBits < ORDERING_BLOCK_POW_TARGET_FLOOR) {
    return { valid: false, error: 'Ordering block missing or invalid powTargetBits' };
  }
  if (!Array.isArray(block.utxoTxTree?.utxoTxIds)) {
    return { valid: false, error: 'Ordering block missing utxoTxTree.utxoTxIds' };
  }
  if (!Array.isArray(block.utxoTxTree.utxoTxs) ||
      block.utxoTxTree.utxoTxs.length !== block.utxoTxTree.utxoTxIds.length) {
    return { valid: false, error: 'Ordering block utxoTxs must align with utxoTxIds' };
  }
  if (!Array.isArray(block.utxoTxTree?.coinbaseOutputs)) {
    return { valid: false, error: 'Ordering block missing utxoTxTree.coinbaseOutputs' };
  }
  for (const out of block.utxoTxTree.coinbaseOutputs) {
    if (!out.owner || out.owner.length !== 32) {
      return { valid: false, error: 'Coinbase output missing or invalid owner' };
    }
    if (typeof out.value !== 'number' || out.value < 0) {
      return { valid: false, error: 'Coinbase output invalid value' };
    }
    if (typeof out.lockedUntilBlock !== 'number' || out.lockedUntilBlock < h.height) {
      return { valid: false, error: 'Coinbase output invalid lockedUntilBlock' };
    }
  }
  if (!h.subBlockRoot || h.subBlockRoot.length !== 64) {
    return { valid: false, error: 'Ordering block header missing subBlockRoot' };
  }
  if (!h.utxoTxRoot || h.utxoTxRoot.length !== 64) {
    return { valid: false, error: 'Ordering block header missing utxoTxRoot' };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Block hash
// ---------------------------------------------------------------------------

/**
 * The block hash IS the hash of the serialized header.
 */
export function blockHash(header: BlockHeader): string {
  return createHash('blake2b512')
    .update(Buffer.from(encodeHeader(header)))
    .digest()
    .subarray(0, 32)
    .toString('hex');
}

/**
 * Compute the PoW preimage — the serialized header with powNonce=0.
 * The miner hashes this against candidate nonces.
 */
export function computePowHash(header: BlockHeader): Buffer {
  const template = { ...header, powNonce: 0 };
  return createHash('blake2b512')
    .update(Buffer.from(encodeHeader(template)))
    .digest()
    .subarray(0, 32);
}

// ---------------------------------------------------------------------------
// verifyOrderingBlockPoW
// ---------------------------------------------------------------------------

export function verifyOrderingBlockPoW(header: BlockHeader): boolean {
  const preimage = computePowHash(header);
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(header.powNonce));
  const hash = createHash('blake2b512')
    .update(preimage)
    .update(nonceBuf)
    .digest()
    .subarray(0, 32);
  for (let i = 0; i < header.powTargetBits; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    if ((hash[byteIdx]! & (1 << bitIdx)) !== 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// verifyBlockChainLink
// ---------------------------------------------------------------------------

export function verifyBlockChainLink(
  block: OrderingBlock,
  prevBlock: OrderingBlock,
): boolean {
  return (
    block.header.prevBlockHash === blockHash(prevBlock.header) &&
    block.header.height === prevBlock.header.height + 1
  );
}
