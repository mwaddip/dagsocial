import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { leafHash, nodeHash, buildMerkleRoot } from '../src/merkle.js';

const data1 = new Uint8Array([1, 2, 3, 4]);
const data2 = new Uint8Array([5, 6, 7, 8]);
const data3 = new Uint8Array([9, 10, 11, 12]);

function blake2b256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash('blake2b512');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest().subarray(0, 32));
}

/** The pre-L-9 untagged internal-node hash — kept only to prove it was forgeable. */
function untaggedNodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return blake2b256(left, right);
}

/** Untagged buildMerkleRoot, mirroring the pre-L-9 tree shape exactly. */
function untaggedMerkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(32);
  let level = leaves;
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? untaggedNodeHash(level[i]!, level[i + 1]!) : level[i]!);
    }
    level = next;
  }
  return level[0]!;
}

describe('leafHash', () => {
  it('produces 32 bytes', () => {
    const h = leafHash('test', data1);
    expect(h).toBeInstanceOf(Uint8Array);
    expect(h.length).toBe(32);
  });

  it('is deterministic', () => {
    const a = leafHash('test', data1);
    const b = leafHash('test', data1);
    expect(a).toEqual(b);
  });

  it('different domains produce different hashes for same data', () => {
    const a = leafHash('domain-a', data1);
    const b = leafHash('domain-b', data1);
    expect(a).not.toEqual(b);
  });

  it('different data with same domain produce different hashes', () => {
    const a = leafHash('test', data1);
    const b = leafHash('test', data2);
    expect(a).not.toEqual(b);
  });
});

describe('nodeHash', () => {
  it('produces 32 bytes', () => {
    const h = nodeHash(data1, data2);
    expect(h).toBeInstanceOf(Uint8Array);
    expect(h.length).toBe(32);
  });

  it('is deterministic', () => {
    const a = nodeHash(data1, data2);
    const b = nodeHash(data1, data2);
    expect(a).toEqual(b);
  });

  it('order matters (left vs right swap produces different hash)', () => {
    const a = nodeHash(data1, data2);
    const b = nodeHash(data2, data1);
    expect(a).not.toEqual(b);
  });

  it('is domain-tagged with a single 0x00 byte', () => {
    expect(nodeHash(data1, data2)).toEqual(
      blake2b256(Uint8Array.of(0x00), data1, data2),
    );
  });
});

describe('leaf/node domain separation (L-9)', () => {
  // A leaf preimage is `utf8(domain + "\0") ‖ data`. Pick a data length that
  // makes the whole preimage exactly 64 bytes, then split it in half: without a
  // node tag, that pair of halves hashes to the very same digest as the leaf, so
  // a leaf can be re-presented as an internal node (second-preimage → forged
  // inclusion proof).
  const domain = 'stump';
  const prefixLen = new TextEncoder().encode(domain + '\0').length;
  const leafData = new Uint8Array(64 - prefixLen).map((_, i) => (i * 7 + 3) & 0xff);
  const preimage = new Uint8Array(64);
  preimage.set(new TextEncoder().encode(domain + '\0'), 0);
  preimage.set(leafData, prefixLen);
  const left = preimage.subarray(0, 32);
  const right = preimage.subarray(32, 64);

  it('the untagged construction was forgeable (vacuity guard)', () => {
    expect(untaggedNodeHash(left, right)).toEqual(leafHash(domain, leafData));
  });

  it('a leaf and an internal node over the same bytes now differ', () => {
    expect(nodeHash(left, right)).not.toEqual(leafHash(domain, leafData));
  });

  it('no leaf domain in use can begin with the node tag', () => {
    // Every leafHash call site in the monorepo passes one of these literals.
    for (const d of ['stump', 'subblock', 'prune', 'utxotx', 'likebox', 'coinbase', 'epoch']) {
      expect(new TextEncoder().encode(d + '\0')[0]).not.toBe(0x00);
    }
  });
});

describe('buildMerkleRoot', () => {
  it('empty tree returns 32 zero bytes', () => {
    const root = buildMerkleRoot([]);
    expect(root).toBeInstanceOf(Uint8Array);
    expect(root.length).toBe(32);
    expect(root).toEqual(new Uint8Array(32));
  });

  it('single leaf returns that same leaf', () => {
    const leaf = leafHash('t', data1);
    const root = buildMerkleRoot([leaf]);
    expect(root).toEqual(leaf);
  });

  it('2 leaves produce correct root', () => {
    const leaf1 = leafHash('t', data1);
    const leaf2 = leafHash('t', data2);
    const expectedRoot = nodeHash(leaf1, leaf2);
    const root = buildMerkleRoot([leaf1, leaf2]);
    expect(root).toEqual(expectedRoot);
  });

  it('3 leaves (odd count) promotion works', () => {
    const leaf1 = leafHash('t', data1);
    const leaf2 = leafHash('t', data2);
    const leaf3 = leafHash('t', data3);
    // With 3 leaves: h1,h2 pair hashed, h3 promoted, then pair of that
    const expectedRoot = nodeHash(nodeHash(leaf1, leaf2), leaf3);
    const root = buildMerkleRoot([leaf1, leaf2, leaf3]);
    expect(root).toEqual(expectedRoot);
  });

  it('4 leaves produce correct root', () => {
    const leaves = [
      leafHash('t', data1),
      leafHash('t', data2),
      leafHash('t', data3),
      leafHash('t', new Uint8Array([13, 14, 15, 16])),
    ];
    const leftPair = nodeHash(leaves[0]!, leaves[1]!);
    const rightPair = nodeHash(leaves[2]!, leaves[3]!);
    const expectedRoot = nodeHash(leftPair, rightPair);
    const root = buildMerkleRoot(leaves);
    expect(root).toEqual(expectedRoot);
  });

  it('5 leaves (odd at both levels) produces consistent root', () => {
    const leaves = [
      leafHash('t', data1),
      leafHash('t', data2),
      leafHash('t', data3),
      leafHash('t', new Uint8Array([13, 14, 15, 16])),
      leafHash('t', new Uint8Array([17, 18, 19, 20])),
    ];
    const root = buildMerkleRoot(leaves);
    // Level 0 → Level 1 (3 nodes): nodeHash(h0,h1), nodeHash(h2,h3), h4
    // Level 1 → Level 2 (2 nodes): nodeHash(prev0, prev1), prev2
    // Level 2 → root: nodeHash(prev0, prev1)
    const l1_0 = nodeHash(leaves[0]!, leaves[1]!);
    const l1_1 = nodeHash(leaves[2]!, leaves[3]!);
    const l1_2 = leaves[4]!; // promoted
    const l2_0 = nodeHash(l1_0, l1_1);
    const l2_1 = l1_2; // promoted
    const expectedRoot = nodeHash(l2_0, l2_1);
    expect(root).toEqual(expectedRoot);
  });

  it('roots differ from the pre-L-9 untagged tree (vacuity guard)', () => {
    for (const count of [2, 3, 4, 5, 8]) {
      const leaves = Array.from({ length: count }, (_, i) =>
        leafHash('subblock', new Uint8Array([i, i + 1, i + 2, i + 3])),
      );
      expect(buildMerkleRoot(leaves)).not.toEqual(untaggedMerkleRoot(leaves));
    }
  });

  it('degenerate trees are unaffected by the tag (no internal node exists)', () => {
    const leaf = leafHash('subblock', data1);
    expect(buildMerkleRoot([])).toEqual(untaggedMerkleRoot([]));
    expect(buildMerkleRoot([leaf])).toEqual(untaggedMerkleRoot([leaf]));
  });
});
