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
  PROTOCOL_VERSION,
  cumulativeWork,
} from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import type {
  Post,
  LikeBox,
  KarmaBox,
  OrderingBlock,
  UtxoTransaction,
  BlockHeader,
} from '@dagsocial/types';
import type { BlockJournal } from '../../src/store/journal.js';
import type Database from 'better-sqlite3';
import {
  makeTestIdentity,
  makePost,
  makeKarmaBox,
  makeLikeTx,
  makeApplicableBlock,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// Test config
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
  epochBlocks: 100, // High to avoid epoch triggers during simple tests
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
    getCreditBox: (owner: Uint8Array) => unknown;
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => OrderingBlock | null;
    deleteOrderingBlock: (height: number) => void;
  };
}

async function importJournalStore() {
  return (await import('../../src/store/journal.js')) as {
    getBlockJournal: (height: number) => BlockJournal | null;
    deleteBlockJournal: (height: number) => void;
    beginBlockJournal: (height: number) => void;
    abortBlockJournal: () => void;
  };
}

async function importForkResolution() {
  return (await import(
    '../../src/services/fork-resolution.js'
  )) as unknown as {
    extendsOurTip: (block: OrderingBlock) => boolean;
    findForkPoint: (
      ourTip: BlockHeader,
      theirHeaders: BlockHeader[],
    ) => number | null;
    revertBlock: (height: number) => void;
    reorg: (forkHeight: number, newBlocks: OrderingBlock[]) => void;
    MAX_REORG_DEPTH: number;
  };
}

// ---------------------------------------------------------------------------
// Tests — cumulativeWork
// ---------------------------------------------------------------------------

