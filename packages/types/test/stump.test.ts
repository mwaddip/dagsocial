import { describe, it, expect } from 'vitest';
import { computeStumpId } from '../src/stump.js';
import type { Stump } from '../src/stump.js';

const sig64 = new Uint8Array(64).fill(0xcd);

function makeStump(overrides: Partial<Stump> = {}): Stump {
  return {
    rootPostHash: 'a'.repeat(64),
    subtreeMerkleRoot: new Uint8Array(32).fill(0x11),
    authorId: 'user456',
    pruneSignature: sig64,
    karmaDeltas: [
      { userId: 'user1', delta: 5 },
      { userId: 'user2', delta: -3 },
    ],
    replyCount: 7,
    upvoteCount: 12,
    trigger: 'author',
    protocolVersion: 2,
    compactedAtBlockHeight: 500,
    ...overrides,
  };
}

describe('stump', () => {
  describe('computeStumpId', () => {
    it('returns a 64-char hex string', () => {
      const id = computeStumpId(makeStump());
      expect(typeof id).toBe('string');
      expect(id).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(id)).toBe(true);
    });

    it('is deterministic', () => {
      const stump = makeStump();
      expect(computeStumpId(stump)).toBe(computeStumpId(stump));
    });

    it('changes with different rootPostHash', () => {
      const a = makeStump();
      const b = makeStump({ rootPostHash: 'b'.repeat(64) });
      expect(computeStumpId(a)).not.toBe(computeStumpId(b));
    });

    it('changes with different compactedAtBlockHeight', () => {
      const a = makeStump();
      const b = makeStump({ compactedAtBlockHeight: 999 });
      expect(computeStumpId(a)).not.toBe(computeStumpId(b));
    });

    it('changes with different authorId', () => {
      const a = makeStump();
      const b = makeStump({ authorId: 'different-author' });
      expect(computeStumpId(a)).not.toBe(computeStumpId(b));
    });
  });
});
