import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PeerManager } from '../src/peer-mgr.js';
import { PeerState, PenaltyKind } from '../src/types.js';
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

  // -----------------------------------------------------------------------
  // Peer state machine
  // -----------------------------------------------------------------------

  it('initial metadata is Connecting', () => {
    mgr.addPeer(makePeer('peer1'));
    const meta = mgr.getPeerMetadata('peer1');
    expect(meta).not.toBeNull();
    expect(meta!.state).toBe(PeerState.Connecting);
    expect(meta!.stalled).toBe(false);
    expect(meta!.penaltyCount).toBe(0);
    expect(meta!.bannedUntil).toBeNull();
  });

  it('setPeerState transitions through real states', () => {
    mgr.addPeer(makePeer('peer1'));

    mgr.setPeerState('peer1', PeerState.Handshaking);
    expect(mgr.getPeerMetadata('peer1')!.state).toBe(PeerState.Handshaking);

    mgr.setPeerState('peer1', PeerState.Active);
    expect(mgr.getPeerMetadata('peer1')!.state).toBe(PeerState.Active);

    mgr.setPeerState('peer1', PeerState.Disconnected);
    expect(mgr.getPeerMetadata('peer1')!.state).toBe(PeerState.Disconnected);
  });

  it('setPeerState is a no-op for unknown peer', () => {
    // Should not throw
    mgr.setPeerState('ghost', PeerState.Active);
    expect(mgr.getPeerMetadata('ghost')).toBeNull();
  });

  it('isPeerActive returns false for non-Active peers', () => {
    mgr.addPeer(makePeer('peer1'));
    expect(mgr.isPeerActive('peer1')).toBe(false); // Connecting

    mgr.setPeerState('peer1', PeerState.Handshaking);
    expect(mgr.isPeerActive('peer1')).toBe(false);

    mgr.setPeerState('peer1', PeerState.Active);
    expect(mgr.isPeerActive('peer1')).toBe(true);

    mgr.setPeerState('peer1', PeerState.Failed);
    expect(mgr.isPeerActive('peer1')).toBe(false);
  });

  it('isPeerActive returns false for unknown peer', () => {
    expect(mgr.isPeerActive('ghost')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Three-tier penalty (recordPenaltyKind)
  // -----------------------------------------------------------------------

  it('recordPenaltyKind ProtocolViolation removes peer', () => {
    mgr.addPeer(makePeer('peer1'));
    mgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, 'peer1', 'bad protocol');

    expect(mgr.getPeerCount()).toBe(0);
    expect(mgr.isBanned('peer1')).toBe(true);
    expect(mgr.getPeerMetadata('peer1')).toBeNull();
  });

  it('recordPenaltyKind Transient increments penaltyCount', () => {
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(0);

    mgr.recordPenaltyKind(PenaltyKind.Transient, 'peer1', 'timeout');
    const meta = mgr.getPeerMetadata('peer1');
    expect(meta?.penaltyCount).toBe(1);
    expect(meta?.state).toBe(PeerState.Connecting); // state unchanged by penalty
  });

  // -----------------------------------------------------------------------
  // Stall detection
  // -----------------------------------------------------------------------

  it('markStalled and clearStalled', () => {
    mgr.addPeer(makePeer('peer1'));
    mgr.setPeerState('peer1', PeerState.Active);

    mgr.markStalled('peer1');
    expect(mgr.getPeerMetadata('peer1')!.stalled).toBe(true);
    expect(mgr.getStalledPeers().has('peer1')).toBe(true);

    mgr.clearStalled();
    expect(mgr.getPeerMetadata('peer1')!.stalled).toBe(false);
    expect(mgr.getStalledPeers().size).toBe(0);
  });

  it('markStalled is a no-op for unknown peer', () => {
    mgr.markStalled('ghost');
    expect(mgr.getStalledPeers().size).toBe(0);
  });

  it('getNextActivePeer returns non-stalled Active peer', () => {
    mgr.addPeer(makePeer('peer1'));
    mgr.addPeer(makePeer('peer2'));
    mgr.setPeerState('peer1', PeerState.Active);
    mgr.setPeerState('peer2', PeerState.Active);

    // Both Active and non-stalled — returns first
    const next = mgr.getNextActivePeer();
    expect(next).not.toBeNull();
    expect(next!.state).toBe(PeerState.Active);
    expect(next!.stalled).toBe(false);
  });

  it('getNextActivePeer skips stalled peers', () => {
    mgr.addPeer(makePeer('peer1'));
    mgr.addPeer(makePeer('peer2'));
    mgr.setPeerState('peer1', PeerState.Active);
    mgr.setPeerState('peer2', PeerState.Active);

    mgr.markStalled('peer1');

    const next = mgr.getNextActivePeer();
    expect(next).not.toBeNull();
    expect(next!.peerId).toBe('peer2'); // peer1 is stalled, skipped
  });

  it('getNextActivePeer returns null when all peers stalled (and clears stalls)', () => {
    mgr.addPeer(makePeer('peer1'));
    mgr.setPeerState('peer1', PeerState.Active);
    mgr.markStalled('peer1');

    const firstAttempt = mgr.getNextActivePeer();
    expect(firstAttempt).toBeNull();
    // Should have cleared stalls — stalls are now cleared
    expect(mgr.getStalledPeers().size).toBe(0);
  });

  it('getNextActivePeer skips non-Active peers', () => {
    mgr.addPeer(makePeer('peer1'));
    mgr.addPeer(makePeer('peer2'));
    mgr.setPeerState('peer1', PeerState.Handshaking);
    mgr.setPeerState('peer2', PeerState.Active);

    const next = mgr.getNextActivePeer();
    expect(next).not.toBeNull();
    expect(next!.peerId).toBe('peer2');
  });

  it('isStallTimedOut detects stall timeout', () => {
    mgr.addPeer(makePeer('peer1'));
    mgr.setPeerState('peer1', PeerState.Active);

    vi.spyOn(Date, 'now').mockReturnValue(0);
    mgr.markStalled('peer1');

    // Not timed out yet (0ms elapsed)
    vi.spyOn(Date, 'now').mockReturnValue(1);
    expect(mgr.isStallTimedOut('peer1')).toBe(false);

    // Timed out (>30s elapsed)
    vi.spyOn(Date, 'now').mockReturnValue(30001);
    expect(mgr.isStallTimedOut('peer1')).toBe(true);
  });

  it('isStallTimedOut returns false for non-stalled peer', () => {
    mgr.addPeer(makePeer('peer1'));
    mgr.setPeerState('peer1', PeerState.Active);

    expect(mgr.isStallTimedOut('peer1')).toBe(false);
  });

  it('isStallTimedOut returns false for unknown peer', () => {
    expect(mgr.isStallTimedOut('ghost')).toBe(false);
  });

  it('addPeer initializes metadata only if not already present', () => {
    mgr.addPeer(makePeer('peer1'));
    const meta1 = mgr.getPeerMetadata('peer1');
    expect(meta1!.state).toBe(PeerState.Connecting);

    // Transition to Active
    mgr.setPeerState('peer1', PeerState.Active);

    // Re-add should NOT reset metadata (metadata already present)
    mgr.addPeer(makePeer('peer1'));
    const meta2 = mgr.getPeerMetadata('peer1');
    expect(meta2!.state).toBe(PeerState.Active); // preserved
  });
});
