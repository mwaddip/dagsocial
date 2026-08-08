// ---------------------------------------------------------------------------
// P2-B phase 4 — the multi-VouchBox unvouch's money consequence, measured
// through real block application (K2; the engine leg lives in
// input-shape-pins.test.ts).
//
// Block application detects an unvouch by walking the inputs for a VouchBox,
// writes ONE escrow row, and breaks. Nothing bounded the vouch input count:
// the transition arm asked only for zero outputs, and conservation exempts
// zero-output vouch spends wholesale. This test was first written in its
// ACCEPTANCE form and run against untouched HEAD, where it passed with the
// loss measured in karma: two live vouch boxes (2 karma locked), one
// transaction, both boxes consumed, ONE escrow row (karmaAmount 1), and at
// maturity the voucher held 1 karma — supply down by one stake, the escrow
// round-trip broken.
//
// Reachable: castVouch's one-vouch-at-a-time is service-layer only, so a
// block-embedded pair of casts gives one voucher two live VouchBoxes; two
// colluding owners reach it directly. As in the phase 2 suite, the
// transaction is placed straight into the mempool, around the service layer
// that would refuse it — the block creator embeds whatever it picks up, which
// reproduces the malicious-producer case exactly.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeBoxId,
  PROTOCOL_VERSION,
  VOUCH_KARMA_AMOUNT,
} from '@dagsocial/types';
import type {
  KarmaBox,
  VouchBox,
  UtxoTransaction,
  OrderingBlock,
} from '@dagsocial/types';
import {
  fixtureProvenance,
  signTransaction,
  makeTestIdentity,
  hex,
} from '../helpers.js';
import type { TestIdentity } from '../helpers.js';

const testConfig = {
  port: 3000,
  dbPath: ':memory:',
  networkType: 'testnet' as const,
  nodeRole: 'miner' as const,
  postPowTargetBits: 20,
  challengeWindowBlocks: 10,
  orderingBlockIntervalMs: 60000,
  orderingBlockMinSubBlocks: 1,
  maxSubBlocksPerBlock: 1000,
  miningMode: 'internal' as const,
  orderingBlockPowTargetBits: 12,
  creditTreasuryPct: 10,
  treasuryPubKey: '',
  bootstrapPeers: [] as string[],
  listenAddrs: '/ip4/127.0.0.1/tcp/0',
  maxPeers: 50,
};

async function importDb() {
  return (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    closeDb: () => void;
  };
}

async function importBlockCreator() {
  return (await import('../../src/services/block-creator.js')) as unknown as {
    startBlockCreator: (cfg: typeof testConfig) => void;
    stopBlockCreator: () => void;
    createOrderingBlock: () => OrderingBlock | null;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    getBox: (boxId: string) => unknown;
    getKarmaBoxes: (owner: Uint8Array) => KarmaBox[];
  };
}

async function importMempool() {
  return (await import('../../src/store/mempool.js')) as {
    insertUtxoTx: (
      tx: UtxoTransaction,
      batchId: string | null,
      expiresAtHeight: number,
    ) => number;
  };
}

async function importVouchCooldowns() {
  return (await import('../../src/store/vouch-cooldowns.js')) as {
    getVouchCooldowns: (
      voucherId: Uint8Array,
    ) => Array<{ targetId: Uint8Array; releaseAtBlock: number; karmaAmount: bigint }>;
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => OrderingBlock | null;
  };
}

/** Seed a VouchBox with fixture provenance. */
function makeVouchBox(
  value: bigint,
  voucherId: Uint8Array,
  targetId: Uint8Array,
): VouchBox {
  const candidate = {
    boxType: 'vouch' as const,
    value,
    voucherId,
    targetId,
    guard: 'owner_signature' as const,
  };
  Object.assign(candidate, fixtureProvenance(candidate, 1));
  return { ...candidate, id: computeBoxId(candidate) } as unknown as VouchBox;
}

/** A signed unvouch: the given VouchBoxes spent to zero outputs. */
function makeUnvouchTx(vouchBoxIds: string[], signer: TestIdentity): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: vouchBoxIds,
    outputs: [],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, signer.privateKey, hex(signer.userId));
  return tx;
}

const sumKarma = (boxes: KarmaBox[]): bigint =>
  boxes.reduce((sum, b) => sum + b.value, 0n);

describe('P2-B phase 4 — multi-VouchBox unvouch money flow', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch {
      // Module might not have been imported
    }
    vi.resetModules();
  });

  it('K2 consequence: a block embedding a two-VouchBox unvouch is rejected whole', async () => {
    // On HEAD this block applied: both boxes consumed, one escrow row, and at
    // maturity 1 of the 2 locked karma re-minted — the other stake destroyed.
    // Now the embedded tx fails re-validation inside block application
    // ("Unvouch must consume exactly one VouchBox"), which rejects the block.
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const mempool = await importMempool();
    const cooldowns = await importVouchCooldowns();

    const voucher = makeTestIdentity();
    const target1 = makeTestIdentity();
    const target2 = makeTestIdentity();

    // Two live vouch boxes, one stake each — 2 karma locked in total.
    const v1 = makeVouchBox(VOUCH_KARMA_AMOUNT, voucher.userId, target1.userId);
    const v2 = makeVouchBox(VOUCH_KARMA_AMOUNT, voucher.userId, target2.userId);
    utxo.insertBox(v1);
    utxo.insertBox(v2);
    expect(sumKarma(utxo.getKarmaBoxes(voucher.userId))).toBe(0n);

    // One transaction spending BOTH VouchBoxes to zero outputs.
    mempool.insertUtxoTx(makeUnvouchTx([v1.id!, v2.id!], voucher), null, 100000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock();

    // Nothing the block would have done survives: no block, both stakes
    // still live in their boxes, and no escrow row — the destruction is
    // unreachable rather than merely unexercised.
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);
    expect(utxo.getBox(v1.id!)).not.toBeNull();
    expect(utxo.getBox(v2.id!)).not.toBeNull();
    expect(cooldowns.getVouchCooldowns(voucher.userId)).toHaveLength(0);
  });
});
