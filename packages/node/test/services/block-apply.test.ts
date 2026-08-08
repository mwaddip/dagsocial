import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  computePostId,
  encodePost,
  encodeOrderingBlock,
  decodeOrderingBlock,
  PROTOCOL_VERSION,
  LIKE_KARMA_COST,
  KARMA_STALE_THRESHOLD_BLOCKS,
  CREDIT_MINER_REWARD_DELAY,
  EMPTY_STATE_ROOT,
  INVITE_BOND_KARMA,
  INVITE_KARMA_THRESHOLD,
  INVITE_PROBATION_BLOCKS,
} from '@dagsocial/types';
import { verifyOrderingBlockPoW, blockHash } from '@dagsocial/validation';
import type {
  Post,
  KarmaBox,
  BondBox,
  PostLockBox,
  BlockHeader,
  OrderingBlock,
  SubBlockEntry,
  PruneEntry,
  UtxoTransaction,
} from '@dagsocial/types';
import type { BlockJournal, BoxMutation } from '../../src/store/journal.js';
import type { AnyBox } from '@dagsocial/types';
import type { DecayJournalEntry } from '../../src/services/decay.js';
import type Database from 'better-sqlite3';
import type { TestIdentity } from '../helpers.js';
import {
  seedProvenance,
  signTransaction,
  makeTestIdentity,
  makePost,
  makeKarmaBox,
  makeLikeTx,
  changeBoxOf,
  solveHeaderPow,
  signHeader,
  makeApplicableBlock,
  makePruneEntry,
  hex,
  ZERO_HASH,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// Test config
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
  miningMode: 'internal' as const,
  orderingBlockPowTargetBits: 12,
  creditTreasuryPct: 10,
  treasuryPubKey: '',
  bootstrapPeers: [] as string[],
  listenAddrs: '/ip4/127.0.0.1/tcp/0',
  maxPeers: 50,
};

// ---------------------------------------------------------------------------
// Dynamic import helpers
// ---------------------------------------------------------------------------

type DbModule = {
  initDb: (path: string) => void;
  getDb: () => Database.Database;
  closeDb: () => void;
};

type BlockCreatorModule = {
  startBlockCreator: (cfg: typeof testConfig) => void;
  stopBlockCreator: () => void;
  onSubBlockReceived: () => void;
  createOrderingBlock: () => OrderingBlock | null;
};

async function importDb(): Promise<DbModule> {
  return (await import('../../src/store/db.js')) as unknown as DbModule;
}

async function importBlockCreator(): Promise<BlockCreatorModule> {
  return (await import(
    '../../src/services/block-creator.js'
  )) as unknown as BlockCreatorModule;
}

async function importIdentities() {
}

async function importPosts() {
  return (await import('../../src/store/posts.js')) as {
    insertPost: (post: Post, rawCbor: Uint8Array) => void;
    confirmPost: (postId: string, blockHeight: number) => void;
    getPost: (id: string) => Post | null;
  };
}

async function importMempoolFresh() {
  const mod = await import('../../src/store/mempool.js');
  return mod as {
    insertSubBlock: (
      postId: string,
      expiresAtHeight: number,
      batchId?: string | null,
    ) => number;
    insertUtxoTx: (
      tx: UtxoTransaction,
      batchId: string | null,
      expiresAtHeight: number,
    ) => number;
    getPendingEntries: (limit: number) => Array<{
      rowid: number;
      entryType: string;
      subblockId: string | null;
      utxoTxCbor: Uint8Array | null;
      batchId: string | null;
      expiresAtHeight: number;
      createdAt: string;
    }>;
    removeEntry: (rowid: number) => void;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
    getCreditBoxes: (owner: Uint8Array) => AnyBox[];
    getBox: (boxId: string) => unknown;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
  };
}

async function importBlockApply() {
  return (await import(
    '../../src/services/block-apply.js'
  )) as unknown as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
  };
}

async function importJournalStore() {
  return (await import('../../src/store/journal.js')) as {
    getBlockJournal: (height: number) => BlockJournal | null;
    insertBlockJournal: (journal: BlockJournal) => void;
    deleteBlockJournal: (height: number) => void;
    isBlockJournalOpen: () => boolean;
  };
}

/** boxIds of box 'remove' mutations, in application order. */
function removedIds(journal: BlockJournal): string[] {
  return journal.mutations
    .filter((m) => m.kind === 'box' && m.op === 'remove')
    .map((m) => (m as BoxMutation).boxId);
}

/** boxIds of box 'insert' mutations, in application order. */
function insertedIds(journal: BlockJournal): string[] {
  return journal.mutations
    .filter((m) => m.kind === 'box' && m.op === 'insert')
    .map((m) => (m as BoxMutation).boxId);
}

/** Box inserts matching a predicate over the recorded box payload. */
function boxInserts(
  journal: BlockJournal,
  match: (box: AnyBox) => boolean,
): BoxMutation[] {
  return journal.mutations.filter(
    (m) => m.kind === 'box' && m.op === 'insert' && match(m.box!),
  ) as BoxMutation[];
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => OrderingBlock | null;
    deleteOrderingBlock: (height: number) => void;
  };
}

