import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EMPTY_STATE_ROOT,
  INVITE_BOND_KARMA,
  INVITE_PROBATION_BLOCKS,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type {
  BondBox,
  KarmaBox,
  OrderingBlock,
  UtxoTransaction,
} from '@dagsocial/types';
import type Database from 'better-sqlite3';
import type { TestIdentity } from '../helpers.js';
import {
  makeTestIdentity,
  makeKarmaBox,
  seedProvenance,
  signTransaction,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// P2-B phase 1c — the creator must not mine a body its own mutation phase
// rejected.
//
// The reachable scenario is a stale mempool entry: a bond settlement that was
// valid at pool entry (invitee at/above INVITE_KARMA_THRESHOLD) turns invalid
// while pooled, because the invitee's karma-reducing spend commits first. Its
// inputs (the bond) stay live, so at block creation the embedded-tx
// re-validation — not the liveness skip — is what fails, and the speculative
// state-root run (H-6) rejects the whole body.
//
// The pre-fix twin of the first test passed on unmodified HEAD (2026-08-07):
// createOrderingBlock() solved real PoW over a header carrying
// EMPTY_STATE_ROOT while this node held a live prover — the `?? EMPTY_STATE_
// ROOT` fallback conflated "no prover" with "body rejected" — and the node's
// own apply then rejected that block at embedded-tx re-validation. Work
// wasted, height skipped; finalizeBlock's cleanup evicted the entry, so the
// next interval self-healed.
// ---------------------------------------------------------------------------

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

type DbModule = {
  initDb: (path: string) => void;
  getDb: () => Database;
  closeDb: () => void;
};

async function importDb(): Promise<DbModule> {
  return (await import('../../src/store/db.js')) as unknown as DbModule;
}

async function importBlockCreator() {
  return (await import('../../src/services/block-creator.js')) as unknown as {
    startBlockCreator: (cfg: typeof testConfig) => void;
    stopBlockCreator: () => void;
    createOrderingBlock: () => OrderingBlock | null;
  };
}

async function importMempool() {
  return (await import('../../src/store/mempool.js')) as {
    insertUtxoTx: (
      tx: UtxoTransaction,
      batchId: string | null,
      expiresAtHeight: number,
    ) => number;
    getPendingEntries: (limit: number) => Array<{ rowid: number }>;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
    getBox: (boxId: string) => unknown;
    getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
    getUnspentBoxes: () => import('@dagsocial/types').AnyBox[];
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => OrderingBlock | null;
  };
}

async function importAvl() {
  return (await import('../../src/state/avl-prover.js')) as
    typeof import('../../src/state/avl-prover.js');
}

/** Prover singleton on the test DB, seeded boxes bootstrapped — src/index.ts wiring. */
async function activateProver() {
  const avlMod = await importAvl();
  const utxo = await importUtxo();
  const handle = avlMod.createAvlProver();
  const unspent = utxo.getUnspentBoxes();
  if (unspent.length > 0) avlMod.bootstrapAvlProver(handle, unspent, 0, []);
  expect(avlMod.tryGetAvlProver()).not.toBeNull();
  return handle;
}

/** The engine deps every production validation path builds over the store. */
async function storeBackedDeps() {
  const utxoStore = await import('../../src/store/utxo.js');
  const { getDb } = await import('../../src/store/db.js');
  return {
    getBox: utxoStore.getBox,
    getBoxByProvenance: utxoStore.getBoxByProvenance,
    insertBox: utxoStore.insertBox,
    consumeBox: utxoStore.consumeBox,
    getKarmaBox: utxoStore.getKarmaBox,
    getKarmaValue: utxoStore.getKarmaValue,
    runInTransaction: (fn: () => void) => {
      getDb().transaction(fn)();
    },
    isSystemBox: () => false,
  };
}

/** Committed bond (inviter ← settlement) whose probation spans the window. */
function makeCommittedBond(
  inviterId: Uint8Array,
  inviteePublicKey: Uint8Array,
  probationStartBlock: number,
  probationEndBlock: number,
): BondBox {
  return seedProvenance<BondBox>(
    {
      boxType: 'bond' as const,
      value: INVITE_BOND_KARMA,
      inviterId,
      inviteOutputIndex: 0,
      inviteePublicKey,
      probationStartBlock,
      probationEndBlock,
      guard: 'bond_dual' as const,
    },
    1,
  );
}

/** Settlement of `bond` to its inviter, signed by the committed invitee. */
function makeSettlementTx(bond: BondBox, invitee: TestIdentity): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [bond.id!],
    outputs: [
      {
        boxType: 'karma',
        value: INVITE_BOND_KARMA,
        owner: bond.inviterId,
        guard: 'owner_signature',
        proofSource: 'bond-settle',
      } as KarmaBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, invitee.privateKey, Buffer.from(invitee.userId).toString('hex'));
  return tx;
}

/**
 * Seed the stale-settlement scenario and return its pieces:
 * bond committed, settlement valid at pool entry, pooled, then invalidated by
 * the invitee's karma-reducing spend committing — with the bond still live.
 */
