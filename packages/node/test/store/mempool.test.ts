import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SubBlock } from '@dagsocial/types';
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
    insertSubBlock: (subBlock: SubBlock, expiresAtHeight: number, batchId?: string | null) => number;
    insertUtxoTx: (tx: any, batchId: string | null, expiresAtHeight: number) => number;
    getPendingEntries: (limit: number) => any[];
    purgeExpired: (currentHeight: number) => number;
    removeEntry: (rowid: number) => void;
    removeBatch: (batchId: string) => void;
  };
}

function makeSubBlock(overrides?: Partial<SubBlock>): SubBlock {
  return {
    subBlockId: 'sb_test1',
    post: {
      id: 'post_test1',
      content: 'hello',
      author: new Uint8Array(32).fill(1),
      parentRefs: [],
      challenge: new Uint8Array(32).fill(2),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: Date.now(),
      signature: new Uint8Array(64),
    },
    likeBoxes: [],
    producerId: new Uint8Array(32).fill(3),
    protocolVersion: 1,
    ...overrides,
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
    const sb = makeSubBlock();

    const rowid = insertSubBlock(sb, 100); // expires at height 100
    const entries = getPendingEntries(10);

    expect(entries).toHaveLength(1);
    expect(entries[0].rowid).toBe(rowid);
    expect(entries[0].entryType).toBe('subblock');
    expect(entries[0].subblockCbor).toBeInstanceOf(Uint8Array);
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
    const sb = makeSubBlock({ subBlockId: 'sb_batch' });

    insertSubBlock(sb, 50, 'batch-abc');
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
      insertSubBlock(makeSubBlock({ subBlockId: `sb_${i}` }), 100);
    }

    const entries = getPendingEntries(3);
    expect(entries).toHaveLength(3);
  });

  it('getPendingEntries returns entries in FIFO order by rowid', async () => {
    const { insertSubBlock, getPendingEntries } = await importMempoolFresh();

    insertSubBlock(makeSubBlock({ subBlockId: 'first' }), 100);
    insertSubBlock(makeSubBlock({ subBlockId: 'second' }), 100);
    insertSubBlock(makeSubBlock({ subBlockId: 'third' }), 100);

    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(3);
    // rowid should be ascending
    expect(entries[0].rowid).toBeLessThan(entries[1].rowid);
    expect(entries[1].rowid).toBeLessThan(entries[2].rowid);
  });

  it('purgeExpired removes entries with expires_at_height < currentHeight', async () => {
    const { insertSubBlock, insertUtxoTx, getPendingEntries, purgeExpired } =
      await importMempoolFresh();

    insertSubBlock(makeSubBlock({ subBlockId: 'sb_expired' }), 10);
    insertSubBlock(makeSubBlock({ subBlockId: 'sb_valid' }), 50);
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

    insertSubBlock(makeSubBlock({ subBlockId: 'a' }), 10);
    insertSubBlock(makeSubBlock({ subBlockId: 'b' }), 20);
    insertSubBlock(makeSubBlock({ subBlockId: 'c' }), 30);

    const removed = purgeExpired(25);
    expect(removed).toBe(2); // a (10) and b (20) — both < 25
  });

  it('removeEntry removes a specific row by rowid', async () => {
    const { insertSubBlock, getPendingEntries, removeEntry } = await importMempoolFresh();

    const rowid1 = insertSubBlock(makeSubBlock({ subBlockId: 'keep' }), 100);
    const rowid2 = insertSubBlock(makeSubBlock({ subBlockId: 'remove' }), 100);

    removeEntry(rowid2);

    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].rowid).toBe(rowid1);
  });

  it('removeBatch removes all entries with a given batchId', async () => {
    const { insertSubBlock, insertUtxoTx, getPendingEntries, removeBatch } =
      await importMempoolFresh();

    const tx = { inputs: ['box4'], outputs: [], signatures: {}, protocolVersion: 1 };

    insertSubBlock(makeSubBlock({ subBlockId: 'batch_a1' }), 100, 'batch-a');
    insertUtxoTx(tx as any, 'batch-a', 100);
    insertSubBlock(makeSubBlock({ subBlockId: 'batch_b1' }), 100, 'batch-b');

    removeBatch('batch-a');

    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].batchId).toBe('batch-b');
  });

  it('handles multiple entries of mixed types', async () => {
    const { insertSubBlock, insertUtxoTx, getPendingEntries } = await importMempoolFresh();
    const tx = { inputs: ['box5'], outputs: [], signatures: {}, protocolVersion: 1 };

    insertSubBlock(makeSubBlock({ subBlockId: 'sb1' }), 100);
    insertUtxoTx(tx as any, null, 100);
    insertSubBlock(makeSubBlock({ subBlockId: 'sb2' }), 100);

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
    insertSubBlock(makeSubBlock({ subBlockId: 'sb_limit0' }), 100);
    const entries = getPendingEntries(0);
    expect(entries).toEqual([]);
  });

  it('purgeExpired returns 0 when nothing to purge', async () => {
    const { insertSubBlock, purgeExpired } = await importMempoolFresh();
    insertSubBlock(makeSubBlock(), 100);
    const removed = purgeExpired(50); // nothing < 50
    expect(removed).toBe(0);
  });

  it('removeEntry is a no-op for a non-existent rowid', async () => {
    const { insertSubBlock, getPendingEntries, removeEntry } = await importMempoolFresh();
    insertSubBlock(makeSubBlock(), 100);
    removeEntry(9999); // should not throw
    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(1);
  });

  it('removeBatch is a no-op for a non-existent batchId', async () => {
    const { insertSubBlock, getPendingEntries, removeBatch } = await importMempoolFresh();
    insertSubBlock(makeSubBlock(), 100);
    removeBatch('nonexistent'); // should not throw
    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(1);
  });

  it('createdAt is set on insert', async () => {
    const { insertSubBlock, getPendingEntries } = await importMempoolFresh();
    insertSubBlock(makeSubBlock(), 100);
    const entries = getPendingEntries(10);
    expect(entries[0].createdAt).toBeTruthy();
    expect(typeof entries[0].createdAt).toBe('string');
  });
});
