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
import { isDisallowedContentCodepoint } from './content-charset.js';

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
// Input guards (audit M-5, M-6)
// ---------------------------------------------------------------------------
//
// Every exported verify* function receives objects straight off the wire, so
// its arguments may be wrongly typed or out of range. The guards below stand in
// front of the operations that throw on such input — `Buffer.byteLength`,
// `Buffer.from`, `createPublicKey`, `crypto.verify`, `BigInt` /
// `writeBigUInt64LE`, CBOR encoding, and plain `.length` reads — so a malformed
// object yields a clean `false` / `{ valid: false }`, never an exception.
//
// Each guard checks exactly the declared type of the field it protects, so a
// well-formed object from any conforming encoder passes unchanged and the happy
// path is untouched.

/** Narrow to a non-null object. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Narrow to `Uint8Array` (which `Buffer` extends).
 *
 * Deliberately not `ArrayBuffer.isView`: `Buffer.from(new Uint32Array(8))`
 * copies *elements*, not bytes, so a 32-byte-but-not-Uint8Array view would
 * silently yield an 8-byte key and throw downstream in `createPublicKey`.
 */
function isBytes(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array;
}

/**
 * Guard for every value that reaches `BigInt(...)` + `writeBigUInt64LE`, and
 * for bit-count arguments (audit M-6).
 *
 * `Number.isSafeInteger`, not a loose `typeof === 'number'` — the loose check
 * admits `NaN`, `Infinity`, and floats, each of which throws in `BigInt()`, and
 * negatives / values ≥ 2^64, which throw in `writeBigUInt64LE`. Safe integers
 * are a strict subset of u64, so the u64 range is satisfied by construction.
 */
function isU64Safe(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * True iff `hash` opens with at least `targetBits` zero bits.
 *
 * A `targetBits` beyond the hash's own bit length is unsatisfiable, hence
 * `false`. The previous inline loops read past the end of the array instead,
 * where `undefined & mask` coerces to `0` — so an all-zero digest satisfied an
 * arbitrarily large target rather than none. (The practically reachable
 * accept-anything case was a `NaN`/`Infinity` `targetBits`, whose loop never
 * ran at all; `isU64Safe` now rejects that before we get here.)
 */
function hasLeadingZeroBits(hash: Uint8Array, targetBits: number): boolean {
  if (targetBits > hash.length * 8) return false;
  for (let i = 0; i < targetBits; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    const byte = hash[byteIdx];
    if (byte === undefined) return false; // unreachable given the bound above
    if ((byte & (1 << bitIdx)) !== 0) return false;
  }
  return true;
}

/**
 * Guard the fields `signingHash` (via `postPowPreimage`) reads, so a malformed
 * post cannot throw inside `@dagsocial/types`: a non-array `parentRefs` throws
 * in `.map`, an absent `author`/`challenge` throws on `.length`, an `author`
 * that is not a byte view overruns the preimage buffer, and a symbol in
 * `content` / `parentRefs` / `protocolVersion` / `timestamp` throws in
 * `TextEncoder.encode` / `String()`.
 *
 * The numerics use `isU64Safe`, not a loose `typeof === 'number'`. The loose
 * check admitted `NaN` / `Infinity` / negative / fractional values, which the
 * canonical encoder in `@dagsocial/types` has to absorb by writing an all-ones
 * sentinel to stay panic-free — and two such malformed posts then share an
 * encoding. Rejecting them here instead keeps that sentinel path out of reach
 * for anything that passes this guard, and matches the M-6 integer-guard
 * invariant already applied to `verifyPoW`'s nonce and target bits. No
 * well-formed post is affected: a timestamp is a non-negative safe integer and
 * `protocolVersion` must equal `PROTOCOL_VERSION` to pass Stage 1 at all.
 */
function isSignablePost(post: unknown): post is Post {
  if (!isObject(post)) return false;
  if (typeof post.content !== 'string') return false;
  if (!isBytes(post.author)) return false;
  if (!Array.isArray(post.parentRefs)) return false;
  for (const ref of post.parentRefs) {
    if (typeof ref !== 'string') return false;
  }
  if (!isBytes(post.challenge)) return false;
  if (!isU64Safe(post.protocolVersion)) return false;
  if (!isU64Safe(post.timestamp)) return false;
  return true;
}

/**
 * Guard the declared `BlockHeader` fields before the header is CBOR-encoded —
 * `cbor-x` throws on symbol and function values.
 *
 * Only declared fields are checked. A header carrying an *extra* property that
 * holds a symbol, function, or reference cycle would still throw, but such a
 * header cannot arrive over the wire (CBOR encodes none of those); it can only
 * be built in-process, which is trusted.
 */
function isEncodableHeader(h: unknown): h is BlockHeader {
  if (!isObject(h)) return false;
  if (typeof h.protocolVersion !== 'number') return false;
  if (typeof h.height !== 'number') return false;
  if (typeof h.prevBlockHash !== 'string') return false;
  if (typeof h.subBlockRoot !== 'string') return false;
  if (typeof h.utxoTxRoot !== 'string') return false;
  if (typeof h.stateRoot !== 'string') return false;
  if (!isBytes(h.validatorId)) return false;
  if (typeof h.powNonce !== 'number') return false;
  if (typeof h.powTargetBits !== 'number') return false;
  if (typeof h.createdAt !== 'number') return false;
  return true;
}

// ---------------------------------------------------------------------------
// verifyPoW
// ---------------------------------------------------------------------------

export function verifyPoW(input: Uint8Array, nonce: number, targetBits: number): boolean {
  if (!isBytes(input)) return false;
  if (!isU64Safe(nonce)) return false;
  if (!isU64Safe(targetBits)) return false;
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));
  const buf = Buffer.concat([Buffer.from(input), nonceBuf]);
  const hash = createHash('blake2b512').update(buf).digest().subarray(0, 32);
  return hasLeadingZeroBits(hash, targetBits);
}