/** The first nonce that does NOT satisfy the header's declared target. */
function unsolvedHeaderPow(header: BlockHeader): number {
  for (let nonce = 0; ; nonce++) {
    if (!verifyOrderingBlockPoW({ ...header, powNonce: nonce })) return nonce;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('block-apply journal recording', () => {
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
    vi.resetModules();
  });

  // -----------------------------------------------------------------------
  // 1. Coinbase mint records credit box inserts in journal
  // -----------------------------------------------------------------------

  it('coinbase mint records credit box inserts in journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const block = bc.createOrderingBlock();
    expect(block).not.toBeNull();
    expect(block!.header.height).toBe(1);

    // Verify journal was saved
    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).not.toBeNull();
    expect(saved!.blockHeight).toBe(1);

    // Genesis miner has no prior credits, so each coinbase output is exactly
    // one credit insert, its box bytes carried in the journal payload
    const creditInserts = boxInserts(saved!, (b) => b.boxType === 'credit');
    expect(creditInserts.length).toBe(block!.utxoTxTree.coinbaseOutputs.length);
    expect(saved!.mutations.length).toBe(creditInserts.length);
  });

  // -----------------------------------------------------------------------
  // 2. Post confirm records confirmedSubBlockIds in journal
  // -----------------------------------------------------------------------

  it('post confirm records confirmedSubBlockIds in journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const post = makePost(author.userId, 'journal test post');
    const postId = computePostId(post);
    const { encodePost } = await import('@dagsocial/types');

    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const mempool = await importMempoolFresh();
    mempool.insertSubBlock(postId, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock();

    // Verify post was confirmed
    const confirmedPost = posts.getPost(postId);
    expect(confirmedPost).not.toBeNull();

    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).not.toBeNull();
    expect(saved!.confirmedSubBlockIds).toContain(postId);
  });

  // -----------------------------------------------------------------------
  // 5. UTXO tx apply records appliedUtxoTxs in journal
  // -----------------------------------------------------------------------

  it('UTXO tx apply records appliedUtxoTxs in journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const ids = await importIdentities();
    const posts = await importPosts();
    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();

    const author = makeTestIdentity();

    const post = makePost(author.userId, 'utxo journal test');
    const postId = computePostId(post);
    const { encodePost, computeTxId } = await import('@dagsocial/types');
    posts.insertPost(post, encodePost(post));

    // Insert sub-block ID
    mempool.insertSubBlock(postId, 1000);

    // Insert a standalone UTXO transaction in mempool. The like targets the
    // post this same block confirms — N2b's apply rules reject a like on an
    // unconfirmed target, and topology lands (§8b) before the tx loop (§11),
    // so confirm-and-like-in-one-block is the valid shape. A self-like is
    // legal (and uneconomical) by contract.
    const karmaBox = makeKarmaBox(100n, author.userId, 0);
    utxo.insertBox(karmaBox);
    const likeTx = makeLikeTx(author, karmaBox, postId);
    mempool.insertUtxoTx(likeTx, null, 1000);

    bc.startBlockCreator(testConfig);
    const block = bc.createOrderingBlock();

    // Verify UTXO tx was decoded from block CBOR and applied
    const { decodeTx } = await import('@dagsocial/types');
    expect(block!.utxoTxTree.utxoTxs).toBeDefined();
    expect(block!.utxoTxTree.utxoTxs.length).toBe(
      block!.utxoTxTree.utxoTxIds.length,
    );
    for (let i = 0; i < block!.utxoTxTree.utxoTxs.length; i++) {
      const tx = decodeTx(block!.utxoTxTree.utxoTxs[i]);
      expect(computeTxId(tx)).toBe(block!.utxoTxTree.utxoTxIds[i]);
    }

    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).not.toBeNull();
    expect(saved!.appliedUtxoTxs.length).toBeGreaterThan(0);

    // The applied-tx record carries what mempool re-insertion needs: the id
    // and the CBOR, which round-trips to the same transaction
    const applied = saved!.appliedUtxoTxs[0]!;
    expect(applied.txId).toBe(computeTxId(likeTx));
    expect(applied.txCbor).toBeInstanceOf(Uint8Array);
    expect(computeTxId(decodeTx(applied.txCbor))).toBe(applied.txId);

    // The tx's box mutations live in the primitive log: input consumed,
    // change karma created (the burn shape has no other output)
    expect(removedIds(saved!)).toContain(karmaBox.id);
    expect(insertedIds(saved!)).toContain(changeBoxOf(likeTx).id);
  });

  // -----------------------------------------------------------------------
  // 6. Rejected block leaves NO journal — invalid PoW at genesis
  // -----------------------------------------------------------------------

  it('block rejected for invalid PoW leaves no journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const blockApply = await importBlockApply();
    const { expectedTarget } = await import('../../src/services/difficulty.js');

    // A block that passes the genesis and difficulty-schedule checks and then
    // fails on the solution: the target is the scheduled one, the nonce is the
    // first that does not satisfy it. Picking the nonce deterministically is
    // what keeps this off a 1-in-2^targetBits coin flip.
    const miner = makeTestIdentity();
    const block: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: 1,
        prevBlockHash: '0000000000000000000000000000000000000000000000000000000000000000',
        subBlockRoot: '0000000000000000000000000000000000000000000000000000000000000000',
        utxoTxRoot: '0000000000000000000000000000000000000000000000000000000000000000',
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: miner.userId,
        powNonce: 0,
        powTargetBits: expectedTarget(1),
        createdAt: Date.now(),
      },
      subBlockTree: { subBlockRefs: [], subBlockEntries: [], pruneEntries: [] },
      utxoTxTree: {
        utxoTxIds: [],
        utxoTxs: [],
        coinbaseOutputs: [],
      },
      validatorSignature: new Uint8Array(64),
    };
    block.header.powNonce = unsolvedHeaderPow(block.header);
    expect(verifyOrderingBlockPoW(block.header)).toBe(false);
    // Properly signed even though PoW rejects first, so the unsolved nonce is
    // the only thing wrong with this block.
    block.validatorSignature = signHeader(block.header, miner.privateKey);

    const result = blockApply.applyOrderingBlock(block);
    expect(result).toBe(false);

    // No journal should exist for height 1
    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 7. Rejected block leaves NO journal — wrong height at genesis
  // -----------------------------------------------------------------------

  it('block rejected for wrong height at genesis leaves no journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const blockApply = await importBlockApply();

    const miner = makeTestIdentity();
    const block: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: 99, // Genesis must have height 1
        prevBlockHash: '0000000000000000000000000000000000000000000000000000000000000000',
        subBlockRoot: '0000000000000000000000000000000000000000000000000000000000000000',
        utxoTxRoot: '0000000000000000000000000000000000000000000000000000000000000000',
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: miner.userId,
        powNonce: 0,
        powTargetBits: 4,
        createdAt: Date.now(),
      },
      subBlockTree: { subBlockRefs: [], subBlockEntries: [], pruneEntries: [] },
      utxoTxTree: {
        utxoTxIds: [],
        utxoTxs: [],
        coinbaseOutputs: [],
      },
      validatorSignature: new Uint8Array(64),
    };
    // Signed, so the height is the only thing wrong with this block.
    block.validatorSignature = signHeader(block.header, miner.privateKey);

    const result = blockApply.applyOrderingBlock(block);
    expect(result).toBe(false);

    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(99);
    expect(saved).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 8. Rejected block — wrong prevBlockHash at genesis
  // -----------------------------------------------------------------------

  it('block rejected for wrong prevBlockHash at genesis leaves no journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const blockApply = await importBlockApply();

    const miner = makeTestIdentity();
    const block: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: 1,
        prevBlockHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        subBlockRoot: '0000000000000000000000000000000000000000000000000000000000000000',
        utxoTxRoot: '0000000000000000000000000000000000000000000000000000000000000000',
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: miner.userId,
        powNonce: 0,
        powTargetBits: 4,
        createdAt: Date.now(),
      },
      subBlockTree: { subBlockRefs: [], subBlockEntries: [], pruneEntries: [] },
      utxoTxTree: {
        utxoTxIds: [],
        utxoTxs: [],
        coinbaseOutputs: [],
      },
      validatorSignature: new Uint8Array(64),
    };
    // Signed, so the prevBlockHash is the only thing wrong with this block.
    block.validatorSignature = signHeader(block.header, miner.privateKey);

    const result = blockApply.applyOrderingBlock(block);
    expect(result).toBe(false);

    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 9. Rejected block — coinbase value mismatch
  // -----------------------------------------------------------------------

  it('block rejected for coinbase value mismatch leaves no journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const blockApply = await importBlockApply();

    // Genesis paying a zero coinbase when the emission schedule says 100.
    //
    // Every earlier check is made to pass so the block reaches the coinbase
    // check on every run: the target is the scheduled one with a mined nonce,
    // and the Merkle roots are computed rather than zeroed. With a header that
    // failed PoW it was a coin flip whether PoW or the Merkle root did the
    // rejecting, and the coinbase check went untested.
    const { computeSubBlockRoot, computeUtxoTxRoot } = await import(
      '../../src/services/block-creator.js'
    );
    const { expectedTarget } = await import('../../src/services/difficulty.js');
    const subBlockTree = {
      subBlockRefs: [],
      subBlockEntries: [],
      pruneEntries: [],
    };
    const miner = makeTestIdentity();
    const utxoTxTree = {
      utxoTxIds: [],
      utxoTxs: [],
      coinbaseOutputs: [
        // The scheduled maturity lock, so the value is the only thing wrong:
        // a non-numeric `lockedUntilBlock` is now a structure rejection, which
        // would reject this block before it reached the coinbase check.
        {
          value: 0n,
          owner: new Uint8Array(32),
          lockedUntilBlock: 1 + CREDIT_MINER_REWARD_DELAY,
        },
      ],
    };
    const header = {
      protocolVersion: PROTOCOL_VERSION,
      height: 1,
      prevBlockHash: '0000000000000000000000000000000000000000000000000000000000000000',
      subBlockRoot: computeSubBlockRoot(subBlockTree),
      utxoTxRoot: computeUtxoTxRoot(utxoTxTree),
      stateRoot: '0000000000000000000000000000000000000000000000000000000000000000',
      validatorId: miner.userId,
      powNonce: 0,
      powTargetBits: expectedTarget(1),
      createdAt: Date.now(),
    } as BlockHeader;
    header.powNonce = solveHeaderPow(header);
    const block = {
      header,
      subBlockTree,
      utxoTxTree,
      // Signed: the coinbase check sits behind the validator-signature gate, so
      // an unsigned block would reject at the gate and test nothing here.
      validatorSignature: signHeader(header, miner.privateKey),
    } as unknown as OrderingBlock;

    const result = blockApply.applyOrderingBlock(block);
    expect(result).toBe(false);

    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 10. Successful block leaves no journal open after persistence
  // -----------------------------------------------------------------------

  it('no block journal is left open after successful block application', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock();

    const journal = await importJournalStore();
    expect(journal.isBlockJournalOpen()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 11. Decay burns recorded in journal
  // -----------------------------------------------------------------------

  it('records decay burns in journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const ids = await importIdentities();

    // Create an identity with a karma box at block 0 (ancient). The value is
    // large enough that the value-over-minimum cap cannot bind — see the
    // owed-burn derivation below.
    const identity = makeTestIdentity();
    const oldBox = makeKarmaBox(1000n, identity.userId, 0);
    utxo.insertBox(oldBox);

    // Import decay module directly — applyOrderingBlock delegates to it,
    // and we can't build 20,000+ blocks in a test. Inside block application
    // its box mutations are journaled at the store choke point; the return
    // value asserted here is the service's own per-owner summary.
    const { applyKarmaDecay } = await import(
      '../../src/services/decay.js'
    );
    const { KARMA_DECAY_AMOUNT, KARMA_DECAY_INTERVAL_BLOCKS, KARMA_MINIMUM } = await import('@dagsocial/types');

    const decayCfg = {
      staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
      decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
      decayAmount: KARMA_DECAY_AMOUNT,
      karmaMinimum: KARMA_MINIMUM,
    };

    // Spec G phase D: the decay clock is committed state. `oldBox` was inserted
    // with no journal open, so the identity has no record and reads as never
    // active — the same clock its `createdAtBlock` of 0 gave the old box-age
    // reading, so the burn below is unchanged by the swap.
    const records = await import('../../src/store/identity-records.js');

    const deps = {
      getKarmaBoxes: (owner: Uint8Array) => {
        const box = utxo.getKarmaBox(owner);
        return box ? [box] : [];
      },
      consumeBox: (boxId: string, height: number) =>
        utxo.consumeBox(boxId, height),
      insertBox: (box: KarmaBox) => utxo.insertBox(box),
      getIdentityRecord: records.getIdentityRecord,
      putIdentityRecord: records.putIdentityRecord,
      getKarmaOwners: () => [identity.userId],
    };

    const staleHeight = KARMA_STALE_THRESHOLD_BLOCKS + 100;
    const entries: DecayJournalEntry[] = applyKarmaDecay(deps, staleHeight, decayCfg);

    // Never-active clock ⇒ periods count from height 0:
    // owed = floor(staleHeight / interval) × amount.
    //
    // The box value (1000n) keeps the value-over-minimum cap from binding, so
    // the assertion measures the period arithmetic itself. A clamped assertion
    // can hide an unbounded error in its input — the pre-P2A version of this
    // test hardcoded a 720 divisor and the cap swallowed the resulting 2×
    // error. The premise is asserted so a future constant change cannot
    // silently turn this back into a cap test.
    const owed =
      BigInt(Math.floor(staleHeight / KARMA_DECAY_INTERVAL_BLOCKS)) * KARMA_DECAY_AMOUNT;
    expect(owed < 1000n - KARMA_MINIMUM).toBe(true);

    expect(entries.length).toBe(1);
    expect(entries[0]!.owner).toEqual(identity.userId);
    expect(entries[0]!.burnAmount).toBe(owed);
    expect(entries[0]!.consumedBoxIds).toEqual([oldBox.id!]);
    expect(entries[0]!.newBoxId).toBeTruthy();
    expect(entries[0]!.newBoxId).not.toBe('');

    // Old box is consumed — getKarmaBox only returns unspent boxes,
    // so it returns the new decay-burn box, not the old consumed one.
    const karmaBox = utxo.getKarmaBox(identity.userId);
    expect(karmaBox).not.toBeNull();
    expect(karmaBox!.id).toBe(entries[0]!.newBoxId);

    // New decay-burn box exists with reduced value
    expect(karmaBox!.boxType).toBe('karma');
    expect(karmaBox!.value).toBe(1000n - owed);
  });

  // -----------------------------------------------------------------------
  // 12. Vouch-cooldown mint journals karma mutations + escrow deletion (H-7)
  // -----------------------------------------------------------------------

  it('vouch-cooldown mint journals karma mutations and the deleted escrow row (H-7)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const { insertVouchCooldown } = (await import(
      '../../src/store/vouch-cooldowns.js'
    )) as {
      insertVouchCooldown: (
        voucherId: Uint8Array,
        targetId: Uint8Array,
        releaseAtBlock: number,
        karmaAmount: bigint,
      ) => void;
    };

    // Pre-block state: voucher karma + a matured escrow row (release ≤ 1)
    const voucher = makeTestIdentity();
    const target = makeTestIdentity();
    const oldKarma = makeKarmaBox(50n, voucher.userId, 0);
    utxo.insertBox(oldKarma);
    insertVouchCooldown(voucher.userId, target.userId, 1, 7n);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock();

    // H-7: the cooldown mint was journaled in NEITHER old representation —
    // the AVL never saw it, and revert neither reversed the mint nor
    // restored the escrow row. Both now appear: merge-consume + merged
    // insert in the mutation log, the deleted row as a side-record.
    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1)!;
    expect(removedIds(saved)).toContain(oldKarma.id);
    const voucherInserts = boxInserts(
      saved,
      (b) =>
        b.boxType === 'karma' &&
        Buffer.from((b as KarmaBox).owner).equals(Buffer.from(voucher.userId)),
    );
    expect(voucherInserts.length).toBe(1);
    expect((voucherInserts[0]!.box as KarmaBox).value).toBe(57n);

    expect(saved.vouchCooldownDeletions).toHaveLength(1);
    const del = saved.vouchCooldownDeletions[0]!;
    expect(Buffer.from(del.voucherId).equals(Buffer.from(voucher.userId))).toBe(true);
    expect(Buffer.from(del.targetId).equals(Buffer.from(target.userId))).toBe(true);
    expect(del.releaseAtBlock).toBe(1);
    expect(del.karmaAmount).toBe(7n);
  });
});

