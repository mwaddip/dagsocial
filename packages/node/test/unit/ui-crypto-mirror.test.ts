/**
 * TS ↔ JS mirror: the demo UI must encode posts byte-identically to
 * `@dagsocial/types` (audit M-1).
 *
 * The demo UI (`public/index.html`) mines PoW, signs, and computes post ids in
 * the browser; the node verifies all three. If the two encodings drift, every
 * post minted from the UI is rejected — and no unit test in either package
 * would notice, because neither exercises the other's code.
 *
 * This test closes that gap without a browser: it reads `index.html`, extracts
 * the actual crypto declarations from it, evaluates them, and asserts they
 * reproduce the golden vector frozen in the types tests.
 *
 * The UI's `blake2b` comes from the `blakejs` CDN module, which is not
 * installed here, so it is injected as a Node `blake2b512` shim. Both are plain
 * BLAKE2b-512 — the equivalence the project already relies on (see CLAUDE.md,
 * "Platform constraint"). What this test pins is the *encoding*, which is where
 * the two implementations can actually diverge.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  computePostId, signingHash, postPowPreimage, computeBoxId, computeTxId,
  computeCandidateBoxId, canonicalBoxBytes,
} from '@dagsocial/types';
import type {
  CandidateOf,
  Post, KarmaBox, CreditBox, InviteBox, BondBox, PostLockBox, VouchBox,
  AnyBox, UtxoTransaction,
} from '@dagsocial/types';

const INDEX_HTML = fileURLToPath(new URL('../../public/index.html', import.meta.url));

// ---------------------------------------------------------------------------
// Golden vector — must stay identical to packages/types/test/post.test.ts
// ---------------------------------------------------------------------------

const GOLDEN_AUTHOR = new Uint8Array(32);
for (let i = 0; i < 32; i++) GOLDEN_AUTHOR[i] = i;
const GOLDEN_CHALLENGE = new Uint8Array(32);
for (let i = 0; i < 32; i++) GOLDEN_CHALLENGE[i] = 0x20 + i;

const GOLDEN_POST: Post = {
  content: 'dagsocial golden vector ✓',
  author: GOLDEN_AUTHOR,
  parentRefs: [
    '1111111111111111111111111111111111111111111111111111111111111111',
    '2222222222222222222222222222222222222222222222222222222222222222',
  ],
  challenge: GOLDEN_CHALLENGE,
  powNonce: 4294967296,
  protocolVersion: 1,
  timestamp: 1767225600000,
  signature: new Uint8Array(64).fill(0xcd),
};

const GOLDEN_SIGNING_HASH =
  '24157bd74276c86556b41ce0402f8ef9ba4850fc086519c838eb77300ce681d0';
const GOLDEN_POST_ID =
  '0150b9bf676c88c715f0b1fbdf142f8bd0ccf7bb8769e2059488d6c300b6b08f';

// ---------------------------------------------------------------------------
// Golden box vectors — must stay identical to packages/types/test/utxo.test.ts
// (Spec B P0: bigint `value` → CBOR uint64, number fields → minimal-int)
// ---------------------------------------------------------------------------

const GOLDEN_KARMA_CANDIDATE: CandidateOf<KarmaBox> = {
  boxType: 'karma',
  value: 100n,
  owner: GOLDEN_AUTHOR,
  guard: 'owner_signature',
  proofSource: 'genesis',
};

const GOLDEN_CREDIT_CANDIDATE: CandidateOf<CreditBox> = {
  boxType: 'credit',
  value: 123456789n * 10n ** 8n,  // 12_345_678_900_000_000 > 2^53 — the range P0 exists for
  owner: GOLDEN_AUTHOR,
  guard: 'owner_signature',
  proofSource: 70000,             // > 65536 — locks the wide-int encoding path (L-5)
};

const GOLDEN_UTXO_TX: UtxoTransaction = {
  inputs: ['1111111111111111111111111111111111111111111111111111111111111111'],
  outputs: [GOLDEN_KARMA_CANDIDATE, GOLDEN_CREDIT_CANDIDATE],
  signatures: {},
  protocolVersion: 1,
};

const GOLDEN_KARMA_BOX_ID =
  '778a084f4d14df3118b1598cc9cdaac603d18412beb2de56d0290200e30c4622';
const GOLDEN_CREDIT_BOX_ID =
  '14e4bdb5a820ddbc7c8f8e99d6bdac69fa5b5935b576949fbab53bae5323bc9d';
const GOLDEN_UTXO_TX_ID =
  '43d122fc103ffb4931710add70c900ee14e0684de9a4b02eadb8a0ea437e47a0';

/** The candidates as block application materializes them out of GOLDEN_UTXO_TX. */
const GOLDEN_KARMA_BOX: KarmaBox =
  { ...GOLDEN_KARMA_CANDIDATE, txId: GOLDEN_UTXO_TX_ID, index: 0 };
const GOLDEN_CREDIT_BOX: CreditBox =
  { ...GOLDEN_CREDIT_CANDIDATE, txId: GOLDEN_UTXO_TX_ID, index: 1 };

// ---------------------------------------------------------------------------
// Spec G provenance vectors — LIVE as of phase G3b.
//
// The provenance is the real one for these boxes: GOLDEN_UTXO_TX creates the
// karma box at index 0 and the credit box at index 1. Values measured from
// `computeCandidateBoxId` in @dagsocial/types, so both implementations are
// pinned to a constant rather than only to each other.
//
// `GOLDEN_KARMA_CANDIDATE_ID` now equals `GOLDEN_KARMA_BOX_ID` above, and that
// is the phase's whole point rather than a copy-paste slip: `computeBoxId` IS
// `computeCandidateBoxId` applied to the box's own provenance, so the "legacy"
// and "candidate" ids collapsed into one derivation on both sides.
// ---------------------------------------------------------------------------

