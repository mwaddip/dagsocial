import { uid } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { Stump } from '@dagsocial/types';

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
    authorId: uid('author-alice'),
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

  it('insertStump + getStump round-trip (all fields)', async () => {
    const { initDb } = await importDbFresh();
    const { insertStump, getStump } = await importStumpsFresh();

    initDb(':memory:');

    const stump = makeStump({
      rootPostHash: 'hash-roundtrip',
      authorId: uid('author-bob'),
      replyCount: 5,
      upvoteCount: 12,
      trigger: 'storage_prune',
      protocolVersion: 1,
      compactedAtBlockHeight: 99,
    });

    insertStump(stump);

    // stump ID is rootPostHash
    const stumpId = stump.rootPostHash;
    const result = getStump(stumpId);
    expect(result).not.toBeNull();
    expect(result!.rootPostHash).toBe('hash-roundtrip');
    expect(result!.authorId).toEqual(uid('author-bob'));
    expect(result!.replyCount).toBe(5);
    expect(result!.upvoteCount).toBe(12);
    expect(result!.trigger).toBe('storage_prune');
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
