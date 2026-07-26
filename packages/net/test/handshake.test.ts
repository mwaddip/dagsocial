import { describe, it, expect } from 'vitest';
import { buildHandshakeFrame, parseHandshakeBody, validateHandshake } from '@dagsocial/net';
import { MAGIC_TESTNET, decodeFrame } from '@dagsocial/net';
import type { HandshakeMsg } from '@dagsocial/net';

const testMsg: HandshakeMsg = {
  agentName: 'dagsocial/1.0.0',
  protocolVersion: 1,
  nodeName: 'test-node',
  chainHeight: 42,
  capabilities: [1, 2, 3, 4, 5, 8, 9],
  sessionMagic: 12345,
};

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
});
