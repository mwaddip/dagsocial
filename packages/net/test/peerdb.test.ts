import { describe, it, expect, beforeEach } from 'vitest';
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

describe('PeerDb', () => {
  let db: PeerDb;

  beforeEach(() => {
    db = new PeerDb(null, 100, []);
  });

  it('records and retrieves a peer', () => {
    const rec = makeRecord('/ip4/1.2.3.4/tcp/9000', 1000);
    db.record(rec);
    expect(db.get('/ip4/1.2.3.4/tcp/9000')).toEqual(rec);
    expect(db.count()).toBe(1);
  });

  it('merges lastSeenMs on duplicate', () => {
    db.record(makeRecord('/ip4/1.2.3.4/tcp/9000', 1000));
    db.record(makeRecord('/ip4/1.2.3.4/tcp/9000', 500)); // older — should keep 1000
    expect(db.get('/ip4/1.2.3.4/tcp/9000')!.lastSeenMs).toBe(1000);

    db.record(makeRecord('/ip4/1.2.3.4/tcp/9000', 2000)); // newer
    expect(db.get('/ip4/1.2.3.4/tcp/9000')!.lastSeenMs).toBe(2000);
  });

  it('forgets a peer', () => {
    db.record(makeRecord('/ip4/1.2.3.4/tcp/9000', 1000));
    db.forget('/ip4/1.2.3.4/tcp/9000');
    expect(db.get('/ip4/1.2.3.4/tcp/9000')).toBeNull();
    expect(db.count()).toBe(0);
  });

  it('filters self addresses', () => {
    const selfDb = new PeerDb(null, 100, ['/ip4/127.0.0.1/tcp/9000']);
    selfDb.record(makeRecord('/ip4/127.0.0.1/tcp/9000', 1000));
    selfDb.record(makeRecord('/ip4/1.2.3.4/tcp/9000', 1000));
    expect(selfDb.count()).toBe(1);
    expect(selfDb.get('/ip4/1.2.3.4/tcp/9000')).not.toBeNull();
  });

  it('evicts oldest on overflow', () => {
    const smallDb = new PeerDb(null, 3, []);
    smallDb.record(makeRecord('a', 1000));
    smallDb.record(makeRecord('b', 2000));
    smallDb.record(makeRecord('c', 3000));
    smallDb.record(makeRecord('d', 4000)); // evicts 'a' (oldest)
    expect(smallDb.count()).toBe(3);
    expect(smallDb.get('a')).toBeNull();
    expect(smallDb.get('d')).not.toBeNull();
  });

  it('recent returns most recent excluding specified', () => {
    db.record(makeRecord('a', 1000));
    db.record(makeRecord('b', 2000));
    db.record(makeRecord('c', 3000));
    db.record(makeRecord('d', 4000));

    const recent = db.recent(2, new Set(['d']));
    expect(recent).toHaveLength(2);
    expect(recent[0]!.address).toBe('c');
    expect(recent[1]!.address).toBe('b');
  });
});
