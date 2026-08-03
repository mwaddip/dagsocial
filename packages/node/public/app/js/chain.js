/**
 * chain.js — everything this UI needs to speak the Notis protocol.
 *
 * Ports the client-side consensus crypto that `public/index.html` (the demo UI)
 * carries inline: the canonical post encoding, PoW, box/tx/post ids, and the
 * transaction builders. The encoding functions below are byte-identical to the
 * demo's and to `@dagsocial/types`; `test/unit/x-ui-crypto-mirror.test.ts` pins
 * them to the same frozen golden vector, so drift fails CI rather than silently
 * producing posts every node rejects.
 *
 * ANY change to `postFieldBytes`, `computePostId`, `computeBoxId` or
 * `computeTxId` must land in `packages/types/src/post.ts` in the same commit.
 *
 * This module is deliberately free of DOM references so it stays testable.
 */
import { blake2b } from './blake2b.js';

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Protocol constants (mirrored from @dagsocial/types constants.ts)
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 1;
export const LIKE_COST = 2;
export const POST_LOCK_THREAD_COST = 5;
export const POST_LOCK_REPLY_COST = 3;
export const INVITE_KARMA_AMOUNT = 25;
export const INVITE_BOND_KARMA = 25;
export const INVITE_PROBATION_BLOCKS = 1000;
export const MAX_CONTENT_BYTES = 300;
export const MAX_PARENT_REFS = 8;

/** 32 zero bytes, hex — the "unclaimed" sentinel for BondBox.inviteePublicKey. */
export const ZERO_32_HEX = '00'.repeat(32);

// ---------------------------------------------------------------------------
// Hex / byte utilities
// ---------------------------------------------------------------------------

