import { ByteReader } from './reader.js';

export function encodeVlqU(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('encodeVlqU: value must be a non-negative integer');
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new Error('encodeVlqU: value exceeds safe integer range');
  }
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return new Uint8Array(out);
}

export function decodeVlqU(reader: ByteReader): number {
  return reader.readVlqU();
}

export function encodeVlqZigZag(value: number): Uint8Array {
  if (!Number.isInteger(value)) {
    throw new Error('encodeVlqZigZag: value must be an integer');
  }
  // ZigZag: (v << 1) ^ (v >> 31) — unsigned via >>> 0
  const zz = (value << 1) ^ (value >> 31);
  return encodeVlqU(zz >>> 0);
}

export function decodeVlqZigZag(reader: ByteReader): number {
  return reader.readVlqS();
}
