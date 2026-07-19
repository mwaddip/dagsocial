import { describe, it, expect } from 'vitest';
import { generateKeyPair, getUserId } from '../src/identity.js';

describe('identity', () => {
  it('generates 32-byte public key', () => {
    const kp = generateKeyPair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
  });

  it('getUserId is deterministic', () => {
    const kp = generateKeyPair();
    expect(getUserId(kp.publicKey)).toBe(getUserId(kp.publicKey));
  });

  it('different keys produce different user IDs', () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    expect(getUserId(kp1.publicKey)).not.toBe(getUserId(kp2.publicKey));
  });
});
