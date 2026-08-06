import { describe, it, expect, afterEach, vi } from 'vitest';
import { encode } from 'cbor-x';
import {
  buildHandshakeFrame,
  decodeHandshakePayload,
  handshakePenalty,
  parseHandshakeBody,
  validateHandshake,
} from '@dagsocial/net';
import {
  MAGIC_TESTNET,
  MAGIC_MAINNET,
  MAGIC_DEVNET,
  KNOWN_FRAME_MAGICS,
  decodeFrame,
  MAX_ADVERTISED_HEIGHT,
} from '@dagsocial/net';
import { FRAME_VERSION } from '@dagsocial/wire';
import { PeerManager, PenaltyKind } from '@dagsocial/net';
import type { HandshakeMsg, NetConfig } from '@dagsocial/net';

const testMsg: HandshakeMsg = {
  agentName: 'dagsocial/1.0.0',
  protocolVersion: 1,
  nodeName: 'test-node',
  chainHeight: 42,
  capabilities: [1, 2, 3, 4, 5, 8, 9],
  sessionMagic: 12345,
};

/** Validate a message straight through the decode boundary, as the wire path does. */
function validateEncoded(msg: unknown) {
  return validateHandshake(parseHandshakeBody(new Uint8Array(encode(msg))), [1]);
}

