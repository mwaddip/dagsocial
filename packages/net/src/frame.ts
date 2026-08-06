import { createHash } from 'crypto';
import {
  encodeFrame as wireEncodeFrame,
  decodeFrame as wireDecodeFrame,
  type HashFn,
} from '@dagsocial/wire';

// The magics and the canonical set come from @dagsocial/types, never @dagsocial/wire —
// wire still exports identically-named copies until P2-A phase 5 deletes them
// (NET_INTERFACE §Magic Bytes).
export { MAGIC_MAINNET, MAGIC_TESTNET, MAGIC_DEVNET, KNOWN_FRAME_MAGICS } from '@dagsocial/types';

/** Create the standard blake2b256 hasher for frame checksums. */
export function createBlake2b256Hash(): HashFn {
  return (data: Uint8Array): Uint8Array => {
    return new Uint8Array(createHash('blake2b512').update(data).digest().subarray(0, 32));
  };
}

/** Encode a message into a framed envelope for this node's network. */
export function encodeFrame(
  magic: number,
  code: number,
  body: Uint8Array,
): Uint8Array {
  return wireEncodeFrame(magic, code, body, createBlake2b256Hash());
}

/** Decode a framed envelope. Throws on wrong magic, bad checksum, or truncation. */
export function decodeFrame(
  magic: number,
  data: Uint8Array,
): { code: number; body: Uint8Array } {
  return wireDecodeFrame(magic, data, createBlake2b256Hash());
}
