import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';

// Dynamic import pattern — fresh modules per test
async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database;
    closeDb: () => void;
  };
}

async function importMempoolFresh() {
  const mod = await import('../../src/store/mempool.js');
  return mod as {
    insertSubBlock: (postId: string, expiresAtHeight: number, batchId?: string | null) => number;
    insertUtxoTx: (tx: any, batchId: string | null, expiresAtHeight: number) => number;
    getPendingEntries: (limit: number) => any[];
    purgeExpired: (currentHeight: number) => number;
    removeEntry: (rowid: number) => void;
  };
}

describe('mempool store', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await importDbFresh();
    db.initDb(':memory:');
  });

  afterEach(async () => {
    const db = await importDbFresh();
    db.closeDb();
  });

  it('inserts a subblock and retrieves it via getPendingEntries', async () => {
    const { insertSubBlock, getPendingEntries } = await importMempoolFresh();

    const rowid = insertSubBlock('post_test1', 100); // expires at height 100
    const entries = getPendingEntries(10);

    expect(entries).toHaveLength(1);
    expect(entries[0].rowid).toBe(rowid);
    expect(entries[0].entryType).toBe('subblock');
    expect(entries[0].subblockId).toBe('post_test1');
    expect(entries[0].utxoTxCbor).toBeNull();
    expect(entries[0].batchId).toBeNull();
    expect(entries[0].expiresAtHeight).toBe(100);
  });

  it('inserts a UTXO transaction and retrieves it', async () => {
    const { insertUtxoTx, getPendingEntries } = await importMempoolFresh();
    const tx = {
      inputs: ['box1'],
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    };

    insertUtxoTx(tx as any, null, 200);
    const entries = getPendingEntries(10);

    expect(entries).toHaveLength(1);
    expect(entries[0].entryType).toBe('utxo_tx');
    expect(entries[0].utxoTxCbor).toBeInstanceOf(Uint8Array);
    expect(entries[0].expiresAtHeight).toBe(200);
  });

  it('inserts a subblock with batchId and retrieves it', async () => {
    const { insertSubBlock, getPendingEntries } = await importMempoolFresh();

    insertSubBlock('sb_batch', 50, 'batch-abc');
    const entries = getPendingEntries(10);

    expect(entries).toHaveLength(1);
    expect(entries[0].batchId).toBe('batch-abc');
    expect(entries[0].entryType).toBe('subblock');
  });

  it('inserts a UTXO tx with batchId and retrieves it', async () => {
    const { insertUtxoTx, getPendingEntries } = await importMempoolFresh();
    const tx = {
      inputs: ['box2'],
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    };

    insertUtxoTx(tx as any, 'batch-xyz', 75);
    const entries = getPendingEntries(10);

    expect(entries).toHaveLength(1);
    expect(entries[0].batchId).toBe('batch-xyz');
    expect(entries[0].entryType).toBe('utxo_tx');
  });

  it('getPendingEntries respects limit', async () => {
    const { insertSubBlock, getPendingEntries } = await importMempoolFresh();

    for (let i = 0; i < 5; i++) {
      insertSubBlock(`sb_${i}`, 100);
    }

    const entries = getPendingEntries(3);
    expect(entries).toHaveLength(3);
  });

  it('getPendingEntries returns entries in FIFO order by rowid', async () => {
    const { insertSubBlock, getPendingEntries } = await importMempoolFresh();

    insertSubBlock('first', 100);
    insertSubBlock('second', 100);
    insertSubBlock('third', 100);

    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(3);
    // rowid should be ascending
    expect(entries[0].rowid).toBeLessThan(entries[1].rowid);
    expect(entries[1].rowid).toBeLessThan(entries[2].rowid);
  });

  it('purgeExpired removes entries with expires_at_height < currentHeight', async () => {
    const { insertSubBlock, insertUtxoTx, getPendingEntries, purgeExpired } =
      await importMempoolFresh();

    insertSubBlock('sb_expired', 10);
    insertSubBlock('sb_valid', 50);
    const tx = { inputs: ['box3'], outputs: [], signatures: {}, protocolVersion: 1 };
    insertUtxoTx(tx as any, null, 30);

    const removed = purgeExpired(25); // removes entries with expires_at_height < 25
    expect(removed).toBe(1); // only sb_expired at 10; sb_valid at 50 and tx at 30 are kept

    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(2); // sb_valid + tx
    const entryTypes = entries.map((e) => e.entryType);
    expect(entryTypes).toContain('subblock');
    expect(entryTypes).toContain('utxo_tx');
  });

  it('purgeExpired returns count of removed entries', async () => {
    const { insertSubBlock, purgeExpired } = await importMempoolFresh();

    insertSubBlock('a', 10);
    insertSubBlock('b', 20);
    insertSubBlock('c', 30);

    const removed = purgeExpired(25);
    expect(removed).toBe(2); // a (10) and b (20) — both < 25
  });

  it('removeEntry removes a specific row by rowid', async () => {
    const { insertSubBlock, getPendingEntries, removeEntry } = await importMempoolFresh();

    const rowid1 = insertSubBlock('keep', 100);
    const rowid2 = insertSubBlock('remove', 100);

    removeEntry(rowid2);

    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].rowid).toBe(rowid1);
  });

  it('handles multiple entries of mixed types', async () => {
    const { insertSubBlock, insertUtxoTx, getPendingEntries } = await importMempoolFresh();
    const tx = { inputs: ['box5'], outputs: [], signatures: {}, protocolVersion: 1 };

    insertSubBlock('sb1', 100);
    insertUtxoTx(tx as any, null, 100);
    insertSubBlock('sb2', 100);

    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(3);

    const types = entries.map((e) => e.entryType);
    expect(types).toEqual(['subblock', 'utxo_tx', 'subblock']);
  });

  it('getPendingEntries returns empty array when mempool is empty', async () => {
    const { getPendingEntries } = await importMempoolFresh();
    const entries = getPendingEntries(10);
    expect(entries).toEqual([]);
  });

  it('getPendingEntries with limit 0 returns empty array', async () => {
    const { insertSubBlock, getPendingEntries } = await importMempoolFresh();
    insertSubBlock('sb_limit0', 100);
    const entries = getPendingEntries(0);
    expect(entries).toEqual([]);
  });

  it('purgeExpired returns 0 when nothing to purge', async () => {
    const { insertSubBlock, purgeExpired } = await importMempoolFresh();
    insertSubBlock('sb_nopurge', 100);
    const removed = purgeExpired(50); // nothing < 50
    expect(removed).toBe(0);
  });

  it('removeEntry is a no-op for a non-existent rowid', async () => {
    const { insertSubBlock, getPendingEntries, removeEntry } = await importMempoolFresh();
    insertSubBlock('sb_remove_noop', 100);
    removeEntry(9999); // should not throw
    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(1);
  });

  it('createdAt is set on insert', async () => {
    const { insertSubBlock, getPendingEntries } = await importMempoolFresh();
    insertSubBlock('sb_createdat', 100);
    const entries = getPendingEntries(10);
    expect(entries[0].createdAt).toBeTruthy();
    expect(typeof entries[0].createdAt).toBe('string');
  });

  it('subblock entry has subblockId set and utxoTxCbor null', async () => {
    const { insertSubBlock, getPendingEntries } = await importMempoolFresh();
    insertSubBlock('post_abc123', 200);
    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].entryType).toBe('subblock');
    expect(entries[0].subblockId).toBe('post_abc123');
    expect(entries[0].utxoTxCbor).toBeNull();
  });

  it('utxo_tx entry has subblockId null and utxoTxCbor set', async () => {
    const { insertUtxoTx, getPendingEntries } = await importMempoolFresh();
    const tx = { inputs: ['box99'], outputs: [], signatures: {}, protocolVersion: 1 };
    insertUtxoTx(tx as any, null, 300);
    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].entryType).toBe('utxo_tx');
    expect(entries[0].subblockId).toBeNull();
    expect(entries[0].utxoTxCbor).toBeInstanceOf(Uint8Array);
  });
});
