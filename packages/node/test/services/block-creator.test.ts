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
  getUserId,
  PROTOCOL_VERSION,
  LIKE_COST,
  LIKE_THRESHOLD,
  LIKE_MAX_AUTHOR_REWARD,
} from '@dagsocial/types';
import type {
  Post,
  SubBlock,
  LikeBox,
  KarmaBox,
  OrderingBlock,
} from '@dagsocial/types';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Test config (small epoch for boundary testing)
// ---------------------------------------------------------------------------

const testConfig = {
  port: 3000,
  dbPath: ':memory:',
  postPowTargetBits: 20,
  challengeWindowBlocks: 10,
  orderingBlockIntervalMs: 60000,
  orderingBlockMinSubBlocks: 1,
  maxSubBlocksPerBlock: 1000,
  epochBlocks: 2, // Trigger epoch every 2 blocks for easy testing
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
  return (await import('../../src/store/identities.js')) as {
    insertIdentity: (userId: string, publicKey: Uint8Array) => void;
    getIdentity: (
      userId: string,
    ) => { userId: string; publicKey: Uint8Array; createdAt: number } | null;
  };
}

async function importPosts() {
  return (await import('../../src/store/posts.js')) as {
    insertPost: (post: Post, rawCbor: Uint8Array) => void;
    confirmPost: (postId: string, blockHeight: number) => void;
    getPost: (id: string) => Post | null;
  };
}

async function importSubblocks() {
  return (await import('../../src/store/subblocks.js')) as {
    insertSubBlock: (sb: SubBlock) => void;
    getPendingSubBlocks: (limit: number) => SubBlock[];
    confirmSubBlock: (subBlockId: string, blockHeight: number) => void;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
    getUnprocessedLockedLikeBoxes: () => LikeBox[];
  };
}

async function importLikes() {
  return (await import('../../src/store/likes.js')) as {
    insertLike: (targetPostId: string, likerId: string) => string;
    getUnprocessedFreeLikes: () => Array<{
      id: string;
      targetPostId: string;
      likerId: string;
    }>;
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
  userId: string;
  publicKey: Uint8Array;
  privateKey: KeyObject;
}

function makeTestIdentity(): TestIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubKey = rawPublicKey(publicKey);
  const userId = getUserId(pubKey);
  return { userId, publicKey: pubKey, privateKey };
}

