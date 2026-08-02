import { describe, it, expect } from 'vitest';
import { encode } from 'cbor-x';
import { buildHandshakeFrame, parseHandshakeBody, validateHandshake } from '@dagsocial/net';
import { MAGIC_TESTNET, decodeFrame, MAX_ADVERTISED_HEIGHT } from '@dagsocial/net';
import type { HandshakeMsg } from '@dagsocial/net';

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
