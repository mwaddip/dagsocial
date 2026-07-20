import { describe, it, expect } from 'vitest';
import { computePostId, signingHash, getPostDiscriminator, buildProfileContent } from '../src/post.js';
import {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
  POST_POW_TARGET_BITS,
  CHALLENGE_WINDOW_BLOCKS,
  KARMA_POSTING_MINIMUM,
  KARMA_DECAY_RATE,
  KARMA_DECAY_GRACE_BLOCKS,
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
  ORDERING_BLOCK_REWARD_CREDITS,
} from '../src/constants.js';
import type { Post } from '../src/post.js';

const challenge = new Uint8Array(32).fill(0xab);
const signature = new Uint8Array(64).fill(0xcd);

const post: Post = {
  content: 'hello world',
  author: 'abc123',
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
    expect(KARMA_POSTING_MINIMUM).toBe(1);
    expect(KARMA_DECAY_RATE).toBe(0.0001);
    expect(KARMA_DECAY_GRACE_BLOCKS).toBe(100);
  });

  it('like constants are defined', () => {
    expect(LIKE_COST).toBe(2);
    expect(LIKE_THRESHOLD).toBe(5);
    expect(LIKE_MAX_AUTHOR_REWARD).toBe(10);
    expect(LIKE_FREE_THRESHOLD).toBe(10);
  });

  it('epoch constants are defined', () => {
    expect(EPOCH_BLOCKS).toBe(60);
  });

  it('invite constants are defined', () => {
    expect(MAX_PENDING_INVITES).toBe(5);
    expect(INVITE_BOND_KARMA).toBe(10);
    expect(INVITE_PROBATION_BLOCKS).toBe(1000);
    expect(INVITE_KARMA_THRESHOLD).toBe(20);
  });

  it('genesis constants are defined', () => {
    expect(GENESIS_COMMITTEE_KEYS).toEqual([]);
    expect(GENESIS_KARMA_PER_MEMBER).toBe(1000);
    expect(GENESIS_CREDITS_PER_MEMBER).toBe(10000);
    expect(BOOTSTRAP_PERIOD_BLOCKS).toBe(10000);
  });

  it('validator constants are defined', () => {
    expect(ORDERING_BLOCK_REWARD_CREDITS).toBe(100);
  });
});
