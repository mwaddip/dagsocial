import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { uid } from '../helpers.js';

// Module-level state in db.ts requires reset between tests.
async function importFresh() {
  const mod = await import('../../src/store/challenges.js');
  return mod as {
    createChallenge: (
      userId: Uint8Array,
      challenge: Uint8Array,
      expiresAtBlock: number,
    ) => void;
    getActiveChallenge: (
      userId: Uint8Array,
    ) => { challenge: Uint8Array; expiresAtBlock: number; userId: Uint8Array } | null;
    consumeChallenge: (userId: Uint8Array, challenge: Uint8Array) => void;
  };
}

async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

function makeChallenge(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

describe('challenges store', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('createChallenge stores a row and getActiveChallenge returns it', async () => {
    const { initDb } = await importDbFresh();
    const { createChallenge, getActiveChallenge } = await importFresh();

    initDb(':memory:');

    const challenge = makeChallenge();
    const alice = uid('alice');
    createChallenge(alice, challenge, 100);

    const result = getActiveChallenge(alice);
    expect(result).not.toBeNull();
    expect(result!.challenge).toEqual(challenge);
    expect(result!.expiresAtBlock).toBe(100);
  });

  it('getActiveChallenge returns null for unknown userId', async () => {
    const { initDb } = await importDbFresh();
    const { getActiveChallenge } = await importFresh();

    initDb(':memory:');

    const result = getActiveChallenge(uid('nonexistent'));
    expect(result).toBeNull();
  });

  it('createChallenge overwrites existing (upsert — one per account, second create replaces first)', async () => {
    const { initDb } = await importDbFresh();
    const { createChallenge, getActiveChallenge } = await importFresh();

    initDb(':memory:');

    const bob = uid('bob');
    const first = makeChallenge();
    const second = makeChallenge();
    createChallenge(bob, first, 50);
    createChallenge(bob, second, 200);

    const result = getActiveChallenge(bob);
    expect(result).not.toBeNull();
    expect(result!.challenge).toEqual(second);
    expect(result!.expiresAtBlock).toBe(200);

    // Verify only one row exists
    const { getDb } = await importDbFresh();
    const rowCount = getDb()
      .prepare('SELECT COUNT(*) as count FROM challenges WHERE user_id = ?')
      .get(Buffer.from(bob)) as { count: number };
    expect(rowCount.count).toBe(1);
  });

  it('consumeChallenge deletes, subsequent getActiveChallenge returns null', async () => {
    const { initDb } = await importDbFresh();
    const { createChallenge, getActiveChallenge, consumeChallenge } =
      await importFresh();

    initDb(':memory:');

    const carol = uid('carol');
    const challenge = makeChallenge();
    createChallenge(carol, challenge, 100);

    // Verify it exists first
    expect(getActiveChallenge(carol)).not.toBeNull();

    consumeChallenge(carol, challenge);

    // After consumption, should be null
    expect(getActiveChallenge(carol)).toBeNull();
  });

  it('consumeChallenge throws if challenge bytes do not match stored', async () => {
    const { initDb } = await importDbFresh();
    const { createChallenge, consumeChallenge } = await importFresh();

    initDb(':memory:');

    const dave = uid('dave');
    const stored = makeChallenge();
    const wrong = makeChallenge();
    createChallenge(dave, stored, 100);

    expect(() => consumeChallenge(dave, wrong)).toThrow(
      /challenge bytes mismatch/,
    );
  });
});
