import {
  fixtureProvenance,
  uid, signTransaction } from '../helpers.js';
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
} from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import type {
  Post,
  LikeBox,
  KarmaBox,
  OrderingBlock,
  UtxoTransaction,
  SubBlockEntry,
} from '@dagsocial/types';
import type Database from 'better-sqlite3';

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
  // Mining
  miningMode: 'internal' as const,
  orderingBlockPowTargetBits: 12,
  creditTreasuryPct: 10,
  treasuryPubKey: '',
  // Net settings
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
  computeSubBlockRoot: (tree: OrderingBlock['subBlockTree']) => string;
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
    purgeExpired: (currentHeight: number) => number;
    removeEntry: (rowid: number) => void;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => OrderingBlock | null;
  };
}

// ---------------------------------------------------------------------------
// Ed25519 helpers
// ---------------------------------------------------------------------------

/** Extract raw 32-byte Ed25519 public key from SPKI DER KeyObject. */
function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

/** Create a public key KeyObject from raw 32-byte public key. */
function rawToKeyObject(pubKey: Uint8Array): KeyObject {
  const { createPublicKey } = require('crypto');
  const ED25519_SPKI_PREFIX = Buffer.from(
    '302a300506032b6570032100',
    'hex',
  );
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pubKey)]),
    format: 'der',
    type: 'spki',
  });
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

function makeKarmaBox(
  value: bigint,
  owner: Uint8Array,
  seed: number,
): KarmaBox {
  const box: KarmaBox = {
    boxType: 'karma',
    value,
    owner,
    guard: 'owner_signature',
    proofSource: 'genesis',
  };
  Object.assign(box, fixtureProvenance(box, seed));
  const id = computeBoxId(box);
  box.id = id;
  return box;
}