const GOLDEN_KARMA_CANDIDATE_ID =            // (GOLDEN_UTXO_TX_ID, index 0)
  '778a084f4d14df3118b1598cc9cdaac603d18412beb2de56d0290200e30c4622';
const GOLDEN_CREDIT_CANDIDATE_ID =           // (GOLDEN_UTXO_TX_ID, index 1)
  '14e4bdb5a820ddbc7c8f8e99d6bdac69fa5b5935b576949fbab53bae5323bc9d';
const GOLDEN_KARMA_CANDIDATE_ID_WIDE_INDEX = // index 0x12345678 — endianness-visible
  '9a61d4abc3ddd0684b2873b56ebcf77530853c0ec53817450f1fde678342310f';
const GOLDEN_KARMA_CANDIDATE_ID_SENTINEL =   // any index outside [0, 2³²−1)
  '6f86b05beaf09ce7cfc61add7ff3979fd4ced08527287786ebeef33b95419efb';

// ---------------------------------------------------------------------------
// One fixture per box type (Spec G phase E3)
//
// Both mirror blocks encoded karma and credit only, which is how a missing
// `binaryFields` entry survived on `VouchBox`: with no vouch box ever encoded
// through both implementations, nothing could observe that the UI wrote
// `voucherId` as CBOR text where the node writes a byte string. Same shape as
// phase C §4.2 — B3 round-tripped only a karma box, so an in-range tag at 0x03
// could not collide with karma at 0x01.
//
// Every type is now encoded through both implementations in both forms, so the
// next omission fails here instead of needing review to catch.
//
// Field order matches what the UI's tx builders emit — key order is
// consensus-visible (NODE_INTERFACE 1b), not a stylistic choice. Distinct fill
// bytes per field so a transposition is visible too.
// ---------------------------------------------------------------------------

const BYTES_SECRET = new Uint8Array(32).fill(0xa1);
const BYTES_INVITEE = new Uint8Array(32).fill(0xb2);
const BYTES_TARGET = new Uint8Array(32).fill(0xc3);

const GOLDEN_INVITE_BOX: InviteBox = {
  boxType: 'invite', value: 10n, 
  secretHash: BYTES_SECRET, inviterId: GOLDEN_AUTHOR, guard: 'hash_preimage_with_bond',
};

const GOLDEN_BOND_BOX: BondBox = {
  boxType: 'bond', value: 5n, 
  inviterId: GOLDEN_AUTHOR,
  // Was `inviteBoxId: BoxId` — hex text, deliberately not a binary field. Now a
  // plain integer (user decision, 2026-08-06), so this fixture no longer covers
  // the "hex-string field that must NOT be treated as binary" case. `BondBox`
  // has no such field left; `targetPostId` on post_lock still does, and
  // `ALL_BOX_TYPES` runs every type through both encoders, so the case is still
  // exercised — just not here.
  inviteOutputIndex: 1,
  inviteePublicKey: BYTES_INVITEE,
  probationStartBlock: 0, probationEndBlock: 0, guard: 'bond_dual',
};

const GOLDEN_POST_LOCK_BOX: PostLockBox = {
  boxType: 'post_lock', value: 8n, 
  originalValue: 10n, owner: GOLDEN_AUTHOR, targetPostId: GOLDEN_POST_ID,
  guard: 'block_apply',
};

const GOLDEN_VOUCH_BOX: VouchBox = {
  boxType: 'vouch', value: 1n, 
  voucherId: GOLDEN_AUTHOR, targetId: BYTES_TARGET, guard: 'owner_signature',
};

const ALL_BOX_TYPES: ReadonlyArray<{ name: string; box: AnyBox }> = [
  { name: 'karma', box: GOLDEN_KARMA_BOX },
  { name: 'credit', box: GOLDEN_CREDIT_BOX },
  { name: 'invite', box: GOLDEN_INVITE_BOX },
  { name: 'bond', box: GOLDEN_BOND_BOX },
  { name: 'post_lock', box: GOLDEN_POST_LOCK_BOX },
  { name: 'vouch', box: GOLDEN_VOUCH_BOX },
];

/**
 * The tx-builder form of a box: every `Uint8Array` field as a hex string, which
 * is how the UI's builders carry keys (`pubKeyHex`, `secretHashHex`).
 *
 * Derived mechanically rather than hand-written, so a `Uint8Array` field added
 * to any box type is covered here without anyone remembering to update a
 * fixture — which is the failure this whole block exists to prevent.
 */
