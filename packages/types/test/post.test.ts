import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  computePostId,
  signingHash,
  postPowPreimage,
  getPostDiscriminator,
  buildProfileContent,
} from '../src/post.js';
import {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
  POST_POW_TARGET_BITS,
  CHALLENGE_WINDOW_BLOCKS,
  KARMA_POSTING_MINIMUM,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  LIKE_COST,
  LIKE_THRESHOLD,
  LIKE_MAX_AUTHOR_REWARD,
  LIKE_FREE_THRESHOLD,
  EPOCH_BLOCKS,
  MAX_PENDING_INVITES,
  INVITE_BOND_KARMA,
  INVITE_PROBATION_BLOCKS,
  INVITE_KARMA_THRESHOLD,
  GENESIS_COMMITTEE_KEYS,
  GENESIS_KARMA_PER_MEMBER,
  GENESIS_CREDITS_PER_MEMBER,
  BOOTSTRAP_PERIOD_BLOCKS,
  CREDIT_FIXED_RATE_BLOCKS,
  CREDIT_INITIAL_REWARD,
  CREDIT_EPOCH_BLOCKS,
  CREDIT_REWARD_REDUCTION,
  CREDIT_TAIL_REWARD,
  CREDIT_MINER_REWARD_DELAY,
  CREDIT_TREASURY_PCT,
  ORDERING_BLOCK_POW_TARGET_BITS,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
} from '../src/constants.js';
import type { Post } from '../src/post.js';

const challenge = new Uint8Array(32).fill(0xab);
const signature = new Uint8Array(64).fill(0xcd);

const post: Post = {
  content: 'hello world',
  author: new Uint8Array(32).fill(0x11),
  parentRefs: [],
  challenge,
  powNonce: 42,
  protocolVersion: 2,
  timestamp: 1700000000000,
  signature,
};

describe('post', () => {
  it('computePostId is deterministic', () => {
    expect(computePostId(post)).toBe(computePostId(post));
  });

  it('computePostId changes with content', () => {
    expect(computePostId(post))
      .not.toBe(computePostId({ ...post, content: 'different' }));
  });

  it('signingHash excludes powNonce', () => {
    const h1 = signingHash(post);
    const h2 = signingHash({ ...post, powNonce: 99 });
    expect(Buffer.compare(h1, h2)).toBe(0);
  });

  it('signingHash changes with content', () => {
    const h1 = signingHash(post);
    const h2 = signingHash({ ...post, content: 'other' });
    expect(Buffer.compare(h1, h2)).not.toBe(0);
  });

  it('signingHash changes with protocolVersion', () => {
    const h1 = signingHash(post);
    const h2 = signingHash({ ...post, protocolVersion: 3 });
    expect(Buffer.compare(h1, h2)).not.toBe(0);
  });

  it('computePostId changes with powNonce (unlike signingHash)', () => {
    const id1 = computePostId(post);
    const id2 = computePostId({ ...post, powNonce: 43 });
    expect(id1).not.toBe(id2);
  });

  it('computePostId returns a hex string', () => {
    const id = computePostId(post);
    expect(typeof id).toBe('string');
    expect(id).toHaveLength(64); // 32 bytes = 64 hex chars
    expect(/^[0-9a-f]+$/.test(id)).toBe(true);
  });

  it('signingHash returns 32 bytes', () => {
    expect(signingHash(post)).toHaveLength(32);
  });

  it('post with parentRefs hashes differently', () => {
    const withRefs = { ...post, parentRefs: ['ref1'] };
    expect(computePostId(post)).not.toBe(computePostId(withRefs));
  });

  it('post with different challenge hashes differently', () => {
    const otherChallenge = new Uint8Array(32).fill(0xff);
    const other = { ...post, challenge: otherChallenge };
    expect(computePostId(post)).not.toBe(computePostId(other));
  });
});

// ---------------------------------------------------------------------------
// Canonical field encoding (audit M-1)
// ---------------------------------------------------------------------------

/**
 * The pre-M-1 encoding, kept verbatim so every test below can be shown to be
 * non-vacuous: each case that passes under the canonical encoding is asserted
 * to have *failed* under this one.
 */
function legacyPostId(p: Post): string {
  const h = createHash('blake2b512');
  h.update(p.content);
  h.update(p.author);
  for (const ref of p.parentRefs) h.update(ref);
  h.update(p.challenge);
  h.update(String(p.protocolVersion));
  h.update(String(p.powNonce));
  h.update(String(p.timestamp));
  return h.digest().subarray(0, 32).toString('hex');
}

/**
 * Frozen golden vector — the cross-implementation anchor.
 *
 * These three hex strings are reproduced by the demo-UI JS mirror
 * (packages/node/public/index.html, asserted in the node package's
 * ui-crypto-mirror test). A change to either implementation that is not
 * mirrored in the other breaks this vector. Do not "fix" a failure by editing
 * the constants — the encoding is protocol-breaking and unversioned.
 */
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
  powNonce: 4294967296,     // 2^32 — the nonce's u64 high half must be written
  protocolVersion: 1,
  timestamp: 1767225600000, // > 2^32 — the timestamp's high half must be written
  signature: new Uint8Array(64).fill(0xcd),
};

