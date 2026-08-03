import { describe, it, expect } from 'vitest';
import { encode } from 'cbor-x';
import {
  encodeGetPeers,
  decodeGetPeers,
  encodePeers,
  decodePeers,
} from '../src/sync-codec.js';
import { decodeFrame, MAGIC_MAINNET, MAGIC_TESTNET } from '../src/frame.js';
import { MSG_GET_PEERS, MSG_PEERS } from '../src/types.js';
import type { PeerEntryMsg } from '../src/types.js';
import { MAX_PEERS_ENTRIES, MAX_CAPABILITY_CODE } from '../src/msg-guards.js';
import { isBogusAddress } from '../src/bogus-addr.js';

/** CBOR-encode a value as a raw message body (no frame). */
function body(v: unknown): Uint8Array {
  return new Uint8Array(encode(v));
}

/** Bytes that are not well-formed CBOR. */
const GARBAGE = new Uint8Array([0xff, 0xff, 0xff, 0xff]);

/** A known-good Peers entry; override one field to build a rejection delta. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: '/ip4/93.184.216.34/tcp/4001',
    agentName: 'dagsocial/0.1.0',
    nodeName: 'test-node',
    protocolVersion: 1,
    capabilities: [8, 9],
    ...overrides,
  };
}

function entries(n: number): PeerEntryMsg[] {
  return Array.from({ length: n }, (_, i) => ({
    address: `/ip4/51.15.${Math.floor(i / 256)}.${i % 256}/tcp/4001`,
    agentName: `agent-${i}`,
    nodeName: `node-${i}`,
    protocolVersion: 1,
    capabilities: [8],
  }));
}

/**
 * Assert that `mutate` applied to an otherwise-valid body flips the decode
 * from success to `null` — every rejection is proven non-vacuous by its own
 * single-field-delta control.
 */
function expectRejectionDelta(mutate: (v: { peers: Record<string, unknown>[] }) => void): void {
  const v = { peers: [entry()] };
  expect(decodePeers(body(v))).not.toBeNull();
  mutate(v);
  expect(decodePeers(body(v))).toBeNull();
}

describe('GetPeers codec', () => {
  it('frames an empty CBOR map under code 8 and round-trips', () => {
    const frame = encodeGetPeers(MAGIC_TESTNET);
    const { code, body: b } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(MSG_GET_PEERS);
    expect(b.length).toBeGreaterThan(0); // empty map, not zero bytes
    expect(decodeGetPeers(b)).toEqual({});
  });

  it('accepts an empty body', () => {
    expect(decodeGetPeers(new Uint8Array(0))).toEqual({});
  });

  it('accepts a body with unknown fields (forward compat)', () => {
    expect(decodeGetPeers(body({ futureField: 42, other: 'x' }))).toEqual({});
  });

  it('rejects bytes that are not well-formed CBOR', () => {
    expect(decodeGetPeers(GARBAGE)).toBeNull();
  });
});

describe('Peers codec round-trip', () => {
  for (const n of [0, 1, 8, MAX_PEERS_ENTRIES]) {
    it(`round-trips ${n} entries through the frame`, () => {
      const msg = { peers: entries(n) };
      const frame = encodePeers(MAGIC_TESTNET, msg);
      const { code, body: b } = decodeFrame(MAGIC_TESTNET, frame);
      expect(code).toBe(MSG_PEERS);
      expect(decodePeers(b)).toEqual(msg);
    });
  }

  it('round-trips IPv4 and IPv6 multiaddr addresses', () => {
    const msg = {
      peers: [
        entry({ address: '/ip4/93.184.216.34/tcp/4001' }),
        entry({ address: '/ip6/2001:4860:4860::8888/tcp/4001' }),
      ] as unknown as PeerEntryMsg[],
    };
    expect(decodePeers(body(msg))).toEqual(msg);
  });

  it('round-trips empty-string agentName and nodeName', () => {
    const msg = { peers: [entry({ agentName: '', nodeName: '' })] };
    expect(decodePeers(body(msg))).toEqual(msg);
  });

  for (const caps of [[], [0], [0, 1, 2, 3, 4, 5, 6, 7]]) {
    it(`round-trips capabilities of length ${caps.length}`, () => {
      const msg = { peers: [entry({ capabilities: caps })] };
      expect(decodePeers(body(msg))).toEqual(msg);
    });
  }

  it('accepts a capability code at exactly MAX_CAPABILITY_CODE', () => {
    const msg = { peers: [entry({ capabilities: [MAX_CAPABILITY_CODE] })] };
    expect(decodePeers(body(msg))).toEqual(msg);
  });
});

