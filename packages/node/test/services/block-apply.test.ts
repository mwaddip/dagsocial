import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  computeBoxId,
  computePostId,
  encodePost,
  encodeOrderingBlock,
  decodeOrderingBlock,
  PROTOCOL_VERSION,
  LIKE_COST,
  LIKE_THRESHOLD,
  LIKE_MAX_AUTHOR_REWARD,
  KARMA_STALE_THRESHOLD_BLOCKS,
  CREDIT_MINER_REWARD_DELAY,
  EMPTY_STATE_ROOT,
} from '@dagsocial/types';
import { verifyOrderingBlockPoW, blockHash } from '@dagsocial/validation';
import type {
  Post,
  LikeBox,
  KarmaBox,
  PostLockBox,
  BlockHeader,
  OrderingBlock,
  SubBlockEntry,
  PruneEntry,
  UtxoTransaction,
  EpochTally,
  LikeReward,
} from '@dagsocial/types';
import type { BlockJournal } from '../../src/store/journal.js';
import type { DecayJournalEntry } from '../../src/services/decay.js';
import type Database from 'better-sqlite3';
import {
  signTransaction,
  makeTestIdentity,
  makePost,
  makeLikeBox,
  makeKarmaBox,
  makeLikeTx,
  changeBoxOf,
  solveHeaderPow,
  signHeader,
  makeApplicableBlock,
  makePruneEntry,
  hex,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// Test config (small epoch for boundary testing)
// ---------------------------------------------------------------------------

const testConfig = {
  port: 3000,
  dbPath: ':memory:',
  networkMode: 'testnet' as const,
  nodeRole: 'miner' as const,
  postPowTargetBits: 20,
  challengeWindowBlocks: 10,
  orderingBlockIntervalMs: 60000,
  orderingBlockMinSubBlocks: 1,
  maxSubBlocksPerBlock: 1000,
  epochBlocks: 2, // Trigger epoch every 2 blocks for easy testing
  miningMode: 'internal' as const,
  orderingBlockPowTargetBits: 12,
  creditInitialReward: 100,
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
  getDb: () => Database;
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
    getBox: (boxId: string) => unknown;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
    getUnprocessedLockedLikeBoxes: () => LikeBox[];
  };
}

