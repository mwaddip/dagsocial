import { describe, it, expect } from 'vitest';
import { computePruneEntryId, serializePruneEntry } from '../src/stump.js';
import type { PruneEntry } from '../src/stump.js';
import { decode } from 'cbor-x';

function makeEntry(overrides?: Partial<PruneEntry>): PruneEntry {
  return {
    rootPostHash: 'a'.repeat(64),
    subtreePostIds: ['b'.repeat(64), 'c'.repeat(64)],
    subtreeMerkleRoot: new Uint8Array(32).fill(0xdd),
    authorId: new Uint8Array(32).fill(0xaa),
    authorSignature: new Uint8Array(64).fill(0xbb),
    trigger: 'author',
    ...overrides,
  };
}

describe('PruneEntry', () => {
  it('computePruneEntryId produces 64-char hex', () => {
    const entry = makeEntry();
    const id = computePruneEntryId(entry);
    expect(id).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(id)).toBe(true);
  });

  it('computePruneEntryId is deterministic', () => {
    const a = makeEntry();
    const b = makeEntry();
    expect(computePruneEntryId(a)).toBe(computePruneEntryId(b));
  });

  it('computePruneEntryId changes with different rootPostHash', () => {
    const a = makeEntry();
    const b = makeEntry({ rootPostHash: 'd'.repeat(64) });
    expect(computePruneEntryId(a)).not.toBe(computePruneEntryId(b));
  });

  it('serializePruneEntry round-trips via CBOR', () => {
    const entry = makeEntry();
    const bytes = serializePruneEntry(entry);
    const decoded = decode(bytes);
    expect(decoded.rootPostHash).toBe(entry.rootPostHash);
    expect(decoded.subtreePostIds).toEqual(entry.subtreePostIds);
    expect(decoded.trigger).toBe('author');
  });

  it('serializePruneEntry is deterministic', () => {
    const a = makeEntry();
    const b = makeEntry();
    expect(Buffer.from(serializePruneEntry(a)).equals(
      Buffer.from(serializePruneEntry(b)))).toBe(true);
  });

  it('serializePruneEntry changes with different subtreePostIds', () => {
    const a = makeEntry();
    const b = makeEntry({ subtreePostIds: ['e'.repeat(64)] });
    expect(Buffer.from(serializePruneEntry(a)).equals(
      Buffer.from(serializePruneEntry(b)))).toBe(false);
  });
});
