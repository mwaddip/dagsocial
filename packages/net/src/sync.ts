import { decodeSubBlock, encodeSubBlock } from '@dagsocial/types';
import type { SubBlock } from '@dagsocial/types';
import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import type { NetConfig } from './types.js';
import { mergeUint8Arrays } from './util.js';

export const SYNC_PROTOCOL = '/dagsocial/sync/1';

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

/**
 * Register the sync protocol handler — serves sub-block data to requesting peers.
 */
export function registerSyncHandler(
  libp2p: Libp2p,
  getSubBlock: (id: string) => SubBlock | null,
): void {
  libp2p.handle(SYNC_PROTOCOL, async ({ stream }) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream.source) {
        chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
      }

      if (chunks.length === 0) {
        await stream.sink([new Uint8Array([0x00])]);
        return;
      }

      const request = new TextDecoder().decode(mergeUint8Arrays(chunks));
      const subBlock = getSubBlock(request);

      if (!subBlock) {
        await stream.sink([new Uint8Array([0x00])]);
        return;
      }

      await stream.sink([encodeSubBlock(subBlock)]);
    } catch {
      await stream.sink([new Uint8Array([0x00])]);
    }
  });
}