async function importLikes() {
  return (await import('../../src/store/likes.js')) as {
    insertLike: (targetPostId: string, likerId: Uint8Array) => string;
    getUnprocessedFreeLikes: () => Array<{
      id: string;
      targetPostId: string;
      likerId: Uint8Array;
    }>;
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

/** boxIds of 'remove' mutations, in application order. */
function removedIds(journal: BlockJournal): string[] {
  return journal.mutations.filter((m) => m.op === 'remove').map((m) => m.boxId);
}

/** boxIds of 'insert' mutations, in application order. */
function insertedIds(journal: BlockJournal): string[] {
  return journal.mutations.filter((m) => m.op === 'insert').map((m) => m.boxId);
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
    const creditInserts = saved!.mutations.filter(
      (m) => m.op === 'insert' && m.box!.boxType === 'credit',
    );
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
  // 3. Epoch like tally records the spent like boxes as removes (H-5)
  // -----------------------------------------------------------------------

  it('epoch like tally records tallied like boxes as removes (H-5)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const { encodePost } = await import('@dagsocial/types');
    const utxo = await importUtxo();

    // Create a post
    const post = makePost(author.userId, 'like journal test');
    const postId = computePostId(post);
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    // Enough locked likes that the epoch tally spends them
    // (talliedLockedLikeBoxIds requires ≥ 2×LIKE_THRESHOLD likes on the post)
    const likeBoxes: LikeBox[] = [];
    for (let i = 0; i < 2 * LIKE_THRESHOLD; i++) {
      const liker = makeTestIdentity();
      utxo.insertBox(makeKarmaBox(10n, liker.publicKey, 0));
      const likeBox = makeLikeBox(liker.userId, postId, 0);
      utxo.insertBox(likeBox);
      likeBoxes.push(likeBox);
    }

    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig); // epochBlocks = 2

    // Fast-forward 2 blocks; the block after height 2 carries the tally
    for (let i = 0; i < 2; i++) {
      const dp = makePost(author.userId, `ff ${i}`);
      const dpId = computePostId(dp);
      posts.insertPost(dp, encodePost(dp));
      mempool.insertSubBlock(dpId, 1000);
      bc.createOrderingBlock();
    }
    const dp = makePost(author.userId, 'epoch trigger');
    const dpId = computePostId(dp);
    posts.insertPost(dp, encodePost(dp));
    mempool.insertSubBlock(dpId, 1000);
    bc.createOrderingBlock();

    // The old journal copied the block header's likeBoxIds list; the actual
    // spend performed by markLikeBoxesTallied was invisible to the AVL feed
    // (H-5). The record-once journal carries each tallied box as a remove.
    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(3);
    expect(saved).not.toBeNull();
    const removed = removedIds(saved!);
    for (const likeBox of likeBoxes) {
      expect(removed).toContain(likeBox.id);
      expect(utxo.getBox(likeBox.id!)).toBeNull(); // really spent in the DB
    }
  });

  // -----------------------------------------------------------------------
  // 4. Epoch tally mint journals the merge-consumed originals + merged box
  // -----------------------------------------------------------------------

  it('epoch tally mint journals the merge-consumed karma originals', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const { encodePost } = await import('@dagsocial/types');
    const utxo = await importUtxo();

    // Give author some initial karma — the epoch mint will merge it in
    const authorStartBox = makeKarmaBox(100n, author.publicKey, 0);
    utxo.insertBox(authorStartBox);

    // Create target post
    const post = makePost(author.userId, 'epoch journal test');
    const postId = computePostId(post);
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    // Create 6 locked likes (enough for 1 author reward: floor(6/5)=1)
    for (let i = 0; i < 6; i++) {
      const liker = makeTestIdentity();
      utxo.insertBox(makeKarmaBox(10n, liker.publicKey, 0));
      const likeBox = makeLikeBox(liker.userId, postId, 0);
      utxo.insertBox(likeBox);
    }

    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig); // epochBlocks = 2

    // Fast-forward 2 blocks to trigger epoch on block 3
    for (let i = 0; i < 2; i++) {
      const dp = makePost(author.userId, `ff ${i}`);
      const dpId = computePostId(dp);
      posts.insertPost(dp, encodePost(dp));
      mempool.insertSubBlock(dpId, 1000);
      bc.createOrderingBlock();
    }

    // Epoch block (height 3)
    const dp = makePost(author.userId, 'epoch trigger');
    const dpId = computePostId(dp);
    posts.insertPost(dp, encodePost(dp));
    mempool.insertSubBlock(dpId, 1000);

    bc.createOrderingBlock();

    // Verify journal at height 3 (epoch block). The mint consumed the
    // author's pre-existing box and created one merged box — BOTH sides must
    // be in the journal: the old shape recorded only the new box, so revert
    // deleted it without un-consuming the originals (value-loss on reorg).
    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(3);
    expect(saved).not.toBeNull();

    expect(removedIds(saved!)).toContain(authorStartBox.id);

    const authorInserts = saved!.mutations.filter(
      (m) =>
        m.op === 'insert' &&
        m.box!.boxType === 'karma' &&
        Buffer.from((m.box as KarmaBox).owner).equals(Buffer.from(author.userId)),
    );
    expect(authorInserts.length).toBe(1);
    // Merged value: the 100n original plus the epoch author reward
    expect((authorInserts[0]!.box as KarmaBox).value).toBeGreaterThan(100n);

    // The merged box is what the store now holds, at the journal's value
    const held = utxo.getKarmaBox(author.userId);
    expect(held).not.toBeNull();
    expect(held!.id).toBe(authorInserts[0]!.boxId);
    expect(held!.value).toBe((authorInserts[0]!.box as KarmaBox).value);
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

    // Insert a standalone UTXO transaction in mempool
    const karmaBox = makeKarmaBox(100n, author.userId, 0);
    utxo.insertBox(karmaBox);
    const likeTx = makeLikeTx(author, karmaBox, 'unrelated_post_id');
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
    // outputs (change karma + like box) created
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
        likeBoxIds: [],
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
        likeBoxIds: [],
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
        likeBoxIds: [],
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
      likeBoxIds: [],
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

    // Create an identity with a karma box at block 0 (ancient)
    const identity = makeTestIdentity();
    const oldBox = makeKarmaBox(100n, identity.userId, 0);
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

    const deps = {
      getKarmaBoxes: (owner: Uint8Array) => {
        const box = utxo.getKarmaBox(owner);
        return box ? [box] : [];
      },
      consumeBox: (boxId: string, height: number) =>
        utxo.consumeBox(boxId, height),
      insertBox: (box: KarmaBox) => utxo.insertBox(box),
      getKarmaOwners: () => [identity.userId],
    };

    const staleHeight = KARMA_STALE_THRESHOLD_BLOCKS + 100;
    const entries: DecayJournalEntry[] = applyKarmaDecay(deps, staleHeight, decayCfg);

    // owedPeriods = floor((staleHeight - 0) / 720) = 28
    // maxBurn = min(28 * 5, 100 - 10) = min(140, 90) = 90
    const owed = BigInt(Math.floor(staleHeight / 720)) * KARMA_DECAY_AMOUNT;
    const maxBurn = 100n - 10n;
    const expectedBurn = owed < maxBurn ? owed : maxBurn;

    expect(entries.length).toBe(1);
    expect(entries[0]!.owner).toEqual(identity.userId);
    expect(entries[0]!.burnAmount).toBe(expectedBurn);
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
    expect(karmaBox!.value).toBe(100n - expectedBurn);
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
    const voucherInserts = saved.mutations.filter(
      (m) =>
        m.op === 'insert' &&
        m.box!.boxType === 'karma' &&
        Buffer.from((m.box as KarmaBox).owner).equals(Buffer.from(voucher.userId)),
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

    // Well-formed, conserving, spending a box that really exists. The only
    // thing it lacks is the victim's authorisation.
    const forged = makeLikeTx(victim, victimBox, 'target_post');
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

    // Correctly signed by the owner and a legal karma → karma + like shape,
    // but the outputs total 102 against a 100 karma input: the change box
    // keeps the full balance and the LikeBox is conjured out of nothing.
    const inflating: UtxoTransaction = {
      inputs: [attackerBox.id!],
      outputs: [
        {
          boxType: 'karma',
          value: 100n,
          createdAtBlock: 0,
          owner: attacker.userId,
          guard: 'owner_signature',
          proofSource: 'like_op',
          lastTouchBlock: 0,
        } as KarmaBox,
        {
          boxType: 'like',
          value: LIKE_COST,
          createdAtBlock: 0,
          likerId: attacker.userId,
          targetPostId: 'target_post',
          guard: 'epoch_tally',
        } as LikeBox,
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
    const mempool = await importMempoolFresh();
    const { computeTxId } = await import('@dagsocial/types');

    const alice = makeTestIdentity();
    const bob = makeTestIdentity();
    const aliceBox = makeKarmaBox(100n, alice.userId, 0);
    const bobBox = makeKarmaBox(40n, bob.userId, 0);
    utxo.insertBox(aliceBox);
    utxo.insertBox(bobBox);

    const aliceTx = makeLikeTx(alice, aliceBox, 'post_a');
    const bobTx = makeLikeTx(bob, bobBox, 'post_b');
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
      100n - LIKE_COST,
    );
    expect((utxo.getBox(changeBoxOf(bobTx).id!) as KarmaBox).value).toBe(
      40n - LIKE_COST,
    );
  });

  it('still defers and retries a tx that consumes a box created in the same block', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();
    const { computeTxId } = await import('@dagsocial/types');

    const liker = makeTestIdentity();
    const startBox = makeKarmaBox(100n, liker.userId, 0);
    utxo.insertBox(startBox);

    const txA = makeLikeTx(liker, startBox, 'post_a');
    const txB = makeLikeTx(liker, changeBoxOf(txA), 'post_b');

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

    // 100 → 98 → 96, with both intermediate boxes spent.
    expect(utxo.getBox(startBox.id!)).toBeNull();
    expect(utxo.getBox(changeBoxOf(txA).id!)).toBeNull();
    const finalBox = utxo.getBox(changeBoxOf(txB).id!) as KarmaBox | null;
    expect(finalBox).not.toBeNull();
    expect(finalBox!.value).toBe(100n - 2n * LIKE_COST);
  });
});