export function buf2hex(buf) {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hex2buf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function concatUint8Arrays(arrays) {
  const totalLength = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

/** UTF-8 byte length — the unit `MAX_CONTENT_BYTES` is measured in. */
export function utf8Length(str) {
  return encoder.encode(str).length;
}

// ---------------------------------------------------------------------------
// Canonical post field encoding (audit M-1)
// ---------------------------------------------------------------------------
//
// Byte-identical mirror of postFieldBytes() in @dagsocial/types (src/post.ts).
// See contracts/TYPES_INTERFACE.md → "Canonical field encoding (M-1)".
//
// Every variable-length field is length-prefixed and the ref array carries an
// explicit count, so distinct field tuples cannot collide into one postId.

const POST_ID_DOMAIN = encoder.encode('dagsocial/post-id/1');

/**
 * Sentinel for a numeric field outside the encodable domain. The encoders are
 * total — they never throw — and the encodable domain is the non-negative safe
 * integers, whose top 11 bits are always zero, so no valid value can encode to
 * all-ones.
 */
const U32_SENTINEL = 0xffffffff;

function isEncodableU32(n) {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n < U32_SENTINEL;
}

function isEncodableU64(n) {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/** u32LE(n) — 4-byte little-endian. */
export function encodeU32LE(n) {
  const v = isEncodableU32(n) ? n : U32_SENTINEL;
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}

/** u64LE(n) — 8-byte little-endian. The sole u64 encoder (PoW nonce + fields). */
export function encodeLE64(n) {
  if (!isEncodableU64(n)) return new Uint8Array(8).fill(0xff);
  const lo = n >>> 0;
  const hi = Math.floor(n / 0x100000000) >>> 0;
  return new Uint8Array([
    lo & 0xff, (lo >>> 8) & 0xff, (lo >>> 16) & 0xff, (lo >>> 24) & 0xff,
    hi & 0xff, (hi >>> 8) & 0xff, (hi >>> 16) & 0xff, (hi >>> 24) & 0xff,
  ]);
}

/** LP(bytes) = u32LE(byteLength) ‖ bytes. */
function lengthPrefixed(bytes) {
  return concatUint8Arrays([encodeU32LE(bytes.length), bytes]);
}

/**
 * postFieldBytes — the canonical, injective encoding shared by the signing
 * hash, the PoW preimage, and the post id. Excludes powNonce (the author signs
 * before mining) and signature.
 */
export function postFieldBytes(content, authorBytes, parentRefs, challengeBytes, protocolVersion, timestamp) {
  return concatUint8Arrays([
    lengthPrefixed(encoder.encode(content)),
    lengthPrefixed(authorBytes),
    encodeU32LE(parentRefs.length),
    ...parentRefs.map((r) => lengthPrefixed(encoder.encode(r))),
    lengthPrefixed(challengeBytes),
    encodeU32LE(protocolVersion),
    encodeLE64(timestamp),
  ]);
}

/** blake2b512 truncated to 32 bytes — the project's universal 32-byte digest. */
function hash32(bytes) {
  return blake2b(bytes, null, 64).slice(0, 32);
}

// ---------------------------------------------------------------------------
// CBOR encoder (minimal, matches cbor-x 1.6.4 output for box types)
// ---------------------------------------------------------------------------
//
// cbor-x preserves JavaScript object insertion order for map keys — it does NOT
// sort canonically. We match by encoding keys in the order Object.keys()
// returns them, which is insertion order.

function cborEncodeString(str) {
  const bytes = encoder.encode(str);
  const len = bytes.length;
  if (len <= 23) return concatUint8Arrays([new Uint8Array([0x60 | len]), bytes]);
  if (len <= 255) return concatUint8Arrays([new Uint8Array([0x78, len]), bytes]);
  throw new Error('String too long for CBOR: ' + len);
}

function cborEncodeBytes(buf) {
  const len = buf.length;
  if (len <= 23) return concatUint8Arrays([new Uint8Array([0x40 | len]), buf]);
  if (len <= 255) return concatUint8Arrays([new Uint8Array([0x58, len]), buf]);
  throw new Error('Bytes too long for CBOR: ' + len);
}

function cborEncodeInt(n) {
  if (n >= 0) {
    if (n <= 23) return new Uint8Array([n]);
    if (n <= 255) return new Uint8Array([0x18, n]);
    if (n <= 65535) return new Uint8Array([0x19, (n >> 8) & 0xff, n & 0xff]);
    throw new Error('Number too large for CBOR: ' + n);
  }
  const val = -1 - n;
  if (val <= 23) return new Uint8Array([0x20 | val]);
  if (val <= 255) return new Uint8Array([0x38, val]);
  if (val <= 65535) return new Uint8Array([0x39, (val >> 8) & 0xff, val & 0xff]);
  throw new Error('Number too small for CBOR: ' + n);
}

function cborEncodeUndefined() {
  return new Uint8Array([0xf7]);
}

/** Encode a plain object as a CBOR map. Preserves insertion order. */
function cborEncodeMap(obj) {
  const keys = Object.keys(obj);
  const parts = [];
  for (const k of keys) {
    parts.push(cborEncodeString(k));
    const v = obj[k];
    if (typeof v === 'string') parts.push(cborEncodeString(v));
    else if (typeof v === 'number') parts.push(cborEncodeInt(v));
    else if (typeof v === 'boolean') parts.push(new Uint8Array([v ? 0xf5 : 0xf4]));
    else if (v === undefined || v === null) parts.push(cborEncodeUndefined());
    else if (v instanceof Uint8Array) parts.push(cborEncodeBytes(v));
    else throw new Error('Unsupported CBOR value type for key ' + k);
  }
  const body = concatUint8Arrays(parts);
  const numPairs = keys.length;
  // cbor-x always emits 0xB9 + 2-byte big-endian length for maps
  const header = new Uint8Array([0xb9, (numPairs >> 8) & 0xff, numPairs & 0xff]);
  return concatUint8Arrays([header, body]);
}

export function cborEncode(value) {
  if (typeof value === 'string') return cborEncodeString(value);
  if (typeof value === 'number') return cborEncodeInt(value);
  if (typeof value === 'boolean') return new Uint8Array([value ? 0xf5 : 0xf4]);
  if (value === undefined || value === null) return cborEncodeUndefined();
  if (value instanceof Uint8Array) return cborEncodeBytes(value);
  if (typeof value === 'object') return cborEncodeMap(value);
  throw new Error('Unsupported CBOR type');
}

/** Box fields that are binary on the wire but travel as hex in JSON. */
const BINARY_BOX_FIELDS = ['owner', 'likerId', 'secretHash', 'inviterId', 'inviteePublicKey'];

/** Strip `id` and re-hydrate hex fields to bytes, ready for CBOR. */
function boxForCbor(box) {
  const { id, ...rest } = box;
  const out = {};
  for (const [k, v] of Object.entries(rest)) {
    out[k] = BINARY_BOX_FIELDS.includes(k) && typeof v === 'string' ? hex2buf(v) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** boxId = blake2b512(CBOR(box without `id`))[0..32] — matches server computeBoxId. */
export function computeBoxId(box) {
  return buf2hex(hash32(cborEncode(boxForCbor(box))));
}

/**
 * Deterministic transaction ID — matches server computeTxId.
 * Hashes inputs (hex strings), CBOR-encoded outputs (minus `id`),
 * preimages (sorted by boxId), and protocolVersion.
 */
export function computeTxId(tx) {
  const parts = [];

  // 1. Inputs — hash hex strings as UTF-8 text
  for (const input of tx.inputs) parts.push(encoder.encode(input));

  // 2. Outputs — CBOR encode each box, stripping `id` before encoding
  for (const output of tx.outputs) parts.push(cborEncode(boxForCbor(output)));

  // 3. Preimages (sorted by boxId key, if present)
  if (tx.preimages) {
    for (const boxId of Object.keys(tx.preimages).sort()) {
      parts.push(encoder.encode(boxId));
      const preimage = tx.preimages[boxId];
      parts.push(typeof preimage === 'string' ? hex2buf(preimage) : preimage);
    }
  }

  // 4. Protocol version as UTF-8 string
  parts.push(encoder.encode(String(tx.protocolVersion)));

  return buf2hex(hash32(concatUint8Arrays(parts)));
}

/**
 * postId = blake2b512(POST_ID_DOMAIN ‖ postFieldBytes ‖ u64LE(powNonce))[0..32]
 *
 * Domain-tagged, so the id is never equal to the PoW hash over the same post.
 */
export function computePostId(post) {
  const cBytes = typeof post.challenge === 'string' ? hex2buf(post.challenge) : post.challenge;
  const aBytes = typeof post.author === 'string' ? hex2buf(post.author) : post.author;
  const combined = concatUint8Arrays([
    POST_ID_DOMAIN,
    postFieldBytes(post.content, aBytes, post.parentRefs, cBytes, post.protocolVersion, post.timestamp),
    encodeLE64(post.powNonce),
  ]);
  return buf2hex(hash32(combined));
}

// ---------------------------------------------------------------------------
// Proof of work
// ---------------------------------------------------------------------------

function countLeadingZeroBits(buf) {
  let bits = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      bits += 8;
      continue;
    }
    let mask = 0x80;
    while ((buf[i] & mask) === 0) {
      bits++;
      mask >>= 1;
    }
    break;
  }
  return bits;
}

/** PoW preimage = postFieldBytes; solvePoW appends u64LE(nonce). */
export function buildPowInput(content, authorBytes, parentRefs, challengeBytes, protocolVersion, timestamp) {
  return postFieldBytes(content, authorBytes, parentRefs, challengeBytes, protocolVersion, timestamp);
}

/** Hashes per slice between event-loop yields — roughly 50–100ms of work. */
const POW_SLICE = 20000;

/**
 * Mine until the digest has `targetBits` leading zero bits.
 *
 * The node's default post difficulty is 20 bits — around a million hashes, or
 * several seconds of pure JS. Mining in one synchronous loop would block the
 * main thread for that whole time, so the tab would freeze and the progress
 * text the caller is updating would never actually paint.
 *
 * So this yields to the event loop every `POW_SLICE` hashes. The yields cost a
 * few hundred milliseconds across a full solve, which buys a responsive tab and
 * a progress counter that moves.
 *
 * @param {(progress: string) => void} [onProgress] called once per slice
 * @returns {Promise<number>} the winning nonce
 */
export async function solvePoW(powInput, targetBits, onProgress) {
  let nonce = 0;
  const start = performance.now();

  for (;;) {
    const sliceEnd = nonce + POW_SLICE;
    for (; nonce < sliceEnd; nonce++) {
      const combined = concatUint8Arrays([powInput, encodeLE64(nonce)]);
      if (countLeadingZeroBits(hash32(combined)) >= targetBits) return nonce;
    }

    if (onProgress) {
      const elapsed = (performance.now() - start) / 1000;
      const rate = nonce / Math.max(elapsed, 0.001) / 1000;
      onProgress(`${(nonce / 1000).toFixed(0)}k hashes · ${rate.toFixed(0)}k/s · ${elapsed.toFixed(1)}s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Sign a transaction by its txId. Returns the txId alongside the signature so
 * callers can log/correlate it with what the node computes.
 */
export async function signTxId(tx, privKey) {
  const txId = computeTxId(tx);
  const sig = await crypto.subtle.sign('Ed25519', privKey, hex2buf(txId));
  return { txId, signature: buf2hex(new Uint8Array(sig)) };
}

/** Sign a post over its signing hash (same preimage as PoW, minus the nonce). */
export async function signPost(content, authorBytes, parentRefs, challengeBytes, protocolVersion, timestamp, privKey) {
  const input = buildPowInput(content, authorBytes, parentRefs, challengeBytes, protocolVersion, timestamp);
  const sig = await crypto.subtle.sign('Ed25519', privKey, hash32(input));
  return buf2hex(new Uint8Array(sig));
}

/** Sign a raw challenge — the auth proof for DELETE /posts/:id. */
export async function signChallenge(challengeHex, privKey) {
  const sig = await crypto.subtle.sign('Ed25519', privKey, hash32(hex2buf(challengeHex)));
  return buf2hex(new Uint8Array(sig));
}

// ---------------------------------------------------------------------------
// UTXO selection
// ---------------------------------------------------------------------------

/**
 * Largest-first UTXO selection. Returns boxes whose combined value covers
 * `requiredAmount`. Assumes boxes are sorted value-descending (the server does
 * this). Throws if the total is insufficient.
 */
export function selectBoxes(boxes, requiredAmount) {
  if (requiredAmount <= 0) return [];
  let accumulated = 0;
  const selected = [];
  for (const box of boxes) {
    accumulated += box.value;
    selected.push(box);
    if (accumulated >= requiredAmount) break;
  }
  if (accumulated < requiredAmount) {
    throw new Error(`Insufficient total value: need ${requiredAmount}, have ${accumulated}`);
  }
  return selected;
}

// ---------------------------------------------------------------------------
// Transaction builders
// ---------------------------------------------------------------------------
//
// Every builder returns an unsigned tx: `signatures` is empty and the caller
// fills it via signTxId(). `height` is the node's current block height — on-chain
// time is measured in block height, never wall clock.

/** Karma-lock tx for post creation: karma → karma(change) + PostLockBox. */
export function buildKarmaLockTx(karmaState, lockAmount, targetPostId, pubKeyHex, height) {
  const selected = selectBoxes(karmaState.boxes, lockAmount);
  const selectedTotal = selected.reduce((sum, b) => sum + b.value, 0);

  return {
    inputs: selected.map((b) => b.boxId),
    outputs: [
      {
        boxType: 'karma',
        value: selectedTotal - lockAmount,
        createdAtBlock: height,
        owner: pubKeyHex,
        guard: 'owner_signature',
        proofSource: targetPostId,
        lastTouchBlock: height,
      },
      {
        boxType: 'post_lock',
        value: lockAmount,
        createdAtBlock: height,
        originalValue: lockAmount,
        owner: pubKeyHex,
        targetPostId,
        guard: 'epoch_tally',
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

/** Like tx: karma → karma(change) + LikeBox. */
export function buildLikeTx(karmaState, targetPostId, pubKeyHex, height) {
  const selected = selectBoxes(karmaState.boxes, LIKE_COST);
  const selectedTotal = selected.reduce((sum, b) => sum + b.value, 0);

  return {
    inputs: selected.map((b) => b.boxId),
    outputs: [
      {
        boxType: 'karma',
        value: selectedTotal - LIKE_COST,
        createdAtBlock: height,
        owner: pubKeyHex,
        guard: 'owner_signature',
        proofSource: targetPostId,
        lastTouchBlock: height,
      },
      {
        boxType: 'like',
        value: LIKE_COST,
        createdAtBlock: height,
        likerId: pubKeyHex,
        targetPostId,
        guard: 'epoch_tally',
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

/**
 * Unlike tx: consumes a LikeBox and returns the locked karma in full.
 *
 * The node enforces sum(inputs) == sum(outputs), so the refund must equal the
 * LikeBox value — no "penalty" burn (audit L-6).
 */
export function buildUnlikeTx(likeBoxId, pubKeyHex, height) {
  return {
    inputs: [likeBoxId],
    outputs: [
      {
        boxType: 'karma',
        value: LIKE_COST,
        createdAtBlock: height,
        owner: pubKeyHex,
        guard: 'owner_signature',
        proofSource: 'unlike',
        lastTouchBlock: height,
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

/**
 * Unlike tx for a *free* like: there is no LikeBox to consume, so the tx just
 * re-anchors one karma box at its own value to carry the removal. Re-emitting
 * the aggregate balance would mint karma and is rejected (audit L-6, L-7).
 */
export function buildFreeUnlikeTx(sourceBox, pubKeyHex, height) {
  return {
    inputs: [sourceBox.boxId],
    outputs: [
      {
        boxType: 'karma',
        value: sourceBox.value,
        createdAtBlock: height,
        owner: pubKeyHex,
        guard: 'owner_signature',
        proofSource: 'unlike-free',
        lastTouchBlock: height,
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

/** Credit transfer: credit boxes → recipient credit + change. */
export function buildCreditTransferTx(creditState, recipientHex, amount, pubKeyHex, height) {
  const unlocked = creditState.boxes.filter(
    (b) => !b.lockedUntilBlock || b.lockedUntilBlock <= height,
  );
  const selected = selectBoxes(unlocked, amount);
  const change = selected.reduce((sum, b) => sum + b.value, 0) - amount;

  const outputs = [
    {
      boxType: 'credit',
      value: amount,
      createdAtBlock: height,
      owner: recipientHex,
      guard: 'owner_signature',
      proofSource: -1,
    },
  ];
  if (change > 0) {
    outputs.push({
      boxType: 'credit',
      value: change,
      createdAtBlock: height,
      owner: pubKeyHex,
      guard: 'owner_signature',
      proofSource: -1,
    });
  }

  return { inputs: selected.map((b) => b.boxId), outputs, signatures: {}, protocolVersion: PROTOCOL_VERSION };
}

/** Invite creation: karma → karma(change) + InviteBox + BondBox. */
export function buildCreateInviteTx(karmaState, pubKeyHex, secretHashHex, height) {
  const totalDeducted = INVITE_KARMA_AMOUNT + INVITE_BOND_KARMA;
  const selected = selectBoxes(karmaState.boxes, totalDeducted);
  const selectedTotal = selected.reduce((sum, b) => sum + b.value, 0);

  const karmaOutput = {
    boxType: 'karma',
    value: selectedTotal - totalDeducted,
    createdAtBlock: height,
    owner: pubKeyHex,
    guard: 'owner_signature',
    proofSource: 'invite-create',
    lastTouchBlock: height,
  };

  const inviteOutput = {
    boxType: 'invite',
    value: INVITE_KARMA_AMOUNT,
    createdAtBlock: height,
    secretHash: secretHashHex,
    inviterId: pubKeyHex,
    guard: 'hash_preimage_with_bond',
  };
  inviteOutput.id = computeBoxId(inviteOutput);

  const bondOutput = {
    boxType: 'bond',
    value: INVITE_BOND_KARMA,
    createdAtBlock: height,
    inviterId: pubKeyHex,
    inviteBoxId: inviteOutput.id,
    inviteePublicKey: ZERO_32_HEX, // 32 zero bytes = unclaimed
    probationStartBlock: 0,
    probationEndBlock: 0,
    guard: 'bond_dual',
  };

  return {
    inputs: selected.map((b) => b.boxId),
    outputs: [karmaOutput, inviteOutput, bondOutput],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

/**
 * Redeem step 1 — commit: BondBox(unclaimed) → BondBox(committed). The preimage
 * proves knowledge of the secret without publishing it on-chain yet.
 */
export function buildCommitTx(bondBox, inviteePubKeyHex, secretHex, height) {
  return {
    inputs: [bondBox.id],
    outputs: [
      {
        boxType: 'bond',
        value: bondBox.value,
        createdAtBlock: height,
        inviterId: bondBox.inviterId,
        inviteBoxId: bondBox.inviteBoxId,
        inviteePublicKey: inviteePubKeyHex,
        probationStartBlock: height,
        probationEndBlock: height + INVITE_PROBATION_BLOCKS,
        guard: 'bond_dual',
      },
    ],
    signatures: {},
    preimages: { [bondBox.id]: secretHex },
    protocolVersion: PROTOCOL_VERSION,
  };
}

/** Redeem step 2 — reveal: invite + bond → karma(invitee) + bond(claimed). */
export function buildClaimInviteTx(inviteBox, bondBox, inviteePubKeyHex, secretHex, height) {
  return {
    inputs: [inviteBox.id, bondBox.id],
    outputs: [
      {
        boxType: 'karma',
        value: inviteBox.value,
        createdAtBlock: height,
        owner: inviteePubKeyHex,
        guard: 'owner_signature',
        proofSource: inviteBox.id,
        lastTouchBlock: height,
      },
      {
        boxType: 'bond',
        value: bondBox.value,
        createdAtBlock: height,
        inviterId: inviteBox.inviterId,
        inviteBoxId: bondBox.inviteBoxId || '',
        inviteePublicKey: inviteePubKeyHex,
        probationStartBlock: bondBox.probationStartBlock,
        probationEndBlock: bondBox.probationEndBlock,
        guard: 'bond_dual',
      },
    ],
    signatures: {},
    preimages: { [inviteBox.id]: secretHex },
    protocolVersion: PROTOCOL_VERSION,
  };
}

/** Invite cancel: karma + invite + bond → karma (full refund to the inviter). */
export function buildCancelInviteTx(karmaState, inviteBox, bondBox, pubKeyHex, height) {
  return {
    inputs: [...karmaState.boxes.map((b) => b.boxId), inviteBox.id, bondBox.id],
    outputs: [
      {
        boxType: 'karma',
        value: karmaState.total + inviteBox.value + bondBox.value,
        createdAtBlock: height,
        owner: pubKeyHex,
        guard: 'owner_signature',
        proofSource: 'invite-cancel',
        lastTouchBlock: height,
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

/** Hash a 32-byte invite secret into the `secretHash` an InviteBox commits to. */
export function hashInviteSecret(secretBytes) {
  return buf2hex(hash32(secretBytes));
}
