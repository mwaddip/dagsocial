import { MAX_STREAM_BYTES } from './msg-guards.js';

export function mergeUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * A chunk off a libp2p stream: raw bytes, or a `Uint8ArrayList` view of them.
 */
type StreamChunk = Uint8Array | { subarray(): Uint8Array };

/**
 * Read a stream into a single buffer, refusing to hold more than `maxBytes`.
 *
 * A stream source keeps yielding until the peer closes its side, so draining one
 * into an array hands the peer our heap: a connection that simply never stops
 * writing is an out-of-memory kill, and it costs the attacker nothing. Reads stop
 * at the ceiling — the accumulated chunks are released and the loop breaks, which
 * closes the iterator, so an over-cap peer cannot keep us reading either.
 *
 * Returns `null` when the cap is exceeded; callers treat that as a protocol
 * violation. A stream that simply carries nothing returns an empty array, which
 * is a different (and legitimate) outcome.
 */
export async function readStreamBounded(
  source: AsyncIterable<StreamChunk>,
  maxBytes: number = MAX_STREAM_BYTES,
): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  for await (const chunk of source) {
    const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray();
    total += bytes.length;
    if (total > maxBytes) {
      chunks.length = 0;
      return null;
    }
    chunks.push(bytes);
  }

  return mergeUint8Arrays(chunks);
}
