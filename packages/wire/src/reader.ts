import { ReaderError } from './errors.js';

export const MAX_ARRAY_LENGTH = 1 << 24;

/**
 * Hard cap on the number of bytes a single VLQ may occupy. A canonical value in
 * the documented range [0, 2^53-1] needs at most 8 bytes; the slack tolerates
 * non-canonical zero-padded encodings while still bounding the read loop on a
 * malformed stream. Matches the contract's "exceeds 10 bytes" rule.
 */
const MAX_VLQ_BYTES = 10;

export class ByteReader {
  private _position = 0;
  private _positionLimit: number;

  constructor(private readonly bytes: Uint8Array) {
    this._positionLimit = bytes.length;
  }

  get position(): number { return this._position; }
  get remaining(): number { return this.bytes.length - this._position; }
  get isExhausted(): boolean { return this._position >= this.bytes.length; }

  private checkPositionLimit(): void {
    if (this._position > this._positionLimit) {
      throw new ReaderError(
        `position limit ${this._positionLimit} reached at position ${this._position}`,
        'position-limit-exceeded',
      );
    }
  }

  readU8(): number {
    this.checkPositionLimit();
    if (this._position >= this.bytes.length) {
      throw new ReaderError(`readU8: EOF at ${this._position}`, 'truncated');
    }
    return this.bytes[this._position++]!;
  }

  readBytes(n: number): Uint8Array {
    this.checkPositionLimit();
    if (this.remaining < n) {
      throw new ReaderError(`readBytes(${n}): only ${this.remaining} available`, 'truncated');
    }
    const out = this.bytes.subarray(this._position, this._position + n);
    this._position += n;
    return out;
  }

  readBool(): boolean {
    const b = this.readU8();
    if (b === 0) return false;
    if (b === 1) return true;
    throw new ReaderError(`readBool: expected 0 or 1, got ${b}`, 'invalid-tag');
  }

  readVlqU(): number {
    let value = 0;
    let shift = 0;
    let bytesRead = 0;
    while (true) {
      const b = this.readU8();
      bytesRead++;
      // Multiplication instead of bitwise shift: `<<` coerces to 32 bits and
      // would silently corrupt anything at or above 2^32. `(b & 0x7f) * 2**shift`
      // is exact for every shift used here (7 significant bits scaled by a power
      // of two), so the only inexactness risk is the running sum — guarded below.
      const chunk = (b & 0x7f) * (2 ** shift);
      if (chunk > Number.MAX_SAFE_INTEGER - value) {
        throw new ReaderError('readVlqU: value exceeds safe integer range', 'vlq-overflow');
      }
      value += chunk;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (bytesRead >= MAX_VLQ_BYTES) {
        throw new ReaderError(`readVlqU: VLQ exceeds ${MAX_VLQ_BYTES} bytes`, 'vlq-overflow');
      }
    }
    return value;
  }

  readVlqS(): number {
    const u = this.readVlqU();
    // ZigZag decode, arithmetic rather than `(u >>> 1) ^ -(u & 1)`: the bitwise
    // form coerces to 32 bits and misdecodes any zigzag value at or above 2^32.
    // even -> u/2, odd -> -(u+1)/2.
    const half = Math.floor(u / 2);
    return u % 2 === 0 ? half : -(half + 1);
  }

  readArray<T>(reader: (r: ByteReader) => T): T[] {
    const length = this.readVlqU();
    if (length > MAX_ARRAY_LENGTH) {
      throw new ReaderError(`readArray: length ${length} exceeds max ${MAX_ARRAY_LENGTH}`, 'array-too-large');
    }
    const out: T[] = new Array(length);
    for (let i = 0; i < length; i++) out[i] = reader(this);
    return out;
  }

  readOption<T>(reader: (r: ByteReader) => T): T | null {
    const tag = this.readU8();
    if (tag === 0) return null;
    if (tag === 1) return reader(this);
    throw new ReaderError(`readOption: expected tag 0 or 1, got ${tag}`, 'invalid-tag');
  }
}
