import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encode } from 'cbor-x';
import {
  verifyPoW,
  verifyOrderingBlockPoW,
  verifyPostSignature,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifySubBlockStructure,
  verifyTxStructure,
  verifyOrderingBlockStructure,
} from '@dagsocial/validation';
import {
  NetNode,
  servePeersBody,
  intakePeersBody,
  duePeerExchange,
  GET_PEERS_INTERVAL_MS,
  GET_PEERS_RESPONSE_LIMIT,
} from '../src/node.js';
import { PeerDb } from '../src/peerdb.js';
import { PeerManager } from '../src/peer-mgr.js';
import { encodeGetPeers, decodePeers } from '../src/sync-codec.js';
import { decodeFrame, MAGIC_MAINNET, MAGIC_TESTNET } from '../src/frame.js';
import { MSG_PEERS, PeerState } from '../src/types.js';
import type { NetConfig, PeerRecord, PeersMsg } from '../src/types.js';

// These tests drive the exact functions the stream handler and the 30s timer
// call (servePeersBody / intakePeersBody / duePeerExchange) with real PeerDb
// and PeerManager instances — not a reimplementation of their logic.

function makeConfig(): NetConfig {
  return {
    magic: MAGIC_TESTNET,
    bootstrapPeers: [],
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    maxPeers: 8,
    penaltyScoreThreshold: 500,
    temporalBanDurationMs: 3_600_000,
    penaltySafeIntervalMs: 120_000,
    syncRequestTimeoutMs: 30_000,
  };
}

function makePeerMgr(): PeerManager {
  return new PeerManager(makeConfig());
}

function rec(address: string, lastSeenMs: number): PeerRecord {
  return {
    address,
    lastSeenMs,
    agentName: 'dagsocial',
    nodeName: `node-at-${lastSeenMs}`,
    protocolVersion: 1,
    capabilities: [8, 9],
  };
}

function body(v: unknown): Uint8Array {
  return new Uint8Array(encode(v));
}

/** The unframed GetPeers body exactly as the dispatch hands it to the serve path. */
function getPeersRequestBody(): Uint8Array {
  return decodeFrame(MAGIC_TESTNET, encodeGetPeers(MAGIC_TESTNET)).body;
}

const GARBAGE = new Uint8Array([0xff, 0xff, 0xff, 0xff]);

/** Unwrap a framed Peers response produced by servePeersBody. */
function unwrapPeers(response: Uint8Array): PeersMsg {
  const frame = decodeFrame(MAGIC_TESTNET, response);
  expect(frame.code).toBe(MSG_PEERS);
  const msg = decodePeers(frame.body);
  expect(msg).not.toBeNull();
  return msg as PeersMsg;
}

describe('servePeersBody', () => {
  it('serves at most 8 entries, never the requester or a banned address', () => {
    const peerDb = new PeerDb(null, 100, []);
    for (let i = 0; i < 12; i++) {
      peerDb.record(rec(`/ip4/51.15.0.${i}/tcp/4001`, 1000 + i));
    }
    const requesterAddr = '/ip4/51.15.0.10/tcp/4001';
    peerDb.ban('/ip4/51.15.0.11/tcp/4001'); // most recent — must still be excluded

    const response = servePeersBody(getPeersRequestBody(), {
      peerDb,
      peerMgr: makePeerMgr(),
      peerId: 'requester',
      requesterAddr,
      magic: MAGIC_TESTNET,
    });
    expect(response).not.toBeNull();
    const msg = unwrapPeers(response as Uint8Array);

    expect(msg.peers.length).toBe(GET_PEERS_RESPONSE_LIMIT);
    const addrs = msg.peers.map((p) => p.address);
    expect(addrs).not.toContain(requesterAddr);
    expect(addrs).not.toContain('/ip4/51.15.0.11/tcp/4001');
    // Most recently seen first: 9, 8, ... (10 is the requester, 11 banned)
    expect(addrs[0]).toBe('/ip4/51.15.0.9/tcp/4001');
  });

  it('answers { peers: [] } from an empty PeerDb rather than skipping the response', () => {
    const response = servePeersBody(getPeersRequestBody(), {
      peerDb: new PeerDb(null, 100, []),
      peerMgr: makePeerMgr(),
      peerId: 'requester',
      requesterAddr: null,
      magic: MAGIC_TESTNET,
    });
    expect(response).not.toBeNull();
    expect(unwrapPeers(response as Uint8Array)).toEqual({ peers: [] });
  });

  it('permanently bans the sender of a malformed GetPeers (control: valid body does not)', () => {
    const peerDb = new PeerDb(null, 100, []);

    const okMgr = makePeerMgr();
    const ok = servePeersBody(getPeersRequestBody(), {
      peerDb, peerMgr: okMgr, peerId: 'good', requesterAddr: null, magic: MAGIC_TESTNET,
    });
    expect(ok).not.toBeNull();
    expect(okMgr.isBanned('good')).toBe(false);

    const banMgr = makePeerMgr();
    const bad = servePeersBody(GARBAGE, {
      peerDb, peerMgr: banMgr, peerId: 'bad', requesterAddr: null, magic: MAGIC_TESTNET,
    });
    expect(bad).toBeNull();
    expect(banMgr.isBanned('bad')).toBe(true);
  });
});