// ---------------------------------------------------------------------------
// verifyPostSignature
// ---------------------------------------------------------------------------

export function verifyPostSignature(post: Post, publicKey: Uint8Array): boolean {
  // `createPublicKey` throws ("Failed to read asymmetric key") unless the SPKI
  // envelope carries exactly 32 raw bytes.
  if (!isBytes(publicKey) || publicKey.length !== 32) return false;
  if (!isSignablePost(post)) return false;
  // A wrong-*length* signature is left to `crypto.verify`, which rejects it
  // cleanly; only a non-byte-view throws.
  if (!isBytes(post.signature)) return false;
  const pubDer = wrapSpki(publicKey);
  const pubKeyObj = createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
  const sigBuf = Buffer.from(post.signature);
  return cryptoVerify(null, signingHash(post), pubKeyObj, sigBuf);
}

// ---------------------------------------------------------------------------
// verifyValidatorSignature
// ---------------------------------------------------------------------------

/**
 * Verify that `signature` is a valid raw Ed25519 signature over the block hash,
 * made by the key declared in `header.validatorId`.
 *
 * The signed message is `Buffer.from(blockHash(header), 'hex')` — the 32 raw
 * bytes of `blake2b512(encodeHeader(header))[:32]`, exactly what the block
 * creator signs. `validatorSignature` lives on the block, not in the header, so
 * `blockHash(header)` is stable before and after signing.
 *
 * PoW proves work was spent; it does not prove who spent it. This is the check
 * that binds a block to the holder of `validatorId`'s private key.
 */
