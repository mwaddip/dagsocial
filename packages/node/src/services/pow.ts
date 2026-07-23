import { randomBytes } from 'crypto';

export { verifyPoW } from '@dagsocial/validation';

export function generateChallenge(): Uint8Array {
  return randomBytes(32);
}