describe('intakePeersBody', () => {
  const good1 = '/ip4/51.15.7.7/tcp/4001';
  const good2 = '/ip6/2001:4860:4860::8888/tcp/4001';

  function entry(address: string): Record<string, unknown> {
    return { address, agentName: 'remote', nodeName: 'r1', protocolVersion: 1, capabilities: [8] };
  }

  it('records every good entry with the local clock, not the wire', () => {
    const peerDb = new PeerDb(null, 100, []);
    const peerMgr = makePeerMgr();
    const usable = intakePeersBody(body({ peers: [entry(good1), entry(good2)] }), {
      peerDb, peerMgr, peerId: 'sender', magic: MAGIC_MAINNET, nowMs: 5555,
    });
    expect(usable).toBe(2);
    expect(peerDb.get(good1)?.lastSeenMs).toBe(5555);
    expect(peerDb.get(good2)?.lastSeenMs).toBe(5555);
    expect(peerMgr.isBanned('sender')).toBe(false);
  });

  it('drops bogus entries silently — good ones recorded, no penalty for the sender', () => {
    const peerDb = new PeerDb(null, 100, []);
    const peerMgr = makePeerMgr();
    const usable = intakePeersBody(
      body({
        peers: [
          entry(good1),
          entry('/ip4/127.0.0.1/tcp/4001'), // always bogus
          entry('/ip4/10.1.2.3/tcp/4001'), // bogus on mainnet
          entry('/dns4/example.com/tcp/443'), // no IP component — bogus
        ],
      }),
      { peerDb, peerMgr, peerId: 'sender', magic: MAGIC_MAINNET, nowMs: 1 },
    );
    expect(usable).toBe(1);
    expect(peerDb.count()).toBe(1);
    expect(peerDb.get(good1)).not.toBeNull();
    expect(peerMgr.isBanned('sender')).toBe(false);
  });

  it('records a private address under testnet magic (NAT/LAN is normal there)', () => {
    const peerDb = new PeerDb(null, 100, []);
    const usable = intakePeersBody(body({ peers: [entry('/ip4/10.1.2.3/tcp/4001')] }), {
      peerDb, peerMgr: makePeerMgr(), peerId: 'sender', magic: MAGIC_TESTNET, nowMs: 1,
    });
    expect(usable).toBe(1);
    expect(peerDb.get('/ip4/10.1.2.3/tcp/4001')).not.toBeNull();
  });

  it('never records our own address', () => {
    const peerDb = new PeerDb(null, 100, [good1]);
    const peerMgr = makePeerMgr();
    intakePeersBody(body({ peers: [entry(good1), entry(good2)] }), {
      peerDb, peerMgr, peerId: 'sender', magic: MAGIC_MAINNET, nowMs: 1,
    });
    expect(peerDb.get(good1)).toBeNull();
    expect(peerDb.get(good2)).not.toBeNull();
    expect(peerMgr.isBanned('sender')).toBe(false);
  });

  it('never records a banned address, without penalizing the sender', () => {
    const peerDb = new PeerDb(null, 100, []);
    peerDb.ban(good1);
    const peerMgr = makePeerMgr();
    intakePeersBody(body({ peers: [entry(good1)] }), {
      peerDb, peerMgr, peerId: 'sender', magic: MAGIC_MAINNET, nowMs: 1,
    });
    expect(peerDb.get(good1)).toBeNull();
    expect(peerMgr.isBanned('sender')).toBe(false);
  });

  it('permanently bans the sender of an undecodable body and records nothing', () => {
    const peerDb = new PeerDb(null, 100, []);
    const peerMgr = makePeerMgr();
    const usable = intakePeersBody(GARBAGE, {
      peerDb, peerMgr, peerId: 'sender', magic: MAGIC_MAINNET, nowMs: 1,
    });
    expect(usable).toBeNull();
    expect(peerDb.count()).toBe(0);
    expect(peerMgr.isBanned('sender')).toBe(true);
  });

  it('permanently bans the sender of an over-cap body (65 entries)', () => {
    const peerDb = new PeerDb(null, 100, []);
    const peerMgr = makePeerMgr();
    const peers = Array.from({ length: 65 }, (_, i) => entry(`/ip4/51.15.1.${i % 256}/tcp/${4001 + i}`));
    const usable = intakePeersBody(body({ peers }), {
      peerDb, peerMgr, peerId: 'sender', magic: MAGIC_MAINNET, nowMs: 1,
    });
    expect(usable).toBeNull();
    expect(peerDb.count()).toBe(0);
    expect(peerMgr.isBanned('sender')).toBe(true);
  });
});

