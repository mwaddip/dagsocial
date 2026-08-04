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
} from '@dagsocial/types';
import type { Post, KarmaBox, CreditBox, UtxoTransaction } from '@dagsocial/types';

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

const GOLDEN_KARMA_BOX: KarmaBox = {
  boxType: 'karma',
  value: 100n,
  createdAtBlock: 70000,          // > 65536 — locks the wide-int encoding path (L-5)
  owner: GOLDEN_AUTHOR,
  guard: 'owner_signature',
  proofSource: 'genesis',
  lastTouchBlock: 70000,
};

const GOLDEN_CREDIT_BOX: CreditBox = {
  boxType: 'credit',
  value: 123456789n * 10n ** 8n,  // 12_345_678_900_000_000 > 2^53 — the range P0 exists for
  createdAtBlock: 70000,
  owner: GOLDEN_AUTHOR,
  guard: 'owner_signature',
  proofSource: 42,
};

const GOLDEN_UTXO_TX: UtxoTransaction = {
  inputs: ['1111111111111111111111111111111111111111111111111111111111111111'],
  outputs: [GOLDEN_KARMA_BOX, GOLDEN_CREDIT_BOX],
  signatures: {},
  protocolVersion: 1,
};

const GOLDEN_KARMA_BOX_ID =
  '83c95fbb82c1ba033280286ea0fd5a4dd09776c6c68e1426dfdae1668947c9d1';
const GOLDEN_CREDIT_BOX_ID =
  'b256df0c3fca8bd2e7567d11ca66e4e1e4cd41b0ab148ec5956907047b596905';
const GOLDEN_UTXO_TX_ID =
  '0156333db37f658f278aef3ba2c9d2ce3c2f126cf7fb98b7a835dde4ee92ac7c';

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
  computeBoxId: (box: Record<string, unknown>) => string;
  computeTxId: (tx: Record<string, unknown>) => string;
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
    extractConst(html, 'U32_SENTINEL'),
    extractDeclaration(html, 'function buf2hex('),
    extractDeclaration(html, 'function hex2buf('),
    extractDeclaration(html, 'function concatUint8Arrays('),
    extractDeclaration(html, 'function isEncodableU32('),
    extractDeclaration(html, 'function isEncodableU64('),
    extractDeclaration(html, 'function encodeU32LE('),
    extractDeclaration(html, 'function encodeLE64('),
    extractDeclaration(html, 'function lengthPrefixed('),
    extractDeclaration(html, 'function postFieldBytes('),
    extractDeclaration(html, 'function buildPowInput('),
    extractDeclaration(html, 'function computePostId('),
    // The box/tx encoding mirror (Spec B P0): the UI's CBOR encoder and the
    // box/tx id functions built on it.
    extractDeclaration(html, 'function cborEncodeString('),
    extractDeclaration(html, 'function cborEncodeBytes('),
    extractDeclaration(html, 'function cborEncodeInt('),
    extractDeclaration(html, 'function cborEncodeBigInt('),
    extractDeclaration(html, 'function cborEncodeUndefined('),
    extractDeclaration(html, 'function cborEncodeMap('),
    extractDeclaration(html, 'function cborEncode('),
    extractDeclaration(html, 'function computeBoxId('),
    extractDeclaration(html, 'function computeTxId('),
    'return { postFieldBytes, buildPowInput, computePostId, encodeLE64, encodeU32LE,\n' +
    '         cborEncode, cborEncodeInt, cborEncodeBigInt, computeBoxId, computeTxId };',
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
    // createdAtBlock 70000 stays minimal-int (uint32 form 1a00011170, not 1b…)
    expect(karmaHex).toContain('1a00011170');
    expect(karmaHex).not.toContain('1b0000000000011170');
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

  it('cborEncodeBigInt always emits the 8-byte uint64 form, and only that', () => {
    expect(hexOf(ui.cborEncodeBigInt(0n))).toBe('1b0000000000000000');
    expect(hexOf(ui.cborEncodeBigInt(2n))).toBe('1b0000000000000002');
    expect(hexOf(ui.cborEncodeBigInt(100n))).toBe('1b0000000000000064');
    expect(hexOf(ui.cborEncodeBigInt(2n ** 64n - 1n))).toBe('1bffffffffffffffff');
    expect(() => ui.cborEncodeBigInt(2n ** 64n)).toThrow();
    expect(() => ui.cborEncodeBigInt(-1n)).toThrow();
  });
});
