import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  encodeFrame, decodeFrame, MAGIC_MAINNET, MAGIC_TESTNET, FRAME_VERSION,
  ByteReader, ReaderError,
} from '@dagsocial/wire';

function blake2b256(data: Uint8Array): Uint8Array {
  return createHash('blake2b512').update(data).digest().subarray(0, 32);
}

describe('encodeFrame / decodeFrame', () => {
  it('round-trips a simple message', () => {
    const body = new Uint8Array([1, 2, 3]);
    const frame = encodeFrame(MAGIC_TESTNET, 1, body, blake2b256);
    const { code, body: decoded } = decodeFrame(MAGIC_TESTNET, frame, blake2b256);
    expect(code).toBe(1);
    expect(decoded).toEqual(body);
  });

  it('round-trips empty body', () => {
    const frame = encodeFrame(MAGIC_TESTNET, 9, new Uint8Array(0), blake2b256);
    const { code, body } = decodeFrame(MAGIC_TESTNET, frame, blake2b256);
    expect(code).toBe(9);
    expect(body.length).toBe(0);
  });

  it('round-trips a large body', () => {
    const body = new Uint8Array(100_000);
    for (let i = 0; i < body.length; i++) body[i] = i & 0xff;
    const frame = encodeFrame(MAGIC_MAINNET, 5, body, blake2b256);
    const { code, body: decoded } = decodeFrame(MAGIC_MAINNET, frame, blake2b256);
    expect(code).toBe(5);
    expect(decoded).toEqual(body);
  });

  it('rejects wrong magic', () => {
    const frame = encodeFrame(MAGIC_TESTNET, 1, new Uint8Array(0), blake2b256);
    expect(() => decodeFrame(MAGIC_MAINNET, frame, blake2b256)).toThrow(ReaderError);
  });

  it('rejects checksum mismatch', () => {
    const frame = encodeFrame(MAGIC_TESTNET, 1, new Uint8Array([1, 2, 3]), blake2b256);
    // Corrupt the last byte (body)
    frame[frame.length - 1] ^= 0xff;
    expect(() => decodeFrame(MAGIC_TESTNET, frame, blake2b256)).toThrow('checksum');
  });

  it('rejects truncated frame', () => {
    const frame = encodeFrame(MAGIC_TESTNET, 1, new Uint8Array([1, 2, 3]), blake2b256);
    const truncated = frame.subarray(0, 6); // only magic (4) + version (1) + code start
    expect(() => decodeFrame(MAGIC_TESTNET, truncated, blake2b256)).toThrow(ReaderError);
  });

  it('VLQ code encodes efficiently', () => {
    // code 1 should be 1 byte in the VLQ field
    const frame = encodeFrame(MAGIC_TESTNET, 1, new Uint8Array(0), blake2b256);
    // magic(4) + version(1) + code_VLQ(1) + length_VLQ(1) + checksum(4) = 11
    expect(frame.length).toBe(11);
  });

  it('different networks produce different frames', () => {
    const body = new Uint8Array([42]);
    const tFrame = encodeFrame(MAGIC_TESTNET, 1, body, blake2b256);
    const mFrame = encodeFrame(MAGIC_MAINNET, 1, body, blake2b256);
    // Frames should differ in the magic bytes
    expect(tFrame[0]).not.toBe(mFrame[0]);
  });
});
