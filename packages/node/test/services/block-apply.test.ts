import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  generateKeyPairSync,
  createHash,
  type KeyObject,
} from 'crypto';
import {
  computeBoxId,
  computePostId,
  PROTOCOL_VERSION,
  LIKE_COST,
  LIKE_THRESHOLD,
  LIKE_MAX_AUTHOR_REWARD,
  KARMA_STALE_THRESHOLD_BLOCKS,
} from '@dagsocial/types';
import type {
  Post,
  LikeBox,
  KarmaBox,
  OrderingBlock,
  UtxoTransaction,
  BlockJournal,
  DecayJournalEntry,
} from '@dagsocial/types';
import type Database from 'better-sqlite3';
import { signTransaction } from '../helpers.js';

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
    getCurrentJournal: () => BlockJournal | null;
  };
}

async function importJournalStore() {
  return (await import('../../src/store/journal.js')) as {
    getBlockJournal: (height: number) => BlockJournal | null;
    insertBlockJournal: (journal: BlockJournal) => void;
    deleteBlockJournal: (height: number) => void;
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => OrderingBlock | null;
    deleteOrderingBlock: (height: number) => void;
  };
}

// ---------------------------------------------------------------------------
// Ed25519 helpers
// ---------------------------------------------------------------------------

function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

interface TestIdentity {
  userId: Uint8Array;
  publicKey: Uint8Array;
  privateKey: KeyObject;
}

function makeTestIdentity(): TestIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubKey = rawPublicKey(publicKey);
  const userId = pubKey;
  return { userId, publicKey: pubKey, privateKey };
}

function makePost(authorId: Uint8Array, content = 'test post'): Post {
  return {
    content,
    author: authorId,
    parentRefs: [],
    challenge: new Uint8Array(32),
    powNonce: 0,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: Date.now(),
    signature: new Uint8Array(64),
  };
}

function makeLikeBox(
  likerId: Uint8Array,
  targetPostId: string,
  createdAtBlock: number,
): LikeBox {
  const box: LikeBox = {
    boxType: 'like',
    value: 2,
    createdAtBlock,
    likerId,
    targetPostId,
    guard: 'epoch_tally',
  };
  const id = computeBoxId(box);
  box.id = id;
  return box;
}

function makeKarmaBox(
  value: number,
  owner: Uint8Array,
  createdAtBlock: number,
): KarmaBox {
  const box: KarmaBox = {
    boxType: 'karma',
    value,
    createdAtBlock,
    owner,
    guard: 'owner_signature',
    proofSource: 'genesis',
    lastTouchBlock: createdAtBlock,
  };
  const id = computeBoxId(box);
  box.id = id;
  return box;
}

/**
 * Build a signed, value-conserving like transaction — the shape a real client
 * submits: the liker's karma box is consumed and split into a karma change box
 * and the LikeBox.
 *
 * Block application re-validates every embedded tx in full, so a fixture that
 * omitted the signature or the change output would be indistinguishable from a
 * forgery and would take the whole block down with it.
 */
function makeLikeTx(
  liker: TestIdentity,
  karmaBox: KarmaBox,
  targetPostId: string,
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!],
    outputs: [
      {
        boxType: 'karma',
        value: karmaBox.value - LIKE_COST,
        createdAtBlock: 0,
        owner: liker.userId,
        guard: 'owner_signature',
        proofSource: 'like_op',
        lastTouchBlock: 0,
      } as KarmaBox,
      {
        boxType: 'like',
        value: LIKE_COST,
        createdAtBlock: 0,
        likerId: liker.userId,
        targetPostId,
        guard: 'epoch_tally',
      } as LikeBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, liker.privateKey, Buffer.from(liker.userId).toString('hex'));
  return tx;
}

