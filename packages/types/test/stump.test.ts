import { describe, it, expect } from 'vitest';
import { computePruneEntryId, serializePruneEntry } from '../src/stump.js';
import type { PruneEntry } from '../src/stump.js';

const sig64 = new Uint8Array(64).fill(0xcd);
const merkleRoot32 = new Uint8Array(32).fill(0x11);
// A UserId is 32 raw bytes — an Ed25519 public key, never a display string.
const authorKey = new Uint8Array(32).fill(0x44);
const otherAuthorKey = new Uint8Array(32).fill(0x55);

function makePruneEntry(overrides: Partial<PruneEntry> = {}): PruneEntry {
  return {
    rootPostHash: 'a'.repeat(64),
    subtreePostIds: ['bb'.repeat(32), 'cc'.repeat(32)],
    subtreeMerkleRoot: merkleRoot32,
    authorId: authorKey,
    authorSignature: sig64,
    trigger: 'author',
    ...overrides,
  };
}

describe('stump', () => {
  describe('computePruneEntryId', () => {
    it('returns a 64-char hex string', () => {
      const id = computePruneEntryId(makePruneEntry());
      expect(typeof id).toBe('string');
      expect(id).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(id)).toBe(true);
    });

    it('is deterministic', () => {
      const entry = makePruneEntry();
      expect(computePruneEntryId(entry)).toBe(computePruneEntryId(entry));
    });

    it('changes with different rootPostHash', () => {
      const a = makePruneEntry();
      const b = makePruneEntry({ rootPostHash: 'b'.repeat(64) });
      expect(computePruneEntryId(a)).not.toBe(computePruneEntryId(b));
    });

    it('changes with different subtreeMerkleRoot', () => {
      const a = makePruneEntry();
      const b = makePruneEntry({ subtreeMerkleRoot: new Uint8Array(32).fill(0x22) });
      expect(computePruneEntryId(a)).not.toBe(computePruneEntryId(b));
    });

    it('changes with different authorId', () => {
      const a = makePruneEntry();
      const b = makePruneEntry({ authorId: otherAuthorKey });
      expect(computePruneEntryId(a)).not.toBe(computePruneEntryId(b));
    });
  });

  describe('serializePruneEntry', () => {
    it('returns Uint8Array', () => {
      const bytes = serializePruneEntry(makePruneEntry());
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(0);
    });

    it('is deterministic', () => {
      const entry = makePruneEntry();
      const a = serializePruneEntry(entry);
      const b = serializePruneEntry(entry);
      expect(Buffer.compare(a, b)).toBe(0);
    });

    it('changes with different subtreePostIds', () => {
      const a = makePruneEntry();
      const b = makePruneEntry({ subtreePostIds: ['dd'.repeat(32)] });
      expect(Buffer.compare(serializePruneEntry(a), serializePruneEntry(b))).not.toBe(0);
    });

    it('changes with different trigger', () => {
      const a = makePruneEntry();
      const b = makePruneEntry({ trigger: 'storage_prune' });
      expect(Buffer.compare(serializePruneEntry(a), serializePruneEntry(b))).not.toBe(0);
    });
  });
});
