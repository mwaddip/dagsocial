import { describe, it, expect } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  ReaderError,
  encodeVlqU,
  decodeVlqU,
  encodeVlqZigZag,
  decodeVlqZigZag,
} from '@dagsocial/wire';

/**
 * L-8 regression suite: VLQ must cover its full documented range [0, 2^53-1].
 *
 * The pre-fix encoders used `v & 0x7f` / `v >>>= 7`, which coerce to 32 bits and
 * silently corrupted every value at or above 2^32 (2^32 encoded as `80 00`, i.e.
 * zero). The `legacy*` helpers below reproduce that arithmetic verbatim so these
 * tests fail loudly if the bitwise form is ever reinstated.
 */

/** The pre-fix (32-bit) unsigned encoder — kept only to prove it was broken. */
function legacyEncodeVlqU(value: number): Uint8Array {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return new Uint8Array(out);
}

/** The pre-fix (32-bit) ZigZag transform — kept only to prove it was broken. */
function legacyZigZag(value: number): number {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

const LARGE_UNSIGNED = [
  2 ** 32,
  2 ** 32 + 1,
  2 ** 40,
  2 ** 53 - 1,
  Number.MAX_SAFE_INTEGER,
];

describe('VLQ unsigned — full [0, 2^53-1] range (L-8)', () => {
  it('round-trips values at and above 2^32', () => {
    for (const v of LARGE_UNSIGNED) {
      const reader = new ByteReader(encodeVlqU(v));
      expect(decodeVlqU(reader)).toBe(v);
      expect(reader.isExhausted).toBe(true);
    }
  });

  it('round-trips the same values through ByteWriter/ByteReader', () => {
    const w = new ByteWriter();
    for (const v of LARGE_UNSIGNED) w.writeVlqU(v);

    const r = new ByteReader(w.toBytes());
    for (const v of LARGE_UNSIGNED) expect(r.readVlqU()).toBe(v);
    expect(r.isExhausted).toBe(true);
  });

  it('encodes 2^32 as five bytes, not the truncated two-byte form', () => {
    expect(encodeVlqU(2 ** 32)).toEqual(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x10]));
  });

  it('encodes MAX_SAFE_INTEGER as eight bytes', () => {
    expect(encodeVlqU(Number.MAX_SAFE_INTEGER)).toEqual(
      new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f]),
    );
  });

  it('ByteWriter and the standalone encoder agree byte-for-byte', () => {
    for (const v of [0, 1, 127, 128, 16383, 2 ** 31, ...LARGE_UNSIGNED]) {
      const w = new ByteWriter();
      w.writeVlqU(v);
      expect(w.toBytes()).toEqual(encodeVlqU(v));
    }
  });

  it('the old 32-bit encoder corrupted every value >= 2^32 (vacuity guard)', () => {
    // 2^32 became `80 00` — a two-byte encoding of zero.
    expect(legacyEncodeVlqU(2 ** 32)).toEqual(new Uint8Array([0x80, 0x00]));
    expect(decodeVlqU(new ByteReader(legacyEncodeVlqU(2 ** 32)))).toBe(0);
    // MAX_SAFE_INTEGER became 2^32-1.
    expect(decodeVlqU(new ByteReader(legacyEncodeVlqU(Number.MAX_SAFE_INTEGER)))).toBe(
      0xffffffff,
    );
    // The fixed encoder disagrees with the legacy one on the whole large range.
    for (const v of LARGE_UNSIGNED) {
      expect(encodeVlqU(v)).not.toEqual(legacyEncodeVlqU(v));
    }
    // ...and agrees with it below 2^32, where the legacy form was still correct.
    for (const v of [0, 1, 127, 128, 16383, 1_000_000, 2 ** 31, 2 ** 32 - 1]) {
      expect(encodeVlqU(v)).toEqual(legacyEncodeVlqU(v));
    }
  });

  it('rejects values beyond the safe-integer range on write', () => {
    expect(() => encodeVlqU(Number.MAX_SAFE_INTEGER + 2)).toThrow(/safe integer/);
    expect(() => new ByteWriter().writeVlqU(Number.MAX_SAFE_INTEGER + 2)).toThrow(
      /safe integer/,
    );
  });
});

