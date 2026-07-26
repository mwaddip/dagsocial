import { describe, it, expect } from 'vitest';
import {
  ByteReader,
  ReaderError,
  encodeVlqU,
  decodeVlqU,
  encodeVlqZigZag,
  decodeVlqZigZag,
} from '@dagsocial/wire';

describe('VLQ unsigned', () => {
  it('round-trips small values', () => {
    for (const v of [0, 1, 127, 128, 255, 16383, 16384, 1_000_000]) {
      const encoded = encodeVlqU(v);
      const reader = new ByteReader(encoded);
      expect(decodeVlqU(reader)).toBe(v);
      expect(reader.isExhausted).toBe(true);
    }
  });

  it('encodes 0 as single byte', () => {
    expect(encodeVlqU(0)).toEqual(new Uint8Array([0]));
  });

  it('encodes 127 as single byte', () => {
    expect(encodeVlqU(127)).toEqual(new Uint8Array([127]));
  });

  it('encodes 128 as two bytes', () => {
    expect(encodeVlqU(128)).toEqual(new Uint8Array([0x80, 0x01]));
  });

  it('encodes 16383 as two bytes', () => {
    expect(encodeVlqU(16383)).toEqual(new Uint8Array([0xff, 0x7f]));
  });

  it('rejects negative values', () => {
    expect(() => encodeVlqU(-1)).toThrow();
  });

  it('throws on truncated VLQ', () => {
    const r = new ByteReader(new Uint8Array([0x80])); // continuation without termination
    expect(() => decodeVlqU(r)).toThrow(ReaderError);
  });

  it('readVlqU available on ByteReader directly', () => {
    const r = new ByteReader(new Uint8Array([0xac, 0x02])); // 300
    expect(r.readVlqU()).toBe(300);
  });
});

describe('VLQ ZigZag', () => {
  it('round-trips signed values', () => {
    for (const v of [0, 1, -1, 127, -127, 128, -128, 1000, -1000]) {
      const encoded = encodeVlqZigZag(v);
      const reader = new ByteReader(encoded);
      expect(decodeVlqZigZag(reader)).toBe(v);
      expect(reader.isExhausted).toBe(true);
    }
  });

  it('0 encodes as single byte', () => {
    expect(encodeVlqZigZag(0)).toEqual(new Uint8Array([0]));
  });

  it('-1 encodes as single byte', () => {
    expect(encodeVlqZigZag(-1)).toEqual(new Uint8Array([1]));
  });

  it('1 encodes as single byte', () => {
    expect(encodeVlqZigZag(1)).toEqual(new Uint8Array([2]));
  });
});
