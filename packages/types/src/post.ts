import { createHash } from 'crypto';
import type { UserId } from './identity.js';

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

// ---------------------------------------------------------------------------
// Canonical field encoding (audit M-1)
// ---------------------------------------------------------------------------
//
// The previous preimages concatenated fields with no delimiters, so distinct
// field tuples produced identical bytes: (powNonce=5, timestamp=23) and
// (52, 3) both yielded …"5""23"… == …"52""3"… → the same postId. Every
// variable-length field is now length-prefixed and the ref array carries an
// explicit count, so `postFieldBytes` is injective: no two distinct posts
// share an encoding.
//
// This encoding is protocol-breaking and unversioned. It MUST stay
// byte-identical here and in the demo-UI JS (packages/node/public/index.html);
// the frozen golden vector in the tests is the cross-implementation anchor.

const encoder = new TextEncoder();

/**
 * Domain separator for the post id. Prefixing it makes the id a distinct hash
 * from the PoW hash `blake2b512(postFieldBytes ‖ u64LE(powNonce))`, which
 * otherwise shares the entire tail.
 */
const POST_ID_DOMAIN = encoder.encode('dagsocial/post-id/1');

/**
 * Sentinel written for a numeric field outside the encodable domain.
 *
 * The fixed-width writers below are deliberately *total*: `BigInt()` /
 * `writeBigUInt64LE` throw on NaN, ±Infinity, fractional, and negative input,
 * which would turn a malformed post into a panic inside `signingHash` and
 * break the no-panic contract `@dagsocial/validation` asserts (audit M-5/M-6).
 *
 * An all-ones sentinel is unreachable from a valid field — the encodable
 * domain is the non-negative safe integers (≤ 2^53−1), whose top 11 bits are
 * always zero — so a malformed post can never encode to the same bytes as a
 * well-formed one. Two *malformed* posts can share an encoding; they are
 * rejected upstream on protocol version, PoW, and signature, and tightening
 * `isSignablePost` in `@dagsocial/validation` to `Number.isSafeInteger` would
 * close that residue at its root.
 */
const U32_SENTINEL = 0xffffffff;

/** True for the values `writeU32LE` encodes faithfully. */
function isEncodableU32(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n < U32_SENTINEL;
}

/** True for the values `writeU64LE` encodes faithfully. */
function isEncodableU64(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/** Write `n` as 4-byte little-endian at `off`; returns the next offset. */
function writeU32LE(out: Uint8Array, off: number, n: number): number {
  const v = isEncodableU32(n) ? n : U32_SENTINEL;
  out[off] = v & 0xff;
  out[off + 1] = (v >>> 8) & 0xff;
  out[off + 2] = (v >>> 16) & 0xff;
  out[off + 3] = (v >>> 24) & 0xff;
  return off + 4;
}

/** Write `n` as 8-byte little-endian at `off`; returns the next offset. */
function writeU64LE(out: Uint8Array, off: number, n: number): number {
  if (!isEncodableU64(n)) {
    out.fill(0xff, off, off + 8);
    return off + 8;
  }
  const lo = n >>> 0;
  const hi = Math.floor(n / 0x100000000) >>> 0;
  out[off] = lo & 0xff;
  out[off + 1] = (lo >>> 8) & 0xff;
  out[off + 2] = (lo >>> 16) & 0xff;
  out[off + 3] = (lo >>> 24) & 0xff;
  out[off + 4] = hi & 0xff;
  out[off + 5] = (hi >>> 8) & 0xff;
  out[off + 6] = (hi >>> 16) & 0xff;
  out[off + 7] = (hi >>> 24) & 0xff;
  return off + 8;
}

/** Write `u32LE(byteLength) ‖ bytes` at `off`; returns the next offset. */
function writeLengthPrefixed(out: Uint8Array, off: number, bytes: Uint8Array): number {
  const next = writeU32LE(out, off, bytes.length);
  out.set(bytes, next);
  return next + bytes.length;
}

/** Encode `powNonce` as the trailing 8 bytes of the post-id preimage. */
function powNonceBytes(powNonce: number): Uint8Array {
  const out = new Uint8Array(8);
  writeU64LE(out, 0, powNonce);
  return out;
}

/**
 * The canonical, injective field encoding — `postFieldBytes` in
 * TYPES_INTERFACE.md:
 *
 *   LP(utf8(content)) ‖ LP(author) ‖ u32LE(parentRefs.length)
 *   ‖ LP(utf8(ref))… ‖ LP(challenge) ‖ u32LE(protocolVersion)
 *   ‖ u64LE(timestamp)
 *
 * `powNonce` is excluded — the author signs before mining, and PoW appends the
 * nonce itself. `signature` is excluded from every preimage.
 */
function postFieldBytes(post: Post): Uint8Array {
  const content = encoder.encode(post.content);
  const refs = post.parentRefs.map((r) => encoder.encode(r));

  let total =
    4 + content.length +           // LP(content)
    4 + post.author.length +       // LP(author)
    4 +                            // u32LE(refCount)
    4 + post.challenge.length +    // LP(challenge)
    4 +                            // u32LE(protocolVersion)
    8;                             // u64LE(timestamp)
  for (const ref of refs) total += 4 + ref.length;

  const out = new Uint8Array(total);
  let off = 0;
  off = writeLengthPrefixed(out, off, content);
  off = writeLengthPrefixed(out, off, post.author);
  off = writeU32LE(out, off, refs.length);
  for (const ref of refs) off = writeLengthPrefixed(out, off, ref);
  off = writeLengthPrefixed(out, off, post.challenge);
  off = writeU32LE(out, off, post.protocolVersion);
  off = writeU64LE(out, off, post.timestamp);
  return out;
}

/**
 * Build the deterministic PoW preimage for a post — the canonical
 * `postFieldBytes` encoding above. The miner hashes this against candidate
 * nonces; `signingHash` hashes it unchanged. Excludes powNonce (the miner
 * varies this) and signature (not yet set).
 */
export function postPowPreimage(post: Post): Uint8Array {
  return postFieldBytes(post);
}

/**
 * Hash that the author signs: blake2b512(postFieldBytes(post)) truncated to
 * 32 bytes. Carries no domain tag — these are the exact bytes PoW is solved
 * over. Uses blake2b512 (Node.js v22 lacks blake2b256).
 */
export function signingHash(post: Post): Buffer {
  return createHash('blake2b512')
    .update(postFieldBytes(post))
    .digest()
    .subarray(0, 32);
}

/**
 * Deterministic post ID:
 *   blake2b512(POST_ID_DOMAIN ‖ postFieldBytes(post) ‖ u64LE(powNonce))[0..32]
 *
 * Includes powNonce (excluded from signingHash) and is domain-tagged, so the
 * id is never equal to the PoW hash over the same post.
 */
export function computePostId(post: Post): PostId {
  return createHash('blake2b512')
    .update(POST_ID_DOMAIN)
    .update(postFieldBytes(post))
    .update(powNonceBytes(post.powNonce))
    .digest()
    .subarray(0, 32)
    .toString('hex');
}

/** Verify that a post's computed ID matches an expected ID. */
export function verifyPostId(post: Post, expectedId: string): boolean {
  return computePostId(post) === expectedId;
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