describe('cumulativeWork', () => {
  it('returns 0 for empty headers array', () => {
    expect(cumulativeWork([])).toBe(0n);
  });

  it('returns equal work for two headers with same target bits', () => {
    const h1: BlockHeader = {
      protocolVersion: PROTOCOL_VERSION,
      height: 1,
      prevBlockHash: '00'.repeat(32),
      subBlockRoot: '00'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits: 10,
      createdAt: 1000,
    };
    const h2: BlockHeader = {
      ...h1,
      height: 2,
      prevBlockHash: 'ff'.repeat(32),
      powTargetBits: 10,
    };
    expect(cumulativeWork([h1, h2])).toBe(2n * (1n << 10n));
  });

  it('doubles work per additional target bit', () => {
    const h1: BlockHeader = {
      protocolVersion: PROTOCOL_VERSION,
      height: 1,
      prevBlockHash: '00'.repeat(32),
      subBlockRoot: '00'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits: 5,
      createdAt: 1000,
    };
    const h2: BlockHeader = {
      ...h1,
      height: 2,
      prevBlockHash: 'ff'.repeat(32),
      powTargetBits: 6, // 2^6 = 2 * 2^5
    };
    // Work(h1) = 2^5 = 32, Work(h2) = 2^6 = 64
    expect(cumulativeWork([h1])).toBe(32n);
    expect(cumulativeWork([h1, h2])).toBe(96n);
  });

  it('higher cumulative work wins chain comparison', () => {
    // Chain A: 2 blocks at 5 bits each = 2 * 32 = 64
    const chainA = [
      {
        protocolVersion: PROTOCOL_VERSION, height: 1, prevBlockHash: '00'.repeat(32),
        subBlockRoot: '00'.repeat(32), utxoTxRoot: '00'.repeat(32), stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 5, createdAt: 1000,
      },
      {
        protocolVersion: PROTOCOL_VERSION, height: 2, prevBlockHash: 'ff'.repeat(32),
        subBlockRoot: '00'.repeat(32), utxoTxRoot: '00'.repeat(32), stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 5, createdAt: 2000,
      },
    ] as BlockHeader[];

    // Chain B: 1 block at 7 bits = 128
    const chainB = [
      {
        protocolVersion: PROTOCOL_VERSION, height: 1, prevBlockHash: '00'.repeat(32),
        subBlockRoot: '00'.repeat(32), utxoTxRoot: '00'.repeat(32), stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 7, createdAt: 1000,
      },
    ] as BlockHeader[];

    expect(cumulativeWork(chainB) > cumulativeWork(chainA)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — extendsOurTip
// ---------------------------------------------------------------------------

describe('extendsOurTip', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    vi.resetModules();
  });

  it('returns true when prevBlockHash matches our tip', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const post = makePost(author.userId, 'genesis');
    const postId = computePostId(post);
    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const mempool = await importMempoolFresh();
    mempool.insertSubBlock(postId, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block1 = bc.createOrderingBlock();
    expect(block1).not.toBeNull();

    // Create a second block that chains from block 1
    const post2 = makePost(author.userId, 'block 2');
    const postId2 = computePostId(post2);
    posts.insertPost(post2, encodePost(post2));
    mempool.insertSubBlock(postId2, 1000);

    const block2 = bc.createOrderingBlock();
    expect(block2).not.toBeNull();

    // block2's prevBlockHash should match block1's hash
    const forkResolution = await importForkResolution();
    // extendsOurTip checks if the BLOCK being received extends OUR tip
    // At this point, our tip is block2. But block2 was just created and applied.
    // To test the "true" case: a block with prevBlockHash matching our current tip
    const ordering = await importOrdering();
    const ourTip = ordering.getOrderingBlock(ordering.getCurrentHeight());
    expect(ourTip).not.toBeNull();

    // A hypothetical block that extends our tip
    const candidate: OrderingBlock = {
      ...block2!,
      header: {
        ...block2!.header,
        height: ourTip!.header.height + 1,
        prevBlockHash: blockHash(ourTip!.header),
      },
    };
    expect(forkResolution.extendsOurTip(candidate)).toBe(true);
  });

  it('returns false when prevBlockHash does not match our tip', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const post = makePost(author.userId, 'genesis');
    const postId = computePostId(post);
    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const mempool = await importMempoolFresh();
    mempool.insertSubBlock(postId, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock();

    // A candidate block with a random prevBlockHash
    const forkResolution = await importForkResolution();
    const candidate: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: 2,
        prevBlockHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        subBlockRoot: '00'.repeat(32),
        utxoTxRoot: '00'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 4,
        createdAt: Date.now(),
      },
      subBlockTree: { subBlockRefs: [], subBlockEntries: [], stumpIds: [] },
      utxoTxTree: { utxoTxIds: [], utxoTxs: [], likeBoxIds: [], coinbaseOutputs: [] },
      validatorSignature: new Uint8Array(64),
    };

    expect(forkResolution.extendsOurTip(candidate)).toBe(false);
  });

  it('returns false when no tip exists (empty chain)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const forkResolution = await importForkResolution();
    const candidate: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: 1,
        prevBlockHash: '00'.repeat(32),
        subBlockRoot: '00'.repeat(32),
        utxoTxRoot: '00'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 4,
        createdAt: Date.now(),
      },
      subBlockTree: { subBlockRefs: [], subBlockEntries: [], stumpIds: [] },
      utxoTxTree: { utxoTxIds: [], utxoTxs: [], likeBoxIds: [], coinbaseOutputs: [] },
      validatorSignature: new Uint8Array(64),
    };

    expect(forkResolution.extendsOurTip(candidate)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests — findForkPoint
// ---------------------------------------------------------------------------

describe('findForkPoint', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    vi.resetModules();
  });

  it('finds common ancestor between two chains', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build chain: block 1, block 2, block 3
    for (let i = 0; i < 3; i++) {
      const post = makePost(author.userId, `block ${i + 1}`);
      const postId = computePostId(post);
      posts.insertPost(post, encodePost(post));
      mempool.insertSubBlock(postId, 1000);
      bc.createOrderingBlock();
    }

    const ordering = await importOrdering();
    const ourTip = ordering.getOrderingBlock(3);
    expect(ourTip).not.toBeNull();

    // Construct theirHeaders: block 3 (fork) -> block 2 (same as ours) -> block 1 (same)
    // Their chain has same blocks 1 and 2 but a different block 3
    const block1 = ordering.getOrderingBlock(1);
    const block2 = ordering.getOrderingBlock(2);
    const forkBlock3: BlockHeader = {
      protocolVersion: PROTOCOL_VERSION,
      height: 3,
      prevBlockHash: blockHash(block2!.header), // chains from our block 2
      subBlockRoot: 'ff'.repeat(32), // different content
      utxoTxRoot: 'ff'.repeat(32),
      stateRoot: 'ff'.repeat(33),
      validatorId: new Uint8Array(32),
      powNonce: 999,
      powTargetBits: 4,
      createdAt: Date.now(),
    };

    const theirHeaders: BlockHeader[] = [
      forkBlock3,           // newest first (their tip)
      block2!.header,       // should match ours at height 2
    ];

    const forkResolution = await importForkResolution();
    const forkPoint = forkResolution.findForkPoint(ourTip!.header, theirHeaders);

    // Common ancestor should be at height 2 (block 2 matches both chains)
    expect(forkPoint).toBe(2);
  });

  it('returns null when no common ancestor found', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build chain: block 1 only
    const post = makePost(author.userId, 'genesis');
    const postId = computePostId(post);
    posts.insertPost(post, encodePost(post));
    mempool.insertSubBlock(postId, 1000);
    bc.createOrderingBlock();

    const ordering = await importOrdering();
    const ourTip = ordering.getOrderingBlock(1);
    expect(ourTip).not.toBeNull();

    // Their headers: completely different chain with no overlap
    const theirHeaders: BlockHeader[] = [
      {
        protocolVersion: PROTOCOL_VERSION,
        height: 5,
        prevBlockHash: 'ab'.repeat(32),
        subBlockRoot: '00'.repeat(32),
        utxoTxRoot: '00'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 4,
        createdAt: Date.now(),
      },
    ];

    const forkResolution = await importForkResolution();
    const forkPoint = forkResolution.findForkPoint(ourTip!.header, theirHeaders);
    expect(forkPoint).toBeNull();
  });

  it('returns null when depth exceeds MAX_REORG_DEPTH', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const forkResolution = await importForkResolution();

    // Build a deep chain (more than MAX_REORG_DEPTH) via block-creator
    const author = makeTestIdentity();
    const ids = await importIdentities();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const MAX_DEPTH = forkResolution.MAX_REORG_DEPTH;
    const chainLength = MAX_DEPTH + 5;

    for (let i = 0; i < chainLength; i++) {
      const post = makePost(author.userId, `deep ${i}`);
      const postId = computePostId(post);
      posts.insertPost(post, encodePost(post));
      mempool.insertSubBlock(postId, 1000);
      bc.createOrderingBlock();
    }

    const ordering = await importOrdering();
    const ourTip = ordering.getOrderingBlock(chainLength);
    expect(ourTip).not.toBeNull();

    // Their headers reference a block at height chainLength - MAX_DEPTH - 1
    // which is beyond MAX_REORG_DEPTH from our tip
    const deepBlock = ordering.getOrderingBlock(chainLength - MAX_DEPTH - 1);
    expect(deepBlock).not.toBeNull();

    const theirHeaders: BlockHeader[] = [
      {
        protocolVersion: PROTOCOL_VERSION,
        height: chainLength - MAX_DEPTH - 1 + 3,
        prevBlockHash: blockHash(deepBlock!.header),
        subBlockRoot: '00'.repeat(32),
        utxoTxRoot: '00'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 4,
        createdAt: Date.now(),
      },
      deepBlock!.header,
    ];

    const forkPoint = forkResolution.findForkPoint(ourTip!.header, theirHeaders);
    // The common ancestor (deepBlock) is beyond MAX_REORG_DEPTH from our tip
    expect(forkPoint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — revertBlock
// ---------------------------------------------------------------------------

describe('revertBlock', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    vi.resetModules();
  });

  it('reverts coinbase credits', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock(); // genesis with coinbase

    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).not.toBeNull();

    // Revert
    const forkResolution = await importForkResolution();
    forkResolution.revertBlock(1);

    // Block and journal deleted
    expect(ordering.getOrderingBlock(1)).toBeNull();
    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).toBeNull();
  });

  it('reverts post confirmations', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const post = makePost(author.userId, 'unconfirm me');
    const postId = computePostId(post);
    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const mempool = await importMempoolFresh();
    mempool.insertSubBlock(postId, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = bc.createOrderingBlock();
    expect(block).not.toBeNull();

    // Verify post was confirmed
    const postAfter = posts.getPost(postId);
    expect(postAfter).not.toBeNull();

    // Revert
    const forkResolution = await importForkResolution();
    forkResolution.revertBlock(1);

    // Block deleted
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
  });

  it('throws when no journal exists for height', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const forkResolution = await importForkResolution();
    expect(() => forkResolution.revertBlock(99)).toThrow(
      'No journal for height 99',
    );
  });

  it('reverts UTXO transactions: outputs deleted, inputs unspent', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const ids = await importIdentities();
    const posts = await importPosts();
    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();

    const author = makeTestIdentity();

    const post = makePost(author.userId, 'utxo revert test');
    const postId = computePostId(post);
    const { encodePost } = await import('@dagsocial/types');
    posts.insertPost(post, encodePost(post));

    // Insert sub-block
    mempool.insertSubBlock(postId, 1000);

    // Insert a standalone UTXO tx
    const karmaBox = makeKarmaBox(100n, author.userId, 0);
    utxo.insertBox(karmaBox);
    const likeTx = makeLikeTx(author, karmaBox, 'unrelated');
    mempool.insertUtxoTx(likeTx, null, 1000);

    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock();

    // Verify journal has the applied tx (mempool re-insertion record) and the
    // primitive mutation log the revert will replay
    const journalStore = await importJournalStore();
    const journal = journalStore.getBlockJournal(1);
    expect(journal).not.toBeNull();
    expect(journal!.appliedUtxoTxs.length).toBeGreaterThan(0);
    const txRecord = journal!.appliedUtxoTxs[0]!;
    expect(txRecord.txId).toBeTruthy();
    expect(txRecord.txCbor).toBeInstanceOf(Uint8Array);

    const insertedIds = journal!.mutations
      .filter((m) => m.op === 'insert')
      .map((m) => m.boxId);
    const removedIds = journal!.mutations
      .filter((m) => m.op === 'remove')
      .map((m) => m.boxId);
    // The like tx's change box was created, its karma input consumed
    expect(insertedIds.length).toBeGreaterThan(0);
    expect(removedIds).toContain(karmaBox.id);

    // Revert
    const forkResolution = await importForkResolution();
    forkResolution.revertBlock(1);

    // Every box the block created is gone; every box it consumed is live again
    for (const boxId of insertedIds) {
      expect(utxo.getBox(boxId)).toBeNull();
    }
    for (const boxId of removedIds) {
      expect(utxo.getBox(boxId)).not.toBeNull();
    }

    // Block and journal should be gone
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(journalStore.getBlockJournal(1)).toBeNull();
  });

  it('refuses to run while a block journal is open', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock();

    const journalStore = await importJournalStore();
    const forkResolution = await importForkResolution();
    journalStore.beginBlockJournal(2);
    try {
      expect(() => forkResolution.revertBlock(1)).toThrow(
        'a block journal is open',
      );
    } finally {
      journalStore.abortBlockJournal();
    }

    // Nothing was reverted
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).not.toBeNull();
  });

  it('rolls back decay burns', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const ids = await importIdentities();

    // Create identity with a karma box at block 0 (ancient)
    const identity = makeTestIdentity();
    const oldBox = makeKarmaBox(100n, identity.userId, 0);
    utxo.insertBox(oldBox);
    const oldBoxId = oldBox.id!;

    // Apply decay manually (simulates what block application does)
    const { applyKarmaDecay } = await import(
      '../../src/services/decay.js'
    );
    const {
      KARMA_STALE_THRESHOLD_BLOCKS,
      KARMA_DECAY_INTERVAL_BLOCKS,
      KARMA_DECAY_AMOUNT,
      KARMA_MINIMUM,
    } = await import('@dagsocial/types');

    // Use real store functions for getKarmaBoxes (returns all boxes)
    const { getKarmaBoxes } = await import('../../src/store/utxo.js');

    const decayCfg = {
      staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
      decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
      decayAmount: KARMA_DECAY_AMOUNT,
      karmaMinimum: KARMA_MINIMUM,
    };

    const deps = {
      getKarmaBoxes,
      consumeBox: utxo.consumeBox,
      insertBox: utxo.insertBox,
      getKarmaOwners: () => [identity.userId],
    };

    const entries = applyKarmaDecay(
      deps,
      KARMA_STALE_THRESHOLD_BLOCKS + 100,
      decayCfg,
    );

    expect(entries.length).toBe(1);
    const newBoxId = entries[0]!.newBoxId;

    // Verify old box consumed (not returned by getKarmaBox which filters spent)
    const afterDecayBox = utxo.getKarmaBox(identity.userId);
    expect(afterDecayBox).not.toBeNull();
    expect(afterDecayBox!.id).toBe(newBoxId); // only unspent box is the new one

    // Reverse: delete new box, unconsume old boxes
    // (same logic as revertBlock step 2b in fork-resolution.ts)
    const { deleteBox, unconsumeBox } = await import(
      '../../src/store/utxo.js'
    );
    for (const entry of entries) {
      deleteBox(entry.newBoxId);
      for (const boxId of entry.consumedBoxIds) {
        unconsumeBox(boxId);
      }
    }

    // Old box restored (unspent), new box gone
    const restoredBox = utxo.getKarmaBox(identity.userId);
    expect(restoredBox).not.toBeNull();
    expect(restoredBox!.boxType).toBe('karma');
    expect(restoredBox!.value).toBe(100n);
    expect(restoredBox!.id).toBe(oldBoxId);

    expect(utxo.getBox(newBoxId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — reorg
// ---------------------------------------------------------------------------

describe('reorg', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    vi.resetModules();
  });

  it('reverts blocks and re-inserts txs/sub-blocks to mempool', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig); // epochBlocks = 100 (no epoch)

    // Build 3 blocks
    for (let i = 0; i < 3; i++) {
      const post = makePost(author.userId, `reorg test ${i}`);
      const postId = computePostId(post);
      posts.insertPost(post, encodePost(post));
      mempool.insertSubBlock(postId, 1000);
      bc.createOrderingBlock();
    }

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(3);

    // Mempool should be empty (all consumed)
    expect(mempool.getPendingEntries(100)).toHaveLength(0);

    // Reorg back to height 0 (full rollback, no new blocks)
    const forkResolution = await importForkResolution();
    forkResolution.reorg(0, []);

    // All blocks should be gone
    expect(ordering.getCurrentHeight()).toBe(0);
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getOrderingBlock(2)).toBeNull();
    expect(ordering.getOrderingBlock(3)).toBeNull();

    // Journals should be gone
    const journalStore = await importJournalStore();
    expect(journalStore.getBlockJournal(1)).toBeNull();
    expect(journalStore.getBlockJournal(2)).toBeNull();
    expect(journalStore.getBlockJournal(3)).toBeNull();

    // Mempool should have re-inserted sub-blocks
    const pendingAfter = mempool.getPendingEntries(100);
    expect(pendingAfter.length).toBeGreaterThan(0);
  });

  it('reorg then rebuild: state matches new chain', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build 2 blocks
    for (let i = 0; i < 2; i++) {
      const post = makePost(author.userId, `chain a ${i}`);
      const postId = computePostId(post);
      posts.insertPost(post, encodePost(post));
      mempool.insertSubBlock(postId, 1000);
      bc.createOrderingBlock();
    }

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);

    // Roll back to height 0
    const forkResolution = await importForkResolution();
    forkResolution.reorg(0, []);

    expect(ordering.getCurrentHeight()).toBe(0);

    // Rebuild: new chain from mempool entries (re-inserted by reorg)
    // The block creator will pick up re-inserted sub-blocks
    bc.createOrderingBlock(); // height 1
    bc.createOrderingBlock(); // height 2

    expect(ordering.getCurrentHeight()).toBe(2);

    // Verify new chain blocks exist
    expect(ordering.getOrderingBlock(1)).not.toBeNull();
    expect(ordering.getOrderingBlock(2)).not.toBeNull();

    // Journals should exist for the new chain
    const journalStore = await importJournalStore();
    expect(journalStore.getBlockJournal(1)).not.toBeNull();
    expect(journalStore.getBlockJournal(2)).not.toBeNull();
  });

  it('reorg with new blocks applies competing chain', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build 3 blocks
    for (let i = 0; i < 3; i++) {
      const post = makePost(author.userId, `original ${i}`);
      const postId = computePostId(post);
      posts.insertPost(post, encodePost(post));
      mempool.insertSubBlock(postId, 1000);
      bc.createOrderingBlock();
    }

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(3);

    // Save block 1 (the fork point)
    const block1 = ordering.getOrderingBlock(1);
    expect(block1).not.toBeNull();

    // Save block 2 and 3 from store before reverting
    const block2 = ordering.getOrderingBlock(2);
    const block3 = ordering.getOrderingBlock(3);
    expect(block2).not.toBeNull();
    expect(block3).not.toBeNull();

    // Delete block 3 and 2, but keep block 1 (simulate fork at height 1)
    const forkResolution = await importForkResolution();
    forkResolution.revertBlock(3);
    forkResolution.revertBlock(2);

    expect(ordering.getCurrentHeight()).toBe(1);

    // Now apply competing chain: blocks 2A, 3A (using same blocks for test simplicity)
    // In a real reorg, these would be different blocks from a peer
    // For the test, we apply the same blocks to verify the mechanism works
    forkResolution.reorg(1, [block2!, block3!]);

    expect(ordering.getCurrentHeight()).toBe(3);
    expect(ordering.getOrderingBlock(2)).not.toBeNull();
    expect(ordering.getOrderingBlock(3)).not.toBeNull();

    // Journals should exist for all 3 heights
    const journalStore = await importJournalStore();
    expect(journalStore.getBlockJournal(1)).not.toBeNull();
    expect(journalStore.getBlockJournal(2)).not.toBeNull();
    expect(journalStore.getBlockJournal(3)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // A full mempool must not abort a reorg (audit M-8). Re-insertion is
  // bookkeeping; letting MempoolFullError escape would roll back the whole
  // chain switch — mempool pressure turning into a consensus-liveness failure.
  // -------------------------------------------------------------------------
  it('drops re-inserted entries and still completes the reorg when the pool is full', async () => {
    const originalCap = process.env['MAX_MEMPOOL_ENTRIES'];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env['MAX_MEMPOOL_ENTRIES'] = '1';
      vi.resetModules();

      const db = await importDb();
      db.initDb(':memory:');

      const author = makeTestIdentity();
      await importIdentities();

      const { encodePost } = await import('@dagsocial/types');
      const posts = await importPosts();
      const mempool = await importMempoolFresh();
      const bc = await importBlockCreator();
      bc.startBlockCreator(testConfig);

      // Two blocks, one sub-block each. Each insert sits alone in the pool
      // (cap 1) and is consumed by its block, so building the chain is fine.
      for (let i = 0; i < 2; i++) {
        const post = makePost(author.userId, `full pool ${i}`);
        const postId = computePostId(post);
        posts.insertPost(post, encodePost(post));
        mempool.insertSubBlock(postId, 1000);
        bc.createOrderingBlock();
      }

      const ordering = await importOrdering();
      expect(ordering.getCurrentHeight()).toBe(2);
      expect(mempool.getPendingEntries(100)).toHaveLength(0);

      // Fill the pool to its cap, so every re-insertion below is rejected.
      mempool.insertSubBlock('occupier', 1000);
      expect(mempool.getPendingEntries(100)).toHaveLength(1);

      const forkResolution = await importForkResolution();
      expect(() => forkResolution.reorg(0, [])).not.toThrow();

      // The chain switch completed despite every re-insertion being dropped.
      expect(ordering.getCurrentHeight()).toBe(0);
      expect(ordering.getOrderingBlock(1)).toBeNull();
      expect(ordering.getOrderingBlock(2)).toBeNull();
      expect(mempool.getPendingEntries(100)).toHaveLength(1);
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('Reorg re-insertion dropped')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
      if (originalCap === undefined) delete process.env['MAX_MEMPOOL_ENTRIES'];
      else process.env['MAX_MEMPOOL_ENTRIES'] = originalCap;
    }
  });

  it('control — the same reorg re-inserts entries when the pool has room', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    await importIdentities();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    for (let i = 0; i < 2; i++) {
      const post = makePost(author.userId, `room in pool ${i}`);
      const postId = computePostId(post);
      posts.insertPost(post, encodePost(post));
      mempool.insertSubBlock(postId, 1000);
      bc.createOrderingBlock();
    }

    mempool.insertSubBlock('occupier', 1000);

    const forkResolution = await importForkResolution();
    forkResolution.reorg(0, []);

    // Default cap (10000): the reverted sub-blocks come back.
    expect(mempool.getPendingEntries(100).length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — reorg abort restores the AVL prover (NODE_INTERFACE
// "Reorg-abort-safe"). SQLite rollback restores the DB and the AVL storage
// rows, but not the prover's in-memory tree: without the reorg-level restore
// it would end at fork-point + applied-prefix state.
// ---------------------------------------------------------------------------

describe('reorg abort', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    vi.resetModules();
  });

  it('failed mid-reorg apply leaves chain, DB, and prover digest at the pre-reorg state', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // Activate the AVL prover singleton against the test DB — the same
    // instance tryGetAvlProver() hands to block-apply and reorg().
    const { createAvlProver, tryGetAvlProver } = (await import(
      '../../src/state/avl-prover.js'
    )) as typeof import('../../src/state/avl-prover.js');
    createAvlProver();

    // Chain of 3 empty blocks (coinbase only); every box in the prover's tree
    // arrived through the apply funnel, so tree and DB agree.
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    for (let i = 0; i < 3; i++) bc.createOrderingBlock();

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(3);
    const originalHashes = [1, 2, 3].map(
      (h) => blockHash(ordering.getOrderingBlock(h)!.header),
    );

    const preBoxes = db.getDb().prepare('SELECT * FROM utxo_boxes ORDER BY id').all();
    const avl = tryGetAvlProver();
    expect(avl).not.toBeNull();
    const preDigest = new Uint8Array(avl!.prover.digest()!);

    // Competing chain: a valid block at height 2, then a block whose
    // prevBlockHash still names the original height-2 block — rejected by the
    // chain-link check after the valid prefix has already been applied.
    const goodB2 = await makeApplicableBlock({ height: 2 });
    const badB3 = await makeApplicableBlock({ height: 3 });

    const forkResolution = await importForkResolution();
    expect(() => forkResolution.reorg(1, [goodB2, badB3])).toThrow(
      'reorg failed: block at height 3 rejected',
    );

    // Chain and DB: byte-for-byte the pre-reorg state (SQLite rollback).
    expect(ordering.getCurrentHeight()).toBe(3);
    for (const h of [1, 2, 3]) {
      expect(blockHash(ordering.getOrderingBlock(h)!.header)).toBe(originalHashes[h - 1]);
    }
    expect(db.getDb().prepare('SELECT * FROM utxo_boxes ORDER BY id').all()).toEqual(preBoxes);

    // Prover: the in-memory digest is back at the pre-reorg tip. Without the
    // reorg-level restore it would sit at fork-point + goodB2.
    const postDigest = avl!.prover.digest();
    expect(postDigest).not.toBeNull();
    expect(Buffer.from(postDigest!).equals(Buffer.from(preDigest))).toBe(true);
  });
});
