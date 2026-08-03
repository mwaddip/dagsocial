import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, closeDb, getDb } from '../src/store/db.js';
import { loadAllPeers, putPeer, peerStorage } from '../src/store/peers.js';
import { PeerDb, type PeerRecord } from '@dagsocial/net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkPeer(address: string, lastSeenMs: number): PeerRecord {
  return {
    address,
    lastSeenMs,
    agentName: 'dagsocial-test',
    nodeName: `node-at-${address}`,
    protocolVersion: 1,
    capabilities: [1, 2, 8],
  };
}

const ADDR_1 = '/ip4/10.0.0.1/tcp/9001';
const ADDR_2 = '/ip4/10.0.0.2/tcp/9001';
const ADDR_3 = '/ip4/10.0.0.3/tcp/9001';

describe('peer persistence (PeerStorage over SQLite)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dagsocial-peers-'));
    dbPath = path.join(tmpDir, 'test.db');
    initDb(dbPath);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Simulate a process restart: close the SQLite handle, reopen the same file. */
  function restartDb(): void {
    closeDb();
    initDb(dbPath);
  }

  // -------------------------------------------------------------------------
  // Round-trip across a restart
  // -------------------------------------------------------------------------

  it('peers recorded before a restart are served by a fresh PeerDb after it', () => {
    const p1 = mkPeer(ADDR_1, 1000);
    const p2 = mkPeer(ADDR_2, 2000);
    const p3 = mkPeer(ADDR_3, 3000);
    const before = new PeerDb(peerStorage, 100, []);
    before.record(p1);
    before.record(p2);
    before.record(p3);

    restartDb();

    const after = new PeerDb(peerStorage, 100, []);
    // Most recently seen first, every field intact
    expect(after.recent(10, new Set())).toEqual([p3, p2, p1]);
  });

  it('control: with null storage the same sequence yields nothing after the restart', () => {
    const before = new PeerDb(null, 100, []);
    before.record(mkPeer(ADDR_1, 1000));
    before.record(mkPeer(ADDR_2, 2000));
    expect(before.count()).toBe(2); // recorded fine in memory...

    restartDb();

    const after = new PeerDb(null, 100, []);
    expect(after.recent(10, new Set())).toEqual([]); // ...but gone after restart
    expect(after.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Eviction / forget / ban write through to the DB
  // -------------------------------------------------------------------------

  it('eviction at cap deletes the evicted row from the DB, not just memory', () => {
    const pdb = new PeerDb(peerStorage, 2, []);
    pdb.record(mkPeer(ADDR_1, 1000)); // oldest — will be evicted
    pdb.record(mkPeer(ADDR_2, 2000));
    pdb.record(mkPeer(ADDR_3, 3000)); // pushes size to 3 > cap 2

    // Direct row check: the evicted address is gone from disk
    const rows = getDb()
      .prepare('SELECT address FROM peers ORDER BY address')
      .all() as Array<{ address: string }>;
    expect(rows.map((r) => r.address)).toEqual([ADDR_2, ADDR_3]);

    restartDb();
    const after = new PeerDb(peerStorage, 2, []);
    expect(after.recent(10, new Set()).map((r) => r.address)).toEqual([ADDR_3, ADDR_2]);
  });

  it('forget deletes the row durably', () => {
    const pdb = new PeerDb(peerStorage, 100, []);
    pdb.record(mkPeer(ADDR_1, 1000));
    pdb.record(mkPeer(ADDR_2, 2000));
    pdb.forget(ADDR_1);

    restartDb();
    const after = new PeerDb(peerStorage, 100, []);
    expect(after.recent(10, new Set()).map((r) => r.address)).toEqual([ADDR_2]);
  });

  it('ban deletes the row durably', () => {
    const pdb = new PeerDb(peerStorage, 100, []);
    pdb.record(mkPeer(ADDR_1, 1000));
    pdb.record(mkPeer(ADDR_2, 2000));
    pdb.ban(ADDR_1);

    restartDb();
    const after = new PeerDb(peerStorage, 100, []);
    expect(after.recent(10, new Set()).map((r) => r.address)).toEqual([ADDR_2]);
  });

  // -------------------------------------------------------------------------
  // loadAll totality
  // -------------------------------------------------------------------------

  it('loadAll skips corrupt capabilities rows with a warning and returns the readable ones', () => {
    putPeer(mkPeer(ADDR_1, 1000));
    putPeer(mkPeer(ADDR_2, 2000));
    putPeer(mkPeer(ADDR_3, 3000));
    // Corrupt two rows, two different ways: unparseable JSON and a
    // parseable-but-wrong shape (object where an integer array belongs).
    getDb().prepare('UPDATE peers SET capabilities = ? WHERE address = ?').run('not json', ADDR_2);
    getDb().prepare('UPDATE peers SET capabilities = ? WHERE address = ?').run('{"a":1}', ADDR_3);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const records = loadAllPeers(); // must not throw
      expect(records.map((r) => r.address)).toEqual([ADDR_1]);
      expect(warn).toHaveBeenCalledTimes(2);

      // A corrupt row must not prevent PeerDb construction (node startup path)
      const pdb = new PeerDb(peerStorage, 100, []);
      expect(pdb.count()).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('control: all-valid rows all load', () => {
    putPeer(mkPeer(ADDR_1, 1000));
    putPeer(mkPeer(ADDR_2, 2000));
    const records = loadAllPeers();
    expect(records.map((r) => r.address).sort()).toEqual([ADDR_1, ADDR_2]);
  });

  // -------------------------------------------------------------------------
  // Self-address filtering on load
  // -------------------------------------------------------------------------

  it('a stored self-address is filtered from memory on load but stays on disk', () => {
    const self = mkPeer('/ip4/192.168.1.5/tcp/9001', 5000);
    const other = mkPeer(ADDR_2, 2000);
    putPeer(self);
    putPeer(other);

    const pdb = new PeerDb(peerStorage, 100, [self.address]);
    expect(pdb.count()).toBe(1);
    expect(pdb.get(self.address)).toBeNull();
    expect(pdb.get(other.address)).toEqual(other);

    // Deliberately NOT deleted from disk — a self-address today may be
    // someone else tomorrow.
    expect(loadAllPeers()).toHaveLength(2);
  });
});
