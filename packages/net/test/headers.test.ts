import { describe, it, expect } from 'vitest';
import { encode, decode } from 'cbor-x';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import { PROTOCOL_VERSION } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import { HEADERS_PROTOCOL } from '../src/sync.js';
import { mergeUint8Arrays } from '../src/util.js';

// ---------------------------------------------------------------------------
// Mock data helpers
// ---------------------------------------------------------------------------

function makeMockHeader(
  height: number,
  prevBlockHash: string,
  targetBits = 4,
): BlockHeader {
  return {
    protocolVersion: PROTOCOL_VERSION,
    height,
    prevBlockHash,
    subBlockRoot: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: height * 100,
    powTargetBits: targetBits,
    createdAt: 1000000 + height * 10000,
  };
}

function makeMockOrderingBlock(
  height: number,
  prevBlockHash: string,
): OrderingBlock {
  return {
    header: makeMockHeader(height, prevBlockHash),
    subBlockTree: { subBlockRefs: [], subBlockEntries: [], pruneEntries: [] },
    utxoTxTree: {
      utxoTxIds: [],
      utxoTxs: [],
      coinbaseOutputs: [
        { value: 100, owner: new Uint8Array(32), lockedUntilBlock: null },
      ],
    },
    validatorSignature: new Uint8Array(64),
  };
}

/**
 * Simulate the headers protocol handler with the given blocks in the store.
 * Returns the CBOR-encoded response bytes.
 */
function simulateHeadersHandler(
  requestBytes: Uint8Array,
  store: Map<number, OrderingBlock>,
): Uint8Array {
  const getOrderingBlock = (height: number): OrderingBlock | null =>
    store.get(height) ?? null;

  const request = decode(requestBytes) as {
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
    return Buffer.from(encode({ blocks }));
  } else {
    // Return headers only (newest-first)
    const headers: BlockHeader[] = [];
    for (
      let h = request.startHeight;
      h > 0 && headers.length < (request.maxCount || 20);
      h--
    ) {
      const block = getOrderingBlock(h);
      if (block) headers.push(block.header);
      else break; // gap — stop
    }
    return Buffer.from(encode(headers));
  }
}

// ---------------------------------------------------------------------------
// Tests — protocol constants
// ---------------------------------------------------------------------------

describe('HEADERS_PROTOCOL', () => {
  it('is the expected protocol string', () => {
    expect(HEADERS_PROTOCOL).toBe('/dagsocial/headers/1');
  });
});

// ---------------------------------------------------------------------------
// Tests — CBOR encode/decode of requests
// ---------------------------------------------------------------------------

describe('headers request encode/decode', () => {
  it('encodes and decodes a headers request', () => {
    const request = { startHeight: 10, maxCount: 5 };
    const encoded = Buffer.from(encode(request));
    const decoded = decode(new Uint8Array(encoded)) as {
      startHeight: number;
      maxCount: number;
    };
    expect(decoded.startHeight).toBe(10);
    expect(decoded.maxCount).toBe(5);
  });

  it('encodes and decodes a blocks request', () => {
    const request = { startHeight: 1, endHeight: 3, mode: 'blocks' };
    const encoded = Buffer.from(encode(request));
    const decoded = decode(new Uint8Array(encoded)) as {
      startHeight: number;
      endHeight: number;
      mode: string;
    };
    expect(decoded.startHeight).toBe(1);
    expect(decoded.endHeight).toBe(3);
    expect(decoded.mode).toBe('blocks');
  });
});

// ---------------------------------------------------------------------------
// Tests — header response encode/decode
// ---------------------------------------------------------------------------

