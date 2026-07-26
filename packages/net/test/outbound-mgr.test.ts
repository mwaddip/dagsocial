import { describe, it, expect, beforeEach } from 'vitest';
import { OutboundManager, PeerDb } from '@dagsocial/net';
import type { NetConfig } from '@dagsocial/net';

const testConfig: NetConfig = {
  magic: 0x54444147,
  bootstrapPeers: ['/ip4/10.0.0.1/tcp/9000'],
  listenAddrs: '/ip4/0.0.0.0/tcp/0',
  maxPeers: 10,
  minPeers: 3,
  peerDbCap: 100,
  outboundFillIntervalMs: 30000,
  outboundRedialCooldownMs: 60000,
  penaltyScoreThreshold: 500,
  temporalBanDurationMs: 3600000,
  penaltySafeIntervalMs: 120000,
  peerEvictionIntervalMs: 3600000,
  syncRequestTimeoutMs: 10000,
};

describe('OutboundManager', () => {
  let mgr: OutboundManager;
  let db: PeerDb;

  beforeEach(() => {
    db = new PeerDb(null, 100, []);
    mgr = new OutboundManager(testConfig, db);
  });

  it('returns null when below minPeers (floor phase — caller dials seeds)', () => {
    expect(mgr.pickCandidate(1)).toBeNull();
  });

  it('returns null when at maxPeers', () => {
    expect(mgr.pickCandidate(10)).toBeNull();
  });

  it('returns null when above maxPeers', () => {
    expect(mgr.pickCandidate(15)).toBeNull();
  });

  it('returns bootstrap peers', () => {
    expect(mgr.getBootstrapPeers()).toEqual(['/ip4/10.0.0.1/tcp/9000']);
  });

  it('returns candidate from PeerDb in fill phase', () => {
    db.record({
      address: '/ip4/1.2.3.4/tcp/9000',
      lastSeenMs: Date.now(),
      agentName: 'test',
      nodeName: 'peer1',
      protocolVersion: 1,
      capabilities: [],
    });
    const candidate = mgr.pickCandidate(5); // 5 connected, max 10
    expect(candidate).toBe('/ip4/1.2.3.4/tcp/9000');
  });

  it('respects redial cooldown', () => {
    db.record({
      address: '/ip4/1.2.3.4/tcp/9000',
      lastSeenMs: Date.now(),
      agentName: 'test',
      nodeName: 'peer1',
      protocolVersion: 1,
      capabilities: [],
    });
    mgr.recordDialResult('/ip4/1.2.3.4/tcp/9000', false); // failed
    expect(mgr.pickCandidate(5)).toBeNull(); // in cooldown
  });

  it('clears cooldown on successful dial', () => {
    db.record({
      address: '/ip4/1.2.3.4/tcp/9000',
      lastSeenMs: Date.now(),
      agentName: 'test',
      nodeName: 'peer1',
      protocolVersion: 1,
      capabilities: [],
    });
    mgr.recordDialResult('/ip4/1.2.3.4/tcp/9000', false); // failed
    mgr.recordDialResult('/ip4/1.2.3.4/tcp/9000', true); // succeeded
    const candidate = mgr.pickCandidate(5);
    expect(candidate).toBe('/ip4/1.2.3.4/tcp/9000');
  });

  it('returns null when PeerDb is empty in fill phase', () => {
    expect(mgr.pickCandidate(5)).toBeNull(); // db is empty
  });

  it('picks most recent candidate from PeerDb', () => {
    db.record({
      address: '/ip4/1.1.1.1/tcp/9000',
      lastSeenMs: 1000,
      agentName: 'test',
      nodeName: 'older',
      protocolVersion: 1,
      capabilities: [],
    });
    db.record({
      address: '/ip4/2.2.2.2/tcp/9000',
      lastSeenMs: 2000,
      agentName: 'test',
      nodeName: 'newer',
      protocolVersion: 1,
      capabilities: [],
    });
    const candidate = mgr.pickCandidate(5);
    expect(candidate).toBe('/ip4/2.2.2.2/tcp/9000'); // most recent first
  });

  it('returns null when at exact minPeers boundary (still floor phase)', () => {
    // minPeers is 3, so connectedCount < 3 means floor phase
    // at 3 exactly we are in fill phase, but with empty db we get null
    expect(mgr.pickCandidate(3)).toBeNull(); // fill phase but empty db
  });
});
