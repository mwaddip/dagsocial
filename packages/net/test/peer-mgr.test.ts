import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PeerManager } from '../src/peer-mgr.js';
import type { NetConfig, Peer } from '../src/types.js';

function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return {
    bootstrapPeers: [],
    listenAddrs: '/ip4/0.0.0.0/tcp/0',
    maxPeers: 50,
    penaltyScoreThreshold: 500,
    temporalBanDurationMs: 3600000,
    penaltySafeIntervalMs: 120000,
    peerEvictionIntervalMs: 3600000,
    syncRequestTimeoutMs: 10000,
    ...overrides,
  };
}

function makePeer(id: string): Peer {
  return { id, multiaddrs: [`/ip4/127.0.0.1/tcp/${9000 + parseInt(id)}`], protocols: [], connectedAt: Date.now() };
}

describe('PeerManager', () => {
  let mgr: PeerManager;
  let config: NetConfig;

  beforeEach(() => {
    config = makeConfig();
    mgr = new PeerManager(config);
  });

  it('starts with no peers', () => {
    expect(mgr.getPeerCount()).toBe(0);
    expect(mgr.getPeers()).toEqual([]);
  });

  it('adds and tracks peers', () => {
    mgr.addPeer(makePeer('peer1'));
    mgr.addPeer(makePeer('peer2'));
    expect(mgr.getPeerCount()).toBe(2);
    expect(mgr.getPeer('peer1')?.id).toBe('peer1');
  });

  it('does not add banned peers', () => {
    mgr.recordPenalty('permanent', 'peer1', 0, 'test');
    mgr.addPeer(makePeer('peer1'));
    expect(mgr.getPeerCount()).toBe(0);
  });

  it('removes peers', () => {
    mgr.addPeer(makePeer('peer1'));
    mgr.removePeer('peer1');
    expect(mgr.getPeerCount()).toBe(0);
  });

  it('accumulates penalty scores', () => {
    mgr.addPeer(makePeer('peer1'));
    // Override safe interval
    vi.spyOn(Date, 'now').mockReturnValue(0);
    mgr.recordPenalty('misbehavior', 'peer1', 100, 'bad message');
    vi.spyOn(Date, 'now').mockReturnValue(config.penaltySafeIntervalMs + 1);
    mgr.recordPenalty('misbehavior', 'peer1', 100, 'bad message again');
    // Peer should still be tracked (not banned yet at 200 < 500)
    expect(mgr.getPeerCount()).toBe(1);
  });

  it('bans peer when threshold exceeded', () => {
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(0);
    mgr.recordPenalty('misbehavior', 'peer1', 499, 'bad');
    vi.spyOn(Date, 'now').mockReturnValue(config.penaltySafeIntervalMs + 1);
    mgr.recordPenalty('misbehavior', 'peer1', 1, 'one more');
    expect(mgr.getPeerCount()).toBe(0);
    expect(mgr.isBanned('peer1')).toBe(true);
  });

  it('permanent penalty bans instantly regardless of score', () => {
    mgr.addPeer(makePeer('peer1'));
    mgr.recordPenalty('permanent', 'peer1', 0, 'wrong magic');
    expect(mgr.isBanned('peer1')).toBe(true);
    expect(mgr.getPeerCount()).toBe(0);
  });

  it('respects penalty safe interval (cooldown)', () => {
    mgr.addPeer(makePeer('peer1'));
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    mgr.recordPenalty('misbehavior', 'peer1', 100, 'first');
    mgr.recordPenalty('misbehavior', 'peer1', 100, 'too soon — should be ignored');
    // Only first penalty should count
    const entry = (mgr as any).peers.get('peer1');
    expect(entry.penaltyScore).toBe(100);
  });

  it('evicts a random peer', () => {
    mgr.addPeer(makePeer('peer1'));
    mgr.addPeer(makePeer('peer2'));
    const evicted = mgr.evictRandom();
    expect(evicted).toBeDefined();
    expect(mgr.getPeerCount()).toBe(1);
  });

  it('returns null when evicting from empty set', () => {
    expect(mgr.evictRandom()).toBeNull();
  });

  it('temporal ban expires', () => {
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(0);
    mgr.recordPenalty('misbehavior', 'peer1', 500, 'ban');
    expect(mgr.isBanned('peer1')).toBe(true);

    // Fast-forward past ban duration
    vi.spyOn(Date, 'now').mockReturnValue(config.temporalBanDurationMs + 1);
    expect(mgr.isBanned('peer1')).toBe(false);
    // Should be cleaned from bans map
    expect((mgr as any).bans.has('peer1')).toBe(false);
  });
});