// ---------------------------------------------------------------------------
// Epoch tally acceptance across differing row orders (audit C-6)
// ---------------------------------------------------------------------------

describe('block-apply epoch tally ordering', () => {
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
   * The same logical tally as held by a node that received every like in the
   * opposite order: each map rebuilt in reverse key order, each array
   * reversed. Nothing about the reward set changes — only the order the rows
   * came out of that node's database in.
   */
  function reverseTallyOrder(tally: EpochTally): EpochTally {
    const rewards: Record<string, LikeReward> = {};
    for (const postId of Object.keys(tally.rewards).reverse()) {
      const reward = tally.rewards[postId]!;
      const likerRefunds: Record<string, bigint> = {};
      for (const likerId of Object.keys(reward.likerRefunds).reverse()) {
        likerRefunds[likerId] = reward.likerRefunds[likerId]!;
      }
      rewards[postId] = { ...reward, likerRefunds };
    }
    return {
      ...tally,
      rewards,
      talliedLockedLikeBoxIds: [...tally.talliedLockedLikeBoxIds].reverse(),
      processedFreeLikeIds: [...tally.processedFreeLikeIds].reverse(),
      consumedPostLockBoxIds: [...tally.consumedPostLockBoxIds].reverse(),
      newPostLockBoxes: [...tally.newPostLockBoxes].reverse(),
    };
  }

  /**
   * A peer's epoch block: built from the peer's own tally ordering, with its
   * own Merkle root over that ordering — exactly what arrives over gossip from
   * an honest second miner whose like rows sit in a different order.
   */
  it('accepts a peer epoch block whose tally was assembled in a different order', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const posts = await importPosts();
    const utxo = await importUtxo();
    const { encodePost } = await import('@dagsocial/types');

    // Three posts with different like counts, so the tally carries three
    // reward entries and the busiest one clears the refund threshold
    // (2 × LIKE_THRESHOLD) and so has a populated likerRefunds map.
    const author = makeTestIdentity();
    const likeCounts = [2 * LIKE_THRESHOLD, LIKE_THRESHOLD + 1, 2];
    for (let i = 0; i < likeCounts.length; i++) {
      const post = makePost(author.userId, `epoch ordering post ${i}`);
      const postId = computePostId(post);
      posts.insertPost(post, encodePost(post));
      for (let n = 0; n < likeCounts[i]!; n++) {
        utxo.insertBox(makeLikeBox(makeTestIdentity().userId, postId, 1));
      }
    }

    // Two ordinary blocks; with epochBlocks = 2 the next one carries the tally.
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock();
    bc.createOrderingBlock();

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);

    const { computeEpochTally, computeSubBlockRoot, computeUtxoTxRoot, computeBlockReward } =
      await import('../../src/services/block-creator.js');

    const height = 3;
    const localTally = computeEpochTally(height);
    expect(Object.keys(localTally.rewards).length).toBe(3);
    // Exactly the busiest post cleared the refund threshold. Which key that is
    // depends on box ids, so assert over the set rather than a position.
    const withRefunds = Object.values(localTally.rewards).filter(
      (reward) => Object.keys(reward.likerRefunds).length > 0,
    );
    expect(withRefunds.length).toBe(1);
    expect(Object.keys(withRefunds[0]!.likerRefunds).length).toBe(2 * LIKE_THRESHOLD);

    const peerTally = reverseTallyOrder(localTally);

    // Vacuity guard: under the insertion-order `JSON.stringify` this check used
    // to use, these two tallies are different strings — so the acceptance below
    // is not passing for want of a difference between them. (Bigint-safe
    // replacer: reward amounts don't survive a plain JSON.stringify.)
    const naiveJson = (v: unknown): string =>
      JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
    expect(naiveJson(peerTally.rewards)).not.toBe(naiveJson(localTally.rewards));

    const subBlockTree = { subBlockRefs: [], subBlockEntries: [], pruneEntries: [] };
    const miner = makeTestIdentity();
    const utxoTxTree = {
      utxoTxIds: [],
      utxoTxs: [],
      likeBoxIds: [],
      coinbaseOutputs: [
        {
          owner: miner.userId,
          value: computeBlockReward(height),
          lockedUntilBlock: height + CREDIT_MINER_REWARD_DELAY,
          isTreasury: false,
        },
      ],
      epochTallyResults: peerTally,
    };

    const { expectedTarget } = await import('../../src/services/difficulty.js');
    const peerHeader = {
      protocolVersion: PROTOCOL_VERSION,
      height,
      prevBlockHash: blockHash(ordering.getOrderingBlock(2)!.header),
      subBlockRoot: computeSubBlockRoot(subBlockTree),
      utxoTxRoot: computeUtxoTxRoot(utxoTxTree),
      stateRoot: '0000000000000000000000000000000000000000000000000000000000000000',
      validatorId: miner.userId,
      powNonce: 0,
      // Mined at the scheduled target: PoW is not what is under test, but a
      // block off the difficulty schedule no longer reaches the tally check.
      powTargetBits: expectedTarget(height),
      createdAt: Date.now(),
    } as BlockHeader;
    peerHeader.powNonce = solveHeaderPow(peerHeader);

    const peerBlock = {
      header: peerHeader,
      subBlockTree,
      utxoTxTree,
      validatorSignature: signHeader(peerHeader, miner.privateKey),
    } as unknown as OrderingBlock;

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(peerBlock)).toBe(true);
    expect(ordering.getCurrentHeight()).toBe(3);
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
    // 720-block maturity delay. The value is correct, so the emission check
    // above waves it through.
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