function makePost(authorId: string, content = 'test post'): Post {
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
  likerId: string,
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

  it('createOrderingBlock returns null when nothing pending', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const block = bc.createOrderingBlock();
    expect(block).toBeNull();
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
    ids.insertIdentity(author.userId, author.publicKey);

    // Create and insert post
    const post = makePost(author.userId, 'hello world');
    const postId = computePostId(post);
    const { encodePost } = await import('@dagsocial/types');
    const rawCbor = encodePost(post);

    const posts = await importPosts();
    posts.insertPost(post, rawCbor);

    // Create sub-block
    const subBlock: SubBlock = {
      subBlockId: postId,
      post,
      likeBoxes: [],
      producerId: author.userId,
      protocolVersion: PROTOCOL_VERSION,
    };
    const subblocks = await importSubblocks();
    subblocks.insertSubBlock(subBlock);

    // Start block creator and create block
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const block = bc.createOrderingBlock();
    expect(block).not.toBeNull();
    expect(block!.height).toBe(1);
    expect(block!.subBlockRefs).toContain(postId);
  });

  // -----------------------------------------------------------------------
  // 3. Block includes sub-block refs
  // -----------------------------------------------------------------------

  it('block includes sub-block refs', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();
    ids.insertIdentity(author.userId, author.publicKey);

    const post = makePost(author.userId, 'post one');
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
    const subblocks = await importSubblocks();
    subblocks.insertSubBlock(subBlock);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const block = bc.createOrderingBlock();
    expect(block).not.toBeNull();
    expect(block!.subBlockRefs).toEqual([postId]);
    expect(block!.validatorId).toBeTruthy();
    expect(block!.validatorSignature.length).toBe(64);
    expect(block!.hash).toBeTruthy();
    expect(block!.hash.length).toBe(64); // 32 bytes hex = 64 chars
  });

  // -----------------------------------------------------------------------
  // 4. Sub-block confirmed after block creation
  // -----------------------------------------------------------------------

  it('sub-block and post confirmed after block creation', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();
    ids.insertIdentity(author.userId, author.publicKey);

    const post = makePost(author.userId, 'confirm me');
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
    const subblocks = await importSubblocks();
    subblocks.insertSubBlock(subBlock);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const block = bc.createOrderingBlock();
    expect(block).not.toBeNull();

    // Verify sub-block is now confirmed (no longer pending)
    const pendingAfter = subblocks.getPendingSubBlocks(10);
    expect(pendingAfter).toHaveLength(0);

    // Verify post is confirmed
    const confirmedPost = posts.getPost(postId);
    expect(confirmedPost).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // 5. Epoch tally runs only at epoch boundaries
  // -----------------------------------------------------------------------

  it('epoch tally runs only at epoch boundaries (height % epochBlocks === 0)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();
    ids.insertIdentity(author.userId, author.publicKey);

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const subblocks = await importSubblocks();

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig); // epochBlocks = 2

    // --- Block 1 (height 1): currentHeight=0, not epoch ---
    const post1 = makePost(author.userId, 'block 1');
    const postId1 = computePostId(post1);
    posts.insertPost(post1, encodePost(post1));
    subblocks.insertSubBlock({
      subBlockId: postId1,
      post: post1,
      likeBoxes: [],
      producerId: author.userId,
      protocolVersion: PROTOCOL_VERSION,
    });

    const block1 = bc.createOrderingBlock();
    expect(block1).not.toBeNull();
    expect(block1!.height).toBe(1);
    expect(block1!.epochTallyResults).toBeUndefined();

    // --- Block 2 (height 2): currentHeight=1, 1 % 2 = 1, not epoch ---
    const post2 = makePost(author.userId, 'block 2');
    const postId2 = computePostId(post2);
    posts.insertPost(post2, encodePost(post2));
    subblocks.insertSubBlock({
      subBlockId: postId2,
      post: post2,
      likeBoxes: [],
      producerId: author.userId,
      protocolVersion: PROTOCOL_VERSION,
    });

    const block2 = bc.createOrderingBlock();
    expect(block2).not.toBeNull();
    expect(block2!.height).toBe(2);
    expect(block2!.epochTallyResults).toBeUndefined();

    // --- Block 3 (height 3): currentHeight=2, 2 % 2 = 0, IS epoch ---
    const post3 = makePost(author.userId, 'block 3');
    const postId3 = computePostId(post3);
    posts.insertPost(post3, encodePost(post3));
    subblocks.insertSubBlock({
      subBlockId: postId3,
      post: post3,
      likeBoxes: [],
      producerId: author.userId,
      protocolVersion: PROTOCOL_VERSION,
    });

    const block3 = bc.createOrderingBlock();
    expect(block3).not.toBeNull();
    expect(block3!.height).toBe(3);
    expect(block3!.epochTallyResults).toBeDefined();
    // Empty tally since no likes
    expect(block3!.epochTallyResults!.rewards).toEqual({});
  });

  // -----------------------------------------------------------------------
  // 6. Epoch tally processes locked + free likes, computes author reward
  // -----------------------------------------------------------------------

  it('epoch tally processes locked+free likes and computes author reward', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();
    ids.insertIdentity(author.userId, author.publicKey);

    // Give author some initial karma
    const { encodePost } = await import('@dagsocial/types');
    const utxo = await importUtxo();
    const authorKarmaBox = makeKarmaBox(100, author.publicKey, 0);
    utxo.insertBox(authorKarmaBox);

    // Create target post
    const post = makePost(author.userId, 'epoch test post');
    const postId = computePostId(post);
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    // Create 6 locked likes (enough for 1 author reward: floor(6/5)=1)
    const likers: TestIdentity[] = [];
    for (let i = 0; i < 6; i++) {
      const liker = makeTestIdentity();
      ids.insertIdentity(liker.userId, liker.publicKey);
      // Give liker karma
      utxo.insertBox(makeKarmaBox(10, liker.publicKey, 0));
      // Create like box
      const likeBox = makeLikeBox(liker.userId, postId, 0);
      utxo.insertBox(likeBox);
      likers.push(liker);
    }

    // Add one free like
    const freeLiker = makeTestIdentity();
    ids.insertIdentity(freeLiker.userId, freeLiker.publicKey);
    utxo.insertBox(makeKarmaBox(10, freeLiker.publicKey, 0));
    const likesStore = await importLikes();
    likesStore.insertLike(postId, freeLiker.userId);

    // Fast-forward: create 2 blocks so height is 2 (next block triggers epoch)
    // Block 1
    const dummyPost1 = makePost(author.userId, 'dummy 1');
    const d1Id = computePostId(dummyPost1);
    posts.insertPost(dummyPost1, encodePost(dummyPost1));
    const subblocks = await importSubblocks();
    subblocks.insertSubBlock({
      subBlockId: d1Id,
      post: dummyPost1,
      likeBoxes: [],
      producerId: author.userId,
      protocolVersion: PROTOCOL_VERSION,
    });

    // Block 2
    const dummyPost2 = makePost(author.userId, 'dummy 2');
    const d2Id = computePostId(dummyPost2);
    posts.insertPost(dummyPost2, encodePost(dummyPost2));
    subblocks.insertSubBlock({
      subBlockId: d2Id,
      post: dummyPost2,
      likeBoxes: [],
      producerId: author.userId,
      protocolVersion: PROTOCOL_VERSION,
    });

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock(); // height 1
    bc.createOrderingBlock(); // height 2

    // Block 3: epoch should fire (currentHeight=2, newHeight=3)
    const dummyPost3 = makePost(author.userId, 'dummy 3');
    const d3Id = computePostId(dummyPost3);
    posts.insertPost(dummyPost3, encodePost(dummyPost3));
    subblocks.insertSubBlock({
      subBlockId: d3Id,
      post: dummyPost3,
      likeBoxes: [],
      producerId: author.userId,
      protocolVersion: PROTOCOL_VERSION,
    });

    const block3 = bc.createOrderingBlock();
    expect(block3).not.toBeNull();
    expect(block3!.epochTallyResults).toBeDefined();

    const rewards = block3!.epochTallyResults!.rewards;
    expect(rewards[postId]).toBeDefined();
    expect(rewards[postId].likeCount).toBe(7); // 6 locked + 1 free
    // authorReward = min(floor(7/5), 10) = min(1, 10) = 1
    expect(rewards[postId].authorReward).toBe(1);

    // Liker refunds: totalLikes=7, refund=1 (>=5 but <10), net=-1
    const refunds = rewards[postId].likerRefunds;
    for (const liker of likers) {
      expect(refunds[liker.userId]).toBe(-1); // net: 1 refund - 2 cost
    }
    // Free liker should NOT have a refund entry
    expect(refunds[freeLiker.userId]).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // 7. Liker refund tiers: 0 (<5 likes), 1 (5-9), 2 (>=10)
  // -----------------------------------------------------------------------

  it('liker refund tiers: 0 (<5), -1 (5-9), 0 (>=10)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();
    ids.insertIdentity(author.userId, author.publicKey);

    const { encodePost } = await import('@dagsocial/types');
    const utxo = await importUtxo();

    // Give author karma
    const authorKarmaBox = makeKarmaBox(100, author.publicKey, 0);
    utxo.insertBox(authorKarmaBox);

    const posts = await importPosts();

    // --- Post A: 3 locked likes → refund tier 0 (total < 5) ---
    const postA = makePost(author.userId, 'post A - 3 likes');
    const postAId = computePostId(postA);
    posts.insertPost(postA, encodePost(postA));
    const likersA: TestIdentity[] = [];
    for (let i = 0; i < 3; i++) {
      const liker = makeTestIdentity();
      ids.insertIdentity(liker.userId, liker.publicKey);
      utxo.insertBox(makeKarmaBox(10, liker.publicKey, 0));
      const likeBox = makeLikeBox(liker.userId, postAId, 0);
      utxo.insertBox(likeBox);
      likersA.push(liker);
    }

    // --- Post B: 7 locked likes → refund tier 1 (total >= 5, < 10) ---
    const postB = makePost(author.userId, 'post B - 7 likes');
    const postBId = computePostId(postB);
    posts.insertPost(postB, encodePost(postB));
    const likersB: TestIdentity[] = [];
    for (let i = 0; i < 7; i++) {
      const liker = makeTestIdentity();
      ids.insertIdentity(liker.userId, liker.publicKey);
      utxo.insertBox(makeKarmaBox(10, liker.publicKey, 0));
      const likeBox = makeLikeBox(liker.userId, postBId, 0);
      utxo.insertBox(likeBox);
      likersB.push(liker);
    }

    // --- Post C: 12 locked likes → refund tier 2 (total >= 10) ---
    const postC = makePost(author.userId, 'post C - 12 likes');
    const postCId = computePostId(postC);
    posts.insertPost(postC, encodePost(postC));
    const likersC: TestIdentity[] = [];
    for (let i = 0; i < 12; i++) {
      const liker = makeTestIdentity();
      ids.insertIdentity(liker.userId, liker.publicKey);
      utxo.insertBox(makeKarmaBox(10, liker.publicKey, 0));
      const likeBox = makeLikeBox(liker.userId, postCId, 0);
      utxo.insertBox(likeBox);
      likersC.push(liker);
    }

    // Fast-forward 2 blocks to trigger epoch on block 3
    const subblocks = await importSubblocks();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    for (let i = 0; i < 2; i++) {
      const dp = makePost(author.userId, `dummy fast-forward ${i}`);
      const dpId = computePostId(dp);
      posts.insertPost(dp, encodePost(dp));
      subblocks.insertSubBlock({
        subBlockId: dpId,
        post: dp,
        likeBoxes: [],
        producerId: author.userId,
        protocolVersion: PROTOCOL_VERSION,
      });
      bc.createOrderingBlock();
    }

    // Now epoch block (height 3)
    const dp = makePost(author.userId, 'dummy epoch trigger');
    const dpId = computePostId(dp);
    posts.insertPost(dp, encodePost(dp));
    subblocks.insertSubBlock({
      subBlockId: dpId,
      post: dp,
      likeBoxes: [],
      producerId: author.userId,
      protocolVersion: PROTOCOL_VERSION,
    });

    const epochBlock = bc.createOrderingBlock();
    expect(epochBlock).not.toBeNull();
    expect(epochBlock!.epochTallyResults).toBeDefined();

    const rewards = epochBlock!.epochTallyResults!.rewards;

    // Post A: 3 likes, refund = 0, net = -2
    expect(rewards[postAId]).toBeDefined();
    expect(rewards[postAId].likeCount).toBe(3);
    expect(rewards[postAId].authorReward).toBe(0); // floor(3/5) = 0
    for (const liker of likersA) {
      expect(rewards[postAId].likerRefunds[liker.userId]).toBe(-2);
    }

    // Post B: 7 likes, refund = 1, net = -1
    expect(rewards[postBId]).toBeDefined();
    expect(rewards[postBId].likeCount).toBe(7);
    expect(rewards[postBId].authorReward).toBe(1); // floor(7/5) = 1
    for (const liker of likersB) {
      expect(rewards[postBId].likerRefunds[liker.userId]).toBe(-1);
    }

    // Post C: 12 likes, refund = 2, net = 0
    expect(rewards[postCId]).toBeDefined();
    expect(rewards[postCId].likeCount).toBe(12);
    expect(rewards[postCId].authorReward).toBe(
      Math.min(Math.floor(12 / LIKE_THRESHOLD), LIKE_MAX_AUTHOR_REWARD),
    ); // floor(12/5)=2, capped at 10
    for (const liker of likersC) {
      expect(rewards[postCId].likerRefunds[liker.userId]).toBe(0);
    }
  });

  // -----------------------------------------------------------------------
  // 8. Free likes don't generate refunds
  // -----------------------------------------------------------------------

  it('free likes count toward total but do not generate refund entries', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();
    ids.insertIdentity(author.userId, author.publicKey);

    const { encodePost } = await import('@dagsocial/types');
    const utxo = await importUtxo();
    utxo.insertBox(makeKarmaBox(100, author.publicKey, 0));

    const post = makePost(author.userId, 'free likes test');
    const postId = computePostId(post);
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    // 3 locked likes (refund tier 0 by themselves)
    for (let i = 0; i < 3; i++) {
      const liker = makeTestIdentity();
      ids.insertIdentity(liker.userId, liker.publicKey);
      utxo.insertBox(makeKarmaBox(10, liker.publicKey, 0));
      const likeBox = makeLikeBox(liker.userId, postId, 0);
      utxo.insertBox(likeBox);
    }

    // 5 free likes — push total to 8, tipping into refund tier 1
    const likesStore = await importLikes();
    for (let i = 0; i < 5; i++) {
      const freeLiker = makeTestIdentity();
      ids.insertIdentity(freeLiker.userId, freeLiker.publicKey);
      utxo.insertBox(makeKarmaBox(10, freeLiker.publicKey, 0));
      likesStore.insertLike(postId, freeLiker.userId);
    }

    // Fast-forward 2 blocks
    const subblocks = await importSubblocks();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    for (let i = 0; i < 2; i++) {
      const dp = makePost(author.userId, `ff ${i}`);
      const dpId = computePostId(dp);
      posts.insertPost(dp, encodePost(dp));
      subblocks.insertSubBlock({
        subBlockId: dpId,
        post: dp,
        likeBoxes: [],
        producerId: author.userId,
        protocolVersion: PROTOCOL_VERSION,
      });
      bc.createOrderingBlock();
    }

    // Epoch block
    const dp = makePost(author.userId, 'epoch');
    const dpId = computePostId(dp);
    posts.insertPost(dp, encodePost(dp));
    subblocks.insertSubBlock({
      subBlockId: dpId,
      post: dp,
      likeBoxes: [],
      producerId: author.userId,
      protocolVersion: PROTOCOL_VERSION,
    });

    const epochBlock = bc.createOrderingBlock();
    const rewards = epochBlock!.epochTallyResults!.rewards;

    expect(rewards[postId]).toBeDefined();
    expect(rewards[postId].likeCount).toBe(8); // 3 locked + 5 free
    expect(rewards[postId].authorReward).toBe(
      Math.min(Math.floor(8 / LIKE_THRESHOLD), LIKE_MAX_AUTHOR_REWARD),
    ); // floor(8/5)=1

    // Only 3 locked likers should appear in refunds — free likers never do
    const refundKeys = Object.keys(rewards[postId].likerRefunds);
    expect(refundKeys).toHaveLength(3);
    // Each locked liker gets net = 1 (refund) - 2 (cost) = -1
    for (const key of refundKeys) {
      expect(rewards[postId].likerRefunds[key]).toBe(-1);
    }
  });

  // -----------------------------------------------------------------------
  // 9. Deduplication: like box in both sub-block and standalone skipped
  // -----------------------------------------------------------------------

  it('deduplicates like boxes appearing in both sub-blocks and standalone pool', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();
    ids.insertIdentity(author.userId, author.publicKey);

    const { encodePost } = await import('@dagsocial/types');
    const utxo = await importUtxo();
    utxo.insertBox(makeKarmaBox(100, author.publicKey, 0));

    const post = makePost(author.userId, 'dedup test');
    const postId = computePostId(post);
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    // Create 2 like boxes
    const liker1 = makeTestIdentity();
    ids.insertIdentity(liker1.userId, liker1.publicKey);
    utxo.insertBox(makeKarmaBox(10, liker1.publicKey, 0));
    const likeBox1 = makeLikeBox(liker1.userId, postId, 0);
    utxo.insertBox(likeBox1);

    const liker2 = makeTestIdentity();
    ids.insertIdentity(liker2.userId, liker2.publicKey);
    utxo.insertBox(makeKarmaBox(10, liker2.publicKey, 0));
    const likeBox2 = makeLikeBox(liker2.userId, postId, 0);
    utxo.insertBox(likeBox2);

    // likeBox1 rides in the sub-block; likeBox2 is standalone
    const subBlock: SubBlock = {
      subBlockId: postId,
      post,
      likeBoxes: [likeBox1],
      producerId: author.userId,
      protocolVersion: PROTOCOL_VERSION,
    };
    const subblocks = await importSubblocks();
    subblocks.insertSubBlock(subBlock);

    // Both are unprocessed in UTXO (standalone pool has both)
    // likeBox1 should be deduped from standalone pool
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = bc.createOrderingBlock();

    expect(block).not.toBeNull();
    // Standalone likeBoxIds should only contain likeBox2
    expect(block!.likeBoxIds).not.toContain(likeBox1.id);
    expect(block!.likeBoxIds).toContain(likeBox2.id);
    expect(block!.likeBoxIds).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // 10. getCurrentHeight increments after block creation
  // -----------------------------------------------------------------------

  it('getCurrentHeight increments after block creation', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();
    ids.insertIdentity(author.userId, author.publicKey);

    const { encodePost } = await import('@dagsocial/types');

    const post = makePost(author.userId, 'height test');
    const postId = computePostId(post);
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const subblocks = await importSubblocks();
    subblocks.insertSubBlock({
      subBlockId: postId,
      post,
      likeBoxes: [],
      producerId: author.userId,
      protocolVersion: PROTOCOL_VERSION,
    });

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
    subblocks.insertSubBlock({
      subBlockId: postId2,
      post: post2,
      likeBoxes: [],
      producerId: author.userId,
      protocolVersion: PROTOCOL_VERSION,
    });

    bc.createOrderingBlock();
    expect(ordering.getCurrentHeight()).toBe(2);
  });
});