describe('handshake', () => {
  it('round-trips through frame', () => {
    const frame = buildHandshakeFrame(MAGIC_TESTNET, testMsg);
    const { code, body } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(1);
    const parsed = parseHandshakeBody(body);
    expect(parsed).toEqual(testMsg);
  });

  // -------------------------------------------------------------------------
  // Frame fallback policy (audit L-15) — which decode failures may fall back
  // to the legacy unframed raw-CBOR handshake, decided by ReaderError code
  // (never by message text)
  // -------------------------------------------------------------------------

  describe('frame fallback policy', () => {
    it('accepts a well-formed frame (control)', () => {
      const frame = buildHandshakeFrame(MAGIC_TESTNET, testMsg);
      const decoded = decodeHandshakePayload(MAGIC_TESTNET, frame);
      expect(decoded.kind).toBe('framed');
      if (decoded.kind === 'reject') return;
      expect(validateHandshake(parseHandshakeBody(decoded.body), [1]).ok).toBe(true);
    });

    it('rejects a frame from the wrong network without a raw-CBOR retry', () => {
      const frame = buildHandshakeFrame(MAGIC_MAINNET, testMsg);
      expect(decodeHandshakePayload(MAGIC_TESTNET, frame))
        .toEqual({ kind: 'reject', code: 'wrong-magic' });
    });

    it('recognizes every canonical magic as a foreign network — none falls through to legacy', () => {
      // A canonical magic the classifier does not recognize falls through to
      // the raw-CBOR parser, decodes as malformed, and permanently bans the
      // peer. The devnet entry is the one a stale local literal would miss.
      expect(KNOWN_FRAME_MAGICS).toContain(MAGIC_DEVNET);
      for (const magic of KNOWN_FRAME_MAGICS) {
        if (magic === MAGIC_TESTNET) continue; // our own network — accepted, not rejected
        const frame = buildHandshakeFrame(magic, testMsg);
        expect(decodeHandshakePayload(MAGIC_TESTNET, frame))
          .toEqual({ kind: 'reject', code: 'wrong-magic' });
      }
    });

    it('rejects a checksum-mismatched frame (pre-fix: retried as raw CBOR)', () => {
      // Pre-fix the inbound handler string-matched err.message on 'wrong
      // magic'; a checksum failure matched nothing and fell through to the
      // raw-CBOR parser, which read the corrupt frame bytes as a handshake
      // and misclassified the peer as malformed.
      const frame = buildHandshakeFrame(MAGIC_TESTNET, testMsg);
      frame[frame.length - 1] ^= 0xff;
      expect(decodeHandshakePayload(MAGIC_TESTNET, frame))
        .toEqual({ kind: 'reject', code: 'checksum-mismatch' });
    });

    it('rejects a frame with a version above ours (pre-fix: retried as raw CBOR)', () => {
      const frame = buildHandshakeFrame(MAGIC_TESTNET, testMsg);
      frame[4] = FRAME_VERSION + 1; // version byte follows the 4 magic bytes
      expect(decodeHandshakePayload(MAGIC_TESTNET, frame))
        .toEqual({ kind: 'reject', code: 'unsupported-version' });
    });

    it('falls back to legacy raw CBOR for an unframed handshake, which still validates', () => {
      const raw = new Uint8Array(encode(testMsg));
      const decoded = decodeHandshakePayload(MAGIC_TESTNET, raw);
      expect(decoded.kind).toBe('legacy');
      if (decoded.kind === 'reject') return;
      const result = validateHandshake(parseHandshakeBody(decoded.body), [1]);
      expect(result.ok).toBe(true);
      expect(result.msg).toEqual(testMsg);
    });

    it('falls back for a truncated frame', () => {
      const frame = buildHandshakeFrame(MAGIC_TESTNET, testMsg);
      const cut = frame.subarray(0, 6); // magic (4) + version (1) + code start
      expect(decodeHandshakePayload(MAGIC_TESTNET, cut).kind).toBe('legacy');
    });
  });

  it('validates compatible protocol version', () => {
    const result = validateHandshake(testMsg, [1]);
    expect(result.ok).toBe(true);
    expect(result.peerHeight).toBe(42);
    expect(result.msg).toEqual(testMsg);
  });

  it('rejects incompatible protocol version', () => {
    const msg = { ...testMsg, protocolVersion: 99 };
    const result = validateHandshake(msg, [1]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unsupported protocol version');
  });

  // -------------------------------------------------------------------------
  // Ban policy — adversarial input is banned, a version mismatch is not
  //
  // A permanent ban on version mismatch would partition the network on any
  // routine PROTOCOL_VERSION bump, so the two rejection classes must stay
  // distinguishable all the way to the penalty call.
  // -------------------------------------------------------------------------

  describe('ban policy', () => {
    const BAN_MS = 3_600_000;

    function makeMgr(): PeerManager {
      const config: NetConfig = {
        bootstrapPeers: [],
        listenAddrs: '/ip4/0.0.0.0/tcp/0',
        maxPeers: 10,
        penaltyScoreThreshold: 500,
        temporalBanDurationMs: BAN_MS,
        penaltySafeIntervalMs: 120_000,
        syncRequestTimeoutMs: 10_000,
      };
      const mgr = new PeerManager(config);
      mgr.addPeer({ id: 'peer1', multiaddrs: [], protocols: [], connectedAt: 0 });
      return mgr;
    }

    /** Apply the handshake ban policy exactly as the node's stream handlers do. */
    function applyPolicy(mgr: PeerManager, raw: unknown): void {
      const result = validateEncoded(raw);
      expect(result.ok).toBe(false);
      mgr.recordPenaltyKind(handshakePenalty(result.rejection), 'peer1', 'handshake');
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('classifies an unsupported version as a compatibility mismatch', () => {
      const result = validateEncoded({ ...testMsg, protocolVersion: 99 });
      expect(result.rejection).toBe('unsupported-version');
      expect(handshakePenalty(result.rejection)).toBe(PenaltyKind.Transient);
    });

    it('classifies malformed input as adversarial', () => {
      for (const raw of [
        7,
        { ...testMsg, chainHeight: -1 },
        { ...testMsg, chainHeight: MAX_ADVERTISED_HEIGHT + 1 },
        { ...testMsg, sessionMagic: 'magic' },
        { ...testMsg, agentName: '' },
      ]) {
        const result = validateEncoded(raw);
        expect(result.rejection).toBe('malformed');
        expect(handshakePenalty(result.rejection)).toBe(PenaltyKind.ProtocolViolation);
      }
    });

    it('classifies a malformed body carrying a bad version as malformed', () => {
      // An attacker must not dodge the permanent ban by tacking an unsupported
      // version onto otherwise garbage input.
      const result = validateEncoded({ protocolVersion: 99, chainHeight: -1 });
      expect(result.rejection).toBe('malformed');
    });

    it('does NOT permanently ban a peer on an unsupported version', () => {
      const mgr = makeMgr();
      vi.spyOn(Date, 'now').mockReturnValue(0);

      applyPolicy(mgr, { ...testMsg, protocolVersion: 99 });

      expect(mgr.isBanned('peer1')).toBe(false);
      expect(mgr.getPeerCount()).toBe(1);
    });

    it('keeps a retrying version-mismatched peer on an expiring ban only', () => {
      const mgr = makeMgr();
      // Hammer past the score threshold: retrying every 12s sits well above
      // the decay break-even (a 50-point Transient drains within half the
      // 120s interval), so pressure accrues at net +40 per attempt and
      // crosses 500 on the 13th. The worst outcome must still be a temporal
      // ban that lifts on its own once the peer upgrades.
      for (let i = 0; i < 13; i++) {
        vi.spyOn(Date, 'now').mockReturnValue(i * 12_000);
        applyPolicy(mgr, { ...testMsg, protocolVersion: 99 });
      }
      vi.spyOn(Date, 'now').mockReturnValue(12 * 12_000);
      expect(mgr.isBanned('peer1')).toBe(true);

      vi.spyOn(Date, 'now').mockReturnValue(12 * 12_000 + BAN_MS + 1);
      expect(mgr.isBanned('peer1')).toBe(false);
    });

    it('permanently bans a peer that sends a malformed handshake', () => {
      const mgr = makeMgr();
      vi.spyOn(Date, 'now').mockReturnValue(0);

      applyPolicy(mgr, { ...testMsg, chainHeight: -1 });

      expect(mgr.isBanned('peer1')).toBe(true);
      expect(mgr.getPeerCount()).toBe(0);

      // Still banned long after any temporal ban would have expired.
      vi.spyOn(Date, 'now').mockReturnValue(BAN_MS * 10);
      expect(mgr.isBanned('peer1')).toBe(true);
    });
  });

  it('rejects missing agentName', () => {
    const msg = { ...testMsg, agentName: '' };
    const result = validateHandshake(msg, [1]);
    expect(result.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Height bounds (audit C-7) — chainHeight drives servePeer's per-height loop
  // -------------------------------------------------------------------------

  describe('chainHeight bounds', () => {
    it('rejects a negative chainHeight', () => {
      const result = validateEncoded({ ...testMsg, chainHeight: -1 });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('chainHeight');
      expect(result.peerHeight).toBe(0);
      expect(result.msg).toBeUndefined();
    });

    it('rejects the audit payload chainHeight: -1000000000', () => {
      const result = validateEncoded({ ...testMsg, chainHeight: -1_000_000_000 });
      expect(result.ok).toBe(false);
    });

    it('rejects a chainHeight above MAX_ADVERTISED_HEIGHT', () => {
      const result = validateEncoded({ ...testMsg, chainHeight: MAX_ADVERTISED_HEIGHT + 1 });
      expect(result.ok).toBe(false);
    });

    it('accepts a chainHeight exactly at MAX_ADVERTISED_HEIGHT', () => {
      const result = validateEncoded({ ...testMsg, chainHeight: MAX_ADVERTISED_HEIGHT });
      expect(result.ok).toBe(true);
      expect(result.peerHeight).toBe(MAX_ADVERTISED_HEIGHT);
    });

    it('rejects a fractional chainHeight', () => {
      expect(validateEncoded({ ...testMsg, chainHeight: 1.5 }).ok).toBe(false);
    });

    it('rejects a NaN chainHeight', () => {
      expect(validateEncoded({ ...testMsg, chainHeight: NaN }).ok).toBe(false);
    });

    it('rejects a string chainHeight', () => {
      expect(validateEncoded({ ...testMsg, chainHeight: '10' }).ok).toBe(false);
    });

    it('rejects a missing chainHeight', () => {
      const { chainHeight, ...withoutHeight } = testMsg;
      expect(validateEncoded(withoutHeight).ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Shape validation — nothing untrusted reaches a field access
  // -------------------------------------------------------------------------

  describe('shape validation', () => {
    it('returns null from parseHandshakeBody on non-CBOR bytes', () => {
      expect(parseHandshakeBody(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toBeNull();
    });

    it('rejects a null body without throwing', () => {
      expect(validateHandshake(null, [1]).ok).toBe(false);
    });

    it('rejects a non-map body (a bare number)', () => {
      const result = validateEncoded(7);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not a map');
    });

    it('rejects an array body', () => {
      expect(validateEncoded([1, 2, 3]).ok).toBe(false);
    });

    it('rejects a non-string nodeName', () => {
      expect(validateEncoded({ ...testMsg, nodeName: 5 }).ok).toBe(false);
    });

    it('rejects a non-array capabilities', () => {
      expect(validateEncoded({ ...testMsg, capabilities: 'all' }).ok).toBe(false);
    });

    it('rejects capabilities holding a non-number', () => {
      expect(validateEncoded({ ...testMsg, capabilities: [1, 'two'] }).ok).toBe(false);
    });

    it('rejects a negative sessionMagic', () => {
      expect(validateEncoded({ ...testMsg, sessionMagic: -1 }).ok).toBe(false);
    });

    it('rejects a sessionMagic above uint32', () => {
      expect(validateEncoded({ ...testMsg, sessionMagic: 0x1_0000_0000 }).ok).toBe(false);
    });

    it('rejects a non-string declaredAddress', () => {
      expect(validateEncoded({ ...testMsg, declaredAddress: 42 }).ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Forward compatibility — unknown extras are ignored, not rejected
  // -------------------------------------------------------------------------

  describe('forward compatibility', () => {
    it('ignores unknown extra fields', () => {
      const result = validateEncoded({ ...testMsg, futureField: 'whatever' });
      expect(result.ok).toBe(true);
      expect(result.msg).toEqual(testMsg);
    });

    it('preserves unknown capability codes', () => {
      const result = validateEncoded({ ...testMsg, capabilities: [1, 4242] });
      expect(result.ok).toBe(true);
      expect(result.peerCapabilities).toEqual([1, 4242]);
    });

    it('treats absent capabilities as empty', () => {
      const { capabilities, ...withoutCaps } = testMsg;
      const result = validateEncoded(withoutCaps);
      expect(result.ok).toBe(true);
      expect(result.peerCapabilities).toEqual([]);
    });

    it('accepts an absent declaredAddress', () => {
      const result = validateEncoded({ ...testMsg, declaredAddress: undefined });
      expect(result.ok).toBe(true);
      expect(result.msg?.declaredAddress).toBeUndefined();
    });
  });
});
