import { decodeSubBlock, encodeSubBlock } from '@dagsocial/types';
import type { SubBlock, BlockHeader, OrderingBlock } from '@dagsocial/types';
import { encode, decode } from 'cbor-x';
import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import type { NetConfig } from './types.js';
import { mergeUint8Arrays } from './util.js';

export const SYNC_PROTOCOL = '/dagsocial/sync/1';
export const HEADERS_PROTOCOL = '/dagsocial/headers/1';

// ---------------------------------------------------------------------------
// Sub-block requests (legacy text-based protocol — kept for backward compat)
// ---------------------------------------------------------------------------

/**
 * Request a specific sub-block from a peer via a direct stream.
 *
 * Protocol:
 *   Request:  subBlockId as hex string (64 chars)
 *   Response: CBOR-encoded SubBlock, or single byte 0x00 (not found)
 *
 * Throws on timeout, not-found, or decode failure.
 */
export async function requestSubBlock(
  libp2p: Libp2p,
  subBlockId: string,
  peerId: string,
  config: NetConfig,
): Promise<SubBlock> {
  const peer = libp2p.getPeers().find((p) => p.toString() === peerId);
  if (!peer) {
    throw new Error(`Peer ${peerId} not connected`);
  }

  let stream: Stream | undefined;
  try {
    stream = await libp2p.dialProtocol(peer, SYNC_PROTOCOL, {
      signal: AbortSignal.timeout(config.syncRequestTimeoutMs),
    });

    // Send request
    const encoder = new TextEncoder();
    await stream.sink([encoder.encode(subBlockId)]);

    // Read response
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.source) {
      chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
    }

    if (chunks.length === 0) {
      throw new Error('Empty response from peer');
    }

    const response = mergeUint8Arrays(chunks);

    // Check for not-found marker
    if (response.length === 1 && response[0] === 0x00) {
      throw new Error(`Sub-block ${subBlockId} not found on peer ${peerId}`);
    }

    return decodeSubBlock(response);
  } finally {
    if (stream) {
      await stream.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Header/block requests (legacy CBOR protocol — kept for backward compat)
// ---------------------------------------------------------------------------

/**
 * Request headers from a peer, starting at startHeight and going down.
 * Returns newest-first.
 */
export async function requestHeaders(
  libp2p: Libp2p,
  startHeight: number,
  maxCount: number,
  peerId: string,
  config: NetConfig,
): Promise<BlockHeader[]> {
  const peer = libp2p.getPeers().find(p => p.toString() === peerId);
  if (!peer) throw new Error(`Peer ${peerId} not connected`);

  let stream: Stream | undefined;
  try {
    stream = await libp2p.dialProtocol(peer, HEADERS_PROTOCOL, {
      signal: AbortSignal.timeout(config.syncRequestTimeoutMs),
    });

    const request = { startHeight, maxCount };
    await stream.sink([Buffer.from(encode(request))] as any);

    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.source) {
      chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
    }

    if (chunks.length === 0) return [];
    return decode(mergeUint8Arrays(chunks)) as BlockHeader[];
  } finally {
    if (stream) await stream.close();
  }
}

/**
 * Request full ordering blocks from startHeight to endHeight (inclusive).
 */
export async function requestBlocks(
  libp2p: Libp2p,
  startHeight: number,
  endHeight: number,
  peerId: string,
  config: NetConfig,
): Promise<OrderingBlock[]> {
  const peer = libp2p.getPeers().find(p => p.toString() === peerId);
  if (!peer) throw new Error(`Peer ${peerId} not connected`);

  let stream: Stream | undefined;
  try {
    stream = await libp2p.dialProtocol(peer, HEADERS_PROTOCOL, {
      signal: AbortSignal.timeout(config.syncRequestTimeoutMs * 5), // blocks are bigger
    });

    const request = { startHeight, endHeight, mode: 'blocks' };
    await stream.sink([Buffer.from(encode(request))] as any);

    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.source) {
      chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
    }

    if (chunks.length === 0) return [];
    const response = decode(mergeUint8Arrays(chunks)) as { blocks: OrderingBlock[] };
    return response.blocks;
  } finally {
    if (stream) await stream.close();
  }
}
