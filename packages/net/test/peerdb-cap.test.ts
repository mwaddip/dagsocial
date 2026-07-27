import { describe, it, expect } from 'vitest';
import { PeerDb } from '@dagsocial/net';
import type { PeerRecord } from '@dagsocial/net';

function makeRecord(addr: string, lastSeenMs: number): PeerRecord {
  return {
    address: addr,
    lastSeenMs,
    agentName: 'test',
    nodeName: addr,
    protocolVersion: 1,
    capabilities: [],
  };
}

describe('PeerDb soft cap with LRU eviction', () => {
  it('evicts LRU peer when exceeding cap', () => {
    const db = new PeerDb(null, 3, []);

    db.record(makeRecord('a', 1000));
    db.record(makeRecord('b', 2000));
    db.record(makeRecord('c', 3000));
    db.record(makeRecord('d', 4000)); // triggers eviction

    // 'a' should be evicted (oldest lastSeenMs)
    const all = db.all();
    expect(all.find((p) => p.address === 'a')).toBeUndefined();
    expect(all.find((p) => p.address === 'd')).toBeDefined();
    expect(db.count()).toBe(3);
  });

  it('does not regress lastSeenMs on out-of-order updates', () => {
    const db = new PeerDb(null, 10, []);
    db.record(makeRecord('a', 5000));
    db.record(makeRecord('a', 3000)); // older timestamp — should be ignored
    const entry = db.get('a');
    expect(entry).not.toBeNull();
    expect(entry!.lastSeenMs).toBe(5000); // max(5000, 3000) = 5000
  });

  it('newer timestamp overwrites older', () => {
    const db = new PeerDb(null, 10, []);
    db.record(makeRecord('a', 1000));
    db.record(makeRecord('a', 2000)); // newer — should update
    expect(db.get('a')!.lastSeenMs).toBe(2000);
  });

  it('multiple evictions maintain LRU ordering', () => {
    const db = new PeerDb(null, 3, []);

    db.record(makeRecord('a', 1000));
    db.record(makeRecord('b', 2000));
    db.record(makeRecord('c', 3000));
    // cap is 3, this evicts 'a'
    db.record(makeRecord('d', 1500));
    // now entries: b(2000), c(3000), d(1500)
    // evicts 'd' (oldest: 1500 < 2000 < 3000)
    db.record(makeRecord('e', 2500));

    const all = db.all();
    expect(all.find((p) => p.address === 'a')).toBeUndefined();
    expect(all.find((p) => p.address === 'd')).toBeUndefined();
    expect(all.find((p) => p.address === 'b')).toBeDefined();
    expect(all.find((p) => p.address === 'c')).toBeDefined();
    expect(all.find((p) => p.address === 'e')).toBeDefined();
    expect(db.count()).toBe(3);
  });

  it('re-updating a peer bumps its lastSeenMs and prevents eviction', () => {
    const db = new PeerDb(null, 3, []);

    db.record(makeRecord('a', 1000));
    db.record(makeRecord('b', 2000));
    db.record(makeRecord('c', 3000));
    // Re-update 'a' with a newer timestamp so it is no longer the LRU
    db.record(makeRecord('a', 3500));
    // Now trigger eviction — 'b' (2000) should be the LRU
    db.record(makeRecord('d', 4000));

    const all = db.all();
    expect(all.find((p) => p.address === 'a')).toBeDefined(); // survived
    expect(all.find((p) => p.address === 'b')).toBeUndefined(); // evicted
    expect(all.find((p) => p.address === 'c')).toBeDefined();
    expect(all.find((p) => p.address === 'd')).toBeDefined();
  });
});
