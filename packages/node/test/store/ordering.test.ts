import { uid } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { OrderingBlock } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dynamic import helpers
// ---------------------------------------------------------------------------

async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database;
    closeDb: () => void;
  };
}

async function importOrderingFresh() {
  const mod = await import('../../src/store/ordering.js');
  return mod as {
    createOrderingBlock: (block: OrderingBlock) => void;
    getOrderingBlock: (height: number) => OrderingBlock | null;
    getCurrentHeight: () => number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrderingBlock(
  overrides: Partial<OrderingBlock> = {},
): OrderingBlock {
  return {
    header: {
      protocolVersion: 1,
      height: 1,
      prevBlockHash: '00'.repeat(64),
      subBlockRoot: '00'.repeat(64),
      utxoTxRoot: '00'.repeat(64),
      stateRoot: '00'.repeat(33),
      validatorId: uid('validator-1'),
      powNonce: 0,
      powTargetBits: 12,
      createdAt: Date.now(),
    },
    subBlockTree: {
      subBlockRefs: ['sb-1', 'sb-2'],
      stumpIds: ['stump-1'],
      subBlockEntries: [],
    },
    utxoTxTree: {
      utxoTxIds: ['tx-1'],
      utxoTxs: [],
      coinbaseOutputs: [],
    },
    validatorSignature: new Uint8Array(64).fill(0xab),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ordering store', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('getCurrentHeight returns 0 on empty table', async () => {
    const { initDb } = await importDbFresh();
    const { getCurrentHeight } = await importOrderingFresh();

    initDb(':memory:');

    expect(getCurrentHeight()).toBe(0);
  });

  it('createOrderingBlock + getOrderingBlock round-trip (all fields)', async () => {
    const { initDb } = await importDbFresh();
    const { createOrderingBlock, getOrderingBlock } =
      await importOrderingFresh();

    initDb(':memory:');

    const block = makeOrderingBlock({
      header: {
        protocolVersion: 1,
        height: 1,
        prevBlockHash: 'aa'.repeat(64),
        subBlockRoot: 'bb'.repeat(64),
        utxoTxRoot: 'cc'.repeat(64),
        stateRoot: '00'.repeat(33),
        validatorId: uid('validator-alice'),
        powNonce: 42,
        powTargetBits: 14,
        createdAt: 1234567890,
      },
      subBlockTree: {
        subBlockRefs: ['sb-ref-1', 'sb-ref-2'],
        stumpIds: ['stump-aaa'],
        subBlockEntries: [],
      },
      utxoTxTree: {
        utxoTxIds: ['tx-id-1'],
        utxoTxs: [],
        coinbaseOutputs: [
          {
            owner: uid('coinbase-recipient'),
            value: 100,
            lockedUntilBlock: 100,
            isTreasury: false,
          },
        ],
      },
      validatorSignature: new Uint8Array(64).fill(0xcd),
    });

    createOrderingBlock(block);

    const result = getOrderingBlock(1);
    expect(result).not.toBeNull();
    const h = result!.header;
    expect(h.height).toBe(1);
    expect(h.protocolVersion).toBe(1);
    expect(h.prevBlockHash).toBe('aa'.repeat(64));
    expect(h.subBlockRoot).toBe('bb'.repeat(64));
    expect(h.utxoTxRoot).toBe('cc'.repeat(64));
    expect(h.validatorId).toEqual(uid('validator-alice'));
    expect(h.powNonce).toBe(42);
    expect(h.powTargetBits).toBe(14);
    expect(h.createdAt).toBe(1234567890);

    expect(result!.validatorSignature).toEqual(
      new Uint8Array(64).fill(0xcd),
    );

    // subBlockTree
    expect(result!.subBlockTree.subBlockRefs).toEqual(['sb-ref-1', 'sb-ref-2']);
    expect(result!.subBlockTree.stumpIds).toEqual(['stump-aaa']);

    // utxoTxTree
    expect(result!.utxoTxTree.utxoTxIds).toEqual(['tx-id-1']);
    expect(result!.utxoTxTree.coinbaseOutputs).toHaveLength(1);
    expect(result!.utxoTxTree.coinbaseOutputs[0]!.value).toBe(100);

    // getCurrentHeight should reflect the inserted block
    const { getCurrentHeight } = await importOrderingFresh();
    expect(getCurrentHeight()).toBe(1);
  });

  it('getOrderingBlock returns null for unknown height', async () => {
    const { initDb } = await importDbFresh();
    const { getOrderingBlock } = await importOrderingFresh();

    initDb(':memory:');

    const result = getOrderingBlock(999);
    expect(result).toBeNull();
  });
});
