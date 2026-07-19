import { describe, it, expect } from 'vitest';
import { base58Encode, base58Decode } from '../src/base58.js';

describe('base58', () => {
  it('round-trips random 32-byte buffers', () => {
    for (let i = 0; i < 100; i++) {
      const original = crypto.getRandomValues(new Uint8Array(32));
      expect(base58Decode(base58Encode(original))).toEqual(original);
    }
  });

  it('handles leading zeros', () => {
    const bytes = new Uint8Array([0, 0, 1, 2, 3]);
    const encoded = base58Encode(bytes);
    expect(encoded.startsWith('11')).toBe(true);
    expect(base58Decode(encoded)).toEqual(bytes);
  });

  it('rejects invalid characters', () => {
    expect(() => base58Decode('0OIl')).toThrow('Invalid base58 character');
  });

  it('encodes empty buffer', () => {
    expect(base58Encode(new Uint8Array([]))).toBe('');
  });
});
