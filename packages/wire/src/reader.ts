import { ReaderError } from './errors.js';

export const MAX_ARRAY_LENGTH = 1 << 24;

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
    throw new ReaderError(`readBool: expected 0 or 1, got ${b}`, 'truncated');
  }

  readVlqU(): number {
    let value = 0;
    let shift = 0;
    while (true) {
      const b = this.readU8();
      // Use multiplication instead of bitwise shift to avoid 32-bit signed overflow
      value += (b & 0x7f) * (2 ** shift);
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) {
        throw new ReaderError('readVlqU: VLQ too long (overflow)', 'vlq-overflow');
      }
    }
    return value;
  }

  readVlqS(): number {
    const u = this.readVlqU();
    // zigzag decode: (n >>> 1) ^ -(n & 1)
    return (u >>> 1) ^ -(u & 1);
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
    throw new ReaderError(`readOption: expected tag 0 or 1, got ${tag}`, 'truncated');
  }
}
