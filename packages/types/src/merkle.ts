import { createHash } from 'crypto';

/**
 * Domain-separated leaf hash for Merkle trees.
 * Prevents cross-tree collision (a subBlock ID hash can't collide with a
 * UTXO tx ID hash even if the underlying bytes match).
 */
export function leafHash(domain: string, data: Uint8Array): Uint8Array {
  const domainBytes = Buffer.from(domain + '\0', 'utf8') as unknown as Uint8Array;
  const hash = createHash('blake2b512')
    .update(domainBytes)
    .update(Buffer.from(data) as unknown as Uint8Array)
    .digest();
  return new Uint8Array(hash.subarray(0, 32));
}

/**
 * Hash of two child nodes in the Merkle tree.
 */
export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  const hash = createHash('blake2b512')
    .update(Buffer.from(left) as unknown as Uint8Array)
    .update(Buffer.from(right) as unknown as Uint8Array)
    .digest();
  return new Uint8Array(hash.subarray(0, 32));
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
