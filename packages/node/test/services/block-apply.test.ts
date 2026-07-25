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
  SubBlock,
  LikeBox,
  KarmaBox,
  OrderingBlock,
  UtxoTransaction,
  BlockJournal,
  DecayJournalEntry,
} from '@dagsocial/types';
import type Database from 'better-sqlite3';

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
      subBlock: SubBlock,
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
      subblockCbor: Uint8Array | null;
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

function makeLikeTx(
  karmaBox: KarmaBox,
  targetPostId: string,
): UtxoTransaction {
  return {
    inputs: [karmaBox.id!],
    outputs: [
      {
        boxType: 'like',
        value: LIKE_COST,
        createdAtBlock: 0,
        likerId: karmaBox.owner,
        targetPostId,
        guard: 'epoch_tally',
      } as LikeBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
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
  // 2. Post confirm records confirmedSubBlockIds and subBlockCbors
  // -----------------------------------------------------------------------

  it('post confirm records confirmedSubBlockIds and subBlockCbors in journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const post = makePost(author.userId, 'journal test post');
    const postId = computePostId(post);
    const { encodePost } = await import('@dagsocial/types');

    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const subBlock: SubBlock = {
      subBlockId: postId,
      post,
      likeBoxes: [],
      producerId: author.userId,
      protocolVersion: PROTOCOL_VERSION,
    };
    const mempool = await importMempoolFresh();
    mempool.insertSubBlock(subBlock, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock();

    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).not.toBeNull();
    expect(saved!.confirmedSubBlockIds).toContain(postId);
    expect(saved!.subBlockCbors.length).toBe(1);
    expect(saved!.subBlockCbors[0]!.subBlockId).toBe(postId);
    expect(saved!.subBlockCbors[0]!.cbor).toBeInstanceOf(Uint8Array);
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

    // Insert sub-block for the post
    const mempool = await importMempoolFresh();
    const sb: SubBlock = {
      subBlockId: postId,
      post,
      likeBoxes: [],
      producerId: author.userId,
      protocolVersion: PROTOCOL_VERSION,
    };
    mempool.insertSubBlock(sb, 1000);

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
      mempool.insertSubBlock({
        subBlockId: dpId,
        post: dp,
        likeBoxes: [],
        producerId: author.userId,
        protocolVersion: PROTOCOL_VERSION,
      }, 1000);
      bc.createOrderingBlock();
    }

    // Epoch block (height 3)
    const dp = makePost(author.userId, 'epoch trigger');
    const dpId = computePostId(dp);
    posts.insertPost(dp, encodePost(dp));
    mempool.insertSubBlock({
      subBlockId: dpId,
      post: dp,
      likeBoxes: [],
      producerId: author.userId,
      protocolVersion: PROTOCOL_VERSION,
    }, 1000);

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

    // Insert sub-block
    const sb: SubBlock = {
      subBlockId: postId,
      post,
      likeBoxes: [],
      producerId: author.userId,
      protocolVersion: PROTOCOL_VERSION,
    };
    mempool.insertSubBlock(sb, 1000);

    // Insert a standalone UTXO transaction in mempool
    const karmaBox = makeKarmaBox(100, author.userId, 0);
    utxo.insertBox(karmaBox);
    const likeTx = makeLikeTx(karmaBox, 'unrelated_post_id');
    mempool.insertUtxoTx(likeTx, null, 1000);

    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock();

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
      subBlockTree: { subBlockRefs: [], stumpIds: [] },
      utxoTxTree: {
        utxoTxIds: [],
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
      subBlockTree: { subBlockRefs: [], stumpIds: [] },
      utxoTxTree: {
        utxoTxIds: [],
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
      subBlockTree: { subBlockRefs: [], stumpIds: [] },
      utxoTxTree: {
        utxoTxIds: [],
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

    // Genesis with coinbase output but no value (coinbase should be > 0)
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
        powTargetBits: 4,
        createdAt: Date.now(),
      },
      subBlockTree: { subBlockRefs: [], stumpIds: [] },
      utxoTxTree: {
        utxoTxIds: [],
        likeBoxIds: [],
        coinbaseOutputs: [
          { value: 0, owner: new Uint8Array(32), lockedUntilBlock: null },
        ], // zero coinbase when reward should be 100
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
