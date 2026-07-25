import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import { encode, decode } from 'cbor-x';
import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import type { NetConfig } from './types.js';

export const HEADERS_PROTOCOL = '/dagsocial/headers/1';

function mergeUint8Arrays(chunks: Uint8Array[]): Uint8Array {
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

/**
 * Register handler for header and block requests.
 */
export function registerHeadersHandler(
  libp2p: Libp2p,
  getOrderingBlock: (height: number) => OrderingBlock | null,
): void {
  libp2p.handle(HEADERS_PROTOCOL, async ({ stream }) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream.source) {
        chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
      }
      if (chunks.length === 0) {
        await stream.sink([new Uint8Array(0)]);
        return;
      }

      const request = decode(mergeUint8Arrays(chunks)) as {
        startHeight: number;
        maxCount?: number;
        endHeight?: number;
        mode?: string;
      };

      if (request.mode === 'blocks') {
        // Return full blocks
        const blocks: OrderingBlock[] = [];
        for (let h = request.startHeight; h <= request.endHeight!; h++) {
          const block = getOrderingBlock(h);
          if (block) blocks.push(block);
        }
        await stream.sink([Buffer.from(encode({ blocks }))] as any);
      } else {
        // Return headers only
        const headers: BlockHeader[] = [];
        for (let h = request.startHeight; h > 0 && headers.length < (request.maxCount || 20); h--) {
          const block = getOrderingBlock(h);
          if (block) headers.push(block.header);
          else break; // gap — stop
        }
        await stream.sink([Buffer.from(encode(headers))] as any);
      }
    } catch {
      await stream.sink([new Uint8Array(0)]);
    }
  });
}
