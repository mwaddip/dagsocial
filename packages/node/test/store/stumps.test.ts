import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { Stump, KarmaDelta } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dynamic import helpers
// ---------------------------------------------------------------------------

async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database;
    closeDb: () => void;
  };
}

async function importStumpsFresh() {
  const mod = await import('../../src/store/stumps.js');
  return mod as {
    insertStump: (stump: Stump) => void;
    getStump: (stumpId: string) => Stump | null;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStump(overrides: Partial<Stump> = {}): Stump {
  return {
    rootPostHash: 'root-post-hash-abc123',
    subtreeMerkleRoot: new Uint8Array(32).fill(0x11),
    authorId: 'author-alice',
    pruneSignature: new Uint8Array(64).fill(0x22),
    karmaDeltas: [
      { userId: 'user-1', delta: 10 },
      { userId: 'user-2', delta: -5 },
    ] satisfies KarmaDelta[],
    replyCount: 3,
    upvoteCount: 7,
    trigger: 'author',
    protocolVersion: 1,
    compactedAtBlockHeight: 42,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stumps store', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('insertStump + getStump round-trip (all fields including karmaDeltas)', async () => {
    const { initDb } = await importDbFresh();
    const { insertStump, getStump } = await importStumpsFresh();
    const { computeStumpId } = await import('@dagsocial/types');

    initDb(':memory:');

    const stump = makeStump({
      rootPostHash: 'hash-roundtrip',
      subtreeMerkleRoot: new Uint8Array(32).fill(0x33),
      authorId: 'author-bob',
      pruneSignature: new Uint8Array(64).fill(0x44),
      karmaDeltas: [{ userId: 'user-x', delta: 100 }],
      replyCount: 5,
      upvoteCount: 12,
      trigger: 'drep',
      protocolVersion: 1,
      compactedAtBlockHeight: 99,
    });

    const stumpId = computeStumpId(stump);
    insertStump(stump);

    const result = getStump(stumpId);
    expect(result).not.toBeNull();
    expect(result!.rootPostHash).toBe('hash-roundtrip');
    expect(result!.subtreeMerkleRoot).toEqual(new Uint8Array(32).fill(0x33));
    expect(result!.authorId).toBe('author-bob');
    expect(result!.pruneSignature).toEqual(new Uint8Array(64).fill(0x44));
    expect(result!.karmaDeltas).toEqual([{ userId: 'user-x', delta: 100 }]);
    expect(result!.replyCount).toBe(5);
    expect(result!.upvoteCount).toBe(12);
    expect(result!.trigger).toBe('drep');
    expect(result!.protocolVersion).toBe(1);
    expect(result!.compactedAtBlockHeight).toBe(99);
  });

  it('getStump returns null for unknown id', async () => {
    const { initDb } = await importDbFresh();
    const { getStump } = await importStumpsFresh();

    initDb(':memory:');

    const result = getStump('nonexistent-stump-id');
    expect(result).toBeNull();
  });
});