describe('Peers codec rejections (each with its single-field-delta control)', () => {
  it('rejects bytes that are not well-formed CBOR', () => {
    expect(decodePeers(body({ peers: [] }))).not.toBeNull();
    expect(decodePeers(GARBAGE)).toBeNull();
  });

  it('rejects a body that is not a map', () => {
    expect(decodePeers(body({ peers: [] }))).not.toBeNull();
    expect(decodePeers(body([]))).toBeNull();
  });

  it('rejects a missing peers field', () => {
    expect(decodePeers(body({ peers: [] }))).not.toBeNull();
    expect(decodePeers(body({}))).toBeNull();
  });

  it('rejects peers that is not an array', () => {
    expect(decodePeers(body({ peers: [] }))).not.toBeNull();
    expect(decodePeers(body({ peers: 'many' }))).toBeNull();
  });

  it(`rejects ${MAX_PEERS_ENTRIES + 1} entries where ${MAX_PEERS_ENTRIES} decode`, () => {
    expect(decodePeers(body({ peers: entries(MAX_PEERS_ENTRIES) }))).not.toBeNull();
    expect(decodePeers(body({ peers: entries(MAX_PEERS_ENTRIES + 1) }))).toBeNull();
  });

  it('rejects an entry that is not an object', () => {
    expectRejectionDelta((v) => {
      v.peers = [42] as unknown as Record<string, unknown>[];
    });
  });

  it('rejects a number address', () => {
    expectRejectionDelta((v) => {
      v.peers = [entry({ address: 4001 })];
    });
  });

  it('rejects a number agentName', () => {
    expectRejectionDelta((v) => {
      v.peers = [entry({ agentName: 42 })];
    });
  });

  it('rejects a null nodeName', () => {
    expectRejectionDelta((v) => {
      v.peers = [entry({ nodeName: null })];
    });
  });

  it('rejects a string protocolVersion', () => {
    expectRejectionDelta((v) => {
      v.peers = [entry({ protocolVersion: '1' })];
    });
  });

  it('rejects a float protocolVersion', () => {
    expectRejectionDelta((v) => {
      v.peers = [entry({ protocolVersion: 1.5 })];
    });
  });

  it('rejects a NaN protocolVersion', () => {
    expectRejectionDelta((v) => {
      v.peers = [entry({ protocolVersion: NaN })];
    });
  });

  it('rejects a negative protocolVersion', () => {
    expectRejectionDelta((v) => {
      v.peers = [entry({ protocolVersion: -1 })];
    });
  });

  it('rejects a protocolVersion above MAX_CAPABILITY_CODE', () => {
    expectRejectionDelta((v) => {
      v.peers = [entry({ protocolVersion: MAX_CAPABILITY_CODE + 1 })];
    });
  });

  it('rejects capabilities as a string', () => {
    expectRejectionDelta((v) => {
      v.peers = [entry({ capabilities: 'all' })];
    });
  });

  it('rejects capabilities containing a non-integer', () => {
    expectRejectionDelta((v) => {
      v.peers = [entry({ capabilities: [8, 1.5] })];
    });
  });

  it('rejects capabilities containing an out-of-range code', () => {
    expectRejectionDelta((v) => {
      v.peers = [entry({ capabilities: [MAX_CAPABILITY_CODE + 1] })];
    });
  });
});

describe('Peers codec forward compat', () => {
  it('ignores unknown extra keys in an entry and rebuilds from checked fields', () => {
    const decoded = decodePeers(body({ peers: [entry({ lastSeenMs: 123456, weird: 'x' })] }));
    expect(decoded).toEqual({ peers: [entry()] });
  });

  it('ignores unknown extra keys in the top-level body', () => {
    const decoded = decodePeers(body({ peers: [entry()], futureField: true }));
    expect(decoded).toEqual({ peers: [entry()] });
  });
});

// ---------------------------------------------------------------------------
// Bogus address classification — one case per contract row
// (NET_INTERFACE → "Bogus Address Classification")
// ---------------------------------------------------------------------------

