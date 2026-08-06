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
    removeSubBlockEntries: (postIds: string[]) => number;
    hasPendingLike: (targetPostId: string, likerId: string) => boolean;
    countPendingInvites: (inviterId: string) => number;
    hasPendingVouch: (voucherId: string) => boolean;
  };
}

/** Mempool store plus raw row access, for asserting the gate columns directly. */
async function importMempoolWithRow() {
  const mem = await importMempoolFresh();
  const { getDb } = await importDbFresh();
  return {
    ...mem,
    getDbRow: () =>
      (getDb() as any)
        .prepare('SELECT like_target, like_liker, invite_inviter, vouch_voucher FROM mempool')
        .get() as Record<string, string | null>,
  };
}

// ---------------------------------------------------------------------------
// Gate-metadata fixtures — hex ids as they are stored, and the minimal txs
// whose outputs the insert chokepoint lifts them from.
// ---------------------------------------------------------------------------

const TARGET = 'post_target_1';
const OTHER_TARGET = 'post_target_2';
const LIKER_A = 'aa'.repeat(32);
const LIKER_B = 'bb'.repeat(32);
const INVITER_A = 'cc'.repeat(32);
const INVITER_B = 'dd'.repeat(32);
const VOUCHER_A = 'ee'.repeat(32);
const VOUCHER_B = 'ff'.repeat(32);
const TARGET_ID = '11'.repeat(32);

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

function likeTx(targetPostId: string, likerHex: string) {
  return {
    inputs: [],
    outputs: [
      {
        boxType: 'like',
        value: 2,
        likerId: bytes(likerHex),
        targetPostId,
        guard: 'epoch_tally',
      },
    ],
    signatures: {},
    protocolVersion: 1,
  };
}

function inviteTx(inviterHex: string) {
  return {
    inputs: [],
    outputs: [
      {
        boxType: 'invite',
        value: 25,
        inviterId: bytes(inviterHex),
        secretHash: new Uint8Array(32),
        guard: 'hash_preimage_with_bond',
      },
    ],
    signatures: {},
    protocolVersion: 1,
  };
}

function vouchTx(voucherHex: string, targetHex: string) {
  return {
    inputs: [],
    outputs: [
      {
        boxType: 'vouch',
        value: 10,
        voucherId: bytes(voucherHex),
        targetId: bytes(targetHex),
        guard: 'owner_signature',
      },
    ],
    signatures: {},
    protocolVersion: 1,
  };
}

