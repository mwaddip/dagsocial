import { describe, it, expect } from 'vitest';
import { generateChallenge, verifyPoW } from '../../src/services/pow.js';

describe('generateChallenge', () => {
  it('returns 32 bytes', () => {
    const challenge = generateChallenge();
    expect(challenge).toBeInstanceOf(Uint8Array);
    expect(challenge.length).toBe(32);
  });

  it('is random (two calls produce different results)', () => {
    const a = generateChallenge();
    const b = generateChallenge();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe('verifyPoW', () => {
  it('returns true for a valid nonce at low targetBits', () => {
    const input = new Uint8Array([0x01, 0x02, 0x03]);
    const targetBits = 4;

    // Brute-force a valid nonce — should take < 1ms at targetBits=4
    let nonce = 0;
    while (!verifyPoW(input, nonce, targetBits)) {
      nonce++;
      if (nonce > 1_000_000) throw new Error('Could not find valid nonce');
    }

    expect(verifyPoW(input, nonce, targetBits)).toBe(true);
  });

  it('returns false for wrong nonce', () => {
    const input = new Uint8Array([0x01, 0x02, 0x03]);
    const targetBits = 4;

    // Find a valid nonce first
    let nonce = 0;
    while (!verifyPoW(input, nonce, targetBits)) {
      nonce++;
      if (nonce > 1_000_000) throw new Error('Could not find valid nonce');
    }

    // Wrong nonce should fail
    expect(verifyPoW(input, nonce + 1, targetBits)).toBe(false);
  });

  it('returns false for different input (modified challenge fails even with valid nonce)', () => {
    const input = new Uint8Array([0x01, 0x02, 0x03]);
    const differentInput = new Uint8Array([0x01, 0x02, 0x04]);
    const targetBits = 4;

    let nonce = 0;
    while (!verifyPoW(input, nonce, targetBits)) {
      nonce++;
      if (nonce > 1_000_000) throw new Error('Could not find valid nonce');
    }

    // Same nonce, different input → should fail
    expect(verifyPoW(differentInput, nonce, targetBits)).toBe(false);
  });

  it('known answer: pre-computed valid nonce for known input at targetBits=4', () => {
    // Pre-computed: input=[0xde,0xad,0xbe,0xef], targetBits=4 → nonce=18
    // Hash: 03b04b30bb313f48d159a82750aa5710d836eb4aac67e3e4288b0d96d1c35a64
    // First byte 0x03 = 00000011 → 4 leading zero bits
    const input = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const nonce = 18;
    const targetBits = 4;

    expect(verifyPoW(input, nonce, targetBits)).toBe(true);
  });
});
