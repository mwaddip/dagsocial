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
    height: 1,
    hash: 'abc123hash',
    prevBlockHash: '000000prevhash',
    subBlockRefs: ['sb-1', 'sb-2'],
    likeBoxIds: ['like-box-1'],
    utxoTxIds: ['tx-1'],
    stumpIds: ['stump-1'],
    validatorId: 'validator-1',
    validatorSignature: new Uint8Array(64).fill(0xab),
    protocolVersion: 1,
    createdAt: Date.now(),
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
      height: 1,
      hash: 'hash-abc',
      prevBlockHash: 'prev-hash-000',
      subBlockRefs: ['sb-ref-1', 'sb-ref-2'],
      likeBoxIds: ['like-id-1', 'like-id-2'],
      utxoTxIds: ['tx-id-1'],
      stumpIds: ['stump-aaa'],
      validatorId: 'validator-alice',
      validatorSignature: new Uint8Array(64).fill(0xcd),
      epochTallyResults: {
        rewards: {
          'post-1': {
            targetPostId: 'post-1',
            likeCount: 5,
            authorReward: 10,
            likerRefunds: { 'user-a': 2, 'user-b': 1 },
          },
        },
      },
      protocolVersion: 1,
      createdAt: 1234567890,
    });

    createOrderingBlock(block);

    const result = getOrderingBlock(1);
    expect(result).not.toBeNull();
    expect(result!.height).toBe(1);
    expect(result!.hash).toBe('hash-abc');
    expect(result!.prevBlockHash).toBe('prev-hash-000');
    expect(result!.subBlockRefs).toEqual(['sb-ref-1', 'sb-ref-2']);
    expect(result!.likeBoxIds).toEqual(['like-id-1', 'like-id-2']);
    expect(result!.utxoTxIds).toEqual(['tx-id-1']);
    expect(result!.stumpIds).toEqual(['stump-aaa']);
    expect(result!.validatorId).toBe('validator-alice');
    expect(result!.validatorSignature).toEqual(
      new Uint8Array(64).fill(0xcd),
    );
    expect(result!.protocolVersion).toBe(1);
    expect(result!.createdAt).toBe(1234567890);

    // Check epochTallyResults were round-tripped
    expect(result!.epochTallyResults).toBeDefined();
    const rewards = result!.epochTallyResults!.rewards;
    expect(rewards['post-1'].likeCount).toBe(5);
    expect(rewards['post-1'].authorReward).toBe(10);
    expect(rewards['post-1'].likerRefunds).toEqual({
      'user-a': 2,
      'user-b': 1,
    });

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
