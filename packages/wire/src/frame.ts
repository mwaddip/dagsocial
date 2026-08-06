import { ByteWriter } from './writer.js';
import { ByteReader } from './reader.js';
import { ReaderError } from './errors.js';

export type HashFn = (data: Uint8Array) => Uint8Array;

export const FRAME_VERSION = 1;

/** Encode body into a framed envelope. Checksum = first 4 bytes of hashFn(body). */
export function encodeFrame(
  magic: number,
  code: number,
  body: Uint8Array,
  hashFn: HashFn,
): Uint8Array {
  const w = new ByteWriter();

  // magic: 4 bytes big-endian
  w.writeU8((magic >>> 24) & 0xff);
  w.writeU8((magic >>> 16) & 0xff);
  w.writeU8((magic >>> 8) & 0xff);
  w.writeU8(magic & 0xff);

  // version: 1 byte
  w.writeU8(FRAME_VERSION);

  // code: VLQ
  w.writeVlqU(code);

  // body length: VLQ
  w.writeVlqU(body.length);

  // checksum: first 4 bytes of blake2b256(body)
  const hash = hashFn(body);
  if (hash.length < 4) {
    throw new Error('encodeFrame: hash function must return at least 4 bytes');
  }
  w.writeBytes(hash.subarray(0, 4));

  // body
  w.writeBytes(body);

  return w.toBytes();
}

/** Decode a framed envelope. Returns code and body. Throws ReaderError on invalid frame. */
export function decodeFrame(
  magic: number,
  data: Uint8Array,
  hashFn: HashFn,
): { code: number; body: Uint8Array } {
  const r = new ByteReader(data);

  // magic
  // `>>> 0` reinterprets the assembled value as unsigned: the `<<`/`|` chain
  // works in signed 32-bit, so any magic with the high bit set (>= 0x80000000)
  // would come out negative and never equal the expected value.
  const magicRead =
    ((r.readU8() << 24) | (r.readU8() << 16) | (r.readU8() << 8) | r.readU8()) >>> 0;
  if (magicRead !== magic) {
    throw new ReaderError(
      `decodeFrame: wrong magic 0x${magicRead.toString(16)} (expected 0x${magic.toString(16)})`,
      'wrong-magic',
    );
  }

  // version
  const version = r.readU8();
  if (version > FRAME_VERSION) {
    throw new ReaderError(
      `decodeFrame: unsupported frame version ${version}`,
      'unsupported-version',
    );
  }
  // version < FRAME_VERSION: accept (forward compat for older peers)

  // code
  const code = r.readVlqU();

  // body length
  const length = r.readVlqU();

  // checksum
  const checksum = r.readBytes(4);

  // body
  const body = r.readBytes(length);

  // verify checksum
  const expectedChecksum = hashFn(body).subarray(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expectedChecksum[i]) {
      throw new ReaderError('decodeFrame: checksum mismatch', 'checksum-mismatch');
    }
  }

  return { code, body };
}