describe('peerDbCap default (contract: soft cap 1000)', () => {
  const validators = {
    verifyPoW,
    verifyOrderingBlockPoW,
    verifyPostSignature,
    verifyProtocolVersion,
    verifyContentLimits,
    verifyParentRefsCount,
    verifySubBlockStructure,
    verifyTxStructure,
    verifyOrderingBlockStructure,
  };

  // The fallback lives in NetNode.start(), so the test starts a real node.
  // The cap is a private PeerDb field — read via the any-escape the other
  // suites use for internals.
  it('constructs PeerDb with 1000 when peerDbCap is unset', async () => {
    const node = new NetNode(makeConfig(), validators);
    await node.start();
    try {
      expect((node as any).peerDb.cap).toBe(1000);
    } finally {
      await node.stop();
    }
  });

  it('control: an explicit peerDbCap is honored unchanged', async () => {
    const node = new NetNode({ ...makeConfig(), peerDbCap: 42 }, validators);
    await node.start();
    try {
      expect((node as any).peerDb.cap).toBe(42);
    } finally {
      await node.stop();
    }
  });
});

describe('duePeerExchange cadence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function activePeer(peerMgr: PeerManager, id: string): void {
    peerMgr.addPeer({ id, multiaddrs: [], protocols: [], connectedAt: Date.now() });
    peerMgr.setPeerState(id, PeerState.Active);
  }

  it('sends immediately after handshake, then not again inside one interval', () => {
    const peerMgr = makePeerMgr();
    activePeer(peerMgr, 'p1');
    const last = new Map<string, number>();

    expect(duePeerExchange(peerMgr, last, Date.now())).toEqual(['p1']);

    vi.advanceTimersByTime(30_000);
    expect(duePeerExchange(peerMgr, last, Date.now())).toEqual([]);
    vi.advanceTimersByTime(60_000); // 90s since send — still inside the interval
    expect(duePeerExchange(peerMgr, last, Date.now())).toEqual([]);
  });

  it('sends again once the interval elapses', () => {
    const peerMgr = makePeerMgr();
    activePeer(peerMgr, 'p1');
    const last = new Map<string, number>();

    duePeerExchange(peerMgr, last, Date.now());
    vi.advanceTimersByTime(GET_PEERS_INTERVAL_MS);
    expect(duePeerExchange(peerMgr, last, Date.now())).toEqual(['p1']);
  });

  it('never selects a peer that is not Active', () => {
    const peerMgr = makePeerMgr();
    peerMgr.addPeer({ id: 'handshaking', multiaddrs: [], protocols: [], connectedAt: Date.now() });
    peerMgr.setPeerState('handshaking', PeerState.Handshaking);
    activePeer(peerMgr, 'active');

    expect(duePeerExchange(peerMgr, new Map(), Date.now())).toEqual(['active']);
  });

  it('tracks each peer independently', () => {
    const peerMgr = makePeerMgr();
    activePeer(peerMgr, 'p1');
    const last = new Map<string, number>();
    duePeerExchange(peerMgr, last, Date.now());

    vi.advanceTimersByTime(30_000);
    activePeer(peerMgr, 'p2'); // connects one tick later
    expect(duePeerExchange(peerMgr, last, Date.now())).toEqual(['p2']);

    vi.advanceTimersByTime(GET_PEERS_INTERVAL_MS - 30_000); // p1's interval elapsed, p2's has not
    expect(duePeerExchange(peerMgr, last, Date.now())).toEqual(['p1']);
  });
});
