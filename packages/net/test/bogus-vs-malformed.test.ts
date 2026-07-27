import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PeerManager, PenaltyKind } from '@dagsocial/net';
import type { NetConfig, Peer } from '@dagsocial/net';

function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return {
    bootstrapPeers: [],
    listenAddrs: '/ip4/0.0.0.0/tcp/0',
    maxPeers: 50,
    penaltyScoreThreshold: 500,
    temporalBanDurationMs: 3_600_000,
    penaltySafeIntervalMs: 120_000,
    peerEvictionIntervalMs: 3_600_000,
    syncRequestTimeoutMs: 10_000,
    ...overrides,
  };
}

function makePeer(id: string): Peer {
  return {
    id,
    multiaddrs: [`/ip4/127.0.0.1/tcp/${9000 + parseInt(id, 10)}`],
    protocols: [],
    connectedAt: Date.now(),
  };
}

describe('bogus vs malformed distinction', () => {
  let mgr: PeerManager;

  beforeEach(() => {
    mgr = new PeerManager(makeConfig());
  });

  // -----------------------------------------------------------------------
  // Malformed: cannot decode → permanent ban (ProtocolViolation)
  // -----------------------------------------------------------------------

  it('malformed protocol message triggers permanent ban via ProtocolViolation', () => {
    mgr.addPeer(makePeer('peer1'));
    expect(mgr.getPeerCount()).toBe(1);

    // Simulate a malformed message that cannot be decoded
    mgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, 'peer1', 'truncated CBOR body');

    expect(mgr.isBanned('peer1')).toBe(true);
    expect(mgr.getPeerCount()).toBe(0); // peer removed
    expect(mgr.getPeerMetadata('peer1')).toBeNull(); // metadata cleared
  });

  it('malformed message: permanent ban works even for unknown peer', () => {
    // ProtocolViolation should work even if the peer was never added
    mgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, 'rogue', 'garbage frame');
    expect(mgr.isBanned('rogue')).toBe(true);
    // No peers tracked (never added)
    expect(mgr.getPeerCount()).toBe(0);
  });

  it('permanent ban is not temporal — never expires', () => {
    mgr.addPeer(makePeer('peer1'));
    mgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, 'peer1', 'malformed');

    // Ban should persist even with mocked time far in the future
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000); // +100 years
    expect(mgr.isBanned('peer1')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Bogus: well-formed but invalid content → penalty, NOT permanent ban
  // -----------------------------------------------------------------------

  it('well-formed message with invalid content: penalty but peer stays', () => {
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(0);

    // Simulate a well-formed sub-block with invalid content (e.g., empty post)
    mgr.recordPenalty('misbehavior', 'peer1', 100, 'empty content');

    expect(mgr.isBanned('peer1')).toBe(false);
    expect(mgr.getPeerCount()).toBe(1); // peer still tracked
    const meta = mgr.getPeerMetadata('peer1');
    expect(meta).not.toBeNull();
    expect(meta!.penaltyCount).toBe(1);
  });

  it('Transient penalty: does NOT cause permanent ban, just cooldown', () => {
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(0);

    // Bogus data: well-formed but invalid → Transient penalty
    mgr.recordPenaltyKind(PenaltyKind.Transient, 'peer1', 'non-routable address in PEERS');

    expect(mgr.isBanned('peer1')).toBe(false);
    expect(mgr.getPeerCount()).toBe(1);
    const meta = mgr.getPeerMetadata('peer1');
    expect(meta).not.toBeNull();
    expect(meta!.penaltyCount).toBe(1);
  });

  it('accumulating bogus penalties eventually triggers temporal ban (not permanent)', () => {
    mgr.addPeer(makePeer('peer1'));

    // 10 × Transient penalties at 50 each = 500 (= threshold)
    for (let i = 0; i < 10; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(i * (120_000 + 1)); // outside safe interval
      mgr.recordPenaltyKind(PenaltyKind.Transient, 'peer1', `invalid content ${i}`);
    }

    // Temporal ban — peer is banned but it's time-limited
    expect(mgr.isBanned('peer1')).toBe(true);
    expect(mgr.getPeerCount()).toBe(0);

    // After temporal ban expires, peer is no longer banned
    vi.spyOn(Date, 'now').mockReturnValue(10 * 120_001 + 3_600_001); // after ban duration
    expect(mgr.isBanned('peer1')).toBe(false); // temporal ban expired
  });

  // -----------------------------------------------------------------------
  // Contrast: same peer — bogus first (penalty), then malformed (permanent ban)
  // -----------------------------------------------------------------------

  it('bogus then malformed: penalty then permanent ban', () => {
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(0);

    // First: bogus message — penalty, no ban
    mgr.recordPenaltyKind(PenaltyKind.Transient, 'peer1', 'bogus content');
    expect(mgr.isBanned('peer1')).toBe(false);

    // Advance time past safe interval
    vi.spyOn(Date, 'now').mockReturnValue(120_001);

    // Then: malformed message — permanent ban
    mgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, 'peer1', 'corrupted frame');
    expect(mgr.isBanned('peer1')).toBe(true);
    expect(mgr.getPeerCount()).toBe(0);
  });

  it('malformed first: permanent ban trumps everything', () => {
    mgr.addPeer(makePeer('peer1'));

    // Malformed message detected first
    mgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, 'peer1', 'garbage data');
    expect(mgr.isBanned('peer1')).toBe(true);

    // Subsequent bogus penalties are no-ops (peer already removed)
    mgr.recordPenalty('misbehavior', 'peer1', 100, 'empty content');
    expect(mgr.getPeerCount()).toBe(0);
    expect(mgr.getPeerMetadata('peer1')).toBeNull();
  });
});