/**
 * A signed, value-conserving UTXO transaction used purely as inclusion
 * plumbing by the assembly tests below. It still builds the retired LikeBox
 * split shape (legal while the LikeBox type exists, until T2); the live burn
 * shape is `helpers.makeLikeTx`. Assembly does not validate transactions, so
 * any conserving payload exercises the same paths.
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
        owner: liker.userId,
        guard: 'owner_signature',
        proofSource: 'like_op',
      } as KarmaBox,
      {
        boxType: 'like',
        value: LIKE_COST,
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
// Tests
// ---------------------------------------------------------------------------

describe('block-creator', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(async () => {
    // Stop the interval if running
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch {
      // Module might not have been imported
    }
    vi.resetModules();
  });

  // -----------------------------------------------------------------------
  // 1. Null return when nothing pending
  // -----------------------------------------------------------------------

  it('createOrderingBlock produces genesis block even with nothing pending', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const block = bc.createOrderingBlock();
    // Empty blocks are always mined — miners need coinbase rewards.
    // At genesis (height 0→1), this produces a block with coinbase outputs.
    expect(block).not.toBeNull();
    expect(block!.header.height).toBe(1);
    expect(block!.subBlockTree.subBlockRefs).toEqual([]);
    expect(block!.subBlockTree.subBlockEntries).toEqual([]);
    expect(block!.utxoTxTree.coinbaseOutputs.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 2. Pending sub-block triggers block creation
  // -----------------------------------------------------------------------

  it('pending sub-block triggers block creation', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // Set up identity
    const author = makeTestIdentity();
    const ids = await importIdentities();

    // Create and insert post
    const post = makePost(author.userId, 'hello world');
    const postId = computePostId(post);
    const { encodePost } = await import('@dagsocial/types');
    const rawCbor = encodePost(post);

    const posts = await importPosts();
    posts.insertPost(post, rawCbor);

    // Insert postId into mempool (ID-based, not CBOR-based)
    const mempool = await importMempoolFresh();
    mempool.insertSubBlock(postId, 1000);

    // Start block creator and create block
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const block = bc.createOrderingBlock();
    expect(block).not.toBeNull();
    expect(block!.header.height).toBe(1);
    expect(block!.subBlockTree.subBlockRefs).toContain(postId);

    // Verify subBlockEntries in the block
    expect(block!.subBlockTree.subBlockEntries).toBeDefined();
    expect(block!.subBlockTree.subBlockEntries.length).toBe(
      block!.subBlockTree.subBlockRefs.length,
    );
    for (const entry of block!.subBlockTree.subBlockEntries) {
      expect(entry.postId).toBe(postId);
      expect(entry.parentRefs).toEqual(post.parentRefs);
      // Filled from the resolved post, never from a client claim (audit H-3).
      expect(entry.author).toBe(Buffer.from(post.author).toString('hex'));
    }
  });

  // -----------------------------------------------------------------------
  // 3. Block includes sub-block refs
  // -----------------------------------------------------------------------

  it('block includes sub-block refs', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const post = makePost(author.userId, 'post one');
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
    expect(block!.subBlockTree.subBlockRefs).toEqual([postId]);
    expect(block!.header.validatorId).toBeTruthy();
    expect(block!.validatorSignature.length).toBe(64);
    const h = blockHash(block!.header);
    expect(h).toBeTruthy();
    expect(h.length).toBe(64); // 32 bytes hex = 64 chars
  });

  // -----------------------------------------------------------------------
  // 4. Sub-block confirmed after block creation
  // -----------------------------------------------------------------------

  it('sub-block and post confirmed after block creation', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const post = makePost(author.userId, 'confirm me');
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

    // Verify mempool is now empty (confirmed entries removed)
    const pendingAfter = mempool.getPendingEntries(10);
    expect(pendingAfter).toHaveLength(0);

    // Verify post is confirmed
    const confirmedPost = posts.getPost(postId);
    expect(confirmedPost).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // 5. Template assembly carries no retired fields (P2-D N3a)
  // -----------------------------------------------------------------------

  it('template assembly emits likeBoxIds: [] and no epochTallyResults', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const posts = await importPosts();
    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();

    const author = makeTestIdentity();
    const post = makePost(author.userId, 'template shape');
    const postId = computePostId(post);
    const { encodePost } = await import('@dagsocial/types');
    posts.insertPost(post, encodePost(post));
    mempool.insertSubBlock(postId, 1000);

    const karmaBox = makeKarmaBox(100n, author.userId, 0);
    utxo.insertBox(karmaBox);
    mempool.insertUtxoTx(makeLikeTx(author, karmaBox, postId), null, 1000);

    bc.startBlockCreator(testConfig);
    const block = bc.createOrderingBlock();

    expect(block).not.toBeNull();
    // The type fields stay until T2, but the creator only ever writes the
    // empty constants: nothing fills likeBoxIds, nothing attaches a tally.
    expect(block!.utxoTxTree.likeBoxIds).toEqual([]);
    expect(block!.utxoTxTree.epochTallyResults).toBeUndefined();
    // Strict absence, not an undefined-valued key.
    expect('epochTallyResults' in block!.utxoTxTree).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 6. Former epoch boundaries are ordinary heights (P2-D N3a)
  // -----------------------------------------------------------------------

  it('a block at a former epoch boundary (height % 60 === 0) carries no tally and applies like any other height', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const bc = await importBlockCreator();
    const ordering = await importOrdering();

    bc.startBlockCreator(testConfig);

    // Drive the real creator+apply across the retired EPOCH_BLOCKS=60
    // boundary. Under the retired trigger the tally rode the block after a
    // currentHeight % 60 === 0 chain tip (height 61), so cover both readings
    // of "the boundary": 60 and 61.
    for (let i = 0; i < 61; i++) {
      expect(bc.createOrderingBlock()).not.toBeNull();
    }
    expect(ordering.getCurrentHeight()).toBe(61); // every block applied

    for (const height of [59, 60, 61]) {
      const stored = ordering.getOrderingBlock(height);
      expect(stored).not.toBeNull();
      expect(stored!.utxoTxTree.likeBoxIds).toEqual([]);
      expect(stored!.utxoTxTree.epochTallyResults).toBeUndefined();
    }
  });

  // -----------------------------------------------------------------------
  // 10. getCurrentHeight increments after block creation
  // -----------------------------------------------------------------------

  it('getCurrentHeight increments after block creation', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const { encodePost } = await import('@dagsocial/types');

    const post = makePost(author.userId, 'height test');
    const postId = computePostId(post);
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const mempool = await importMempoolFresh();
    mempool.insertSubBlock(postId, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Height starts at 0
    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(0);

    bc.createOrderingBlock();
    expect(ordering.getCurrentHeight()).toBe(1);

    // Second block
    const post2 = makePost(author.userId, 'height test 2');
    const postId2 = computePostId(post2);
    posts.insertPost(post2, encodePost(post2));
    mempool.insertSubBlock(postId2, 1000);

    bc.createOrderingBlock();
    expect(ordering.getCurrentHeight()).toBe(2);
  });

  // -----------------------------------------------------------------------
  // 11. utxoTxIds populated from mempool standalone UTXO entries
  // -----------------------------------------------------------------------

  it('populates utxoTxIds from mempool standalone UTXO entries', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const ids = await importIdentities();
    const posts = await importPosts();
    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();

    // Set up identity
    const author = makeTestIdentity();

    // Create and insert a post
    const post = makePost(author.userId, 'utxoTxIds test');
    const postId = computePostId(post);
    const { encodePost, computeTxId } = await import('@dagsocial/types');
    posts.insertPost(post, encodePost(post));

    // Insert sub-block ID into mempool
    mempool.insertSubBlock(postId, 1000);

    // Set up: standalone UTXO transaction in mempool
    const karmaBox = makeKarmaBox(100n, author.userId, 0);
    utxo.insertBox(karmaBox);
    const likeTx = makeLikeTx(author, karmaBox, 'some_post_id_not_matching');
    mempool.insertUtxoTx(likeTx, null, 1000);

    bc.startBlockCreator(testConfig);
    const block = bc.createOrderingBlock();

    expect(block).not.toBeNull();
    expect(block!.utxoTxTree.utxoTxIds.length).toBeGreaterThan(0);
    // The standalone like should be in utxoTxIds
    expect(block!.utxoTxTree.utxoTxIds).toContain(computeTxId(likeTx));

    // Verify inline CBOR UTXO tx fields
    const { decodeTx } = await import('@dagsocial/types');
    expect(block!.utxoTxTree.utxoTxs).toBeDefined();
    expect(block!.utxoTxTree.utxoTxs.length).toBe(
      block!.utxoTxTree.utxoTxIds.length,
    );
    for (let i = 0; i < block!.utxoTxTree.utxoTxs.length; i++) {
      const tx = decodeTx(block!.utxoTxTree.utxoTxs[i]);
      expect(computeTxId(tx)).toBe(block!.utxoTxTree.utxoTxIds[i]);
    }

    // Confirmed entries removed from mempool
    const remaining = mempool.getPendingEntries(100);
    expect(remaining).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 13. Batch-linked UTXO transactions appear in utxoTxIds
  // -----------------------------------------------------------------------

  it('batch-linked UTXO transactions appear in utxoTxIds', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const ids = await importIdentities();
    const posts = await importPosts();
    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();

    // Set up identity
    const author = makeTestIdentity();

    // Create and insert a post
    const post = makePost(author.userId, 'batch UTXO test');
    const postId = computePostId(post);
    const { encodePost, computeTxId } = await import('@dagsocial/types');
    posts.insertPost(post, encodePost(post));

    // Insert sub-block ID with batch_id "batch1"
    mempool.insertSubBlock(postId, 1000, 'batch1');

    // Create a UTXO transaction with batch_id "batch1"
    const karmaBox = makeKarmaBox(100n, author.userId, 0);
    utxo.insertBox(karmaBox);
    const likeTx = makeLikeTx(author, karmaBox, 'unrelated_post_id');
    mempool.insertUtxoTx(likeTx, 'batch1', 1000);

    bc.startBlockCreator(testConfig);
    const block = bc.createOrderingBlock();

    expect(block).not.toBeNull();
    // The batch-linked UTXO tx ID should be in utxoTxIds
    expect(block!.utxoTxTree.utxoTxIds).toContain(computeTxId(likeTx));
    // The sub-block should be referenced
    expect(block!.subBlockTree.subBlockRefs).toContain(postId);
    // Mempool should be empty (both confirmed)
    const remaining = mempool.getPendingEntries(100);
    expect(remaining).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // H-3: the sub-block Merkle leaf commits to the entry's author
  // -----------------------------------------------------------------------

  it('computeSubBlockRoot commits to the entry author', async () => {
    const { computeSubBlockRoot } = await importBlockCreator();

    const postId = 'aa'.repeat(32);
    const entry: SubBlockEntry = {
      postId,
      parentRefs: ['bb'.repeat(32)],
      author: 'cc'.repeat(32),
    };
    const tree = { subBlockRefs: [postId], subBlockEntries: [entry], pruneEntries: [] };
    // Author flipped, nothing else — if the root moved, the block is bound to
    // the authorship claim and a producer cannot rewrite it after mining.
    const flipped = {
      ...tree,
      subBlockEntries: [{ ...entry, author: 'dd'.repeat(32) }],
    };

    expect(computeSubBlockRoot(flipped)).not.toBe(computeSubBlockRoot(tree));
  });
});