function toUiForm(box: AnyBox): Record<string, unknown> {
  return Object.fromEntries(Object.entries(box).map(
    ([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v],
  ));
}

// ---------------------------------------------------------------------------
// Extract the UI's crypto declarations from index.html
// ---------------------------------------------------------------------------

/**
 * Return the source of a top-level declaration, brace-matched from its header.
 *
 * Skips braces inside string literals and comments so a future comment or
 * string containing `{`/`}` cannot truncate the slice.
 */
function extractDeclaration(src: string, header: string): string {
  const start = src.indexOf(header);
  if (start === -1) throw new Error(`index.html no longer declares: ${header}`);

  const open = src.indexOf('{', start);
  if (open === -1) throw new Error(`no body found for: ${header}`);

  let depth = 0;
  let quote: string | null = null;
  let comment: 'line' | 'block' | null = null;

  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    if (comment === 'line') {
      if (ch === '\n') comment = null;
      continue;
    }
    if (comment === 'block') {
      if (ch === '*' && next === '/') { comment = null; i++; }
      continue;
    }
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { comment = 'line'; i++; continue; }
    if (ch === '/' && next === '*') { comment = 'block'; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated body for: ${header}`);
}

/** Return a single-line `const NAME = …;` declaration. */
function extractConst(src: string, name: string): string {
  const header = `const ${name} =`;
  const start = src.indexOf(header);
  if (start === -1) throw new Error(`index.html no longer declares: ${header}`);
  const end = src.indexOf('\n', start);
  return src.slice(start, end === -1 ? undefined : end);
}

interface UiCrypto {
  postFieldBytes: (
    content: string, author: Uint8Array, parentRefs: string[],
    challenge: Uint8Array, protocolVersion: number, timestamp: number,
  ) => Uint8Array;
  buildPowInput: UiCrypto['postFieldBytes'];
  computePostId: (post: Record<string, unknown>) => string;
  encodeLE64: (n: number) => Uint8Array;
  encodeU32LE: (n: number) => Uint8Array;
  cborEncode: (value: unknown) => Uint8Array;
  cborEncodeInt: (n: number) => Uint8Array;
  cborEncodeBigInt: (v: bigint) => Uint8Array;
  cborEncodeString: (str: string) => Uint8Array;
  cborEncodeBytes: (buf: Uint8Array) => Uint8Array;
  canonicalBoxBytes: (box: Record<string, unknown>) => Uint8Array;
  computeBoxId: (box: Record<string, unknown>) => string;
  computeTxId: (tx: Record<string, unknown>) => string;
  u32BE: (n: number) => Uint8Array;
  computeCandidateBoxId: (
    candidate: Record<string, unknown>, txId: string, index: number,
  ) => string;
}

/**
 * `blakejs`-compatible shim over Node's blake2b512. Asserts the UI still calls
 * it the documented way — an unkeyed 64-byte digest.
 */
function blake2bShim(data: Uint8Array, key: null, outlen: number): Uint8Array {
  if (key !== null) throw new Error('UI passed a key to blake2b; mirror assumes unkeyed');
  if (outlen !== 64) throw new Error(`UI requested a ${outlen}-byte digest; mirror assumes 64`);
  return new Uint8Array(createHash('blake2b512').update(data).digest());
}

function loadUiCrypto(): UiCrypto {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const source = [
    'const encoder = new TextEncoder();',
    extractConst(html, 'POST_ID_DOMAIN'),
    extractConst(html, 'BOX_ID_DOMAIN'),
    extractConst(html, 'TX_ID_DOMAIN'),
    extractConst(html, 'U32_SENTINEL'),
    extractDeclaration(html, 'function buf2hex('),
    extractDeclaration(html, 'function hex2buf('),
    extractDeclaration(html, 'function concatUint8Arrays('),
    extractDeclaration(html, 'function isEncodableU32('),
    extractDeclaration(html, 'function isEncodableU64('),
    extractDeclaration(html, 'function encodeU32LE('),
    extractDeclaration(html, 'function encodeLE64('),
    extractDeclaration(html, 'function u32BE('),
    extractDeclaration(html, 'function lengthPrefixed('),
    extractDeclaration(html, 'function postFieldBytes('),
    extractDeclaration(html, 'function buildPowInput('),
    extractDeclaration(html, 'function computePostId('),
    // The box/tx encoding mirror (Spec B P0): the UI's CBOR encoder and the
    // box/tx id functions built on it.
    extractDeclaration(html, 'function cborHead('),
    extractDeclaration(html, 'function cborEncodeString('),
    extractDeclaration(html, 'function cborEncodeBytes('),
    extractDeclaration(html, 'function cborEncodeInt('),
    extractDeclaration(html, 'function cborEncodeBigInt('),
    extractDeclaration(html, 'function cborEncodeUndefined('),
    extractDeclaration(html, 'function cborEncodeMap('),
    extractDeclaration(html, 'function cborEncode('),
    // Spec G phase E: the one strip rule, and the derivation phase G switches to.
    extractDeclaration(html, 'function canonicalBoxBytes('),
    extractDeclaration(html, 'function computeBoxId('),
    extractDeclaration(html, 'function computeCandidateBoxId('),
    extractDeclaration(html, 'function computeTxId('),
    'return { postFieldBytes, buildPowInput, computePostId, encodeLE64, encodeU32LE,\n' +
    '         cborEncode, cborEncodeInt, cborEncodeBigInt, cborEncodeString,\n' +
    '         cborEncodeBytes, canonicalBoxBytes,\n' +
    '         computeBoxId, computeTxId, u32BE, computeCandidateBoxId };',
  ].join('\n\n');

  return new Function('blake2b', source)(blake2bShim) as UiCrypto;
}

const ui = loadUiCrypto();

/** What the UI's signPost() hashes: blake2b(buildSignHashInput(...)).slice(0,32). */
function uiSigningHash(post: Post): string {
  const input = ui.buildPowInput(
    post.content, post.author, post.parentRefs,
    post.challenge, post.protocolVersion, post.timestamp,
  );
  return Buffer.from(blake2bShim(input, null, 64).slice(0, 32)).toString('hex');
}

// ---------------------------------------------------------------------------

describe('demo UI ↔ @dagsocial/types encoding mirror (M-1)', () => {
  it('the UI reproduces the frozen golden signingHash', () => {
    expect(uiSigningHash(GOLDEN_POST)).toBe(GOLDEN_SIGNING_HASH);
  });

  it('the UI reproduces the frozen golden postId', () => {
    expect(ui.computePostId(GOLDEN_POST as unknown as Record<string, unknown>))
      .toBe(GOLDEN_POST_ID);
  });

  it('types reproduces the same frozen golden vector', () => {
    // Pins both live implementations to the constants, not just to each other.
    expect(signingHash(GOLDEN_POST).toString('hex')).toBe(GOLDEN_SIGNING_HASH);
    expect(computePostId(GOLDEN_POST)).toBe(GOLDEN_POST_ID);
  });

  it('the UI PoW preimage is byte-identical to postPowPreimage', () => {
    const uiBytes = ui.buildPowInput(
      GOLDEN_POST.content, GOLDEN_POST.author, GOLDEN_POST.parentRefs,
      GOLDEN_POST.challenge, GOLDEN_POST.protocolVersion, GOLDEN_POST.timestamp,
    );
    expect(Buffer.from(uiBytes).toString('hex'))
      .toBe(Buffer.from(postPowPreimage(GOLDEN_POST)).toString('hex'));
  });

  it('the UI accepts a hex-string author and challenge identically', () => {
    // The posting flow passes hex strings straight from the API response.
    const hexPost = {
      ...GOLDEN_POST,
      author: Buffer.from(GOLDEN_POST.author).toString('hex'),
      challenge: Buffer.from(GOLDEN_POST.challenge).toString('hex'),
    };
    expect(ui.computePostId(hexPost as unknown as Record<string, unknown>))
      .toBe(GOLDEN_POST_ID);
  });

  it('both implementations agree across a spread of posts', () => {
    const variants: Post[] = [
      { ...GOLDEN_POST, content: 'a', parentRefs: [] },
      { ...GOLDEN_POST, content: '', parentRefs: [''] },
      { ...GOLDEN_POST, content: '🙂 multi-byte ✓ ünïcode', parentRefs: ['ab', 'cd'] },
      { ...GOLDEN_POST, powNonce: 0, timestamp: 0 },
      { ...GOLDEN_POST, powNonce: Number.MAX_SAFE_INTEGER, timestamp: Number.MAX_SAFE_INTEGER },
      { ...GOLDEN_POST, parentRefs: Array.from({ length: 8 }, (_, i) => String(i).repeat(64)) },
    ];
    for (const v of variants) {
      expect(ui.computePostId(v as unknown as Record<string, unknown>)).toBe(computePostId(v));
      expect(uiSigningHash(v)).toBe(signingHash(v).toString('hex'));
    }
  });

  it('the M-1 collision pair is distinct in the UI too', () => {
    const a = { ...GOLDEN_POST, powNonce: 5, timestamp: 23 };
    const b = { ...GOLDEN_POST, powNonce: 52, timestamp: 3 };
    const idA = ui.computePostId(a as unknown as Record<string, unknown>);
    const idB = ui.computePostId(b as unknown as Record<string, unknown>);
    expect(idA).not.toBe(idB);
    expect(idA).toBe(computePostId(a));
    expect(idB).toBe(computePostId(b));
  });

  it('the UI fixed-width encoders match the TS ones bit for bit', () => {
    const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');
    expect(hexOf(ui.encodeU32LE(0))).toBe('00000000');
    expect(hexOf(ui.encodeU32LE(1))).toBe('01000000');
    expect(hexOf(ui.encodeU32LE(0x12345678))).toBe('78563412');
    expect(hexOf(ui.encodeLE64(0))).toBe('0000000000000000');
    expect(hexOf(ui.encodeLE64(2 ** 32))).toBe('0000000001000000');
    expect(hexOf(ui.encodeLE64(1767225600000))).toBe('00a8da769b010000');
    // Out-of-domain values normalize to the sentinel rather than throwing.
    for (const bad of [NaN, Infinity, -1, 1.5]) {
      expect(hexOf(ui.encodeLE64(bad))).toBe('ffffffffffffffff');
      expect(hexOf(ui.encodeU32LE(bad))).toBe('ffffffff');
    }
  });
});

// ---------------------------------------------------------------------------

/**
 * Box-value mirror (Spec B P0): the UI's hand-rolled CBOR encoder must emit
 * bigint `value` as CBOR uint64 (0x1b + 8-byte BE) and `number` fields as
 * minimal-int, byte-identical to cbor-x in `@dagsocial/types` — otherwise
 * every client-built box id (and every signed txId) diverges from the node.
 */
describe('demo UI ↔ @dagsocial/types box-value encoding mirror (Spec B P0)', () => {
  const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');

  it('the UI reproduces the frozen golden karma boxId', () => {
    expect(ui.computeBoxId(GOLDEN_KARMA_BOX as unknown as Record<string, unknown>))
      .toBe(GOLDEN_KARMA_BOX_ID);
  });

  it('the UI reproduces the frozen golden credit boxId (value > 2^53)', () => {
    expect(ui.computeBoxId(GOLDEN_CREDIT_BOX as unknown as Record<string, unknown>))
      .toBe(GOLDEN_CREDIT_BOX_ID);
  });

  it('types reproduces the same frozen golden box vectors', () => {
    // Pins both live implementations to the constants, not just to each other.
    expect(computeBoxId(GOLDEN_KARMA_BOX)).toBe(GOLDEN_KARMA_BOX_ID);
    expect(computeBoxId(GOLDEN_CREDIT_BOX)).toBe(GOLDEN_CREDIT_BOX_ID);
  });

  it('the UI accepts hex-string binary fields identically (the tx-builder form)', () => {
    // The UI's tx builders pass `owner` as a hex string straight from state.
    const hexBox = { ...GOLDEN_KARMA_BOX, owner: Buffer.from(GOLDEN_AUTHOR).toString('hex') };
    expect(ui.computeBoxId(hexBox as unknown as Record<string, unknown>))
      .toBe(GOLDEN_KARMA_BOX_ID);
  });

  it.each(ALL_BOX_TYPES)(
    '$name: the tx-builder hex form encodes identically to the byte form (E3)',
    ({ box }) => {
      // The form that catches a missing `binaryFields` entry. With the field
      // absent from the list the UI writes CBOR text (0x78 + 64 ASCII bytes)
      // where the node writes a byte string (0x58 + 32 raw), and every id
      // derived from that box diverges — while both sides' own tests still pass.
      expect(hexOf(ui.canonicalBoxBytes(toUiForm(box)))).toBe(hexOf(canonicalBoxBytes(box)));
      expect(ui.computeBoxId(toUiForm(box))).toBe(computeBoxId(box));
      // And the byte form, which is what a server-returned box carries.
      expect(hexOf(ui.canonicalBoxBytes(box as unknown as Record<string, unknown>)))
        .toBe(hexOf(canonicalBoxBytes(box)));
    },
  );

  it('the UI reproduces the frozen golden txId (what signTxId signs)', () => {
    expect(ui.computeTxId(GOLDEN_UTXO_TX as unknown as Record<string, unknown>))
      .toBe(GOLDEN_UTXO_TX_ID);
    expect(computeTxId(GOLDEN_UTXO_TX)).toBe(GOLDEN_UTXO_TX_ID);
  });

  it('bigint value serializes as 0x1b uint64; number fields stay minimal-int', () => {
    const karmaHex = hexOf(ui.cborEncode(GOLDEN_KARMA_BOX));
    const creditHex = hexOf(ui.cborEncode(GOLDEN_CREDIT_BOX));
    // value 100n → 1b + u64BE(100); value 12345678900000000n → 1b + u64BE
    expect(karmaHex).toContain('1b0000000000000064');
    expect(creditHex).toContain('1b002bdc545d587500');
    // A number field above 65536 stays minimal-int (uint32 form 1a00011170, not
    // the 1b… uint64 form `value` uses). Asserted on the credit box:
    // `proofSource` carries this pin since phase G3b deleted `createdAtBlock`,
    // after which a karma box's canonical bytes hold no number field at all.
    expect(creditHex).toContain('1a00011170');
    expect(creditHex).not.toContain('1b0000000000011170');
  });

  it('cborEncodeInt matches cbor-x across the full number range (L-5)', () => {
    // Byte forms measured against cbor-x 1.6.4 with the computeBoxId encoder
    // config. Note the float64 (0xfb) forms past ±2^32: cbor-x never emits
    // 0x1b uint64 for a JS number — that form is exclusively the bigint path.
    const cases: Array<[number, string]> = [
      [0, '00'], [23, '17'], [24, '1818'], [255, '18ff'],
      [256, '190100'], [65535, '19ffff'],
      [65536, '1a00010000'], [70000, '1a00011170'], [4294967295, '1affffffff'],
      [4294967296, 'fb41f0000000000000'],
      [Number.MAX_SAFE_INTEGER, 'fb433fffffffffffff'],
      [-1, '20'], [-24, '37'], [-25, '3818'], [-70000, '3a0001116f'],
      [-4294967296, '3affffffff'],
      [-4294967297, 'fbc1f0000000100000'],
      [-Number.MAX_SAFE_INTEGER, 'fbc33fffffffffffff'],
    ];
    for (const [n, hex] of cases) expect(hexOf(ui.cborEncodeInt(n)), `n=${n}`).toBe(hex);
    // Non-integers are a UI bug, not an encodable value.
    expect(() => ui.cborEncodeInt(1.5)).toThrow();
    expect(() => ui.cborEncodeInt(NaN)).toThrow();
  });

  /**
   * L-5's other half. `cborEncodeInt` was widened to the full range in Spec B
   * P0; the byte/text encoders still capped their length prefix at 255 and threw
   * beyond. Unreachable today — every box string field is a 64-char hex at most,
   * every byte field is 32, and post content never goes through this encoder —
   * so these pin a foot-gun shut rather than fixing a live divergence.
   */
  const headOf = (b: Uint8Array, n: number): string => Buffer.from(b.subarray(0, n)).toString('hex');

  it('cborEncodeBytes follows the cbor-x length ladder past the old 255 cap (L-5)', () => {
    expect(headOf(ui.cborEncodeBytes(new Uint8Array(0)), 1)).toBe('40');
    expect(headOf(ui.cborEncodeBytes(new Uint8Array(23)), 1)).toBe('57');
    expect(headOf(ui.cborEncodeBytes(new Uint8Array(24)), 2)).toBe('5818');
    expect(headOf(ui.cborEncodeBytes(new Uint8Array(255)), 2)).toBe('58ff');    // the old cap
    expect(headOf(ui.cborEncodeBytes(new Uint8Array(256)), 3)).toBe('590100');  // used to throw
    expect(headOf(ui.cborEncodeBytes(new Uint8Array(65535)), 3)).toBe('59ffff');
    expect(headOf(ui.cborEncodeBytes(new Uint8Array(65536)), 5)).toBe('5a00010000');
    // Definite length, never chunked: header + payload and nothing else.
    expect(ui.cborEncodeBytes(new Uint8Array(65536)).length).toBe(5 + 65536);
  });

  it('cborEncodeString follows the same ladder, counting UTF-8 bytes', () => {
    expect(headOf(ui.cborEncodeString(''), 1)).toBe('60');
    expect(headOf(ui.cborEncodeString('a'.repeat(23)), 1)).toBe('77');
    expect(headOf(ui.cborEncodeString('a'.repeat(24)), 2)).toBe('7818');
    expect(headOf(ui.cborEncodeString('a'.repeat(255)), 2)).toBe('78ff');    // the old cap
    expect(headOf(ui.cborEncodeString('a'.repeat(256)), 3)).toBe('790100');  // used to throw
    expect(headOf(ui.cborEncodeString('a'.repeat(65535)), 3)).toBe('79ffff');
    expect(headOf(ui.cborEncodeString('a'.repeat(65536)), 5)).toBe('7a00010000');
    // 200 × U+2713 is 200 characters but 600 bytes — the prefix counts bytes.
    expect(headOf(ui.cborEncodeString('✓'.repeat(200)), 3)).toBe('790258');
    expect(ui.cborEncodeString('✓'.repeat(200)).length).toBe(3 + 600);
  });

  it('an over-cap field still encodes byte-identically to cbor-x', () => {
    // The ladder measured against the real encoder rather than against itself,
    // at each rung and either side of the old cap.
    for (const len of [255, 256, 65535, 65536]) {
      const box: KarmaBox = {
        ...GOLDEN_KARMA_BOX, owner: new Uint8Array(len), proofSource: 'x'.repeat(len),
      };
      const fromUi = Buffer.from(ui.canonicalBoxBytes(box as unknown as Record<string, unknown>));
      const fromTypes = Buffer.from(canonicalBoxBytes(box));
      expect(fromUi.length, `len=${len}`).toBe(fromTypes.length);
      expect(Buffer.compare(fromUi, fromTypes), `len=${len}`).toBe(0);
    }
  });

  it('cborEncodeBigInt always emits the 8-byte uint64 form, and only that', () => {
    expect(hexOf(ui.cborEncodeBigInt(0n))).toBe('1b0000000000000000');
    expect(hexOf(ui.cborEncodeBigInt(2n))).toBe('1b0000000000000002');
    expect(hexOf(ui.cborEncodeBigInt(100n))).toBe('1b0000000000000064');
    expect(hexOf(ui.cborEncodeBigInt(2n ** 64n - 1n))).toBe('1bffffffffffffffff');
    expect(() => ui.cborEncodeBigInt(2n ** 64n)).toThrow();
    expect(() => ui.cborEncodeBigInt(-1n)).toThrow();
  });
});

// ---------------------------------------------------------------------------

/**
 * Box-identity mirror (Spec G phase E). Two things are pinned here and only one
 * of them is live:
 *
 * - **The strip rule** is live. `canonicalBoxBytes` drops `id` *and* the
 *   provenance keys `txId`/`index`, the fix phase C0 made in types. It moves no
 *   id today — every box the UI hashes is client-built and carries no
 *   provenance — and it stops the UI diverging the first time it hashes a
 *   **server-returned** box, which has carried provenance since phase C.
 * - **`computeCandidateBoxId`** is *not wired to anything*. The UI still
 *   computes legacy ids because the node still does; phase G flips both sides in
 *   one commit. Switching only the client would break the two flows that predict
 *   an id the node must later agree with — the invite flow baked a predicted
 *   `inviteBoxId` into `bond.inviteBoxId`, and the retired unlike path spent a
 *   cached like-box id. (Both flows are since gone: bond pairing is by output
 *   index, and unlike is not a feature.)
 *
 * So every assertion in the preceding two blocks must keep passing untouched: a
 * moved golden vector here means the cutover happened early.
 */
describe('demo UI ↔ @dagsocial/types box identity mirror (Spec G phase E)', () => {
  const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');
  const asUi = (box: object): Record<string, unknown> => box as unknown as Record<string, unknown>;

  /** The same boxes as above, carrying the provenance phase C's producers set. */
  const KARMA_WITH_PROVENANCE = { ...GOLDEN_KARMA_BOX, txId: GOLDEN_UTXO_TX_ID, index: 0 };
  const CREDIT_WITH_PROVENANCE = { ...GOLDEN_CREDIT_BOX, txId: GOLDEN_UTXO_TX_ID, index: 1 };

  // --- the strip rule -------------------------------------------------------

  it('the UI canonical box bytes are byte-identical to canonicalBoxBytes', () => {
    expect(hexOf(ui.canonicalBoxBytes(asUi(GOLDEN_KARMA_BOX))))
      .toBe(hexOf(canonicalBoxBytes(GOLDEN_KARMA_BOX)));
    expect(hexOf(ui.canonicalBoxBytes(asUi(GOLDEN_CREDIT_BOX))))
      .toBe(hexOf(canonicalBoxBytes(GOLDEN_CREDIT_BOX)));
  });

  it('provenance is stripped, so a stored box encodes to its candidate bytes', () => {
    // The non-vacuous case: a box that *does* carry txId/index. With the old
    // id-only strip these bytes gain two map entries and every derived id moves.
    const bare = hexOf(canonicalBoxBytes(GOLDEN_KARMA_BOX));
    expect(hexOf(ui.canonicalBoxBytes(asUi(KARMA_WITH_PROVENANCE)))).toBe(bare);
    expect(hexOf(canonicalBoxBytes(KARMA_WITH_PROVENANCE))).toBe(bare);
    // `id` too — the key the strip already handled before phase C0.
    const stored = { ...KARMA_WITH_PROVENANCE, id: GOLDEN_KARMA_BOX_ID };
    expect(hexOf(ui.canonicalBoxBytes(asUi(stored)))).toBe(bare);
  });

  it('the legacy boxId is unmoved by provenance on both sides', () => {
    expect(ui.computeBoxId(asUi(KARMA_WITH_PROVENANCE))).toBe(GOLDEN_KARMA_BOX_ID);
    expect(computeBoxId(KARMA_WITH_PROVENANCE)).toBe(GOLDEN_KARMA_BOX_ID);
    expect(ui.computeBoxId(asUi(CREDIT_WITH_PROVENANCE))).toBe(GOLDEN_CREDIT_BOX_ID);
    expect(computeBoxId(CREDIT_WITH_PROVENANCE)).toBe(GOLDEN_CREDIT_BOX_ID);
  });

  it('the txId is unmoved by output provenance too — one strip rule, two callers', () => {
    // The UI's second copy of the strip. types routes computeTxId's outputs
    // through canonicalBoxBytes for exactly this reason; the UI now does too.
    const tx: UtxoTransaction = {
      ...GOLDEN_UTXO_TX,
      outputs: [KARMA_WITH_PROVENANCE, CREDIT_WITH_PROVENANCE],
    };
    expect(ui.computeTxId(asUi(tx))).toBe(GOLDEN_UTXO_TX_ID);
    expect(computeTxId(tx)).toBe(GOLDEN_UTXO_TX_ID);
  });

  // --- u32BE ----------------------------------------------------------------

  it('the UI u32BE writes big-endian and normalizes to the sentinel', () => {
    expect(hexOf(ui.u32BE(0))).toBe('00000000');
    expect(hexOf(ui.u32BE(1))).toBe('00000001');          // '01000000' if little-endian
    expect(hexOf(ui.u32BE(0x12345678))).toBe('12345678'); // '78563412' if little-endian
    expect(hexOf(ui.u32BE(0xfffffffe))).toBe('fffffffe'); // top of the encodable domain
    // Out of domain — including 2³²−1 itself, which is the sentinel, so a
    // well-formed index can never collide with a malformed one.
    for (const bad of [NaN, Infinity, -Infinity, -1, 1.5, 0xffffffff, 2 ** 32,
      Number.MAX_SAFE_INTEGER]) {
      expect(hexOf(ui.u32BE(bad)), `n=${bad}`).toBe('ffffffff');
    }
  });

  // --- the Spec G derivation (present, unused) -------------------------------

  it('the UI computeCandidateBoxId matches types on the golden vectors', () => {
    expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, 0))
      .toBe(GOLDEN_KARMA_CANDIDATE_ID);
    expect(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_UTXO_TX_ID, 0))
      .toBe(GOLDEN_KARMA_CANDIDATE_ID);
    expect(ui.computeCandidateBoxId(asUi(GOLDEN_CREDIT_BOX), GOLDEN_UTXO_TX_ID, 1))
      .toBe(GOLDEN_CREDIT_CANDIDATE_ID);
    expect(computeCandidateBoxId(GOLDEN_CREDIT_BOX, GOLDEN_UTXO_TX_ID, 1))
      .toBe(GOLDEN_CREDIT_CANDIDATE_ID);
  });

  it('a stored box re-derives its own id — the derivation is total over both forms', () => {
    // What a light client does: take a box off the wire, re-derive from its own
    // provenance. Only works because the strip is provenance-wide.
    expect(ui.computeCandidateBoxId(asUi(KARMA_WITH_PROVENANCE), GOLDEN_UTXO_TX_ID, 0))
      .toBe(GOLDEN_KARMA_CANDIDATE_ID);
  });

  it('the derivation is not the legacy one — the tag and provenance both bind', () => {
    // Inverted by phase G3b: there is no legacy derivation left to differ from.
    // `computeBoxId` IS `computeCandidateBoxId` applied to the box's own
    // provenance — on BOTH sides — so these must now be equal, and the mirror is
    // what proves the client collapsed them the same way the node did.
    expect(GOLDEN_KARMA_CANDIDATE_ID).toBe(GOLDEN_KARMA_BOX_ID);
    expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_CANDIDATE), GOLDEN_UTXO_TX_ID, 0))
      .toBe(ui.computeBoxId(asUi(GOLDEN_KARMA_BOX)));
  });

  it('both txId and index enter the derivation', () => {
    const otherTx = '9'.repeat(64);
    const ids = [
      ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, 0),
      ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, 1),
      ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), otherTx, 0),
    ];
    expect(new Set(ids).size).toBe(3);
    expect(ids[2]).toBe(computeCandidateBoxId(GOLDEN_KARMA_BOX, otherTx, 0));
  });

  it('a wide index agrees byte for byte across implementations', () => {
    // 0x12345678 is asymmetric, so a little-endian mirror fails here even though
    // it agrees on index 0 — the index every mint and most single-output txs use.
    expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, 0x12345678))
      .toBe(GOLDEN_KARMA_CANDIDATE_ID_WIDE_INDEX);
    expect(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_UTXO_TX_ID, 0x12345678))
      .toBe(GOLDEN_KARMA_CANDIDATE_ID_WIDE_INDEX);
  });

  it('a malformed index derives the sentinel id rather than throwing (M-5)', () => {
    for (const bad of [NaN, Infinity, -1, 1.5, 0xffffffff, 2 ** 32]) {
      expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, bad), `index=${bad}`)
        .toBe(GOLDEN_KARMA_CANDIDATE_ID_SENTINEL);
      expect(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_UTXO_TX_ID, bad), `index=${bad}`)
        .toBe(GOLDEN_KARMA_CANDIDATE_ID_SENTINEL);
    }
  });

  it('txId enters as the UTF-8 bytes of its hex text, not as decoded bytes', () => {
    // Case is the observable: hex decoding would collapse these onto one id.
    // (TYPES_INTERFACE.md → Pinned byte forms — also why derivation stays total
    // on an attacker-supplied txId, where a decode would throw.)
    const upper = GOLDEN_UTXO_TX_ID.toUpperCase();
    const uiUpper = ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), upper, 0);
    expect(uiUpper).not.toBe(GOLDEN_KARMA_CANDIDATE_ID);
    expect(uiUpper).toBe(computeCandidateBoxId(GOLDEN_KARMA_BOX, upper, 0));
    // Odd-length and non-hex text derive an id instead of throwing.
    for (const weird of ['', 'abc', 'zz']) {
      expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), weird, 0), `txId=${weird}`)
        .toBe(computeCandidateBoxId(GOLDEN_KARMA_BOX, weird, 0));
    }
  });

  it('the UI accepts hex-string binary fields identically here too', () => {
    // The tx-builder form: `owner` arrives as hex from state, not as bytes.
    const hexBox = { ...GOLDEN_KARMA_BOX, owner: Buffer.from(GOLDEN_AUTHOR).toString('hex') };
    expect(ui.computeCandidateBoxId(asUi(hexBox), GOLDEN_UTXO_TX_ID, 0))
      .toBe(GOLDEN_KARMA_CANDIDATE_ID);
  });

  it.each(ALL_BOX_TYPES)(
    '$name: the provenance derivation agrees in both forms (E3)',
    ({ box }) => {
      const expected = computeCandidateBoxId(box, GOLDEN_UTXO_TX_ID, 3);
      expect(ui.computeCandidateBoxId(toUiForm(box), GOLDEN_UTXO_TX_ID, 3)).toBe(expected);
      expect(ui.computeCandidateBoxId(asUi(box), GOLDEN_UTXO_TX_ID, 3)).toBe(expected);
    },
  );
});

// ---------------------------------------------------------------------------

/**
 * likeTarget tail mirror (P2-D). The like transaction's target sits inside the
 * `computeTxId` preimage behind an ASCII `like:` marker, appended only when
 * the field is present — presence is `!== undefined`, NOT truthiness. The UI
 * signs what it builds, so a mirror that dropped the tail (or gated it on
 * truthiness) would sign ids the node never computes, and every like from the
 * demo UI would be rejected.
 */
describe('demo UI ↔ @dagsocial/types likeTarget tail mirror (P2-D)', () => {
  const asUi = (tx: object): Record<string, unknown> => tx as unknown as Record<string, unknown>;

  // Measured from @dagsocial/types computeTxId — both implementations pin to
  // constants, not just to each other.
  const GOLDEN_LIKE_TX_ID =
    'a126fd5ef4e1ae9b7044d1e9685f2b8d5f99736027b31d51d7a2cf1d98307c72';
  const GOLDEN_EMPTY_TARGET_TX_ID =
    '42ff2ed25e1000a5334659d3084d230a4179af0563a635d7a28250cf6eba4bc0';

  const GOLDEN_LIKE_TX: UtxoTransaction = {
    ...GOLDEN_UTXO_TX,
    likeTarget: GOLDEN_POST_ID,
  };

  it('the UI reproduces the frozen likeTarget-bearing txId', () => {
    expect(ui.computeTxId(asUi(GOLDEN_LIKE_TX))).toBe(GOLDEN_LIKE_TX_ID);
    expect(computeTxId(GOLDEN_LIKE_TX)).toBe(GOLDEN_LIKE_TX_ID);
  });

  it('absence appends nothing — the un-targeted tx keeps its pre-P2-D id', () => {
    expect(ui.computeTxId(asUi(GOLDEN_UTXO_TX))).toBe(GOLDEN_UTXO_TX_ID);
    expect(GOLDEN_LIKE_TX_ID).not.toBe(GOLDEN_UTXO_TX_ID);
  });

  it('presence is not truthiness — an empty-string target still appends the marker', () => {
    const emptyTarget: UtxoTransaction = { ...GOLDEN_UTXO_TX, likeTarget: '' };
    expect(ui.computeTxId(asUi(emptyTarget))).toBe(GOLDEN_EMPTY_TARGET_TX_ID);
    expect(computeTxId(emptyTarget)).toBe(GOLDEN_EMPTY_TARGET_TX_ID);
    expect(GOLDEN_EMPTY_TARGET_TX_ID).not.toBe(GOLDEN_UTXO_TX_ID);
  });

  it('the target binds — re-pointing the like moves the id identically on both sides', () => {
    const repointed: UtxoTransaction = {
      ...GOLDEN_UTXO_TX,
      likeTarget: '2222222222222222222222222222222222222222222222222222222222222222',
    };
    const uiId = ui.computeTxId(asUi(repointed));
    expect(uiId).not.toBe(GOLDEN_LIKE_TX_ID);
    expect(uiId).toBe(computeTxId(repointed));
  });
});
