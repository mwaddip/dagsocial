import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PeerManager } from '../src/peer-mgr.js';
import { PeerDb } from '../src/peerdb.js';
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
    // Same instant, so no decay window straddles the threshold crossing.
    vi.spyOn(Date, 'now').mockReturnValue(0);
    mgr.recordPenalty('misbehavior', 'peer1', 499, 'bad');
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

  // -----------------------------------------------------------------------
  // Penalty accrual + decay (contract: "Accrual and decay (audit L-13)")
  // -----------------------------------------------------------------------

  it('always accrues: 5 rapid MisbehaviorPenalties ban the peer (fails pre-fix)', () => {
    // Pre-fix, the safe-interval cooldown discarded 4 of the 5 rapid
    // penalties (score 100, no ban) — ban pressure was independent of attack
    // rate. Post-fix every penalty accrues: 5 × 100 = 500 >= threshold.
    // Nonzero timestamp: the pre-fix cooldown skipped itself while
    // lastPenaltyTime was 0, so a t=0 flood would ban even pre-fix.
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    for (let i = 0; i < 5; i++) {
      mgr.recordPenalty('misbehavior', 'peer1', 100, `invalid gossip ${i}`);
    }
    expect(mgr.isBanned('peer1')).toBe(true);
    expect(mgr.getPeerCount()).toBe(0);
  });

  it('control: the same 5 penalties spaced two intervals apart decay away — no ban', () => {
    mgr.addPeer(makePeer('peer1'));
    for (let i = 0; i < 5; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(i * 2 * config.penaltySafeIntervalMs);
      mgr.recordPenalty('misbehavior', 'peer1', 100, `sporadic ${i}`);
    }
    expect(mgr.isBanned('peer1')).toBe(false);
    expect(mgr.getPeerCount()).toBe(1);
    // Each 2-interval gap drains 200 — more than the 100 accrued — so the
    // score is back at 100 after every penalty, far from the 500 threshold.
    expect((mgr as any).peers.get('peer1').penaltyScore).toBe(100);
  });

  it('decays the score by 100 per elapsed interval, flooring at 0', () => {
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(0);
    mgr.recordPenalty('misbehavior', 'peer1', 100, 'first');
    mgr.recordPenalty('misbehavior', 'peer1', 100, 'second');
    expect((mgr as any).peers.get('peer1').penaltyScore).toBe(200);

    // Decay is lazy — a zero-score probe forces it without adding pressure.
    vi.spyOn(Date, 'now').mockReturnValue(config.penaltySafeIntervalMs);
    mgr.recordPenalty('misbehavior', 'peer1', 0, 'probe');
    expect((mgr as any).peers.get('peer1').penaltyScore).toBe(100);

    vi.spyOn(Date, 'now').mockReturnValue(2 * config.penaltySafeIntervalMs);
    mgr.recordPenalty('misbehavior', 'peer1', 0, 'probe');
    expect((mgr as any).peers.get('peer1').penaltyScore).toBe(0);

    // Ten further intervals on a zero score: floored at 0, never negative.
    vi.spyOn(Date, 'now').mockReturnValue(12 * config.penaltySafeIntervalMs);
    mgr.recordPenalty('misbehavior', 'peer1', 0, 'probe');
    expect((mgr as any).peers.get('peer1').penaltyScore).toBe(0);
  });

  it('decay is proportional, not stepwise: half an interval drains half', () => {
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(0);
    mgr.recordPenalty('misbehavior', 'peer1', 200, 'seed');
    vi.spyOn(Date, 'now').mockReturnValue(config.penaltySafeIntervalMs / 2);
    mgr.recordPenalty('misbehavior', 'peer1', 0, 'probe');
    expect((mgr as any).peers.get('peer1').penaltyScore).toBe(150);
  });

  it('break-even: one MisbehaviorPenalty per interval holds steady, never bans', () => {
    mgr.addPeer(makePeer('peer1'));
    for (let i = 0; i < 20; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(i * config.penaltySafeIntervalMs);
      mgr.recordPenalty('misbehavior', 'peer1', 100, `steady ${i}`);
    }
    expect(mgr.isBanned('peer1')).toBe(false);
    expect(mgr.getPeerCount()).toBe(1);
    expect((mgr as any).peers.get('peer1').penaltyScore).toBe(100);
  });

  it('just above break-even: one MisbehaviorPenalty per half interval bans', () => {
    mgr.addPeer(makePeer('peer1'));
    // Net +50 per penalty after the first: 100, 150, … 500 on the 9th.
    for (let i = 0; i < 9; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(i * (config.penaltySafeIntervalMs / 2));
      mgr.recordPenalty('misbehavior', 'peer1', 100, `pressure ${i}`);
    }
    expect(mgr.isBanned('peer1')).toBe(true);
    expect(mgr.getPeerCount()).toBe(0);
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

  // -----------------------------------------------------------------------
  // Ban propagation to PeerDb (contract: "Ban surfaces are unified",
  // audit L-14 phase 2)
  // -----------------------------------------------------------------------

  describe('ban propagation to PeerDb', () => {
    const ADDR = '/ip4/51.15.0.1/tcp/4001';
    const OTHER = '/ip4/51.15.0.2/tcp/4001';

    // Real PeerManager + real PeerDb, joined exactly as NetNode joins them:
    // hooks bound to peerDb.ban/unban. The wrappers count calls so "nothing
    // was propagated" is distinguishable from "propagated but harmless".
    function makeBanPair() {
      const peerDb = new PeerDb(null, 100, []);
      const calls = { ban: 0, unban: 0 };
      const pairMgr = new PeerManager(makeConfig(), {
        onBan: (addr) => { calls.ban++; peerDb.ban(addr); },
        onUnban: (addr) => { calls.unban++; peerDb.unban(addr); },
      });
      return { pairMgr, peerDb, calls };
    }

    /** Track a peer with a declared address, mirrored into PeerDb. */
    function trackPeer(pairMgr: PeerManager, peerDb: PeerDb, id: string, addr: string): void {
      pairMgr.addPeer(makePeer(id));
      pairMgr.setPeerAddress(id, addr);
      peerDb.record({
        address: addr,
        lastSeenMs: 1000,
        agentName: 'test',
        nodeName: id,
        protocolVersion: 1,
        capabilities: [],
      });
    }

    it('metadata records the declared address, null until set', () => {
      const { pairMgr } = makeBanPair();
      pairMgr.addPeer(makePeer('peer1'));
      expect(pairMgr.getPeerMetadata('peer1')!.address).toBeNull();
      pairMgr.setPeerAddress('peer1', ADDR);
      expect(pairMgr.getPeerMetadata('peer1')!.address).toBe(ADDR);
      // Untracked peer: no-op, no throw
      pairMgr.setPeerAddress('ghost', ADDR);
      expect(pairMgr.getPeerMetadata('ghost')).toBeNull();
    });

    it("permanent ban via recordPenalty('permanent') propagates despite the metadata delete (ordering trap)", () => {
      const { pairMgr, peerDb, calls } = makeBanPair();
      trackPeer(pairMgr, peerDb, 'peer1', ADDR);
      trackPeer(pairMgr, peerDb, 'peer2', OTHER);

      pairMgr.recordPenalty('permanent', 'peer1', 0, 'wrong magic');

      // This path deletes the metadata — propagation only happens if the
      // address was read before that delete, so this assertion fails if the
      // read is moved after it.
      expect(pairMgr.getPeerMetadata('peer1')).toBeNull();
      expect(calls.ban).toBe(1);
      expect(peerDb.isBanned(ADDR)).toBe(true);
      const recent = peerDb.recent(10, new Set()).map((r) => r.address);
      expect(recent).not.toContain(ADDR);
      // Control: the unbanned peer's address survives on both surfaces
      expect(peerDb.isBanned(OTHER)).toBe(false);
      expect(recent).toContain(OTHER);
    });

    it('permanent ban via recordPenaltyKind(ProtocolViolation) propagates despite the metadata delete (ordering trap)', () => {
      const { pairMgr, peerDb, calls } = makeBanPair();
      trackPeer(pairMgr, peerDb, 'peer1', ADDR);
      trackPeer(pairMgr, peerDb, 'peer2', OTHER);

      pairMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, 'peer1', 'malformed Peers');

      expect(pairMgr.getPeerMetadata('peer1')).toBeNull();
      expect(calls.ban).toBe(1);
      expect(peerDb.isBanned(ADDR)).toBe(true);
      const recent = peerDb.recent(10, new Set()).map((r) => r.address);
      expect(recent).not.toContain(ADDR);
      expect(peerDb.isBanned(OTHER)).toBe(false);
      expect(recent).toContain(OTHER);
    });

    it('temporal ban via score threshold propagates', () => {
      const { pairMgr, peerDb, calls } = makeBanPair();
      trackPeer(pairMgr, peerDb, 'peer1', ADDR);
      trackPeer(pairMgr, peerDb, 'peer2', OTHER);

      vi.spyOn(Date, 'now').mockReturnValue(1_000);
      pairMgr.recordPenalty('misbehavior', 'peer1', 500, 'threshold crossed');

      expect(pairMgr.isBanned('peer1')).toBe(true);
      expect(calls.ban).toBe(1);
      expect(peerDb.isBanned(ADDR)).toBe(true);
      const recent = peerDb.recent(10, new Set()).map((r) => r.address);
      expect(recent).not.toContain(ADDR);
      expect(peerDb.isBanned(OTHER)).toBe(false);
      expect(recent).toContain(OTHER);
    });

    it('temporal ban expiry lifts the PeerDb ban (control: still banned inside the window)', () => {
      const { pairMgr, peerDb, calls } = makeBanPair();
      trackPeer(pairMgr, peerDb, 'peer1', ADDR);

      vi.spyOn(Date, 'now').mockReturnValue(1_000);
      pairMgr.recordPenalty('misbehavior', 'peer1', 500, 'threshold crossed');
      expect(peerDb.isBanned(ADDR)).toBe(true);

      // Control: one ms before expiry, both surfaces stay banned
      vi.spyOn(Date, 'now').mockReturnValue(1_000 + config.temporalBanDurationMs - 1);
      expect(pairMgr.isBanned('peer1')).toBe(true);
      expect(peerDb.isBanned(ADDR)).toBe(true);
      expect(calls.unban).toBe(0);

      // At expiry the lazy check lifts both surfaces together
      vi.spyOn(Date, 'now').mockReturnValue(1_000 + config.temporalBanDurationMs);
      expect(pairMgr.isBanned('peer1')).toBe(false);
      expect(calls.unban).toBe(1);
      expect(peerDb.isBanned(ADDR)).toBe(false);
    });

    it('expiry propagates even after the peer disconnected and metadata is gone', () => {
      const { pairMgr, peerDb } = makeBanPair();
      trackPeer(pairMgr, peerDb, 'peer1', ADDR);

      vi.spyOn(Date, 'now').mockReturnValue(1_000);
      pairMgr.recordPenalty('misbehavior', 'peer1', 500, 'threshold crossed');
      // Disconnect during the ban window: metadata is deleted, the ban is not.
      // The BanEntry carries the address, so expiry can still unban it.
      pairMgr.removePeer('peer1');
      expect(pairMgr.getPeerMetadata('peer1')).toBeNull();
      expect(peerDb.isBanned(ADDR)).toBe(true);

      vi.spyOn(Date, 'now').mockReturnValue(1_000 + config.temporalBanDurationMs);
      expect(pairMgr.isBanned('peer1')).toBe(false);
      expect(peerDb.isBanned(ADDR)).toBe(false);
    });

    it('a ban with no recorded address propagates nothing and does not throw', () => {
      const { pairMgr, calls } = makeBanPair();
      // Tracked, but the handshake never completed — no declared address
      pairMgr.addPeer(makePeer('peer1'));
      pairMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, 'peer1', 'pre-handshake violation');
      expect(pairMgr.isBanned('peer1')).toBe(true);
      expect(calls.ban).toBe(0);

      // Never added at all (the works-even-if-never-added permanent path)
      pairMgr.recordPenalty('permanent', 'ghost', 0, 'never added');
      expect(pairMgr.isBanned('ghost')).toBe(true);
      expect(calls.ban).toBe(0);
    });
  });
});