const ALWAYS_BOGUS: [string, string][] = [
  ['IPv4 loopback 127/8', '/ip4/127.5.6.7/tcp/4001'],
  ['IPv4 link-local 169.254/16', '/ip4/169.254.9.9/tcp/4001'],
  ['IPv4 multicast 224/4', '/ip4/231.1.2.3/tcp/4001'],
  ['IPv4 broadcast', '/ip4/255.255.255.255/tcp/4001'],
  ['IPv4 unspecified', '/ip4/0.0.0.0/tcp/4001'],
  ['IPv4 benchmark 198.18/15', '/ip4/198.19.200.1/tcp/4001'],
  ['IPv4 reserved Class E 240/4', '/ip4/246.1.2.3/tcp/4001'],
  ['IPv6 loopback ::1', '/ip6/::1/tcp/4001'],
  ['IPv6 unspecified ::', '/ip6/::/tcp/4001'],
  ['IPv6 multicast ff00::/8', '/ip6/ff05::2/tcp/4001'],
  ['IPv6 link-local fe80::/10', '/ip6/fe9b::1/tcp/4001'],
  ['IPv6 IPv4-mapped ::ffff:0:0/96 (public embedded v4)', '/ip6/::ffff:8.8.8.8/tcp/4001'],
];

const MAINNET_ONLY_BOGUS: [string, string][] = [
  ['IPv4 RFC 1918 10/8', '/ip4/10.1.2.3/tcp/4001'],
  ['IPv4 RFC 1918 172.16/12', '/ip4/172.20.0.5/tcp/4001'],
  ['IPv4 RFC 1918 192.168/16', '/ip4/192.168.44.55/tcp/4001'],
  ['IPv4 CGN 100.64/10', '/ip4/100.100.1.1/tcp/4001'],
  ['IPv4 documentation 192.0.2/24', '/ip4/192.0.2.55/tcp/4001'],
  ['IPv4 documentation 198.51.100/24', '/ip4/198.51.100.7/tcp/4001'],
  ['IPv4 documentation 203.0.113/24', '/ip4/203.0.113.99/tcp/4001'],
  ['IPv6 unique-local fc00::/7', '/ip6/fd12:3456::1/tcp/4001'],
  ['IPv6 documentation 2001:db8::/32', '/ip6/2001:db8:dead::beef/tcp/4001'],
];

const NEVER_BOGUS: [string, string][] = [
  ['public IPv4', '/ip4/93.184.216.34/tcp/4001'],
  ['public IPv6', '/ip6/2001:4860:4860::8888/tcp/4001'],
  ['IPv4 just below 172.16/12', '/ip4/172.15.1.1/tcp/4001'],
  ['IPv4 just above 172.16/12', '/ip4/172.32.1.1/tcp/4001'],
  ['IPv4 just above CGN 100.64/10', '/ip4/100.128.1.1/tcp/4001'],
  ['IPv4 just outside benchmark 198.18/15', '/ip4/198.20.1.1/tcp/4001'],
  ['IPv4 just below multicast', '/ip4/223.255.255.254/tcp/4001'],
  ['IPv6 fe00:: outside fe80::/10', '/ip6/fe00::1/tcp/4001'],
];

describe('isBogusAddress', () => {
  for (const [name, addr] of ALWAYS_BOGUS) {
    it(`${name} is bogus under both magics`, () => {
      expect(isBogusAddress(addr, MAGIC_MAINNET)).toBe(true);
      expect(isBogusAddress(addr, MAGIC_TESTNET)).toBe(true);
    });
  }

  for (const [name, addr] of MAINNET_ONLY_BOGUS) {
    it(`${name} is bogus under mainnet magic only`, () => {
      expect(isBogusAddress(addr, MAGIC_MAINNET)).toBe(true);
      expect(isBogusAddress(addr, MAGIC_TESTNET)).toBe(false);
    });
  }

  for (const [name, addr] of NEVER_BOGUS) {
    it(`${name} is not bogus under either magic`, () => {
      expect(isBogusAddress(addr, MAGIC_MAINNET)).toBe(false);
      expect(isBogusAddress(addr, MAGIC_TESTNET)).toBe(false);
    });
  }

  it('fails closed on an unparseable string, without throwing', () => {
    expect(isBogusAddress('not a multiaddr', MAGIC_MAINNET)).toBe(true);
    expect(isBogusAddress('not a multiaddr', MAGIC_TESTNET)).toBe(true);
  });

  it('fails closed on the empty string', () => {
    expect(isBogusAddress('', MAGIC_MAINNET)).toBe(true);
    expect(isBogusAddress('', MAGIC_TESTNET)).toBe(true);
  });

  it('fails closed on a multiaddr with no IP component', () => {
    expect(isBogusAddress('/dns4/example.com/tcp/443', MAGIC_MAINNET)).toBe(true);
    expect(isBogusAddress('/unix/tmp/sock', MAGIC_TESTNET)).toBe(true);
  });
});