/** The karma change box a `makeLikeTx` output creates, with its stored id. */
function changeBoxOf(tx: UtxoTransaction): KarmaBox {
  const change = tx.outputs[0] as KarmaBox;
  return { ...change, id: computeBoxId(change) };
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
  // 1. Coinbase mint records creditBoxIds in journal
  // -----------------------------------------------------------------------

  it('coinbase mint records creditBoxIds in journal', async () => {
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
    expect(saved!.creditBoxIds.length).toBeGreaterThan(0);

    // Each coinbase output should produce one credit box ID
    expect(saved!.creditBoxIds.length).toBe(
      block!.utxoTxTree.coinbaseOutputs.length,
    );
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
  // 3. Like tally records talliedLikeBoxIds in journal
  // -----------------------------------------------------------------------

  it('like tally records talliedLikeBoxIds in journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const { encodePost } = await import('@dagsocial/types');
    const utxo = await importUtxo();

    // Give author karma
    utxo.insertBox(makeKarmaBox(100, author.publicKey, 0));

    // Create a post
    const post = makePost(author.userId, 'like journal test');
    const postId = computePostId(post);
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    // Create a standalone like box (not attached to sub-block)
    const liker = makeTestIdentity();
    utxo.insertBox(makeKarmaBox(10, liker.publicKey, 0));
    const likeBox = makeLikeBox(liker.userId, postId, 0);
    utxo.insertBox(likeBox);

    // Insert sub-block ID for the post
    const mempool = await importMempoolFresh();
    mempool.insertSubBlock(postId, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock();

    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).not.toBeNull();
    expect(saved!.talliedLikeBoxIds.length).toBeGreaterThan(0);
    // The standalone like box should be tallied
    expect(saved!.talliedLikeBoxIds).toContain(likeBox.id);
  });

  // -----------------------------------------------------------------------
  // 4. Epoch tally karma mints records karmaMints in journal
  // -----------------------------------------------------------------------

  it('epoch tally records karmaMints in journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const { encodePost } = await import('@dagsocial/types');
    const utxo = await importUtxo();

    // Give author some initial karma
    utxo.insertBox(makeKarmaBox(100, author.publicKey, 0));

    // Create target post
    const post = makePost(author.userId, 'epoch journal test');
    const postId = computePostId(post);
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    // Create 6 locked likes (enough for 1 author reward: floor(6/5)=1)
    for (let i = 0; i < 6; i++) {
      const liker = makeTestIdentity();
      utxo.insertBox(makeKarmaBox(10, liker.publicKey, 0));
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

    // Verify journal at height 3 (epoch block)
    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(3);
    expect(saved).not.toBeNull();
    expect(saved!.karmaMints.length).toBeGreaterThan(0);

    // At least one author reward karma mint for the post
    const authorMints = saved!.karmaMints.filter(
      (m) => Buffer.from(m.userId).equals(Buffer.from(author.userId)),
    );
    expect(authorMints.length).toBeGreaterThan(0);
    expect(authorMints.reduce((sum, m) => sum + m.amount, 0)).toBeGreaterThan(0);
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
    const karmaBox = makeKarmaBox(100, author.userId, 0);
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

    const applied = saved!.appliedUtxoTxs[0]!;
    expect(applied.txId).toBe(computeTxId(likeTx));
    expect(applied.inputBoxIds).toEqual(likeTx.inputs);
    expect(applied.outputBoxIds.length).toBeGreaterThan(0);
    expect(applied.txCbor).toBeInstanceOf(Uint8Array);
  });

  // -----------------------------------------------------------------------
  // 6. Rejected block leaves NO journal — invalid PoW at genesis
  // -----------------------------------------------------------------------

  it('block rejected for invalid PoW leaves no journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const blockApply = await importBlockApply();

    // Construct a block that passes genesis check but fails PoW
    const block: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: 1,
        prevBlockHash: '0000000000000000000000000000000000000000000000000000000000000000',
        subBlockRoot: '0000000000000000000000000000000000000000000000000000000000000000',
        utxoTxRoot: '0000000000000000000000000000000000000000000000000000000000000000',
        stateRoot: '0000000000000000000000000000000000000000000000000000000000000000000',
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 20, // High difficulty — nonce 0 will not satisfy
        createdAt: Date.now(),
      },
      subBlockTree: { subBlockRefs: [], subBlockEntries: [], stumpIds: [] },
      utxoTxTree: {
        utxoTxIds: [],
        utxoTxs: [],
        likeBoxIds: [],
        coinbaseOutputs: [],
      },
      validatorSignature: new Uint8Array(64),
    };

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

    const block: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: 99, // Genesis must have height 1
        prevBlockHash: '0000000000000000000000000000000000000000000000000000000000000000',
        subBlockRoot: '0000000000000000000000000000000000000000000000000000000000000000',
        utxoTxRoot: '0000000000000000000000000000000000000000000000000000000000000000',
        stateRoot: '0000000000000000000000000000000000000000000000000000000000000000000',
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 4,
        createdAt: Date.now(),
      },
      subBlockTree: { subBlockRefs: [], subBlockEntries: [], stumpIds: [] },
      utxoTxTree: {
        utxoTxIds: [],
        utxoTxs: [],
        likeBoxIds: [],
        coinbaseOutputs: [],
      },
      validatorSignature: new Uint8Array(64),
    };

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

    const block: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: 1,
        prevBlockHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        subBlockRoot: '0000000000000000000000000000000000000000000000000000000000000000',
        utxoTxRoot: '0000000000000000000000000000000000000000000000000000000000000000',
        stateRoot: '0000000000000000000000000000000000000000000000000000000000000000000',
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 4,
        createdAt: Date.now(),
      },
      subBlockTree: { subBlockRefs: [], subBlockEntries: [], stumpIds: [] },
      utxoTxTree: {
        utxoTxIds: [],
        utxoTxs: [],
        likeBoxIds: [],
        coinbaseOutputs: [],
      },
      validatorSignature: new Uint8Array(64),
    };

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
    // check on every run: powTargetBits 0 satisfies PoW unconditionally and
    // the Merkle roots are computed rather than zeroed. With a non-zero target
    // over a Date.now() header it was a coin flip whether PoW or the Merkle
    // root did the rejecting, and the coinbase check went untested.
    const { computeSubBlockRoot, computeUtxoTxRoot } = await import(
      '../../src/services/block-creator.js'
    );
    const subBlockTree = {
      subBlockRefs: [],
      subBlockEntries: [],
      pruneEntries: [],
    };
    const utxoTxTree = {
      utxoTxIds: [],
      utxoTxs: [],
      likeBoxIds: [],
      coinbaseOutputs: [
        { value: 0, owner: new Uint8Array(32), lockedUntilBlock: null },
      ],
    };
    const block = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: 1,
        prevBlockHash: '0000000000000000000000000000000000000000000000000000000000000000',
        subBlockRoot: computeSubBlockRoot(subBlockTree),
        utxoTxRoot: computeUtxoTxRoot(utxoTxTree),
        stateRoot: '0000000000000000000000000000000000000000000000000000000000000000',
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 0,
        createdAt: Date.now(),
      },
      subBlockTree,
      utxoTxTree,
      validatorSignature: new Uint8Array(64),
    } as unknown as OrderingBlock;

    const result = blockApply.applyOrderingBlock(block);
    expect(result).toBe(false);

    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 10. Successful block clears journal module state after persistence
  // -----------------------------------------------------------------------

  it('getCurrentJournal returns null after successful block application', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock();

    const blockApply = await importBlockApply();
    // Journal module state should be cleared after successful apply
    expect(blockApply.getCurrentJournal()).toBeNull();
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
    const oldBox = makeKarmaBox(100, identity.userId, 0);
    utxo.insertBox(oldBox);

    // Import decay module directly — applyOrderingBlock delegates to it,
    // and we can't build 20,000+ blocks in a test. The journal entries
    // returned by applyKarmaDecay are exactly what get pushed into
    // currentJournal.decayBurns.
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
    const expectedBurn = Math.min(
      Math.floor(staleHeight / 720) * KARMA_DECAY_AMOUNT,
      100 - 10,
    );

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
    expect(karmaBox!.value).toBe(100 - expectedBurn);
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
    const victimBox = makeKarmaBox(100, victim.userId, 0);
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
    expect(survivor!.value).toBe(100);
  });

  it('rejects the whole block when an embedded tx mints value', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();

    const attacker = makeTestIdentity();
    const attackerBox = makeKarmaBox(100, attacker.userId, 0);
    utxo.insertBox(attackerBox);

    // Correctly signed by the owner and a legal karma → karma + like shape,
    // but the outputs total 102 against a 100 karma input: the change box
    // keeps the full balance and the LikeBox is conjured out of nothing.
    const inflating: UtxoTransaction = {
      inputs: [attackerBox.id!],
      outputs: [
        {
          boxType: 'karma',
          value: 100,
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
    expect(survivor!.value).toBe(100);
  });

  it('applies a block whose embedded txs are all valid', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();
    const { computeTxId } = await import('@dagsocial/types');

    const alice = makeTestIdentity();
    const bob = makeTestIdentity();
    const aliceBox = makeKarmaBox(100, alice.userId, 0);
    const bobBox = makeKarmaBox(40, bob.userId, 0);
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
      100 - LIKE_COST,
    );
    expect((utxo.getBox(changeBoxOf(bobTx).id!) as KarmaBox).value).toBe(
      40 - LIKE_COST,
    );
  });

  it('still defers and retries a tx that consumes a box created in the same block', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();
    const { computeTxId } = await import('@dagsocial/types');

    const liker = makeTestIdentity();
    const startBox = makeKarmaBox(100, liker.userId, 0);
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
    expect(finalBox!.value).toBe(100 - 2 * LIKE_COST);
  });
});
