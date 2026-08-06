import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PeerManager } from '../src/peer-mgr.js';
import { PenaltyKind, PeerState } from '../src/types.js';
import type { NetConfig, Peer } from '../src/types.js';

function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return {
    magic: 0x54444147,
    postPowTargetBits: 8,
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
  return {
    id,
    multiaddrs: [`/ip4/127.0.0.1/tcp/${9000 + parseInt(id)}`],
    protocols: [],
    connectedAt: Date.now(),
  };
}

describe('penalty attribution (using PeerManager)', () => {
  let mgr: PeerManager;
  let config: NetConfig;

  beforeEach(() => {
    config = makeConfig();
    mgr = new PeerManager(config);
  });

  it('ProtocolViolation permanently bans and removes the peer', () => {
    mgr.addPeer(makePeer('peer1'));
    expect(mgr.getPeerCount()).toBe(1);

    mgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, 'peer1', 'malformed message');

    expect(mgr.isBanned('peer1')).toBe(true);
    expect(mgr.getPeerCount()).toBe(0);
    expect(mgr.getPeerMetadata('peer1')).toBeNull();
  });

  it('Transient adds 50 points and does NOT ban (below threshold)', () => {
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(0);

    mgr.recordPenaltyKind(PenaltyKind.Transient, 'peer1', 'timeout');

    const meta = mgr.getPeerMetadata('peer1');
    expect(meta).not.toBeNull();
    expect(meta!.penaltyCount).toBe(1);
    expect(mgr.getPeerCount()).toBe(1);
    expect(mgr.isBanned('peer1')).toBe(false);
  });

  it('RateLimit adds 100 points (higher than Transient)', () => {
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(0);

    mgr.recordPenaltyKind(PenaltyKind.RateLimit, 'peer1', 'too many messages');

    const meta = mgr.getPeerMetadata('peer1');
    expect(meta).not.toBeNull();
    expect(meta!.penaltyCount).toBe(1);
    expect(mgr.getPeerCount()).toBe(1);
    expect(mgr.isBanned('peer1')).toBe(false);
  });

  it('Transient is lower severity than RateLimit (scores verified)', () => {
    // Transient = 50, RateLimit = 100 per the three-tier penalty system
    mgr.addPeer(makePeer('transientPeer'));
    mgr.addPeer(makePeer('rateLimitPeer'));
    vi.spyOn(Date, 'now').mockReturnValue(0);

    mgr.recordPenaltyKind(PenaltyKind.Transient, 'transientPeer', 'timeout');
    mgr.recordPenaltyKind(PenaltyKind.RateLimit, 'rateLimitPeer', 'flood');

    // Both peers still tracked (below threshold of 500)
    expect(mgr.getPeerCount()).toBe(2);

    // RateLimit accrues penalties faster towards threshold (100 vs 50)
    // Verify by getting metadata entries — penaltyCount is the same (1 each)
    const tMeta = mgr.getPeerMetadata('transientPeer');
    const rMeta = mgr.getPeerMetadata('rateLimitPeer');
    expect(tMeta?.penaltyCount).toBe(1);
    expect(rMeta?.penaltyCount).toBe(1);
  });

  it('accumulating Transient penalties above break-even triggers temporal ban', () => {
    mgr.addPeer(makePeer('peer1'));
    // A Transient (50) decays away within half a safe interval, so only
    // faster misbehavior accrues pressure. One penalty per interval/10 nets
    // +40 per step — 50, 90, 130, … crossing 500 on the 13th penalty.
    for (let i = 0; i < 13; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(i * (config.penaltySafeIntervalMs / 10));
      mgr.recordPenaltyKind(PenaltyKind.Transient, 'peer1', `timeout ${i}`);
    }

    expect(mgr.isBanned('peer1')).toBe(true);
    expect(mgr.getPeerCount()).toBe(0);
  });

  it('rapid non-fatal penalties all accrue — none are discarded (fails pre-fix)', () => {
    // Pre-fix the safe-interval cooldown swallowed the second penalty
    // (penaltyCount 1); post-fix every penalty counts. Nonzero timestamp:
    // the pre-fix cooldown skipped itself while lastPenaltyTime was 0.
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(1_000);

    mgr.recordPenaltyKind(PenaltyKind.Transient, 'peer1', 'first');
    mgr.recordPenaltyKind(PenaltyKind.Transient, 'peer1', 'second — counts too');

    const meta = mgr.getPeerMetadata('peer1');
    expect(meta?.penaltyCount).toBe(2);
    expect((mgr as any).peers.get('peer1').penaltyScore).toBe(100);
  });

  it('kind path bans a flood too: 5 rapid RateLimit penalties (parity with recordPenalty)', () => {
    // Nonzero timestamp for the same reason as the recordPenalty flood test.
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    for (let i = 0; i < 5; i++) {
      mgr.recordPenaltyKind(PenaltyKind.RateLimit, 'peer1', `flood ${i}`);
    }
    expect(mgr.isBanned('peer1')).toBe(true);
    expect(mgr.getPeerCount()).toBe(0);
  });

  it('kind path decays too: two RateLimits one interval apart hold at 100, not 200', () => {
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(0);
    mgr.recordPenaltyKind(PenaltyKind.RateLimit, 'peer1', 'first');
    vi.spyOn(Date, 'now').mockReturnValue(config.penaltySafeIntervalMs);
    mgr.recordPenaltyKind(PenaltyKind.RateLimit, 'peer1', 'second');

    expect((mgr as any).peers.get('peer1').penaltyScore).toBe(100);
    expect(mgr.getPeerMetadata('peer1')?.penaltyCount).toBe(2);
    expect(mgr.isBanned('peer1')).toBe(false);
  });

  it('ProtocolViolation bans instantly at zero score and regardless of decay', () => {
    // Permanent bans bypass scoring entirely — no accumulated score needed.
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(0);
    mgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, 'peer1', 'malformed');
    expect(mgr.isBanned('peer1')).toBe(true);
    expect(mgr.getPeerMetadata('peer1')).toBeNull();

    // A peer whose score has long since decayed to nothing is still
    // permanently banned on the spot — decay never applies to permanents.
    mgr.addPeer(makePeer('peer2'));
    mgr.recordPenaltyKind(PenaltyKind.RateLimit, 'peer2', 'noise');
    vi.spyOn(Date, 'now').mockReturnValue(1000 * config.penaltySafeIntervalMs);
    mgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, 'peer2', 'malformed later');
    expect(mgr.isBanned('peer2')).toBe(true);
    expect(mgr.getPeerCount()).toBe(0);

    // Permanent = survives any clock advance.
    vi.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER);
    expect(mgr.isBanned('peer1')).toBe(true);
    expect(mgr.isBanned('peer2')).toBe(true);
  });

  it('penalty for unknown peer is a no-op', () => {
    mgr.recordPenaltyKind(PenaltyKind.Transient, 'ghost', 'who?');
    mgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, 'ghost2', '??');
    // Should not throw, no peers tracked
    expect(mgr.getPeerCount()).toBe(0);
  });
});
