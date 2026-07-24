import { describe, it, expect } from 'vitest';
import { leafHash, nodeHash, buildMerkleRoot } from '../src/merkle.js';

const data1 = new Uint8Array([1, 2, 3, 4]);
const data2 = new Uint8Array([5, 6, 7, 8]);
const data3 = new Uint8Array([9, 10, 11, 12]);

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
});