// ---------------------------------------------------------------------------
// Embedded UTXO tx re-validation at block application
// ---------------------------------------------------------------------------

describe('block-apply embedded tx re-validation', () => {
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
    vi.resetModules();
  });

  /**
   * Mine and apply a block over whatever sits in the mempool.
   *
   * The block creator does not validate what it picks up, so putting a
   * transaction into the mempool directly — around the service layer that
   * would have refused it — reproduces the malicious-producer case exactly:
   * validator selection is permissionless PoW, so a producer can embed a
   * transaction that passed validation on no node at all.
   */
  async function mineBlockOverMempool() {
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    return bc.createOrderingBlock();
  }

  it('rejects the whole block when an embedded tx spends a live box unsigned', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();

    const victim = makeTestIdentity();
    const victimBox = makeKarmaBox(100n, victim.userId, 0);
    utxo.insertBox(victimBox);

    // Well-formed — envelope included — conserving, and spending a box that
    // really exists. The only thing it lacks is the victim's authorisation.
    //
    // The target is 64-hex because `checkTxEnvelope` (validateTx step 0) pins
    // `likeTarget` to a post id, and the placeholder string this fixture used
    // to carry made it envelope-invalid: the funnel skipped the transaction
    // and the block applied, so the whole-block rejection asserted below was
    // never reached. It need not name a post that exists — `validateTx` never
    // looks one up; the apply-time like rules do, and step 6 refuses the
    // missing signature long before them.
    const forged = makeLikeTx(victim, victimBox, ZERO_HASH);
    forged.signatures = {};
    mempool.insertUtxoTx(forged, null, 1000);

    await mineBlockOverMempool();

    // Nothing the block would have done survives — not the block row, not the
    // coinbase mint, not the spend.
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).toBeNull();

    const survivor = utxo.getBox(victimBox.id!) as KarmaBox | null;
    expect(survivor).not.toBeNull();
    expect(survivor!.value).toBe(100n);
  });

  it('rejects the whole block when an embedded tx mints value', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();

    const attacker = makeTestIdentity();
    const attackerBox = makeKarmaBox(100n, attacker.userId, 0);
    utxo.insertBox(attackerBox);

    // Correctly signed by the owner and a legal karma → karma + post_lock
    // shape, but the outputs total 105 against a 100 karma input: the change
    // box keeps the full balance and the PostLockBox is conjured from nothing.
    const inflating: UtxoTransaction = {
      inputs: [attackerBox.id!],
      outputs: [
        {
          boxType: 'karma',
          value: 100n,
          owner: attacker.userId,
          guard: 'owner_signature',
          proofSource: 'lock_op',
        } as KarmaBox,
        {
          boxType: 'post_lock',
          value: 5n,
          originalValue: 5n,
          owner: attacker.userId,
          targetPostId: 'target_post',
          guard: 'block_apply',
        } as PostLockBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(
      inflating,
      attacker.privateKey,
      Buffer.from(attacker.userId).toString('hex'),
    );
    mempool.insertUtxoTx(inflating, null, 1000);

    await mineBlockOverMempool();

    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).toBeNull();

    // The attacker's balance is exactly what it was — no 102 anywhere.
    const survivor = utxo.getBox(attackerBox.id!) as KarmaBox | null;
    expect(survivor).not.toBeNull();
    expect(survivor!.value).toBe(100n);
  });

  it('applies a block whose embedded txs are all valid', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const { computeTxId } = await import('@dagsocial/types');

    const alice = makeTestIdentity();
    const bob = makeTestIdentity();
    const aliceBox = makeKarmaBox(100n, alice.userId, 0);
    const bobBox = makeKarmaBox(40n, bob.userId, 0);
    utxo.insertBox(aliceBox);
    utxo.insertBox(bobBox);

    // N2b: likes need confirmed live targets — real posts, confirmed by this
    // same block (topology at §8b precedes the tx loop at §11).
    const author = makeTestIdentity();
    const postA = makePost(author.userId, 'valid-txs target a');
    const postB = makePost(author.userId, 'valid-txs target b');
    const postAId = computePostId(postA);
    const postBId = computePostId(postB);
    posts.insertPost(postA, encodePost(postA));
    posts.insertPost(postB, encodePost(postB));
    mempool.insertSubBlock(postAId, 1000);
    mempool.insertSubBlock(postBId, 1000);

    const aliceTx = makeLikeTx(alice, aliceBox, postAId);
    const bobTx = makeLikeTx(bob, bobBox, postBId);
    mempool.insertUtxoTx(aliceTx, null, 1000);
    mempool.insertUtxoTx(bobTx, null, 1000);

    await mineBlockOverMempool();

    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).not.toBeNull();
    expect(saved!.appliedUtxoTxs.map((t) => t.txId).sort()).toEqual(
      [computeTxId(aliceTx), computeTxId(bobTx)].sort(),
    );

    // Inputs consumed, change boxes live at the conserved values.
    expect(utxo.getBox(aliceBox.id!)).toBeNull();
    expect(utxo.getBox(bobBox.id!)).toBeNull();
    expect((utxo.getBox(changeBoxOf(aliceTx).id!) as KarmaBox).value).toBe(
      100n - LIKE_KARMA_COST,
    );
    expect((utxo.getBox(changeBoxOf(bobTx).id!) as KarmaBox).value).toBe(
      40n - LIKE_KARMA_COST,
    );
  });

  it('still defers and retries a tx that consumes a box created in the same block', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const { computeTxId } = await import('@dagsocial/types');

    const liker = makeTestIdentity();
    const startBox = makeKarmaBox(100n, liker.userId, 0);
    utxo.insertBox(startBox);

    // N2b: likes need confirmed live targets — two real posts, confirmed by
    // the same block that carries the chained likes.
    const author = makeTestIdentity();
    const postA = makePost(author.userId, 'defer-retry target a');
    const postB = makePost(author.userId, 'defer-retry target b');
    const postAId = computePostId(postA);
    const postBId = computePostId(postB);
    posts.insertPost(postA, encodePost(postA));
    posts.insertPost(postB, encodePost(postB));
    mempool.insertSubBlock(postAId, 1000);
    mempool.insertSubBlock(postBId, 1000);

    const txA = makeLikeTx(liker, startBox, postAId);
    const txB = makeLikeTx(liker, changeBoxOf(txA), postBId);

    // B goes in first, so the block lists it first and its input does not
    // exist on the first pass — the "inputs not present yet" case, which must
    // still defer and retry rather than take the block down.
    mempool.insertUtxoTx(txB, null, 1000);
    mempool.insertUtxoTx(txA, null, 1000);

    const block = await mineBlockOverMempool();
    expect(block!.utxoTxTree.utxoTxIds[0]).toBe(computeTxId(txB));

    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).not.toBeNull();
    // Applied in dependency order, not block order.
    expect(saved!.appliedUtxoTxs.map((t) => t.txId)).toEqual([
      computeTxId(txA),
      computeTxId(txB),
    ]);

    // 100 → 99 → 98, with both intermediate boxes spent.
    expect(utxo.getBox(startBox.id!)).toBeNull();
    expect(utxo.getBox(changeBoxOf(txA).id!)).toBeNull();
    const finalBox = utxo.getBox(changeBoxOf(txB).id!) as KarmaBox | null;
    expect(finalBox).not.toBeNull();
    expect(finalBox!.value).toBe(100n - 2n * LIKE_KARMA_COST);
  });

  // -------------------------------------------------------------------------
  // Bond settlement's threshold unlock at the block path (P2-B phase 1b).
  //
  // The unit suite exercises the unlock predicate only through a test-local
  // deps stub, so the production `getKarmaValue` wiring was unpinned: mutating
  // the block path's read from summed to single-box left all tests green.
  // These two run the settlement through the real block pipeline, where deps
  // come from the store. The fixture makes summed-vs-single observable: the
  // invitee's karma sums past INVITE_KARMA_THRESHOLD only across boxes.
  // -------------------------------------------------------------------------

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

  it('bond settlement threshold sums the invitee karma across boxes at the block path', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();

    const inviter = makeTestIdentity();
    const invitee = makeTestIdentity();

    // 12 + 12 = 24 ≥ INVITE_KARMA_THRESHOLD (20), but neither box alone
    // reaches it — a single-box read (getKarmaBox is LIMIT 1 with no ORDER BY)
    // sees 12 < 20 whichever row it lands on, and verdicts locked.
    const splitA = makeKarmaBox(12n, invitee.userId, 0, 0);
    const splitB = makeKarmaBox(12n, invitee.userId, 0, 1);
    utxo.insertBox(splitA);
    utxo.insertBox(splitB);

    // Probation still running at the block's height (1): window (1, 1001) of
    // the pinned length, ending far past the settle height. The threshold leg
    // is therefore the ONLY way this settlement can unlock — an expired window
    // would settle under either read and pin nothing.
    const bond = makeCommittedBond(
      inviter.userId,
      invitee.userId,
      1,
      1 + INVITE_PROBATION_BLOCKS,
    );
    utxo.insertBox(bond);

    mempool.insertUtxoTx(makeSettlementTx(bond, invitee), null, 1000);
    const block = await mineBlockOverMempool();
    expect(block).not.toBeNull();

    // Settled state, not a rejection message: under a single-box read the
    // creator's speculative mutation pass (Spec B P3) drops the settlement —
    // or the verifier rejects the block — and either way the bond survives
    // and the inviter is never paid.
    expect(utxo.getBox(bond.id!)).toBeNull();
    const inviterKarma = utxo.getKarmaBox(inviter.userId);
    expect(inviterKarma).not.toBeNull();
    expect(inviterKarma!.value).toBe(INVITE_BOND_KARMA);

    // The predicate reads the invitee's boxes; the settlement must not spend
    // them.
    expect(utxo.getBox(splitA.id!)).not.toBeNull();
    expect(utxo.getBox(splitB.id!)).not.toBeNull();
  });

  it('the same settlement settles with the invitee karma in one box (control)', async () => {
    // Non-vacuity for the split fixture above: 24 in a single box clears the
    // threshold under summed AND single-box reads, so this control passing
    // while the split test fails is what isolates a mutation to partitioning
    // rather than to the settlement flow being broken generally.
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();

    const inviter = makeTestIdentity();
    const invitee = makeTestIdentity();

    utxo.insertBox(makeKarmaBox(24n, invitee.userId, 0));

    const bond = makeCommittedBond(
      inviter.userId,
      invitee.userId,
      1,
      1 + INVITE_PROBATION_BLOCKS,
    );
    utxo.insertBox(bond);

    mempool.insertUtxoTx(makeSettlementTx(bond, invitee), null, 1000);
    const block = await mineBlockOverMempool();
    expect(block).not.toBeNull();

    expect(utxo.getBox(bond.id!)).toBeNull();
    const inviterKarma = utxo.getKarmaBox(inviter.userId);
    expect(inviterKarma).not.toBeNull();
    expect(inviterKarma!.value).toBe(INVITE_BOND_KARMA);
  });
});

