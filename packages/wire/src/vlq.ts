import { ByteReader } from './reader.js';

export function encodeVlqU(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('encodeVlqU: value must be a non-negative integer');
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new Error('encodeVlqU: value exceeds safe integer range');
  }
  // Arithmetic, not bitwise: `&`/`>>>` coerce to 32 bits, which silently
  // mis-encodes every value at or above 2^32. Keep in sync with
  // ByteWriter.writeVlqU.
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v % 128) + 0x80);
    v = Math.floor(v / 128);
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
  // ZigZag, arithmetic rather than `(v << 1) ^ (v >> 31)`: the bitwise form is
  // 32-bit and corrupts anything outside ±2^31. Doubling can push a large
  // magnitude past the safe-integer range — encodeVlqU then rejects it loudly
  // instead of truncating. Keep in sync with ByteWriter.writeVlqS.
  const zz = value >= 0 ? value * 2 : -value * 2 - 1;
  return encodeVlqU(zz);
}

export function decodeVlqZigZag(reader: ByteReader): number {
  return reader.readVlqS();
}