describe('VLQ unsigned — reader bounds (L-8)', () => {
  it('rejects an encoding whose value exceeds the safe-integer range', () => {
    // Nine 0x7f-payload bytes => 2^63-1, far past 2^53-1.
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]);
    const r = new ByteReader(bytes);
    expect(() => r.readVlqU()).toThrow(ReaderError);
    try {
      new ByteReader(bytes).readVlqU();
    } catch (e) {
      expect((e as ReaderError).code).toBe('vlq-overflow');
    }
  });

  it('rejects a stream that never terminates within the byte cap', () => {
    // 11 continuation bytes carrying no payload: bounded loop, not an infinite one.
    const bytes = new Uint8Array(11).fill(0x80);
    const r = new ByteReader(bytes);
    let caught: unknown;
    try {
      r.readVlqU();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReaderError);
    expect((caught as ReaderError).code).toBe('vlq-overflow');
    // The cap stopped the read at 10 bytes, leaving the 11th unconsumed.
    expect(r.position).toBe(10);
  });

  it('accepts the 8-byte encoding that reaches the top of the range', () => {
    const r = new ByteReader(
      new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f]),
    );
    expect(r.readVlqU()).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('VLQ ZigZag — beyond ±2^31 (L-8)', () => {
  const LARGE_SIGNED = [
    2 ** 31,
    -(2 ** 31),
    2 ** 32,
    -(2 ** 32),
    2 ** 40,
    -(2 ** 40),
    2 ** 51,
    -(2 ** 51),
  ];

  it('round-trips large magnitudes through the standalone codec', () => {
    for (const v of LARGE_SIGNED) {
      const reader = new ByteReader(encodeVlqZigZag(v));
      expect(decodeVlqZigZag(reader)).toBe(v);
      expect(reader.isExhausted).toBe(true);
    }
  });

  it('round-trips large magnitudes through ByteWriter/ByteReader', () => {
    const w = new ByteWriter();
    for (const v of LARGE_SIGNED) w.writeVlqS(v);

    const r = new ByteReader(w.toBytes());
    for (const v of LARGE_SIGNED) expect(r.readVlqS()).toBe(v);
    expect(r.isExhausted).toBe(true);
  });

  it('ByteWriter and the standalone encoder agree byte-for-byte', () => {
    for (const v of [0, 1, -1, 1000, -1000, ...LARGE_SIGNED]) {
      const w = new ByteWriter();
      w.writeVlqS(v);
      expect(w.toBytes()).toEqual(encodeVlqZigZag(v));
    }
  });

  it('keeps the pre-fix encoding for the range where it was correct', () => {
    for (const v of [0, 1, -1, 127, -127, 1000, -1000, 2 ** 30, -(2 ** 31)]) {
      expect(encodeVlqZigZag(v)).toEqual(encodeVlqU(legacyZigZag(v)));
    }
  });

  it('the old 32-bit ZigZag corrupted magnitudes above 2^31 (vacuity guard)', () => {
    // 2^32 wrapped to 0, and 2^40 to 0 — both encoded as a single zero byte.
    expect(legacyZigZag(2 ** 32)).toBe(0);
    expect(legacyZigZag(2 ** 40)).toBe(0);
    for (const v of [2 ** 32, -(2 ** 32), 2 ** 40, -(2 ** 40), 2 ** 51, -(2 ** 51)]) {
      expect(encodeVlqZigZag(v)).not.toEqual(encodeVlqU(legacyZigZag(v)));
    }
  });

  it('rejects magnitudes whose ZigZag doubling leaves the safe range', () => {
    // ZigZag doubles, so the signed domain is roughly ±2^52 — past that the
    // codec throws instead of silently truncating.
    expect(() => encodeVlqZigZag(Number.MAX_SAFE_INTEGER)).toThrow(/safe integer/);
    expect(() => new ByteWriter().writeVlqS(-Number.MAX_SAFE_INTEGER)).toThrow(
      /safe integer/,
    );
  });
});