// ---------------------------------------------------------------------------
// Mint provenance at the apply path (Spec G phase C1)
//
// These exercise the *wiring* rather than the encoders: which context each
// `mintKarma`/`mintCredits` call site passes. A unit test on
// `mint-provenance.ts` cannot see a call site that hands the wrong one over,
// and both mistakes below are silent — a collision, not an error.
// ---------------------------------------------------------------------------

describe('block-apply mint provenance', () => {
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
    vi.resetModules();
  });

  it('a split coinbase mints one box per output, each with its own txId', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const blockApply = await importBlockApply();
    const { computeBlockReward } = await import('../../src/services/block-creator.js');
    const { computeMintTxId } = await import('@dagsocial/types');
    const { coinbaseContext } = await import('../../src/mint-provenance.js');

    // The shape any node with `creditTreasuryPct > 0` produces. Coinbase is N
    // mint *events*, not one N-output transaction, so each output carries its
    // own synthetic txId keyed on its index — and `UNIQUE(tx_id, output_index)`
    // turns a shared txId into a rejected block rather than silent corruption.
    const miner = makeTestIdentity();
    const treasury = makeTestIdentity();
    const reward = computeBlockReward(1);
    const treasuryShare = reward / 10n;

    const block = await makeApplicableBlock({
      miner,
      coinbaseSplit: [
        { owner: miner.userId, value: reward - treasuryShare, isTreasury: false },
        { owner: treasury.userId, value: treasuryShare, isTreasury: true },
      ],
    });
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    const minerBox = utxo.getCreditBoxes(miner.userId)[0];
    const treasuryBox = utxo.getCreditBoxes(treasury.userId)[0];
    expect(minerBox).toBeDefined();
    expect(treasuryBox).toBeDefined();

    // Position in `coinbaseOutputs` is the subject; `index` stays 0 because
    // each event emits exactly one box.
    expect(minerBox!.txId).toBe(computeMintTxId(1, 'coinbase', coinbaseContext(0).subject));
    expect(treasuryBox!.txId).toBe(computeMintTxId(1, 'coinbase', coinbaseContext(1).subject));
    expect(minerBox!.txId).not.toBe(treasuryBox!.txId);
    expect(minerBox!.index).toBe(0);
    expect(treasuryBox!.index).toBe(0);
  });

  it('a decay box consumed by a vouch settlement in the same block gets a distinct outpoint', async () => {
    // The real same-block adjacency between decay and a karma mint. Ordering is
    // what makes it reachable: `applyKarmaDecay` runs *before*
    // `processVouchCooldowns` in the mutation phase, so decay creates a box and
    // the vouch settlement immediately merge-consumes it and mints a
    // replacement — two karma boxes for one owner, at one height.
    //
    // They do not collide, but only because the *reasons* differ. Equal txIds
    // would be a `UNIQUE(tx_id, output_index)` violation and the block would be
    // rejected outright.
    //
    // Thresholds are shrunk through a test-local mock of the config module so
    // a 4-block chain crosses the staleness window. The env overrides this
    // test used before P2-A were the consensus violation the network profile
    // removed; a module mock is a seam only a test can reach — a running node
    // has no equivalent.
    try {
      vi.doMock('../../src/config.js', async () => {
        const actual = await vi.importActual<typeof import('../../src/config.js')>(
          '../../src/config.js',
        );
        return {
          ...actual,
          config: Object.freeze({
            ...actual.config,
            karmaStaleThresholdBlocks: 3,
            karmaDecayIntervalBlocks: 1,
          }),
        };
      });
      vi.resetModules(); // re-import the module graph against the mocked config

      const db = await importDb();
      db.initDb(':memory:');

      const utxo = await importUtxo();
      const vouchStore = await import('../../src/store/vouch-cooldowns.js');
      const journalStore = await importJournalStore();
      const { VOUCH_KARMA_AMOUNT } = await import('@dagsocial/types');
      const { decayContext, vouchSettleContext } = await import(
        '../../src/mint-provenance.js'
      );
      const { computeMintTxId } = await import('@dagsocial/types');

      const idle = makeTestIdentity();
      const target = makeTestIdentity();
      utxo.insertBox(makeKarmaBox(50n, idle.userId, 0));
      // Matures at height 4 — the same block decay first fires in.
      vouchStore.insertVouchCooldown(idle.userId, target.userId, 4, VOUCH_KARMA_AMOUNT);

      const bc = await importBlockCreator();
      bc.startBlockCreator(testConfig);
      bc.createOrderingBlock();
      bc.createOrderingBlock();
      bc.createOrderingBlock();

      // Height 4 > threshold 3: decay fires, then the cooldown settles.
      const block = bc.createOrderingBlock();
      expect(block).not.toBeNull();

      const journal = journalStore.getBlockJournal(4)!;
      const ownerHex = hex(idle.userId);
      const mints = journal.mutations
        .filter((m): m is BoxMutation => m.kind === 'box' && m.op === 'insert')
        .map((m) => m.box as AnyBox)
        .filter((b) => b.boxType === 'karma' && hex((b as KarmaBox).owner) === ownerHex);

      // Vacuity guard: both legs must actually have fired, or this proves
      // nothing about the discriminant.
      expect(mints.length).toBe(2);
      const [decayed, settled] = mints;
      expect((decayed as KarmaBox & { decayBurn?: boolean }).decayBurn).toBe(true);

      expect(decayed!.txId).toBe(
        computeMintTxId(4, 'decay', decayContext(idle.userId).subject),
      );
      expect(settled!.txId).toBe(
        computeMintTxId(4, 'vouch-settle', vouchSettleContext(idle.userId, target.userId).subject),
      );
      expect(decayed!.txId).not.toBe(settled!.txId);
      expect(decayed!.index).toBe(settled!.index);

      // The settlement consumed the decay box it had just been handed.
      expect(utxo.getBox(decayed!.id!)).toBeNull();
      expect(utxo.getKarmaBox(idle.userId)!.id).toBe(settled!.id);
    } finally {
      vi.doUnmock('../../src/config.js');
    }
  });

  it('the same-block decay-then-settle adjacency resets the clock exactly as the boxes did', async () => {
    // Spec G phase D. The same funnel as the test above, read through the
    // *clock* rather than the outpoints.
    //
    // `applyKarmaDecay` runs at block-apply.ts:1018 and `processVouchCooldowns`
    // at :1026, so at height 4 decay writes `lastDecayBlock: 4` and the
    // settlement's mint then writes `lastActivityBlock: 4` — both halves land
    // on the same height, in that order.
    //
    // Under the old code the settlement created a *non-decay* karma box at
    // height 4, which reset staleness for every subsequent block. The record
    // has to reproduce that, and it does for two independent reasons worth
    // pinning separately:
    //
    //   staleness    (h − 4) >= 3 only from h = 7, so blocks 5 and 6 are quiet;
    //   owedPeriods  max(4, 4) = 4, the same clock start the single surviving
    //                non-decay box gave — the `max` cannot pick the stale half.
    //
    // Had the activity bump reset `lastDecayBlock`, or had decay overwritten
    // `lastActivityBlock`, the arithmetic would still look right at height 4
    // and diverge later. Hence the assertions at 5 and 7.
    // Thresholds shrunk through a test-local config mock — see the sibling
    // decay test above for why this replaced the env overrides.
    try {
      vi.doMock('../../src/config.js', async () => {
        const actual = await vi.importActual<typeof import('../../src/config.js')>(
          '../../src/config.js',
        );
        return {
          ...actual,
          config: Object.freeze({
            ...actual.config,
            karmaStaleThresholdBlocks: 3,
            karmaDecayIntervalBlocks: 1,
          }),
        };
      });
      vi.resetModules();

      const db = await importDb();
      db.initDb(':memory:');

      const utxo = await importUtxo();
      const vouchStore = await import('../../src/store/vouch-cooldowns.js');
      const records = await import('../../src/store/identity-records.js');
      const { VOUCH_KARMA_AMOUNT } = await import('@dagsocial/types');

      const idle = makeTestIdentity();
      const target = makeTestIdentity();
      utxo.insertBox(makeKarmaBox(50n, idle.userId, 0));
      vouchStore.insertVouchCooldown(idle.userId, target.userId, 4, VOUCH_KARMA_AMOUNT);

      const bc = await importBlockCreator();
      bc.startBlockCreator(testConfig);
      for (let i = 0; i < 3; i++) bc.createOrderingBlock();

      // Height 4: decay fires, then the cooldown settles for the same owner.
      expect(bc.createOrderingBlock()).not.toBeNull();
      expect(records.getIdentityRecord(idle.userId)).toEqual({
        lastActivityBlock: 4,
        lastDecayBlock: 4,
        likeCarry: 0n,
      });
      const afterAdjacency = utxo.getKarmaBox(idle.userId)!.value;

      // Height 5: within the threshold of the height-4 activity — quiet, and
      // the clock must not drift.
      expect(bc.createOrderingBlock()).not.toBeNull();
      expect(records.getIdentityRecord(idle.userId)).toEqual({
        lastActivityBlock: 4,
        lastDecayBlock: 4,
        likeCarry: 0n,
      });
      expect(utxo.getKarmaBox(idle.userId)!.value).toBe(afterAdjacency);

      // Heights 6 then 7: (7 − 4) >= 3, so decay resumes at 7 and not before.
      expect(bc.createOrderingBlock()).not.toBeNull();
      expect(utxo.getKarmaBox(idle.userId)!.value).toBe(afterAdjacency);

      expect(bc.createOrderingBlock()).not.toBeNull();
      expect(utxo.getKarmaBox(idle.userId)!.value).toBeLessThan(afterAdjacency);
      expect(records.getIdentityRecord(idle.userId)).toEqual({
        lastActivityBlock: 4,
        lastDecayBlock: 7,
        likeCarry: 0n,
      });
    } finally {
      vi.doUnmock('../../src/config.js');
    }
  });
});

