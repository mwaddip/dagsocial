import { createHash } from 'crypto';

export function countLeadingZeroBits(buffer: Buffer): number {
  let bits = 0;
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i]!;
    if (byte === 0) {
      bits += 8;
    } else {
      let mask = 0x80;
      while ((byte & mask) === 0) {
        bits++;
        mask >>= 1;
      }
      break;
    }
  }
  return bits;
}

export function verifyPoW(challenge: string, nonce: number, targetBits: number): boolean {
  const hash = createHash('blake2b512')
    .update(challenge)
    .update(String(nonce))
    .digest()
    .subarray(0, 32);
  return countLeadingZeroBits(hash) >= targetBits;
}

export function solvePoW(challenge: string, targetBits: number): number {
  let nonce = 0;
  while (true) {
    if (verifyPoW(challenge, nonce, targetBits)) return nonce;
    nonce++;
  }
}
