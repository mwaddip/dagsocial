import { describe, it, expect } from 'vitest';
import { createHash, generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto';

describe('PruneEntry Ed25519 signature', () => {
  it('signs (rootPostHash, subtreeMerkleRoot) and verifies', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');

    const rootPostHash = 'a'.repeat(64);
    const subtreeMerkleRoot = Buffer.alloc(32, 0xdd);

    const payload = createHash('blake2b512')
      .update(rootPostHash)
      .update(subtreeMerkleRoot)
      .digest()
      .subarray(0, 32);

    const signature = sign(null, payload, privateKey);

    // Verify
    const authorId = publicKey.export({ format: 'jwk' }).x
      ? Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')
      : publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

    // Actually, get raw 32-byte public key:
    const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

    const keyObject = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: rawPub.toString('base64url'),
      },
      format: 'jwk',
    });

    const valid = verify(null, payload, keyObject, signature);
    expect(valid).toBe(true);
  });

  it('rejects tampered rootPostHash', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

    const rootPostHash = 'a'.repeat(64);
    const subtreeMerkleRoot = Buffer.alloc(32, 0xdd);

    const payload = createHash('blake2b512')
      .update(rootPostHash)
      .update(subtreeMerkleRoot)
      .digest()
      .subarray(0, 32);

    const signature = sign(null, payload, privateKey);

    // Tamper
    const tamperedPayload = createHash('blake2b512')
      .update('b'.repeat(64))
      .update(subtreeMerkleRoot)
      .digest()
      .subarray(0, 32);

    const keyObject = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: rawPub.toString('base64url') },
      format: 'jwk',
    });

    const valid = verify(null, tamperedPayload, keyObject, signature);
    expect(valid).toBe(false);
  });

  it('rejects wrong key', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const { publicKey: otherPub } = generateKeyPairSync('ed25519');
    const rawOther = otherPub.export({ type: 'spki', format: 'der' }).subarray(-32);

    const rootPostHash = 'a'.repeat(64);
    const subtreeMerkleRoot = Buffer.alloc(32, 0xdd);
    const payload = createHash('blake2b512')
      .update(rootPostHash)
      .update(subtreeMerkleRoot)
      .digest()
      .subarray(0, 32);

    const signature = sign(null, payload, privateKey);

    const keyObject = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: rawOther.toString('base64url') },
      format: 'jwk',
    });

    const valid = verify(null, payload, keyObject, signature);
    expect(valid).toBe(false);
  });
});