// ---------------------------------------------------------------------------
// Height-deterministic difficulty + coinbase maturity, enforced at apply
// (audit M-2, M-3)
// ---------------------------------------------------------------------------

describe('block-apply consensus schedules', () => {
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
    vi.resetModules();
  });

  // -----------------------------------------------------------------------
  // M-2: powTargetBits must equal expectedTarget(height)
  // -----------------------------------------------------------------------

  it('rejects a block whose powTargetBits is below the schedule', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const { expectedTarget } = await import('../../src/services/difficulty.js');
    const floorTarget = 4; // the gossip validator's sanity floor
    expect(floorTarget).toBeLessThan(expectedTarget(1));

    // The M-2 attack, in full: a self-declared floor target with a PoW solution
    // that genuinely satisfies it. Nothing here is malformed — the block is
    // internally consistent and costs ~16 hashes to produce.
    const block = await makeApplicableBlock({ powTargetBits: floorTarget });
    expect(verifyOrderingBlockPoW(block.header)).toBe(true);

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    // Rolled back whole: no block, no height, no coinbase mint.
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).toBeNull();
  });

  it('accepts a block whose powTargetBits equals the schedule', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const { expectedTarget } = await import('../../src/services/difficulty.js');
    const block = await makeApplicableBlock();
    expect(block.header.powTargetBits).toBe(expectedTarget(1));

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(1);
  });

  // -----------------------------------------------------------------------
  // M-3: every coinbase lock must equal height + CREDIT_MINER_REWARD_DELAY
  // -----------------------------------------------------------------------

  it('rejects a block whose coinbase output is unlocked', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // lockedUntilBlock 0 — spendable the moment it is minted, bypassing the
    // CREDIT_MINER_REWARD_DELAY maturity. The value is correct, so the
    // emission check above waves it through.
    const block = await makeApplicableBlock({ lockedUntilBlock: 0 });

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);

    // The mint is what the attack is after: no credit box, of any maturity.
    const { getCreditBoxes } = (await import('../../src/store/utxo.js')) as {
      getCreditBoxes: (owner: Uint8Array) => unknown[];
    };
    expect(getCreditBoxes(block.utxoTxTree.coinbaseOutputs[0]!.owner)).toHaveLength(0);
  });

  it('rejects a block whose coinbase lock is one block short of maturity', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // Off by one, not obviously wrong, and still ahead of the block height the
    // gossip validator bounds against — so only an equality check catches it.
    const block = await makeApplicableBlock({
      lockedUntilBlock: 1 + CREDIT_MINER_REWARD_DELAY - 1,
    });

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(0);
  });

  it('accepts a block whose coinbase lock matches the maturity delay', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const block = await makeApplicableBlock({
      lockedUntilBlock: 1 + CREDIT_MINER_REWARD_DELAY,
    });

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(1);

    // Minted, and carrying the lock the block declared.
    const { getCreditBoxes } = (await import('../../src/store/utxo.js')) as {
      getCreditBoxes: (owner: Uint8Array) => Array<{ lockedUntilBlock?: number }>;
    };
    const boxes = getCreditBoxes(block.utxoTxTree.coinbaseOutputs[0]!.owner);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.lockedUntilBlock).toBe(1 + CREDIT_MINER_REWARD_DELAY);
  });

  // -----------------------------------------------------------------------
  // H-1: the block must be signed by the key its validatorId names
  // -----------------------------------------------------------------------

  it('rejects a block whose validator signature is corrupted', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const block = await makeApplicableBlock();
    // Nothing in the header moves, so the PoW solution stays valid and the
    // signature is the only check this block can fail.
    expect(verifyOrderingBlockPoW(block.header)).toBe(true);
    block.validatorSignature[0] = (block.validatorSignature[0]! + 1) % 256;

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    // Rolled back whole: no block, no height, no journal, no coinbase mint.
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).toBeNull();

    const { getCreditBoxes } = (await import('../../src/store/utxo.js')) as {
      getCreditBoxes: (owner: Uint8Array) => unknown[];
    };
    expect(getCreditBoxes(block.utxoTxTree.coinbaseOutputs[0]!.owner)).toHaveLength(0);
  });

  it('rejects a block carrying the all-zero placeholder signature', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // What every hand-built block used to carry, and what an unsigned forgery
    // costs nothing to produce.
    const block = await makeApplicableBlock();
    block.validatorSignature = new Uint8Array(64);

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(0);
  });

  it('rejects a block signed by a key other than the one its validatorId names', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // The H-1 attack in full: the forger does the (testnet-cheap) PoW and
    // publishes under another validator's identity. Every other check passes —
    // the block is internally consistent, on-schedule, and correctly mined.
    // Only the signature ties block production to the key that claims it.
    const forger = makeTestIdentity();
    const block = await makeApplicableBlock({ signWith: forger.privateKey });
    expect(verifyOrderingBlockPoW(block.header)).toBe(true);
    expect(block.header.validatorId).not.toEqual(forger.userId);

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// H-3: consensus-carried sub-block authorship + prune authorship binding
// ---------------------------------------------------------------------------

describe('block-apply H-3 sub-block authorship and prune binding', () => {
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
    vi.resetModules();
  });

  // -----------------------------------------------------------------------
  // Prune authorship binding — the H-3 attack itself
  // -----------------------------------------------------------------------

  it('rejects a block pruning a subtree under a key that is not the root author', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const attacker = makeTestIdentity();
    const post = makePost(author.userId, 'victim post');
    const postId = computePostId(post);

    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const blockApply = await importBlockApply();

    // Height 1 confirms the post — that is what records its author in
    // block_topology, and it is the only place the author is recorded.
    const confirmBlock = await makeApplicableBlock({
      subBlockEntries: [{ postId, parentRefs: [], author: hex(author.userId) }],
    });
    expect(blockApply.applyOrderingBlock(confirmBlock)).toBe(true);

    // Height 2 is the attack: the prune is signed, correctly, by a key that has
    // nothing to do with the post. Merkle root, postId set and signature all
    // verify — only the binding to the recorded author does not.
    const pruneBlock = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(postId, [postId], attacker)],
    });
    expect(hex(attacker.userId)).not.toBe(hex(author.userId));
    expect(blockApply.applyOrderingBlock(pruneBlock)).toBe(false);

    // Rolled back whole: no block at 2, no settlement, no DAG deletion.
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(2)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(1);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(2)).toBeNull();

    const stored = posts.getPost(postId);
    expect(stored).not.toBeNull();
    expect((stored as Post).content).toBe('victim post');

    const { getStump } = (await import('../../src/store/stumps.js')) as {
      getStump: (id: string) => unknown;
    };
    expect(getStump(postId)).toBeNull();
  });

  it('accepts the same prune when authorId is the recorded author (control)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const post = makePost(author.userId, 'victim post');
    const postId = computePostId(post);

    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const blockApply = await importBlockApply();
    const confirmBlock = await makeApplicableBlock({
      subBlockEntries: [{ postId, parentRefs: [], author: hex(author.userId) }],
    });
    expect(blockApply.applyOrderingBlock(confirmBlock)).toBe(true);

    // Identical in shape to the rejected block above — the signing key is the
    // only difference, which is what makes that rejection non-vacuous.
    const pruneBlock = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(postId, [postId], author)],
    });
    expect(blockApply.applyOrderingBlock(pruneBlock)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);

    const { getStump } = (await import('../../src/store/stumps.js')) as {
      getStump: (id: string) => { rootPostHash: string } | null;
    };
    expect(getStump(postId)?.rootPostHash).toBe(postId);
  });

  it('rejects a prune of a root no applied block has confirmed', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // The author's own key, the author's own post — but nothing has confirmed
    // it, so block_topology has no author for it and it is not prunable. Held
    // locally and unconfirmed is exactly the state a gossip-only post is in.
    const author = makeTestIdentity();
    const post = makePost(author.userId, 'unconfirmed post');
    const postId = computePostId(post);

    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const { getTopologyAuthor } = (await import('../../src/store/topology.js')) as {
      getTopologyAuthor: (postId: string) => string | null;
    };
    expect(getTopologyAuthor(postId)).toBeNull();

    const blockApply = await importBlockApply();
    const pruneBlock = await makeApplicableBlock({
      pruneEntries: [makePruneEntry(postId, [postId], author)],
    });
    expect(blockApply.applyOrderingBlock(pruneBlock)).toBe(false);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(0);
    expect((posts.getPost(postId) as Post).content).toBe('unconfirmed post');
  });

  it('accepts the same prune once a block has confirmed the root (control)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const post = makePost(author.userId, 'confirmed post');
    const postId = computePostId(post);

    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const blockApply = await importBlockApply();
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({
          subBlockEntries: [{ postId, parentRefs: [], author: hex(author.userId) }],
        }),
      ),
    ).toBe(true);

    // Same entry, same key — the topology row is the only thing that changed.
    const pruneBlock = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(postId, [postId], author)],
    });
    expect(blockApply.applyOrderingBlock(pruneBlock)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Entry-vs-post verification — content-holders keep lying entries out
  // -----------------------------------------------------------------------

  it('accepts a block whose entry matches the local post (control)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const parentA = 'a1'.repeat(32);
    const parentB = 'b2'.repeat(32);
    const post = { ...makePost(author.userId), parentRefs: [parentA, parentB] };
    const postId = computePostId(post);

    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const blockApply = await importBlockApply();
    const block = await makeApplicableBlock({
      subBlockEntries: [
        { postId, parentRefs: [parentA, parentB], author: hex(author.userId) },
      ],
    });
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(1);
  });

  it('rejects a block whose entry claims an author the local post contradicts', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // Identical to the control above except for `author` — the producer claims
    // authorship of someone else's post, which is what would make the prune
    // binding above authorize them.
    const author = makeTestIdentity();
    const attacker = makeTestIdentity();
    const parentA = 'a1'.repeat(32);
    const parentB = 'b2'.repeat(32);
    const post = { ...makePost(author.userId), parentRefs: [parentA, parentB] };
    const postId = computePostId(post);

    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const blockApply = await importBlockApply();
    const block = await makeApplicableBlock({
      subBlockEntries: [
        { postId, parentRefs: [parentA, parentB], author: hex(attacker.userId) },
      ],
    });
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(0);

    const { getTopologyAuthor } = (await import('../../src/store/topology.js')) as {
      getTopologyAuthor: (postId: string) => string | null;
    };
    expect(getTopologyAuthor(postId)).toBeNull();
  });

  it('rejects a block whose entry grafts the post under a different parent', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // Identical to the control except for `parentRefs`: the producer reparents
    // a victim's post under a root they authored, so the victim's post falls
    // inside the subtree their own prune signature covers.
    const author = makeTestIdentity();
    const parentA = 'a1'.repeat(32);
    const parentB = 'b2'.repeat(32);
    const attackerRoot = 'cc'.repeat(32);
    const post = { ...makePost(author.userId), parentRefs: [parentA, parentB] };
    const postId = computePostId(post);

    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const blockApply = await importBlockApply();
    const block = await makeApplicableBlock({
      subBlockEntries: [
        { postId, parentRefs: [attackerRoot], author: hex(author.userId) },
      ],
    });
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(0);
  });

  it('rejects a block whose entry reorders the post parentRefs', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // Same set, different order. parentRefs are a postId-preimage field, so the
    // order is part of the post's identity and the comparison is sequence-wise.
    const author = makeTestIdentity();
    const parentA = 'a1'.repeat(32);
    const parentB = 'b2'.repeat(32);
    const post = { ...makePost(author.userId), parentRefs: [parentA, parentB] };
    const postId = computePostId(post);

    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const blockApply = await importBlockApply();
    const block = await makeApplicableBlock({
      subBlockEntries: [
        { postId, parentRefs: [parentB, parentA], author: hex(author.userId) },
      ],
    });
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Placeholder path — a node without the content still records the author
  // -----------------------------------------------------------------------

  it('confirms an unseen post as a placeholder and records the entry author', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // The fresh-sync case: no content for this postId anywhere locally, so
    // there is nothing to verify the entry against and the claim is recorded
    // as given. block_topology carries the author; dag_posts does not.
    const claimed = makeTestIdentity();
    const postId = 'ab'.repeat(32);

    const blockApply = await importBlockApply();
    const block = await makeApplicableBlock({
      subBlockEntries: [{ postId, parentRefs: [], author: hex(claimed.userId) }],
    });
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    const { getTopologyAuthor } = (await import('../../src/store/topology.js')) as {
      getTopologyAuthor: (postId: string) => string | null;
    };
    expect(getTopologyAuthor(postId)).toBe(hex(claimed.userId));

    const posts = await importPosts();
    const placeholder = posts.getPost(postId) as Post;
    expect(placeholder).not.toBeNull();
    expect(placeholder.content).toBe('');
    expect(hex(placeholder.author)).toBe('00'.repeat(32));
  });
});