async function seedStaleSettlement() {
  const utxo = await importUtxo();
  const mempool = await importMempool();

  const inviter = makeTestIdentity();
  const invitee = makeTestIdentity();

  // Above INVITE_KARMA_THRESHOLD (20n) at pool time.
  const inviteeKarma = makeKarmaBox(24n, invitee.userId, 0);
  utxo.insertBox(inviteeKarma);

  // Probation still running at the settle height (1): window (1, 1001) of the
  // pinned length. The threshold leg is the only possible unlock.
  const bond = makeCommittedBond(
    inviter.userId,
    invitee.userId,
    1,
    1 + INVITE_PROBATION_BLOCKS,
  );
  utxo.insertBox(bond);

  const settlement = makeSettlementTx(bond, invitee);

  // Entry-time proof: this is the tx pool entry / relay validation accepts.
  const { validateTx } = await import('../../src/services/utxo-engine.js');
  const deps = await storeBackedDeps();
  expect(validateTx(deps, settlement, 1).valid).toBe(true);

  mempool.insertUtxoTx(settlement, null, 1000);

  // The invitee's karma-reducing spend commits AFTER the settlement pooled.
  // The settlement's own input (the bond) stays live, so at the block path
  // this fails re-validation, not the liveness skip.
  utxo.consumeBox(inviteeKarma.id!, 0);
  expect(validateTx(deps, settlement, 1).valid).toBe(false);

  return { utxo, mempool, inviter, invitee, bond, settlement };
}

describe('block creator vs a body its own mutation phase rejects', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch {
      // Module might not have been imported
    }
    vi.doUnmock('../../src/state/avl-prover.js');
    vi.resetModules();
  });

  it('produces nothing on a rejected body, evicts it, and self-heals next attempt', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const { utxo, mempool, inviter, bond } = await seedStaleSettlement();

    // Real prover over the committed unspent set — production wiring. This is
    // what makes EMPTY_STATE_ROOT impossible to reach benignly: with a prover
    // live, only the body-rejected arm could ever have produced it.
    const handle = await activateProver();
    const preDigest = Buffer.from(handle.prover.digest()!).toString('hex');

    const ordering = await importOrdering();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = bc.createOrderingBlock();

    // No block: not mined, not stored, no PoW spent, prover untouched.
    expect(block).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(Buffer.from(handle.prover.digest()!).toString('hex')).toBe(preDigest);

    // Nothing settled: the bond survives and the inviter was never paid.
    expect(utxo.getBox(bond.id!)).not.toBeNull();
    expect(utxo.getKarmaBox(inviter.userId)).toBeNull();

    // The poisoned body's entries are evicted — the same cleanup a rejected
    // finalize runs. Without this the creator rebuilds the identical body
    // every interval, and purgeExpired cannot break the loop because the
    // chain height it keys on has stopped advancing.
    expect(mempool.getPendingEntries(10)).toHaveLength(0);

    // Next attempt self-heals: a clean block, carrying a real digest, applied.
    const second = bc.createOrderingBlock();
    expect(second).not.toBeNull();
    expect(second!.header.stateRoot).not.toBe(EMPTY_STATE_ROOT);
    expect(ordering.getCurrentHeight()).toBe(1);
  });

  it('a creator with no prover still produces a block carrying EMPTY_STATE_ROOT', async () => {
    // The contractual test-only fallback (NODE_INTERFACE "Post-block
    // stateRoot"): no prover means nothing to speculate against, and the
    // creator mines over EMPTY_STATE_ROOT rather than stalling. Discriminating
    // the fatal arm must not have collapsed this one into it.
    const db = await importDb();
    db.initDb(':memory:');

    const avlMod = await importAvl();
    expect(avlMod.tryGetAvlProver()).toBeNull();

    const ordering = await importOrdering();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = bc.createOrderingBlock();

    expect(block).not.toBeNull();
    expect(block!.header.stateRoot).toBe(EMPTY_STATE_ROOT);
    // Proverless apply skips the stateRoot gate, so the node accepts its own
    // block — the fallback keeps producing, it does not just emit and fail.
    expect(ordering.getCurrentHeight()).toBe(1);
    expect(ordering.getOrderingBlock(1)).not.toBeNull();
  });

  it('an unexpected speculation crash is fatal — produce nothing, not EMPTY_STATE_ROOT', async () => {
    // Pins computePostBlockStateRoot's catch-all arm to `body-rejected`. The
    // mapping rides the apply funnel's totality doctrine: the funnel turns the
    // same throw into a block rejection, so a body that crashes speculation is
    // a body no node — this one included — will apply. Mapping it to
    // `no-prover` instead would solve real PoW over EMPTY_STATE_ROOT on that
    // body: the 1c defect in a second costume. Until this test the arm was
    // unpinned — flipping it to `no-prover` left all 909 tests green
    // (2026-08-07 probe).
    //
    // Reached by injection at the module seam, not by crafted data: the
    // creator builds its candidate from locally validated state, so a plain
    // throw inside the speculation models dependency failure (the prover
    // library crashing on its own state), which no fixture can express.
    const db = await importDb();
    db.initDb(':memory:');

    // applyBlockMutations is the speculation's last in-transaction call and
    // runs only after the mutation phase succeeded — so the injected Error is
    // neither a SpeculativeRollback nor a BlockRejected, and only the
    // catch-all can field it. Everything else passes through untouched.
    vi.doMock('../../src/state/avl-prover.js', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../../src/state/avl-prover.js')>();
      return {
        ...actual,
        applyBlockMutations: (): Uint8Array => {
          throw new Error('injected: prover mutation crashed mid-speculation');
        },
      };
    });

    // Live prover with a real digest, so the no-prover early bails cannot be
    // what keeps the block away.
    const utxo = await importUtxo();
    utxo.insertBox(makeKarmaBox(24n, makeTestIdentity().userId, 0));
    const handle = await activateProver();
    const preDigest = Buffer.from(handle.prover.digest()!).toString('hex');

    const ordering = await importOrdering();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = bc.createOrderingBlock();

    // Fatal, exactly like an explicit body rejection: no block, no PoW spent,
    // nothing stored, prover untouched.
    expect(block).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(Buffer.from(handle.prover.digest()!).toString('hex')).toBe(preDigest);
  });
});
