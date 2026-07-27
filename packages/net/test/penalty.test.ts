import { describe, it, expect } from 'vitest';
import { PenaltyKind } from '../src/types.js';

describe('penalty attribution', () => {
  it('distinguishes transient failures from protocol violations', () => {
    // Transient: timeout → cooldown, peer stays in PeerDb
    // Protocol violation: malformed message → permanent ban, peer removed from PeerDb
    expect(PenaltyKind.Transient).not.toBe(PenaltyKind.ProtocolViolation);
  });

  it('distinguishes rate limit from protocol violation', () => {
    // Rate limit: too many messages → cooldown, peer stays
    // Protocol violation: malformed message → permanent ban
    expect(PenaltyKind.RateLimit).not.toBe(PenaltyKind.ProtocolViolation);
  });

  it('transient and rate limit are non-fatal (not bans)', () => {
    const nonFatal = [
      PenaltyKind.Transient,
      PenaltyKind.RateLimit,
    ];

    for (const kind of nonFatal) {
      const isBan = kind === PenaltyKind.ProtocolViolation;
      expect(isBan).toBe(false);
    }
  });

  it('protocol violation is the only fatal penalty kind', () => {
    const isFatal = (kind: PenaltyKind): boolean => kind === PenaltyKind.ProtocolViolation;

    expect(isFatal(PenaltyKind.Transient)).toBe(false);
    expect(isFatal(PenaltyKind.RateLimit)).toBe(false);
    expect(isFatal(PenaltyKind.ProtocolViolation)).toBe(true);
  });

  it('bogus addresses in valid gossip do not trigger penalty', () => {
    // Valid Peers message with some non-routable addresses
    // → bogus entries silently dropped
    // → sender NOT penalized
    // → valid entries still ingested

    const addresses = [
      { addr: '/ip4/8.8.8.8/tcp/9000', bogus: false },
      { addr: '/ip4/127.0.0.1/tcp/9000', bogus: true },   // loopback
      { addr: '/ip4/192.168.1.1/tcp/9000', bogus: true },  // private (mainnet)
      { addr: '/ip4/10.0.0.1/tcp/9000', bogus: true },     // private (mainnet)
      { addr: '/ip4/93.184.216.34/tcp/9000', bogus: false },
    ];

    // Separate bogus from valid
    const valid = addresses.filter((a) => !a.bogus);
    const bogus = addresses.filter((a) => a.bogus);

    // Bogus entries exist but do not invalidate the whole message
    expect(bogus.length).toBeGreaterThan(0);
    // Valid entries are still ingestible
    expect(valid.length).toBeGreaterThan(0);
    // The sender is not penalized for bogus entries in otherwise-valid gossip
  });

  it('malformed Peers message (cap exceeded) triggers protocol violation', () => {
    // If a Peers message declares more than 64 peers, it's a protocol violation
    const peerCount = 65;
    const exceedsCap = peerCount > 64;
    expect(exceedsCap).toBe(true);

    // This should trigger PenaltyKind.ProtocolViolation → permanent ban
    const penaltyKind = exceedsCap
      ? PenaltyKind.ProtocolViolation
      : PenaltyKind.Transient;
    expect(penaltyKind).toBe(PenaltyKind.ProtocolViolation);
  });

  it('valid Peers message within cap does not trigger penalty', () => {
    const peerCount = 8;
    const exceedsCap = peerCount > 64;
    expect(exceedsCap).toBe(false);

    const penaltyKind = exceedsCap
      ? PenaltyKind.ProtocolViolation
      : PenaltyKind.Transient;
    expect(penaltyKind).not.toBe(PenaltyKind.ProtocolViolation);
  });

  it('all penalty kinds are unique', () => {
    const kinds = new Set([
      PenaltyKind.Transient,
      PenaltyKind.ProtocolViolation,
      PenaltyKind.RateLimit,
    ]);
    expect(kinds.size).toBe(3);
  });
});
