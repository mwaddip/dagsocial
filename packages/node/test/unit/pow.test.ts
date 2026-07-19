import { describe, it, expect } from 'vitest';
import { solvePoW, verifyPoW, countLeadingZeroBits } from '../../src/services/pow.js';

describe('countLeadingZeroBits', () => {
  it('counts all zeros as 256', () => {
    expect(countLeadingZeroBits(Buffer.alloc(32, 0))).toBe(256);
  });

  it('counts partial byte', () => {
    const buf = Buffer.alloc(32, 0);
    buf[2] = 0x0f;
    expect(countLeadingZeroBits(buf)).toBe(16 + 4);
  });

  it('returns 0 for leading 1 bit', () => {
    expect(countLeadingZeroBits(Buffer.from([0x80]))).toBe(0);
  });
});

describe('solvePoW / verifyPoW', () => {
  it('solved nonce verifies', () => {
    const nonce = solvePoW('challenge-1', 8);
    expect(verifyPoW('challenge-1', nonce, 8)).toBe(true);
  });

  it('rejects wrong nonce', () => {
    const nonce = solvePoW('challenge-2', 8);
    expect(verifyPoW('challenge-2', nonce + 1, 8)).toBe(false);
  });

  it('rejects wrong challenge', () => {
    const nonce = solvePoW('challenge-3', 8);
    expect(verifyPoW('other-challenge', nonce, 8)).toBe(false);
  });

  it('solve at 16 bits completes within 10s', () => {
    const start = Date.now();
    const nonce = solvePoW('perf-test', 16);
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(verifyPoW('perf-test', nonce, 16)).toBe(true);
  });
});
