import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  encodeFrame, decodeFrame, FRAME_VERSION,
  ReaderError,
} from '@dagsocial/wire';

// Arbitrary u32s: the codec is magic-agnostic — it compares whatever value it was
// handed. Deliberately not the network magics from @dagsocial/types; even a test-only
// import would blur the layering that keeps wire dependency-free (P2-A phase 5).
const TEST_MAGIC = 0x11223344;
const OTHER_MAGIC = 0x55667788;

function blake2b256(data: Uint8Array): Uint8Array {
  return createHash('blake2b512').update(data).digest().subarray(0, 32);
}

/** Run fn, assert it throws a ReaderError, and return its code. */
function readerErrorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ReaderError);
    return (e as ReaderError).code;
  }
  expect.unreachable('expected a ReaderError');
}

describe('encodeFrame / decodeFrame', () => {
  it('round-trips a simple message', () => {
    const body = new Uint8Array([1, 2, 3]);
    const frame = encodeFrame(TEST_MAGIC, 1, body, blake2b256);
    const { code, body: decoded } = decodeFrame(TEST_MAGIC, frame, blake2b256);
    expect(code).toBe(1);
    expect(decoded).toEqual(body);
  });

  it('round-trips empty body', () => {
    const frame = encodeFrame(TEST_MAGIC, 9, new Uint8Array(0), blake2b256);
    const { code, body } = decodeFrame(TEST_MAGIC, frame, blake2b256);
    expect(code).toBe(9);
    expect(body.length).toBe(0);
  });

  it('round-trips a large body', () => {
    const body = new Uint8Array(100_000);
    for (let i = 0; i < body.length; i++) body[i] = i & 0xff;
    const frame = encodeFrame(OTHER_MAGIC, 5, body, blake2b256);
    const { code, body: decoded } = decodeFrame(OTHER_MAGIC, frame, blake2b256);
    expect(code).toBe(5);
    expect(decoded).toEqual(body);
  });

  it('rejects wrong magic with wrong-magic', () => {
    const body = new Uint8Array([1, 2, 3]);
    const frame = encodeFrame(TEST_MAGIC, 1, body, blake2b256);
    // Control: the same frame decodes under the magic it was built with.
    expect(decodeFrame(TEST_MAGIC, frame, blake2b256).body).toEqual(body);
    expect(readerErrorCode(() => decodeFrame(OTHER_MAGIC, frame, blake2b256))).toBe('wrong-magic');
  });

  it('rejects a version above FRAME_VERSION with unsupported-version', () => {
    const frame = encodeFrame(TEST_MAGIC, 1, new Uint8Array([1, 2, 3]), blake2b256);
    // Control: unmutated frame round-trips.
    expect(decodeFrame(TEST_MAGIC, frame, blake2b256).code).toBe(1);
    const mutated = Uint8Array.from(frame);
    mutated[4] = FRAME_VERSION + 1; // version byte sits right after the 4 magic bytes
    expect(readerErrorCode(() => decodeFrame(TEST_MAGIC, mutated, blake2b256))).toBe('unsupported-version');
  });

  it('accepts a version below FRAME_VERSION (forward compat)', () => {
    const frame = encodeFrame(TEST_MAGIC, 1, new Uint8Array([1, 2, 3]), blake2b256);
    const mutated = Uint8Array.from(frame);
    mutated[4] = FRAME_VERSION - 1;
    expect(decodeFrame(TEST_MAGIC, mutated, blake2b256).code).toBe(1);
  });

  it('rejects a flipped body byte with checksum-mismatch', () => {
    const frame = encodeFrame(TEST_MAGIC, 1, new Uint8Array([1, 2, 3]), blake2b256);
    // Control: unmutated frame round-trips.
    expect(decodeFrame(TEST_MAGIC, frame, blake2b256).code).toBe(1);
    const mutated = Uint8Array.from(frame);
    mutated[mutated.length - 1] ^= 0xff;
    expect(readerErrorCode(() => decodeFrame(TEST_MAGIC, mutated, blake2b256))).toBe('checksum-mismatch');
  });

  it('rejects a frame cut short with truncated', () => {
    const frame = encodeFrame(TEST_MAGIC, 1, new Uint8Array([1, 2, 3]), blake2b256);
    // Control: the full frame round-trips.
    expect(decodeFrame(TEST_MAGIC, frame, blake2b256).code).toBe(1);
    const truncated = frame.subarray(0, 6); // only magic (4) + version (1) + code start
    expect(readerErrorCode(() => decodeFrame(TEST_MAGIC, truncated, blake2b256))).toBe('truncated');
  });

  describe('unsigned magic assembly (audit L-15)', () => {
    // Pre-fix these failed: the magic was assembled with a signed `<<` chain,
    // so any magic >= 0x80000000 came out negative and never compared equal —
    // decodeFrame threw on the CORRECT magic in the accept case below.
    const HIGH_BIT_MAGIC = 0x80da6717;
    const OTHER_HIGH_BIT_MAGIC = 0xdeadbeef;

    it('accepts a frame built with a high-bit magic', () => {
      const body = new Uint8Array([9, 9]);
      const frame = encodeFrame(HIGH_BIT_MAGIC, 3, body, blake2b256);
      const decoded = decodeFrame(HIGH_BIT_MAGIC, frame, blake2b256);
      expect(decoded.code).toBe(3);
      expect(decoded.body).toEqual(body);
    });

    it('rejects a different high-bit magic with wrong-magic', () => {
      const frame = encodeFrame(HIGH_BIT_MAGIC, 3, new Uint8Array(0), blake2b256);
      expect(readerErrorCode(() => decodeFrame(OTHER_HIGH_BIT_MAGIC, frame, blake2b256))).toBe('wrong-magic');
    });
  });

  it('VLQ code encodes efficiently', () => {
    // code 1 should be 1 byte in the VLQ field
    const frame = encodeFrame(TEST_MAGIC, 1, new Uint8Array(0), blake2b256);
    // magic(4) + version(1) + code_VLQ(1) + length_VLQ(1) + checksum(4) = 11
    expect(frame.length).toBe(11);
  });

  it('different magics produce different frames', () => {
    const body = new Uint8Array([42]);
    const aFrame = encodeFrame(TEST_MAGIC, 1, body, blake2b256);
    const bFrame = encodeFrame(OTHER_MAGIC, 1, body, blake2b256);
    // Frames should differ in the magic bytes
    expect(aFrame[0]).not.toBe(bFrame[0]);
  });
});