export function verifyValidatorSignature(header: BlockHeader, signature: Uint8Array): boolean {
  // `blockHash` runs `encodeHeader(header)`; `isEncodableHeader` guards every
  // field it reads, so a malformed header returns false rather than throwing
  // (same guard style as `verifyOrderingBlockPoW`).
  if (!isEncodableHeader(header)) return false;
  // `createPublicKey` throws unless the SPKI envelope carries exactly 32 raw
  // bytes. `isEncodableHeader` already proved `validatorId` is a byte view.
  if (header.validatorId.length !== 32) return false;
  // A non-byte signature throws in `Buffer.from`; a wrong-*length* signature is
  // left to `crypto.verify`, which rejects it cleanly (as in verifyPostSignature).
  if (!isBytes(signature)) return false;
  const pubKeyObj = ed25519PublicKeyToKeyObject(header.validatorId);
  const message = Buffer.from(blockHash(header), 'hex');
  return cryptoVerify(null, message, pubKeyObj, Buffer.from(signature));
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
  // `Buffer.byteLength` throws on anything that is not a string or byte view.
  if (typeof content !== 'string') return { valid: false, error: 'Content must be a string' };
  const byteLen = Buffer.byteLength(content, 'utf8');
  if (byteLen === 0) return { valid: false, error: 'Content is empty' };
  if (byteLen > MAX_CONTENT_BYTES) return { valid: false, error: 'Content exceeds max length' };
  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifyContentCharacters
// ---------------------------------------------------------------------------

const CONTENT_CHAR_ERROR =
  'Content contains disallowed characters (control, zero-width, or bidi override)';

/**
 * Consensus Stage-1 character policy. Rejects the Unicode control, format,
 * surrogate, and private-use codepoints (`Cc`/`Cf`/`Cs`/`Co`) enumerated at the
 * pinned Unicode version in `content-charset.ts`, with `\n` as the sole
 * exception. Unassigned (`Cn`) codepoints are allowed.
 *
 * Consults only the static table — never a runtime `\p{...}` escape — so the
 * verdict is identical on every node regardless of the Unicode data version its
 * Node/V8 build ships (audit M-4).
 */
export function verifyContentCharacters(content: string): { valid: boolean; error?: string } {
  if (typeof content !== 'string') return { valid: false, error: CONTENT_CHAR_ERROR };
  // Iterating a string yields whole codepoints (and lone surrogates singly),
  // matching the codepoint semantics the previous `u`-flag regex had.
  for (const ch of content) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isDisallowedContentCodepoint(cp)) {
      return { valid: false, error: CONTENT_CHAR_ERROR };
    }
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifyParentRefsCount
// ---------------------------------------------------------------------------

export function verifyParentRefsCount(refs: string[]): { valid: boolean; error?: string } {
  if (!Array.isArray(refs)) return { valid: false, error: 'Parent refs must be an array' };
  if (refs.length > MAX_PARENT_REFS) {
    return { valid: false, error: `Too many parent refs (max ${MAX_PARENT_REFS})` };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifySubBlockStructure
// ---------------------------------------------------------------------------

export function verifySubBlockStructure(sb: SubBlock): { valid: boolean; error?: string } {
  if (!isObject(sb)) return { valid: false, error: 'Sub-block is not an object' };
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
  if (!isObject(tx)) return { valid: false, error: 'Transaction is not an object' };
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
  if (!isObject(block)) return { valid: false, error: 'Ordering block is not an object' };
  const h = block.header;
  if (!h) return { valid: false, error: 'Ordering block missing header' };
  if (!h.prevBlockHash || h.prevBlockHash.length !== 64) {
    return { valid: false, error: 'Ordering block header missing or invalid prevBlockHash' };
  }
  if (!Array.isArray(block.subBlockTree?.subBlockRefs)) {
    return { valid: false, error: 'Ordering block missing subBlockTree.subBlockRefs' };
  }
  if (!Array.isArray(block.subBlockTree.subBlockEntries) ||
      block.subBlockTree.subBlockEntries.length !== block.subBlockTree.subBlockRefs.length) {
    return { valid: false, error: 'Ordering block subBlockEntries must align with subBlockRefs' };
  }
  // Validate each entry
  for (const entry of block.subBlockTree.subBlockEntries) {
    if (!isObject(entry)) {
      return { valid: false, error: 'Ordering block subBlockEntry is not an object' };
    }
    if (typeof entry.postId !== 'string' || entry.postId.length !== 64) {
      return { valid: false, error: 'Ordering block subBlockEntry has invalid postId' };
    }
    if (!Array.isArray(entry.parentRefs) || entry.parentRefs.length > 8) {
      return { valid: false, error: 'Ordering block subBlockEntry has invalid parentRefs' };
    }
    for (const ref of entry.parentRefs) {
      if (typeof ref !== 'string' || ref.length !== 64) {
        return { valid: false, error: 'Ordering block subBlockEntry parentRef must be 64-char hex' };
      }
    }
    // Structure only: `author` is checked for shape here, not truth. Binding it
    // to the real post and to prune authorization is stateful (audit H-3) and
    // lives in @dagsocial/node.
    if (typeof entry.author !== 'string' || entry.author.length !== 64) {
      return { valid: false, error: 'Ordering block subBlockEntry has invalid author' };
    }
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
    if (!isObject(out)) {
      return { valid: false, error: 'Coinbase output is not an object' };
    }
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
// isValidVouchTarget
// ---------------------------------------------------------------------------

/**
 * Validate that a target UserId for a vouch is a well-formed 32-byte
 * Ed25519 public key.  Does NOT check whether the identity exists on-chain
 * — vouching for unknown public keys is allowed.
 */
export function isValidVouchTarget(userId: Uint8Array): boolean {
  if (!(userId instanceof Uint8Array)) return false;
  if (userId.length !== 32) return false;
  let allZero = true;
  for (let i = 0; i < 32; i++) {
    if (userId[i] !== 0) { allZero = false; break; }
  }
  return !allZero;
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
  if (!isEncodableHeader(header)) return false;
  if (!isU64Safe(header.powNonce) || !isU64Safe(header.powTargetBits)) return false;
  const preimage = computePowHash(header);
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(header.powNonce));
  const hash = createHash('blake2b512')
    .update(preimage)
    .update(nonceBuf)
    .digest()
    .subarray(0, 32);
  return hasLeadingZeroBits(hash, header.powTargetBits);
}

// ---------------------------------------------------------------------------
// verifyBlockChainLink
// ---------------------------------------------------------------------------

export function verifyBlockChainLink(
  block: OrderingBlock,
  prevBlock: OrderingBlock,
): boolean {
  if (!isObject(block) || !isObject(prevBlock)) return false;
  if (!isObject(block.header)) return false;
  // `prevBlock.header` is CBOR-encoded by `blockHash`; `block.header` is only
  // read from, so it needs no encodability guard.
  if (!isEncodableHeader(prevBlock.header)) return false;
  return (
    block.header.prevBlockHash === blockHash(prevBlock.header) &&
    block.header.height === prevBlock.header.height + 1
  );
}
