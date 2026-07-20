import { describe, it, expect } from 'vitest';
import { computePostId, signingHash } from '../src/post.js';
import {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
  DEFAULT_SLOT_WINDOW_BLOCKS,
  DEFAULT_SLOT_TARGET_BITS,
  DEFAULT_SUBMIT_TARGET_BITS,
} from '../src/constants.js';

const unsigned = {
  content: 'hello world',
  author: 'abc123',
  parentRefs: [] as string[],
  slotHash: 'slot-hash-1',
  powNonce: 42,
  protocolVersion: 1,
  timestamp: 1700000000000,
};

describe('post', () => {
  it('computePostId is deterministic', () => {
    expect(computePostId(unsigned)).toBe(computePostId(unsigned));
  });

  it('computePostId changes with content', () => {
    expect(computePostId(unsigned))
      .not.toBe(computePostId({ ...unsigned, content: 'different' }));
  });

  it('signingHash excludes powNonce', () => {
    const h1 = signingHash(unsigned);
    const h2 = signingHash({ ...unsigned, powNonce: 99 });
    expect(Buffer.compare(h1, h2)).toBe(0);
  });

  it('signingHash changes with content', () => {
    const h1 = signingHash(unsigned);
    const h2 = signingHash({ ...unsigned, content: 'other' });
    expect(Buffer.compare(h1, h2)).not.toBe(0);
  });

  it('signingHash changes with protocolVersion', () => {
    const h1 = signingHash(unsigned);
    const h2 = signingHash({ ...unsigned, protocolVersion: 2 });
    expect(Buffer.compare(h1, h2)).not.toBe(0);
  });

  it('computePostId changes with protocolVersion', () => {
    const id1 = computePostId(unsigned);
    const id2 = computePostId({ ...unsigned, protocolVersion: 2 });
    expect(id1).not.toBe(id2);
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

  it('DEFAULT_SLOT_WINDOW_BLOCKS is 100', () => {
    expect(DEFAULT_SLOT_WINDOW_BLOCKS).toBe(100);
  });

  it('DEFAULT_SLOT_TARGET_BITS is 20', () => {
    expect(DEFAULT_SLOT_TARGET_BITS).toBe(20);
  });

  it('DEFAULT_SUBMIT_TARGET_BITS is 8', () => {
    expect(DEFAULT_SUBMIT_TARGET_BITS).toBe(8);
  });
});
