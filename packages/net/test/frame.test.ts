import { describe, it, expect } from 'vitest';
import { encodeFrame, decodeFrame, MAGIC_TESTNET, MAGIC_MAINNET } from '@dagsocial/net';
import { ReaderError } from '@dagsocial/wire';

describe('net frame', () => {
  it('round-trips a message', () => {
    const body = new Uint8Array([1, 2, 3]);
    const frame = encodeFrame(MAGIC_TESTNET, 1, body);
    const { code, body: decoded } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(1);
    expect(decoded).toEqual(body);
  });

  it('rejects wrong network', () => {
    const frame = encodeFrame(MAGIC_TESTNET, 1, new Uint8Array(0));
    expect(() => decodeFrame(MAGIC_MAINNET, frame)).toThrow(ReaderError);
  });

  it('rejects corrupted frame', () => {
    const frame = encodeFrame(MAGIC_TESTNET, 5, new Uint8Array([42]));
    frame[frame.length - 1] ^= 0xff;
    expect(() => decodeFrame(MAGIC_TESTNET, frame)).toThrow('checksum');
  });
});
