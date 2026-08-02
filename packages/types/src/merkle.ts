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
 * Domain tag prefixed to every internal Merkle node (L-9).
 *
 * `leafHash` prefixes its input with `utf8(domain + "\0")`, so every leaf
 * preimage begins with the first byte of a domain string. All in-tree domains
 * are printable ASCII ('stump', 'subblock', 'prune', 'utxotx', 'likebox',
 * 'coinbase', 'epoch'), so NUL can never start a leaf preimage — which makes
 * 0x00 a safe reserved tag for internal nodes. Any future leaf domain must
 * likewise be a non-empty printable string.
 *
 * Without the tag, `nodeHash(left, right)` is a bare hash of 64 concatenated
 * bytes, so a 64-byte leaf preimage could be re-presented as an internal node
 * to forge an inclusion proof (second-preimage).
 */
const NODE_TAG = Uint8Array.of(0x00);

/**
 * Hash of two child nodes in the Merkle tree: `blake2b512(NODE_TAG ‖ left ‖ right)[:32]`.
 *
 * Protocol-breaking relative to the untagged form — it changes every
 * `subBlockRoot` / `utxoTxRoot`. `PROTOCOL_VERSION` is unchanged; devnet DBs
 * are wiped on deploy. Producer (block-creator) and verifier (block-apply)
 * both derive roots through this function, so they stay in agreement.
 */
export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  const hash = createHash('blake2b512')
    .update(NODE_TAG)
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