function pruneEntry(rootPostHash: string) {
  return {
    rootPostHash,
    trigger: 'author',
    authorId: new Uint8Array(32),
    subtreeMerkleRoot: new Uint8Array(32),
    subtreePostIds: [rootPostHash],
    signature: new Uint8Array(64),
    protocolVersion: 1,
  } as any;
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

  // -------------------------------------------------------------------------
  // Correctness gates (audit M-8)
  // -------------------------------------------------------------------------

  describe('gate metadata and correctness gates', () => {
    it('hasPendingLike sees a like inserted past any bounded scan', async () => {
      const { insertSubBlock, insertUtxoTx, hasPendingLike, getPendingEntries } =
        await importMempoolFresh();

      // Bury the like behind the 1000-row bound the old decode-scan used.
      for (let i = 0; i < 1000; i++) insertSubBlock(`filler_${i}`, 100);
      insertUtxoTx(likeTx(TARGET, LIKER_A) as any, null, 100);

      // Vacuity: the entry really is past the old scan's reach, so this test
      // fails against the fetch-1000-and-decode implementation.
      const scanned = getPendingEntries(1000);
      expect(scanned.some((e: any) => e.entryType === 'utxo_tx')).toBe(false);

      expect(hasPendingLike(TARGET, LIKER_A)).toBe(true);
      // Controls — a single-field delta in each direction.
      expect(hasPendingLike(TARGET, LIKER_B)).toBe(false);
      expect(hasPendingLike(OTHER_TARGET, LIKER_A)).toBe(false);
    });

    it('countPendingInvites counts invites past any bounded scan', async () => {
      const { insertSubBlock, insertUtxoTx, countPendingInvites } =
        await importMempoolFresh();

      for (let i = 0; i < 1000; i++) insertSubBlock(`filler_${i}`, 100);
      insertUtxoTx(inviteTx(INVITER_A) as any, null, 100);
      insertUtxoTx(inviteTx(INVITER_A) as any, null, 100);
      insertUtxoTx(inviteTx(INVITER_B) as any, null, 100);

      expect(countPendingInvites(INVITER_A)).toBe(2);
      expect(countPendingInvites(INVITER_B)).toBe(1);
      expect(countPendingInvites(LIKER_A)).toBe(0);
    });

    it('hasPendingVouch is keyed on the voucher alone', async () => {
      const { insertUtxoTx, hasPendingVouch } = await importMempoolFresh();

      insertUtxoTx(vouchTx(VOUCHER_A, TARGET_ID) as any, null, 100);

      expect(hasPendingVouch(VOUCHER_A)).toBe(true);
      expect(hasPendingVouch(VOUCHER_B)).toBe(false);
    });

    it('leaves gate columns null for a tx with no gated outputs', async () => {
      const { insertUtxoTx, getDbRow } = await importMempoolWithRow();
      insertUtxoTx({ inputs: [], outputs: [], signatures: {}, protocolVersion: 1 } as any, null, 100);
      const row = getDbRow();
      expect(row.like_target).toBeNull();
      expect(row.like_liker).toBeNull();
      expect(row.invite_inviter).toBeNull();
      expect(row.vouch_voucher).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // removeSubBlockEntries (audit M-8)
  // -------------------------------------------------------------------------

  describe('removeSubBlockEntries', () => {
    it('removes confirmed sub-blocks past the first rows and spares the rest', async () => {
      const { insertSubBlock, insertUtxoTx, removeSubBlockEntries, getPendingEntries } =
        await importMempoolFresh();

      for (let i = 0; i < 1000; i++) insertSubBlock(`filler_${i}`, 100);
      insertSubBlock('confirmed_a', 100);
      insertUtxoTx(likeTx(TARGET, LIKER_A) as any, null, 100);
      insertSubBlock('confirmed_b', 100);
      insertSubBlock('survivor', 100);

      const removed = removeSubBlockEntries(['confirmed_a', 'confirmed_b']);
      expect(removed).toBe(2);

      const remaining = getPendingEntries(2000);
      expect(remaining.some((e: any) => e.subblockId === 'confirmed_a')).toBe(false);
      expect(remaining.some((e: any) => e.subblockId === 'confirmed_b')).toBe(false);
      // Controls: unrelated entries survive.
      expect(remaining.some((e: any) => e.subblockId === 'survivor')).toBe(true);
      expect(remaining.filter((e: any) => e.entryType === 'utxo_tx')).toHaveLength(1);
      expect(remaining).toHaveLength(1002);
    });

    it('returns 0 for an empty list and ignores unknown ids', async () => {
      const { insertSubBlock, removeSubBlockEntries } = await importMempoolFresh();
      insertSubBlock('kept', 100);
      expect(removeSubBlockEntries([])).toBe(0);
      expect(removeSubBlockEntries(['never_inserted'])).toBe(0);
    });

    it('deletes more ids than SQLite takes bound parameters for', async () => {
      const { insertSubBlock, removeSubBlockEntries, getPendingEntries } =
        await importMempoolFresh();
      const ids = Array.from({ length: 1200 }, (_, i) => `bulk_${i}`);
      for (const id of ids) insertSubBlock(id, 100);
      expect(removeSubBlockEntries(ids)).toBe(1200);
      expect(getPendingEntries(2000)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Size cap — reject, never evict (audit M-8)
  // -------------------------------------------------------------------------

  describe('size cap', () => {
    const originalCap = process.env['MAX_MEMPOOL_ENTRIES'];

    afterEach(() => {
      if (originalCap === undefined) delete process.env['MAX_MEMPOOL_ENTRIES'];
      else process.env['MAX_MEMPOOL_ENTRIES'] = originalCap;
    });

    async function importCapped(cap: number) {
      process.env['MAX_MEMPOOL_ENTRIES'] = String(cap);
      vi.resetModules();
      const dbMod = await import('../../src/store/db.js');
      dbMod.initDb(':memory:');
      const mem = await import('../../src/store/mempool.js');
      return mem as any;
    }

    it('rejects every entry type at the cap and accepts below it', async () => {
      const mem = await importCapped(3);

      // Control: inserts below the cap succeed.
      expect(() => mem.insertSubBlock('sb_1', 100)).not.toThrow();
      expect(() => mem.insertUtxoTx(likeTx(TARGET, LIKER_A) as any, null, 100)).not.toThrow();
      expect(() => mem.insertMempoolPrune(pruneEntry('root_1'), 100)).not.toThrow();

      // At the cap (3 entries), each insert path rejects.
      expect(() => mem.insertSubBlock('sb_2', 100)).toThrow(mem.MempoolFullError);
      expect(() => mem.insertUtxoTx(likeTx(TARGET, LIKER_B) as any, null, 100)).toThrow(
        mem.MempoolFullError,
      );
      expect(() => mem.insertMempoolPrune(pruneEntry('root_2'), 100), ).toThrow(
        mem.MempoolFullError,
      );

      // Rejection, not eviction: the pool still holds exactly the cap.
      expect(mem.getPendingEntries(100)).toHaveLength(3);
    });

    it('accepts again once entries expire — a full pool drains itself', async () => {
      const mem = await importCapped(2);
      mem.insertSubBlock('sb_expiring', 10);
      mem.insertSubBlock('sb_live', 900);
      expect(() => mem.insertSubBlock('sb_blocked', 900)).toThrow(mem.MempoolFullError);

      mem.purgeExpired(50);
      expect(() => mem.insertSubBlock('sb_after_purge', 900)).not.toThrow();
    });

    it('defaults to 10000 entries when MAX_MEMPOOL_ENTRIES is unset', async () => {
      delete process.env['MAX_MEMPOOL_ENTRIES'];
      vi.resetModules();
      const { config } = await import('../../src/config.js');
      expect(config.maxMempoolEntries).toBe(10000);
    });
  });
});
