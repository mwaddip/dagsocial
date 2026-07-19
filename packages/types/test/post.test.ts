import { describe, it, expect } from 'vitest';
import { computePostId, signingHash } from '../src/post.js';

const unsigned = {
  content: 'hello world',
  author: 'abc123',
  parentRefs: [] as string[],
  slotHash: 'slot-hash-1',
  powNonce: 42,
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
});
