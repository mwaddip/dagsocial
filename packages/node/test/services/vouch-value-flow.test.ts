// ---------------------------------------------------------------------------
// P2-B phase 2 — the vouch escrow's money consequence, measured through real
// block application (audit F-consensus-3).
//
// The engine-level legs live in vouch-integrity.test.ts; this file measures
// what the defects DID to the karma supply. Both tests were first written in
// their acceptance form and run against HEAD, where they passed:
//
//   - a 0-value vouch unvouched and matured minted 1 karma from nothing (the
//     escrow wrote the CONSTANT, and maturity re-minted it);
//   - a cast carrying a foreign voucherId applied cleanly and its escrow row
//     keyed to the foreign identity — a karma transfer with no invite.
//
// Transactions are placed straight into the mempool, around the service layer
// that would refuse them: the block creator embeds whatever it picks up, which
// reproduces the malicious-producer case exactly.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeBoxId,
  computeTxId,
  PROTOCOL_VERSION,
  VOUCH_KARMA_AMOUNT,
  VOUCH_COOLDOWN_BLOCKS,
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
  makeKarmaBox,
  hex,
} from '../helpers.js';
import type { TestIdentity } from '../helpers.js';
import { materializeOutput } from '../../src/services/utxo-engine.js';

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
  epochBlocks: 2,
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

/** Seed a VouchBox with fixture provenance; `value` is deliberately free. */
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

/** A signed unvouch: the VouchBox spent to zero outputs. */
function makeUnvouchTx(vouchBoxId: string, signer: TestIdentity): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [vouchBoxId],
    outputs: [],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, signer.privateKey, hex(signer.userId));
  return tx;
}

const sumKarma = (boxes: KarmaBox[]): bigint =>
  boxes.reduce((sum, b) => sum + b.value, 0n);

describe('P2-B phase 2 — vouch escrow money flow', () => {
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

  it('V1 money: a 0-value vouch escrows its actual value, and maturity mints nothing', async () => {
    // Measured on HEAD: the escrow row recorded the CONSTANT (karmaAmount 1)
    // for a box that held 0, and maturity minted that 1 — the voucher's karma
    // went 0 → 1 with no lock backing it, supply from nothing. The escrow now
    // records the box's actual value, so the round trip conserves by
    // construction: 0 in, 0 escrowed, 0 minted. (Casting a 0-value vouch is
    // itself rejected now — vouch-integrity.test.ts V1 — so this state is
    // only reachable as pre-pin history, which still settles exactly.)
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const mempool = await importMempool();
    const cooldowns = await importVouchCooldowns();

    const voucher = makeTestIdentity();
    const target = makeTestIdentity();

    // The voucher's ONLY asset, ever: a vouch box holding zero karma.
    const zeroVouch = makeVouchBox(0n, voucher.userId, target.userId);
    utxo.insertBox(zeroVouch);
    expect(sumKarma(utxo.getKarmaBoxes(voucher.userId))).toBe(0n);

    mempool.insertUtxoTx(makeUnvouchTx(zeroVouch.id!, voucher), null, 100000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block1 = bc.createOrderingBlock();
    expect(block1).not.toBeNull();
    expect(block1!.header.height).toBe(1);
    expect(utxo.getBox(zeroVouch.id!)).toBeNull(); // unvouch applied

    // The escrow row records what the box actually held.
    const rows = cooldowns.getVouchCooldowns(voucher.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.karmaAmount).toBe(0n);
    expect(rows[0]!.releaseAtBlock).toBe(1 + VOUCH_COOLDOWN_BLOCKS);

    // Mine to maturity.
    for (let h = 2; h <= 1 + VOUCH_COOLDOWN_BLOCKS; h++) {
      expect(bc.createOrderingBlock()).not.toBeNull();
    }
    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(1 + VOUCH_COOLDOWN_BLOCKS);

    // Nothing minted, escrow settled: the supply is exactly what was locked.
    expect(sumKarma(utxo.getKarmaBoxes(voucher.userId))).toBe(0n);
    expect(cooldowns.getVouchCooldowns(voucher.userId)).toHaveLength(0);
  });

  it('V2 consequence: a block embedding a foreign-voucherId cast is rejected whole', async () => {
    // On HEAD this block applied, the foreign key's unvouch applied after it,
    // and the escrow row landed keyed to the foreign identity — A's stake
    // pending re-mint to B, a karma transfer with no invite. Now the cast
    // fails re-validation inside block application, which rejects the block.
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const mempool = await importMempool();
    const cooldowns = await importVouchCooldowns();

    const staker = makeTestIdentity(); // A — owns and signs away the karma
    const foreign = makeTestIdentity(); // B — named as voucherId, stakes nothing
    const target = makeTestIdentity();

    const stakerBox = makeKarmaBox(100n, staker.userId, 0);
    utxo.insertBox(stakerBox);

    // A's karma in, a VouchBox carrying B's identity out.
    const castTx: UtxoTransaction = {
      inputs: [stakerBox.id!],
      outputs: [
        {
          boxType: 'karma',
          value: 99n,
          owner: staker.userId,
          guard: 'owner_signature',
          proofSource: 'vouch_op',
        } as KarmaBox,
        {
          boxType: 'vouch',
          value: VOUCH_KARMA_AMOUNT,
          voucherId: foreign.userId,
          targetId: target.userId,
          guard: 'owner_signature',
        } as VouchBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(castTx, staker.privateKey, hex(staker.userId));
    mempool.insertUtxoTx(castTx, null, 100000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock();

    // Nothing the block would have done survives: no block, the staker's box
    // unspent, no vouch box, and no escrow row for either identity — the
    // re-mint to B is unreachable rather than merely unexercised.
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);
    expect(utxo.getBox(stakerBox.id!)).not.toBeNull();
    const vouchBoxId = materializeOutput(
      castTx.outputs[1]!,
      computeTxId(castTx),
      1,
    ).id!;
    expect(utxo.getBox(vouchBoxId)).toBeNull();
    expect(cooldowns.getVouchCooldowns(foreign.userId)).toHaveLength(0);
    expect(cooldowns.getVouchCooldowns(staker.userId)).toHaveLength(0);
  });
});
