import { randomBytes, createHash } from 'crypto';

/**
 * Generate a 32-byte random challenge for PoW.
 * This is the anti-precomputation nonce issued by the node.
 */
export function generateChallenge(): Uint8Array {
  return randomBytes(32);
}

/**
 * Verify a Proof-of-Work solution.
 *
 * Algorithm:
 * 1. Encode `nonce` as an 8-byte little-endian unsigned integer
 * 2. Concatenate `input` || `nonceBytes`
 * 3. Hash with blake2b512, take first 32 bytes
 * 4. Check that the hash has at least `targetBits` leading zero bits
 *
 * @param input - The challenge input (content || author || parentRefs || challenge || protocolVersion || timestamp)
 * @param nonce - The PoW nonce found by the client
 * @param targetBits - Number of leading zero bits required
 * @returns true if the PoW solution is valid
 */
export function verifyPoW(input: Uint8Array, nonce: number, targetBits: number): boolean {
  // Encode nonce as 8-byte little-endian unsigned integer
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));

  const buf = Buffer.concat([Buffer.from(input), nonceBuf]);
  const hash = createHash('blake2b512').update(buf).digest().subarray(0, 32);

  // Check leading zero bits
  for (let i = 0; i < targetBits; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    if ((hash[byteIdx]! & (1 << bitIdx)) !== 0) {
      return false;
    }
  }
  return true;
}