describe('headers response encode/decode', () => {
  it('encodes and decodes a BlockHeader array', () => {
    const headers: BlockHeader[] = [
      makeMockHeader(5, 'aa'.repeat(32)),
      makeMockHeader(4, 'bb'.repeat(32)),
      makeMockHeader(3, 'cc'.repeat(32)),
    ];

    const encoded = Buffer.from(encode(headers));
    const decoded = decode(new Uint8Array(encoded)) as BlockHeader[];

    expect(decoded).toHaveLength(3);
    expect(decoded[0]!.height).toBe(5);
    expect(decoded[1]!.height).toBe(4);
    expect(decoded[2]!.height).toBe(3);
    // Verify prevBlockHash is preserved
    expect(decoded[0]!.prevBlockHash).toBe('aa'.repeat(32));
  });

  it('encodes and decodes a blocks response wrapper', () => {
    const blocks: OrderingBlock[] = [
      makeMockOrderingBlock(1, '00'.repeat(32)),
      makeMockOrderingBlock(2, blockHash(makeMockHeader(1, '00'.repeat(32)))),
    ];

    const response = { blocks };
    const encoded = Buffer.from(encode(response));
    const decoded = decode(new Uint8Array(encoded)) as {
      blocks: OrderingBlock[];
    };

    expect(decoded.blocks).toHaveLength(2);
    expect(decoded.blocks[0]!.header.height).toBe(1);
    expect(decoded.blocks[1]!.header.height).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests — mergeUint8Arrays
// ---------------------------------------------------------------------------

describe('mergeUint8Arrays', () => {
  it('merges multiple chunks into a single array', () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
      new Uint8Array([6, 7, 8, 9]),
    ];
    const merged = mergeUint8Arrays(chunks);
    expect(merged).toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    );
  });

  it('handles empty array', () => {
    const merged = mergeUint8Arrays([]);
    expect(merged.length).toBe(0);
  });

  it('handles single chunk', () => {
    const chunk = new Uint8Array([42]);
    const merged = mergeUint8Arrays([chunk]);
    expect(merged).toEqual(chunk);
  });
});

// ---------------------------------------------------------------------------
// Tests — handler logic: requestHeaders
// ---------------------------------------------------------------------------

describe('handler: requestHeaders (simulated)', () => {
  it('returns headers newest-first from startHeight', () => {
    // Set up store with blocks at heights 1-5
    const store = new Map<number, OrderingBlock>();
    const prevHashes: string[] = ['00'.repeat(32)];
    for (let h = 1; h <= 5; h++) {
      const prev = prevHashes[h - 1]!;
      store.set(h, makeMockOrderingBlock(h, prev));
      prevHashes.push(blockHash(makeMockHeader(h, prev)));
    }

    // Request headers starting from height 5, max 3
    const request = encode({ startHeight: 5, maxCount: 3 });
    const response = simulateHeadersHandler(
      Buffer.from(request),
      store,
    );
    const headers = decode(response) as BlockHeader[];

    // Should return 3 headers: 5, 4, 3 (newest first)
    expect(headers).toHaveLength(3);
    expect(headers[0]!.height).toBe(5);
    expect(headers[1]!.height).toBe(4);
    expect(headers[2]!.height).toBe(3);
  });

  it('respects maxCount', () => {
    const store = new Map<number, OrderingBlock>();
    const prevHashes: string[] = ['00'.repeat(32)];
    for (let h = 1; h <= 10; h++) {
      const prev = prevHashes[h - 1]!;
      store.set(h, makeMockOrderingBlock(h, prev));
      prevHashes.push(blockHash(makeMockHeader(h, prev)));
    }

    // Request at most 2 headers
    const request = encode({ startHeight: 10, maxCount: 2 });
    const response = simulateHeadersHandler(
      Buffer.from(request),
      store,
    );
    const headers = decode(response) as BlockHeader[];

    expect(headers).toHaveLength(2);
    expect(headers[0]!.height).toBe(10);
    expect(headers[1]!.height).toBe(9);
  });

  it('returns empty when no blocks at start height', () => {
    const store = new Map<number, OrderingBlock>();
    // Only blocks 1 and 2 exist
    store.set(1, makeMockOrderingBlock(1, '00'.repeat(32)));
    store.set(
      2,
      makeMockOrderingBlock(
        2,
        blockHash(makeMockHeader(1, '00'.repeat(32))),
      ),
    );

    // Request headers starting from height 99 (no block there)
    const request = encode({ startHeight: 99, maxCount: 20 });
    const response = simulateHeadersHandler(
      Buffer.from(request),
      store,
    );
    const headers = decode(response) as BlockHeader[];

    // getOrderingBlock(99) returns null → the loop breaks immediately
    expect(headers).toHaveLength(0);
  });

  it('stops at first gap in the chain', () => {
    const store = new Map<number, OrderingBlock>();
    // Blocks at height 1, 2, 4, 5 — gap at height 3
    store.set(1, makeMockOrderingBlock(1, '00'.repeat(32)));
    const h2 = makeMockOrderingBlock(
      2,
      blockHash(makeMockHeader(1, '00'.repeat(32))),
    );
    store.set(2, h2);
    // Height 3 is missing
    store.set(
      4,
      makeMockOrderingBlock(4, blockHash(makeMockHeader(2, blockHash(makeMockHeader(1, '00'.repeat(32)))))),
    );
    store.set(
      5,
      makeMockOrderingBlock(5, blockHash(makeMockHeader(4, 'ff'.repeat(32)))),
    );

    // Request from height 5
    const request = encode({ startHeight: 5, maxCount: 5 });
    const response = simulateHeadersHandler(
      Buffer.from(request),
      store,
    );
    const headers = decode(response) as BlockHeader[];

    // Should return headers 5, 4 then stop at gap (height 3 is missing)
    expect(headers).toHaveLength(2);
    expect(headers[0]!.height).toBe(5);
    expect(headers[1]!.height).toBe(4);
  });

  it('defaults maxCount to 20 when not specified', () => {
    const store = new Map<number, OrderingBlock>();
    const prevHashes: string[] = ['00'.repeat(32)];
    for (let h = 1; h <= 25; h++) {
      const prev = prevHashes[h - 1]!;
      store.set(h, makeMockOrderingBlock(h, prev));
      prevHashes.push(blockHash(makeMockHeader(h, prev)));
    }

    // Request without maxCount
    const request = encode({ startHeight: 25 });
    const response = simulateHeadersHandler(
      Buffer.from(request),
      store,
    );
    const headers = decode(response) as BlockHeader[];

    // Should default to max 20
    expect(headers).toHaveLength(20);
    expect(headers[0]!.height).toBe(25);
    expect(headers[19]!.height).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Tests — handler logic: requestBlocks
// ---------------------------------------------------------------------------

describe('handler: requestBlocks (simulated)', () => {
  it('returns full blocks for a height range', () => {
    const store = new Map<number, OrderingBlock>();
    const prevHashes: string[] = ['00'.repeat(32)];
    for (let h = 1; h <= 5; h++) {
      const prev = prevHashes[h - 1]!;
      store.set(h, makeMockOrderingBlock(h, prev));
      prevHashes.push(blockHash(makeMockHeader(h, prev)));
    }

    // Request blocks from height 2 to 4
    const request = encode({
      startHeight: 2,
      endHeight: 4,
      mode: 'blocks',
    });
    const response = simulateHeadersHandler(
      Buffer.from(request),
      store,
    );
    const result = decode(response) as { blocks: OrderingBlock[] };

    expect(result.blocks).toHaveLength(3);
    expect(result.blocks[0]!.header.height).toBe(2);
    expect(result.blocks[1]!.header.height).toBe(3);
    expect(result.blocks[2]!.header.height).toBe(4);
  });

  it('skips missing blocks in the range', () => {
    const store = new Map<number, OrderingBlock>();
    store.set(1, makeMockOrderingBlock(1, '00'.repeat(32)));
    store.set(
      3,
      makeMockOrderingBlock(
        3,
        blockHash(makeMockHeader(1, '00'.repeat(32))),
      ),
    );
    store.set(
      5,
      makeMockOrderingBlock(5, 'ff'.repeat(32)),
    );

    // Request blocks 1-5
    const request = encode({
      startHeight: 1,
      endHeight: 5,
      mode: 'blocks',
    });
    const response = simulateHeadersHandler(
      Buffer.from(request),
      store,
    );
    const result = decode(response) as { blocks: OrderingBlock[] };

    // Only blocks 1, 3, 5 exist
    expect(result.blocks).toHaveLength(3);
    expect(result.blocks[0]!.header.height).toBe(1);
    expect(result.blocks[1]!.header.height).toBe(3);
    expect(result.blocks[2]!.header.height).toBe(5);
  });

  it('returns empty array when no blocks in range', () => {
    const store = new Map<number, OrderingBlock>();

    const request = encode({
      startHeight: 10,
      endHeight: 20,
      mode: 'blocks',
    });
    const response = simulateHeadersHandler(
      Buffer.from(request),
      store,
    );
    const result = decode(response) as { blocks: OrderingBlock[] };

    expect(result.blocks).toHaveLength(0);
  });

  it('returns blocks with full data (coinbase, subBlockTree, utxoTxTree)', () => {
    const store = new Map<number, OrderingBlock>();
    const block = makeMockOrderingBlock(1, '00'.repeat(32));
    store.set(1, block);

    const request = encode({
      startHeight: 1,
      endHeight: 1,
      mode: 'blocks',
    });
    const response = simulateHeadersHandler(
      Buffer.from(request),
      store,
    );
    const result = decode(response) as { blocks: OrderingBlock[] };

    expect(result.blocks).toHaveLength(1);
    const returned = result.blocks[0]!;
    expect(returned.header.height).toBe(1);
    expect(returned.header.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(returned.subBlockTree.subBlockRefs).toEqual([]);
    expect(returned.utxoTxTree.coinbaseOutputs.length).toBe(1);
    expect(returned.utxoTxTree.coinbaseOutputs[0]!.value).toBe(100);
    expect(returned.validatorSignature).toBeInstanceOf(Uint8Array);
    expect(returned.validatorSignature.length).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// Tests — handler round-trip
// ---------------------------------------------------------------------------

describe('handler round-trip', () => {
  it('encode headers request, serve response, decode headers', () => {
    // Build a store with 3 blocks
    const store = new Map<number, OrderingBlock>();
    const h1 = makeMockOrderingBlock(1, '00'.repeat(32));
    store.set(1, h1);
    const h1Hash = blockHash(h1.header);
    const h2 = makeMockOrderingBlock(2, h1Hash);
    store.set(2, h2);
    const h2Hash = blockHash(h2.header);
    const h3 = makeMockOrderingBlock(3, h2Hash);
    store.set(3, h3);

    // Client encodes a headers request
    const request = { startHeight: 3, maxCount: 3 };
    const encodedRequest = Buffer.from(encode(request));

    // Server processes it
    const encodedResponse = simulateHeadersHandler(encodedRequest, store);

    // Client decodes the response
    const headers = decode(new Uint8Array(encodedResponse)) as BlockHeader[];

    expect(headers).toHaveLength(3);
    // Newest first
    expect(headers[0]!.height).toBe(3);
    expect(headers[1]!.height).toBe(2);
    expect(headers[2]!.height).toBe(1);
    // Chain links are correct
    expect(headers[2]!.prevBlockHash).toBe('00'.repeat(32));
    expect(headers[1]!.prevBlockHash).toBe(blockHash(headers[2]!));
    expect(headers[0]!.prevBlockHash).toBe(blockHash(headers[1]!));
  });

  it('encode blocks request, serve response, decode full blocks', () => {
    // Build a store with 2 blocks
    const store = new Map<number, OrderingBlock>();
    const h1 = makeMockOrderingBlock(1, '00'.repeat(32));
    store.set(1, h1);
    const h2 = makeMockOrderingBlock(
      2,
      blockHash(h1.header),
    );
    store.set(2, h2);

    // Client encodes a blocks request
    const request = { startHeight: 1, endHeight: 2, mode: 'blocks' };
    const encodedRequest = Buffer.from(encode(request));

    // Server processes it
    const encodedResponse = simulateHeadersHandler(encodedRequest, store);

    // Client decodes the response
    const response = decode(new Uint8Array(encodedResponse)) as {
      blocks: OrderingBlock[];
    };

    expect(response.blocks).toHaveLength(2);
    expect(response.blocks[0]!.header.height).toBe(1);
    expect(response.blocks[1]!.header.height).toBe(2);
    // Verify full block data
    expect(response.blocks[0]!.validatorSignature).toBeInstanceOf(Uint8Array);
    expect(response.blocks[0]!.validatorSignature.length).toBe(64);
    expect(response.blocks[1]!.utxoTxTree.coinbaseOutputs.length).toBe(1);
  });

  it('round-trip: request with no matching blocks returns empty array', () => {
    const store = new Map<number, OrderingBlock>();

    const request = { startHeight: 100, maxCount: 5 };
    const encodedRequest = Buffer.from(encode(request));
    const encodedResponse = simulateHeadersHandler(encodedRequest, store);
    const headers = decode(new Uint8Array(encodedResponse)) as BlockHeader[];

    expect(headers).toHaveLength(0);
  });

  it('round-trip: blocks mode with partial range', () => {
    const store = new Map<number, OrderingBlock>();
    const h1 = makeMockOrderingBlock(1, '00'.repeat(32));
    store.set(1, h1);
    // Height 2 is missing
    const h3 = makeMockOrderingBlock(3, blockHash(h1.header));
    store.set(3, h3);

    const request = { startHeight: 1, endHeight: 3, mode: 'blocks' };
    const encodedRequest = Buffer.from(encode(request));
    const encodedResponse = simulateHeadersHandler(encodedRequest, store);
    const response = decode(new Uint8Array(encodedResponse)) as {
      blocks: OrderingBlock[];
    };

    expect(response.blocks).toHaveLength(2);
    expect(response.blocks[0]!.header.height).toBe(1);
    expect(response.blocks[1]!.header.height).toBe(3);
  });
});