const GOLDEN_SIGNING_HASH =
  '24157bd74276c86556b41ce0402f8ef9ba4850fc086519c838eb77300ce681d0';
const GOLDEN_POST_ID =
  '0150b9bf676c88c715f0b1fbdf142f8bd0ccf7bb8769e2059488d6c300b6b08f';

describe('canonical field encoding (M-1)', () => {
  it('golden vector: signingHash is frozen', () => {
    expect(signingHash(GOLDEN_POST).toString('hex')).toBe(GOLDEN_SIGNING_HASH);
  });

  it('golden vector: postId is frozen', () => {
    expect(computePostId(GOLDEN_POST)).toBe(GOLDEN_POST_ID);
  });

  it('golden vector: preimage is the exact length-prefixed layout', () => {
    const pre = postPowPreimage(GOLDEN_POST);
    // LP(content 27) + LP(author 32) + u32(refCount) + 2×LP(ref 64)
    // + LP(challenge 32) + u32(protocolVersion) + u64(timestamp)
    expect(pre.length).toBe(31 + 36 + 4 + 2 * 68 + 36 + 4 + 8);
    expect(Buffer.from(pre.subarray(0, 4)).toString('hex')).toBe('1b000000');   // u32LE(27)
    expect(Buffer.from(pre.subarray(-8)).toString('hex')).toBe('00a8da769b010000'); // u64LE(ts)
  });

  it('the M-1 collision pair now yields distinct ids', () => {
    const a: Post = { ...GOLDEN_POST, powNonce: 5, timestamp: 23 };
    const b: Post = { ...GOLDEN_POST, powNonce: 52, timestamp: 3 };
    expect(computePostId(a)).not.toBe(computePostId(b));
    // Vacuity check: this pair DID collide under the old concatenation.
    expect(legacyPostId(a)).toBe(legacyPostId(b));
  });

  it('parentRef boundaries are unambiguous', () => {
    const split: Post = { ...GOLDEN_POST, parentRefs: ['ab', 'cd'] };
    const joined: Post = { ...GOLDEN_POST, parentRefs: ['abcd'] };
    expect(computePostId(split)).not.toBe(computePostId(joined));
    // Vacuity check: undelimited concatenation made these identical.
    expect(legacyPostId(split)).toBe(legacyPostId(joined));
  });

  it('the content/author boundary is unambiguous', () => {
    const a: Post = { ...GOLDEN_POST, content: 'ab', parentRefs: ['cd'] };
    const b: Post = { ...GOLDEN_POST, content: 'abcd', parentRefs: [] };
    // Different ref counts alone are enough; the explicit count seals it.
    expect(computePostId(a)).not.toBe(computePostId(b));
  });

  it('an empty parentRefs array is distinguishable from an empty ref', () => {
    const none: Post = { ...GOLDEN_POST, parentRefs: [] };
    const empty: Post = { ...GOLDEN_POST, parentRefs: [''] };
    expect(computePostId(none)).not.toBe(computePostId(empty));
    // Vacuity check: both appended nothing under the old encoding.
    expect(legacyPostId(none)).toBe(legacyPostId(empty));
  });

  it('the post id is domain-tagged — it is not the PoW hash', () => {
    const nonce = Buffer.alloc(8);
    nonce.writeBigUInt64LE(BigInt(GOLDEN_POST.powNonce));
    const powHash = createHash('blake2b512')
      .update(postPowPreimage(GOLDEN_POST))
      .update(nonce)
      .digest()
      .subarray(0, 32)
      .toString('hex');
    expect(computePostId(GOLDEN_POST)).not.toBe(powHash);
  });

  it('postPowPreimage excludes powNonce, computePostId includes it', () => {
    const other: Post = { ...GOLDEN_POST, powNonce: GOLDEN_POST.powNonce + 1 };
    expect(Buffer.compare(
      Buffer.from(postPowPreimage(GOLDEN_POST)),
      Buffer.from(postPowPreimage(other)),
    )).toBe(0);
    expect(computePostId(GOLDEN_POST)).not.toBe(computePostId(other));
  });

  it('never throws on out-of-domain numerics (validation no-panic contract)', () => {
    // `@dagsocial/validation`'s isSignablePost admits any `typeof === 'number'`,
    // so these reach the encoder. BigInt/writeBigUInt64LE would throw here.
    for (const bad of [NaN, Infinity, -Infinity, -1, 1.5, 2 ** 64, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => signingHash({ ...GOLDEN_POST, timestamp: bad })).not.toThrow();
      expect(() => computePostId({ ...GOLDEN_POST, timestamp: bad })).not.toThrow();
      expect(() => computePostId({ ...GOLDEN_POST, powNonce: bad })).not.toThrow();
      expect(() => computePostId({ ...GOLDEN_POST, protocolVersion: bad })).not.toThrow();
    }
  });

  it('an out-of-domain numeric cannot impersonate a valid one', () => {
    // The all-ones sentinel is unreachable from a non-negative safe integer.
    const valid = computePostId({ ...GOLDEN_POST, timestamp: 0 });
    for (const bad of [NaN, Infinity, -1, 1.5]) {
      expect(computePostId({ ...GOLDEN_POST, timestamp: bad })).not.toBe(valid);
    }
  });
});

