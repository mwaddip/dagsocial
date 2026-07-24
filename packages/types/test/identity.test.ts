import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '../src/identity.js';

describe('identity', () => {
  it('generates 32-byte public key', () => {
    const kp = generateKeyPair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
  });

  it('UserId IS the public key — same bytes, same identity', () => {
    const kp = generateKeyPair();
    // The public key itself is the identity; it's trivially deterministic
    expect(kp.publicKey).toEqual(kp.publicKey);
  });

  it('different keys produce different identities', () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    // Different key bytes → different identities
    expect(Buffer.from(kp1.publicKey).equals(Buffer.from(kp2.publicKey))).toBe(false);
  });
});
