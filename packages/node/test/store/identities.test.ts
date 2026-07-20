import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

// Module-level state in db.ts requires reset between tests.
async function importFresh() {
  const mod = await import('../../src/store/identities.js');
  return mod as {
    insertIdentity: (userId: string, publicKey: Uint8Array) => void;
    getIdentity: (userId: string) => { userId: string; publicKey: Uint8Array; createdAt: number } | null;
  };
}

async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database;
    closeDb: () => void;
  };
}

function makePublicKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

describe('identities store', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('insertIdentity stores a row and getIdentity returns it', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertIdentity, getIdentity } = await importFresh();

    initDb(':memory:');

    const pubKey = makePublicKey();
    insertIdentity('alice', pubKey);

    const result = getIdentity('alice');
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('alice');
    expect(result!.publicKey).toEqual(pubKey);
    expect(result!.createdAt).toBeGreaterThan(0);
  });

  it('getIdentity returns null for unknown userId', async () => {
    const { initDb } = await importDbFresh();
    const { getIdentity } = await importFresh();

    initDb(':memory:');

    const result = getIdentity('nonexistent');
    expect(result).toBeNull();
  });

  it('insertIdentity throws on duplicate userId', async () => {
    const { initDb } = await importDbFresh();
    const { insertIdentity } = await importFresh();

    initDb(':memory:');

    insertIdentity('bob', makePublicKey());
    expect(() => insertIdentity('bob', makePublicKey())).toThrow();
  });

  it('returned publicKey is 32 raw bytes', async () => {
    const { initDb } = await importDbFresh();
    const { insertIdentity, getIdentity } = await importFresh();

    initDb(':memory:');

    const pubKey = makePublicKey();
    insertIdentity('carol', pubKey);

    const result = getIdentity('carol');
    expect(result).not.toBeNull();
    expect(result!.publicKey).toBeInstanceOf(Uint8Array);
    expect(result!.publicKey.length).toBe(32);
  });

  it('returned createdAt is a number > 0', async () => {
    const { initDb } = await importDbFresh();
    const { insertIdentity, getIdentity } = await importFresh();

    initDb(':memory:');

    insertIdentity('dave', makePublicKey());

    const result = getIdentity('dave');
    expect(result).not.toBeNull();
    expect(typeof result!.createdAt).toBe('number');
    expect(result!.createdAt).toBeGreaterThan(0);
    // createdAt should be a reasonable unix timestamp (after 2020-01-01)
    expect(result!.createdAt).toBeGreaterThan(1577836800);
  });
});