// ---------------------------------------------------------------------------
// The apply funnel is a total function of its input
//
// `verifyOrderingBlockStructure` ran only in the gossip topic validator, so the
// pull-sync path — CBOR-decode straight into the apply handler — reached
// consensus code with fields of arbitrary type. Nothing between there and the
// prune loop's `Buffer.from(entry.subtreeMerkleRoot)` checks that field, and a
// throw out of `applyOrderingBlock` becomes an unhandled rejection in the
// gossip callback (whose promise the net layer discards), which exits the
// process. A rejected block is never stored, so the node re-fetches it on
// restart and dies again: one cheaply-mined block, a permanent network-wide
// crash loop.
// ---------------------------------------------------------------------------

describe('block-apply funnel totality', () => {
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
    vi.doUnmock('../../src/store/journal.js');
    vi.resetModules();
  });

  /**
   * A confirmed post and its consensus-recorded author — the state an attacker
   * builds a prune entry against. `rootPostHash` and the recorded author are
   * public consensus data (they ride in every block), so nothing here is a
   * secret the attacker has to obtain.
   */
  async function confirmedPost(): Promise<{ postId: string; author: TestIdentity }> {
    const author = makeTestIdentity();
    const post = makePost(author.userId, 'victim post');
    const postId = computePostId(post);

    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const blockApply = await importBlockApply();
    const confirmBlock = await makeApplicableBlock({
      subBlockEntries: [{ postId, parentRefs: [], author: hex(author.userId) }],
    });
    expect(blockApply.applyOrderingBlock(confirmBlock)).toBe(true);
    return { postId, author };
  }

  // -----------------------------------------------------------------------
  // The kill shot: a prune entry whose subtreeMerkleRoot is not bytes
  // -----------------------------------------------------------------------

  it('rejects — without throwing — a block whose prune entry carries a non-Uint8Array subtreeMerkleRoot', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const { postId, author } = await confirmedPost();
    const blockApply = await importBlockApply();

    // Valid in every respect a node checks: real PoW at the scheduled target,
    // a real validator signature, the scheduled coinbase with the scheduled
    // maturity lock, and Merkle roots computed over this very tree. The prune
    // entry names the root's genuine consensus-recorded author, so the H-3
    // binding check — the only total check standing in front of the prune
    // loop — passes. `subtreeMerkleRoot` is a CBOR integer, which is what
    // `Buffer.from` throws on.
    const killEntry = {
      ...makePruneEntry(postId, [postId], author),
      subtreeMerkleRoot: 42,
    } as unknown as PruneEntry;
    const killBlock = await makeApplicableBlock({ height: 2, pruneEntries: [killEntry] });

    expect(() => blockApply.applyOrderingBlock(killBlock)).not.toThrow();
    expect(blockApply.applyOrderingBlock(killBlock)).toBe(false);

    // Rolled back whole: the chain does not move and no journal is written.
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(2)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(1);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(2)).toBeNull();
    expect(journal.isBlockJournalOpen()).toBe(false);

    // The prune did not settle: the victim's content is untouched.
    const posts = await importPosts();
    expect((posts.getPost(postId) as Post).content).toBe('victim post');
  });

  it('accepts the same block with a real 32-byte subtreeMerkleRoot (control)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const { postId, author } = await confirmedPost();
    const blockApply = await importBlockApply();

    // Identical in every field but one: the merkle root is the real root over
    // the subtree ids and the signature covers it. That is what makes the
    // rejection above a verdict on the field's *type* and nothing else.
    const block = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(postId, [postId], author)],
    });
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);

    const { getStump } = (await import('../../src/store/stumps.js')) as {
      getStump: (id: string) => { rootPostHash: string } | null;
    };
    expect(getStump(postId)?.rootPostHash).toBe(postId);
  });

  // -----------------------------------------------------------------------
  // Path independence — the sync path has no gossip validator in front of it
  // -----------------------------------------------------------------------

  it('rejects the malformed block arriving over the sync path (CBOR round-trip, no gossip validator)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const { postId, author } = await confirmedPost();
    const blockApply = await importBlockApply();

    const killEntry = {
      ...makePruneEntry(postId, [postId], author),
      subtreeMerkleRoot: 42,
    } as unknown as PruneEntry;
    const killBlock = await makeApplicableBlock({ height: 2, pruneEntries: [killEntry] });

    // What `NetNode.appendBlocks` does with a peer's Modifier response: decode
    // the bytes and hand the result straight to the apply handler. No topic
    // validator runs on this path, which is why the structure check cannot
    // live in gossip.
    const decoded = decodeOrderingBlock(encodeOrderingBlock(killBlock));
    // The wire round-trip preserves the hostile field verbatim — a CBOR
    // integer decodes back to a number, not to bytes.
    expect(typeof decoded.subBlockTree.pruneEntries[0]!.subtreeMerkleRoot).toBe('number');

    expect(() => blockApply.applyOrderingBlock(decoded)).not.toThrow();
    expect(blockApply.applyOrderingBlock(decoded)).toBe(false);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(1);
  });

  it('accepts a well-formed block over the same sync path (control)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const { postId, author } = await confirmedPost();
    const blockApply = await importBlockApply();

    const block = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(postId, [postId], author)],
    });
    const decoded = decodeOrderingBlock(encodeOrderingBlock(block));
    expect(blockApply.applyOrderingBlock(decoded)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Totality backstop — an unexpected throw is a rejection, not a crash
  // -----------------------------------------------------------------------

  it('returns false and rolls back when apply throws for a reason no check anticipated', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // A failure from the last step of apply, past every consensus check and
    // past every state mutation the block makes: the block row is written and
    // the coinbase is minted before this runs. Nothing about the block is
    // malformed — this stands in for the class of defect structure validation
    // cannot enumerate in advance.
    vi.doMock('../../src/store/journal.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/store/journal.js')>(
        '../../src/store/journal.js',
      );
      return {
        ...actual,
        insertBlockJournal: () => {
          throw new Error('disk on fire');
        },
      };
    });

    const blockApply = await importBlockApply();
    const block = await makeApplicableBlock();

    expect(() => blockApply.applyOrderingBlock(block)).not.toThrow();
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    // Rolled back whole — including the mutations that had already landed
    // inside the transaction before the throw.
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);

    const { getCreditBoxes } = (await import('../../src/store/utxo.js')) as {
      getCreditBoxes: (owner: Uint8Array) => unknown[];
    };
    expect(getCreditBoxes(block.utxoTxTree.coinbaseOutputs[0]!.owner)).toHaveLength(0);

    // The half-built journal is dropped, so the next block does not inherit it.
    const journalStore = await importJournalStore();
    expect(journalStore.isBlockJournalOpen()).toBe(false);
  });

  it('applies the same block with no stub in place (control)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const blockApply = await importBlockApply();
    const block = await makeApplicableBlock();
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(1);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).not.toBeNull();

    const { getCreditBoxes } = (await import('../../src/store/utxo.js')) as {
      getCreditBoxes: (owner: Uint8Array) => unknown[];
    };
    expect(getCreditBoxes(block.utxoTxTree.coinbaseOutputs[0]!.owner)).toHaveLength(1);
  });
});

