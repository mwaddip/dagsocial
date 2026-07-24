import { generateKeyPairSync } from 'crypto';

export interface KeyPair {
  publicKey: Uint8Array;  // 32 raw bytes — Ed25519 public key
  secretKey: Uint8Array;
}

/**
 * A DAGsocial user identity IS the 32-byte Ed25519 public key.
 * There is no separate "account" concept — the key is the identity.
 */
export type UserId = Uint8Array;

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  // Ed25519 SPKI DER wraps 32 raw key bytes at the end
  const pubBytes = new Uint8Array(pubDer.slice(pubDer.length - 32));
  return { publicKey: pubBytes, secretKey: new Uint8Array(privDer) };
}
