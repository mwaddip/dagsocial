import { createHash } from 'crypto';

/**
 * Convert a hex string to a Buffer, validating even length first.
 * Buffer.from(hex, 'hex') silently truncates odd-length strings by ignoring
 * the last nibble, which can hide data corruption.
 */
export function hexToBuf(hex: string): Buffer {
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBuf: odd hex length (${hex.length}) for "${hex.slice(0, 24)}..."`);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Domain-separated leaf hash for Merkle trees.
 * Prevents cross-tree collision (a subBlock ID hash can't collide with a
 * UTXO tx ID hash even if the underlying bytes match).
 */
export function leafHash(domain: string, data: Uint8Array): Uint8Array {
  const domainBytes = new TextEncoder().encode(domain + '\0');
  const hash = createHash('blake2b512')
    .update(domainBytes)
    .update(data)
    .digest()
    .subarray(0, 32);
  return new Uint8Array(hash);
}

/**
 * Hash of two child nodes in the Merkle tree.
 */
export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  const hash = createHash('blake2b512')
    .update(left)
    .update(right)
    .digest()
    .subarray(0, 32);
  return new Uint8Array(hash);
}

/**
 * Build a standard binary Merkle root from an ordered list of leaf hashes.
 * Empty tree → 32 zero bytes. Single leaf → that leaf IS the root.
 */
export function buildMerkleRoot(leafHashes: Uint8Array[]): Uint8Array {
  if (leafHashes.length === 0) {
    return new Uint8Array(32);
  }
  if (leafHashes.length === 1) {
    return leafHashes[0]!;
  }
  let level = leafHashes;
  while (level.length > 1) {
    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        nextLevel.push(nodeHash(level[i]!, level[i + 1]!));
      } else {
        nextLevel.push(level[i]!);
      }
    }
    level = nextLevel;
  }
  return level[0]!;
}
