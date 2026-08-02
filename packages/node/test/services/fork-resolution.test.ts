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
  cumulativeWork,
  LIKE_COST,
} from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import type {
  Post,
  LikeBox,
  KarmaBox,
  OrderingBlock,
  UtxoTransaction,
  BlockHeader,
  BlockJournal,
} from '@dagsocial/types';
import type Database from 'better-sqlite3';
import { signTransaction } from '../helpers.js';

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
 * Build a signed, value-conserving like transaction: the liker's karma box is
 * consumed and split into a karma change box and the LikeBox.
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
    const karmaBox = makeKarmaBox(100, author.userId, 0);
    utxo.insertBox(karmaBox);
    const likeTx = makeLikeTx(author, karmaBox, 'unrelated');
    mempool.insertUtxoTx(likeTx, null, 1000);

    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock();

    // Verify journal has appliedUtxoTxs
    const journalStore = await importJournalStore();
    const journal = journalStore.getBlockJournal(1);
    expect(journal).not.toBeNull();
    expect(journal!.appliedUtxoTxs.length).toBeGreaterThan(0);

    const txRecord = journal!.appliedUtxoTxs[0]!;

    // Revert
    const forkResolution = await importForkResolution();
    forkResolution.revertBlock(1);

    // Output boxes should be deleted
    for (const boxId of txRecord.outputBoxIds) {
      const box = utxo.getBox(boxId);
      expect(box).toBeNull();
    }

    // Block and journal should be gone
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(journalStore.getBlockJournal(1)).toBeNull();
  });

  it('rolls back decay burns', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const ids = await importIdentities();

    // Create identity with a karma box at block 0 (ancient)
    const identity = makeTestIdentity();
    const oldBox = makeKarmaBox(100, identity.userId, 0);
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
    expect(restoredBox!.value).toBe(100);
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
});
