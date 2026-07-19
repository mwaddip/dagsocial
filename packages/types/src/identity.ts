import { createHash, generateKeyPairSync } from 'crypto';
import { base58Encode } from './base58.js';

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export type UserId = string;

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  // Ed25519 SPKI DER wraps 32 raw key bytes at the end
  const pubBytes = new Uint8Array(pubDer.slice(pubDer.length - 32));
  return { publicKey: pubBytes, secretKey: new Uint8Array(privDer) };
}

export function getUserId(publicKey: Uint8Array): UserId {
  const hash = createHash('blake2b512').update(publicKey).digest();
  return base58Encode(new Uint8Array(hash.slice(0, 32)));
}
