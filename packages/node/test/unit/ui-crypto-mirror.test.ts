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
import { computePostId, signingHash, postPowPreimage } from '@dagsocial/types';
import type { Post } from '@dagsocial/types';

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
    'return { postFieldBytes, buildPowInput, computePostId, encodeLE64, encodeU32LE };',
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