describe('profile discriminators', () => {
  it('getPostDiscriminator returns null for plain text', () => {
    expect(getPostDiscriminator('hello world')).toBeNull();
  });

  it('getPostDiscriminator returns null for JSON without type', () => {
    expect(getPostDiscriminator('{"foo":"bar"}')).toBeNull();
  });

  it('getPostDiscriminator returns null for invalid JSON', () => {
    expect(getPostDiscriminator('{broken')).toBeNull();
  });

  it('getPostDiscriminator returns type for profile JSON', () => {
    expect(getPostDiscriminator('{"type":"bio","text":"hello"}')).toBe('bio');
  });

  it('getPostDiscriminator returns type for username_claim', () => {
    expect(getPostDiscriminator('{"type":"username_claim","claim":"@alice"}')).toBe('username_claim');
  });

  it('buildProfileContent embeds type in JSON', () => {
    const content = buildProfileContent('bio', { text: 'hello' });
    expect(JSON.parse(content)).toEqual({ type: 'bio', text: 'hello' });
  });

  it('buildProfileContent with no extra fields', () => {
    const content = buildProfileContent('profile');
    expect(JSON.parse(content)).toEqual({ type: 'profile' });
  });
});

describe('constants', () => {
  it('PROTOCOL_VERSION is 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('MAX_CONTENT_BYTES is 300', () => {
    expect(MAX_CONTENT_BYTES).toBe(300);
  });

  it('MAX_PARENT_REFS is 8', () => {
    expect(MAX_PARENT_REFS).toBe(8);
  });

  it('PoW constants are defined', () => {
    expect(POST_POW_TARGET_BITS).toBe(20);
    expect(CHALLENGE_WINDOW_BLOCKS).toBe(10);
  });

  it('karma constants are defined', () => {
    expect(KARMA_POSTING_MINIMUM).toBe(1n);
    expect(KARMA_STALE_THRESHOLD_BLOCKS).toBe(20160);
    expect(KARMA_DECAY_INTERVAL_BLOCKS).toBe(720);
    expect(KARMA_DECAY_AMOUNT).toBe(5n);
    expect(KARMA_MINIMUM).toBe(10n);
  });

  it('like constants are defined', () => {
    expect(LIKE_COST).toBe(2n);
    expect(LIKE_THRESHOLD).toBe(5);
    expect(LIKE_MAX_AUTHOR_REWARD).toBe(10n);
    expect(LIKE_FREE_THRESHOLD).toBe(10);
  });

  it('epoch constants are defined', () => {
    expect(EPOCH_BLOCKS).toBe(60);
  });

  it('invite constants are defined', () => {
    expect(MAX_PENDING_INVITES).toBe(5);
    expect(INVITE_BOND_KARMA).toBe(25n);
    expect(INVITE_PROBATION_BLOCKS).toBe(1000);
    expect(INVITE_KARMA_THRESHOLD).toBe(20n);
  });

  it('genesis constants are defined', () => {
    expect(GENESIS_COMMITTEE_KEYS).toEqual([]);
    expect(GENESIS_KARMA_PER_MEMBER).toBe(1000n);
    expect(GENESIS_CREDITS_PER_MEMBER).toBe(10000n * 10n ** 8n);  // credits ×10^8 base units
    expect(BOOTSTRAP_PERIOD_BLOCKS).toBe(10000);
  });

  it('validator constants are defined', () => {
    expect(ORDERING_BLOCK_POW_TARGET_BITS).toBe(12);
    expect(CREDIT_INITIAL_REWARD).toBe(100n * 10n ** 8n);   // credits ×10^8 base units
    expect(CREDIT_FIXED_RATE_BLOCKS).toBe(1_051_200);
    expect(CREDIT_EPOCH_BLOCKS).toBe(129_600);
    expect(CREDIT_REWARD_REDUCTION).toBe(2n * 10n ** 8n);
    expect(CREDIT_TAIL_REWARD).toBe(2n * 10n ** 8n);
    expect(CREDIT_MINER_REWARD_DELAY).toBe(720);
    expect(CREDIT_TREASURY_PCT).toBe(10);
    expect(ORDERING_BLOCK_POW_TARGET_FLOOR).toBe(4);
  });
});
