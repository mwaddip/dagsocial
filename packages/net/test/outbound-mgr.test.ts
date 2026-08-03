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

/** Fake connection with just the slice planTick reads (ConnectionLike). */
function conn(direction: 'inbound' | 'outbound', addr: string) {
  return { direction, remoteAddr: { toString: () => addr } };
}

const NONE = new Set<string>();

describe('OutboundManager', () => {
  let mgr: OutboundManager;
  let db: PeerDb;

  beforeEach(() => {
    db = new PeerDb(null, 100, []);
    mgr = new OutboundManager(testConfig, db);
  });

  it('returns null when below minPeers (floor phase — caller dials seeds)', () => {
    expect(mgr.pickCandidate(1, NONE)).toBeNull();
  });

  it('returns null when at maxPeers', () => {
    expect(mgr.pickCandidate(10, NONE)).toBeNull();
  });

  it('returns null when above maxPeers', () => {
    expect(mgr.pickCandidate(15, NONE)).toBeNull();
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
    const candidate = mgr.pickCandidate(5, NONE); // 5 outbound, max 10
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
    expect(mgr.pickCandidate(5, NONE)).toBeNull(); // in cooldown
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
    const candidate = mgr.pickCandidate(5, NONE);
    expect(candidate).toBe('/ip4/1.2.3.4/tcp/9000');
  });

  it('returns null when PeerDb is empty in fill phase', () => {
    expect(mgr.pickCandidate(5, NONE)).toBeNull(); // db is empty
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
    const candidate = mgr.pickCandidate(5, NONE);
    expect(candidate).toBe('/ip4/2.2.2.2/tcp/9000'); // most recent first
  });

  it('returns null when at exact minPeers boundary (still floor phase)', () => {
    // minPeers is 3, so connectedCount < 3 means floor phase
    // at 3 exactly we are in fill phase, but with empty db we get null
    expect(mgr.pickCandidate(3, NONE)).toBeNull(); // fill phase but empty db
  });

  // -----------------------------------------------------------------------
  // Outbound-only counting (contract: "Outbound Manager", audit L-14 phase 2)
  // -----------------------------------------------------------------------

  describe('planTick counts outbound connections only (eclipse resistance)', () => {
    it('N inbound > maxPeers with 0 outbound: the floor still fires — we still dial out (fails pre-fix)', () => {
      // Pre-fix the timer fed peerMgr.getPeerCount() — ALL tracked peers —
      // into these decisions. Twelve inbound connections read as 12: the
      // floor check (12 < minPeers=3 — false) dialed no seeds, and the fill
      // phase (12 >= maxPeers=10) returned null. An attacker who filled our
      // inbound slots had silenced every outbound dial: the eclipse setup.
      // Post-fix both phases see outbound=0, so the floor fires.
      const inboundFlood = Array.from({ length: 12 }, (_, i) =>
        conn('inbound', `/ip4/198.51.100.${i}/tcp/${40000 + i}`));
      const plan = mgr.planTick(inboundFlood);
      expect(plan.dialBootstrap).toBe(true);
      expect(plan.candidate).toBeNull(); // floor phase: seeds, not PeerDb
    });

    it('control: with minPeers outbound connections the floor no longer fires', () => {
      const conns = [
        ...Array.from({ length: 12 }, (_, i) =>
          conn('inbound', `/ip4/198.51.100.${i}/tcp/${40000 + i}`)),
        conn('outbound', '/ip4/51.15.9.1/tcp/4001'),
        conn('outbound', '/ip4/51.15.9.2/tcp/4001'),
        conn('outbound', '/ip4/51.15.9.3/tcp/4001'),
      ];
      expect(mgr.planTick(conns).dialBootstrap).toBe(false);
    });

    it('outbound connections alone reaching maxPeers stop the fill phase', () => {
      db.record({
        address: '/ip4/1.2.3.4/tcp/9000',
        lastSeenMs: Date.now(),
        agentName: 'test',
        nodeName: 'candidate',
        protocolVersion: 1,
        capabilities: [],
      });
      const conns = Array.from({ length: 10 }, (_, i) =>
        conn('outbound', `/ip4/51.15.9.${i}/tcp/4001`));
      const plan = mgr.planTick(conns);
      expect(plan.dialBootstrap).toBe(false);
      expect(plan.candidate).toBeNull();
    });
  });

  describe('fill-phase exclude set = connected ∪ cooldown', () => {
    const target = '/ip4/1.2.3.4/tcp/9000';

    function recordTarget(): void {
      db.record({
        address: target,
        lastSeenMs: Date.now(),
        agentName: 'test',
        nodeName: 'target',
        protocolVersion: 1,
        capabilities: [],
      });
    }

    it('a candidate we already hold a connection to is not re-dialed (control: returned when not connected)', () => {
      recordTarget();

      // Control: fill phase (3 outbound), target not among our connections
      const notConnected = [
        conn('outbound', '/ip4/51.15.9.1/tcp/4001'),
        conn('outbound', '/ip4/51.15.9.2/tcp/4001'),
        conn('outbound', '/ip4/51.15.9.3/tcp/4001'),
      ];
      expect(mgr.planTick(notConnected).candidate).toBe(target);

      // Same PeerDb, same fill phase, but the target IS one of our live
      // connections — re-dialing it would starve genuinely new candidates.
      const connected = [
        conn('outbound', target),
        conn('outbound', '/ip4/51.15.9.2/tcp/4001'),
        conn('outbound', '/ip4/51.15.9.3/tcp/4001'),
      ];
      expect(mgr.planTick(connected).candidate).toBeNull();
    });

    it('pickCandidate unions the connected set with the cooldown set', () => {
      const cooling = '/ip4/5.6.7.8/tcp/9000';
      recordTarget();
      db.record({
        address: cooling,
        lastSeenMs: Date.now() + 1, // more recent than target
        agentName: 'test',
        nodeName: 'cooling',
        protocolVersion: 1,
        capabilities: [],
      });
      mgr.recordDialResult(cooling, false); // enters redial cooldown

      // Control: cooldown alone leaves the target available
      expect(mgr.pickCandidate(5, NONE)).toBe(target);
      // Connected ∪ cooldown excludes both candidates — nothing to dial
      expect(mgr.pickCandidate(5, new Set([target]))).toBeNull();
    });
  });
});
