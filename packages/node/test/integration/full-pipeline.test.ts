/**
 * Full-pipeline integration tests: validate → mempool → mine → apply → confirm.
 *
 * These tests exercise the complete lifecycle of UTXO transactions (likes,
 * invites) through validation, mempool insertion, block mining, UTXO
 * application, and state confirmation.
 *
 * Block creation stores utxoTxIds in the block but does NOT apply them —
 * that happens during block ingestion (verifier → revalidateTxInContext →
 * applyTx).  These tests replicate the ingestion step manually.
 */
import { rawPublicKey, signTransaction } from '../helpers.js';
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
  createPrivateKey,
} from 'crypto';
import {
  computeBoxId,
  PROTOCOL_VERSION,
  LIKE_COST,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
  encodePost,
  computePostId,
  decodeTx,
} from '@dagsocial/types';
import type {
  Post,
  SubBlock,
  KarmaBox,
  LikeBox,
  InviteBox,
  BondBox,
  UtxoTransaction,
  AnyBox,
} from '@dagsocial/types';
import type Database from 'better-sqlite3';

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
  epochBlocks: 100,
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

async function importDb(): Promise<DbModule> {
  return (await import('../../src/store/db.js')) as unknown as DbModule;
}

async function importBlockCreator() {
  return (await import('../../src/services/block-creator.js')) as {
    startBlockCreator: (cfg: typeof testConfig) => void;
    stopBlockCreator: () => void;
    createOrderingBlock: () => unknown;
  };
}

async function importIdentities() {
  return (await import('../../src/store/identities.js')) as {
    insertIdentity: (userId: Uint8Array, publicKey: Uint8Array) => void;
  };
}

async function importPosts() {
  return (await import('../../src/store/posts.js')) as {
    insertPost: (post: Post, rawCbor: Uint8Array) => void;
    getPost: (id: string) => Post | null;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: AnyBox) => void;
    getBox: (id: string) => AnyBox | null;
    getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
    getUnprocessedLockedLikeBoxes: () => LikeBox[];
  };
}

async function importMempool() {
  return (await import('../../src/store/mempool.js')) as {
    insertUtxoTx: (tx: UtxoTransaction, batchId: string | null, expiresAtHeight: number) => number;
    insertSubBlock: (sb: SubBlock, expiresAtHeight: number) => number;
    getPendingEntries: (limit: number) => Array<{
      rowid: number;
      entryType: string;
      utxoTxCbor: Uint8Array | null;
    }>;
    removeEntry: (rowid: number) => void;
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => unknown;
  };
}

type LikesService = {
  castLike: (
    deps: unknown,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ) => { castLikeResult: string; txId: string; expiresAtHeight: number };
};

async function importLikesService(): Promise<LikesService> {
  return (await import('../../src/services/likes.js')) as unknown as LikesService;
}

type InvitesService = {
  createInvite: (
    deps: unknown,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ) => { status: string; txId: string; expiresAtHeight: number };
};

async function importInvitesService(): Promise<InvitesService> {
  return (await import('../../src/services/invites.js')) as unknown as InvitesService;
}

type UtxoEngine = {
  revalidateTxInContext: (
    deps: unknown,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ) => { valid: boolean; error?: string; computedOutputs?: AnyBox[] };
  applyTx: (
    deps: unknown,
    tx: UtxoTransaction,
    computedOutputs: AnyBox[],
    currentBlockHeight: number,
  ) => void;
};

async function importUtxoEngine(): Promise<UtxoEngine> {
  return (await import('../../src/services/utxo-engine.js')) as unknown as UtxoEngine;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

interface TestIdentity {
  userId: Uint8Array;
  publicKey: Uint8Array;
  privateKey: ReturnType<typeof createPrivateKey>;
}

function makeTestIdentity(): TestIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubKey = rawPublicKey(publicKey);
  return { userId: pubKey, publicKey: pubKey, privateKey };
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

function makeKarmaBox(value: number, owner: Uint8Array, createdAtBlock: number): KarmaBox {
  const box: KarmaBox = {
    boxType: 'karma',
    value,
    createdAtBlock,
    owner,
    guard: 'owner_signature',
    proofSource: 'genesis',
    lastTouchBlock: createdAtBlock,
  };
  box.id = computeBoxId(box);
  return box;
}

// ---------------------------------------------------------------------------
// Engine deps factory
// ---------------------------------------------------------------------------

interface EngineDeps {
  getBox: (id: string) => AnyBox | null;
  insertBox: (box: AnyBox) => void;
  consumeBox: (id: string, atBlock: number) => void;
  getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
  getIdentity: (userId: Uint8Array) => { publicKey: Uint8Array } | null;
  runInTransaction: (fn: () => void) => void;
}

function makeEngineDeps(
  db: Database,
  utxoModule: Awaited<ReturnType<typeof importUtxo>>,
): EngineDeps {
  return {
    getBox: (id: string) => {
      const box = utxoModule.getBox(id);
      if (!box) return null;
      const r = db
        .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
        .get(id) as { spent_at_block: number | null } | undefined;
      return r && r.spent_at_block === null ? box : null;
    },
    insertBox: (box: AnyBox) => utxoModule.insertBox(box),
    consumeBox: (id: string, atBlock: number) => {
      db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(atBlock, id);
    },
    getKarmaBox: (owner: Uint8Array) => utxoModule.getKarmaBox(owner),
    getIdentity: (userId: Uint8Array) => ({ publicKey: userId }),
    runInTransaction: (fn: () => void) => {
      (db.transaction(fn) as () => void)();
    },
  };
}

/**
 * Apply a single UTXO transaction as the block ingestion step would:
 * re-validate in context, then apply the state transition.
 * Returns true if applied successfully, false if revalidation failed.
 */
async function ingestTx(
  deps: EngineDeps,
  tx: UtxoTransaction,
  blockHeight: number,
): Promise<boolean> {
  const utxoEngine = await importUtxoEngine();
  const revalResult = utxoEngine.revalidateTxInContext(deps, tx, blockHeight);
  if (!revalResult.valid) return false;
  // revalidateTxInContext only checks liveness + karma decay — it doesn't
  // compute output IDs.  We must compute them ourselves (matching what the
  // production block ingestion code does in index.ts).
  const outputsWithIds = tx.outputs.map((box) => ({
    ...box,
    id: computeBoxId(box),
  })) as AnyBox[];
  utxoEngine.applyTx(deps, tx, outputsWithIds, blockHeight);
  return true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('full-pipeline', () => {
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

  // -------------------------------------------------------------------------
  // 1. Like tx: validate → mempool → mine → apply → confirm
  // -------------------------------------------------------------------------

  it('like tx flows through validate, mempool, mine, apply, and confirm', async () => {
    const dbModule = await importDb();
    dbModule.initDb(':memory:');
    const db = dbModule.getDb();

    // ---- Setup ----
    const author = makeTestIdentity();
    const liker = makeTestIdentity();

    const identities = await importIdentities();
    identities.insertIdentity(author.userId, author.publicKey);
    identities.insertIdentity(liker.userId, liker.publicKey);

    const utxo = await importUtxo();
    const karmaBox = makeKarmaBox(100, liker.userId, 0);
    utxo.insertBox(karmaBox);

    const post = makePost(author.userId, 'full-pipeline like test');
    const postId = computePostId(post);
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    // Build and sign like tx with karma change output
    const changeVal = karmaBox.value - LIKE_COST;
    const likeTx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [
        {
          boxType: 'karma',
          value: changeVal,
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
          targetPostId: postId,
          guard: 'epoch_tally',
        } as LikeBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const likerPubHex = Buffer.from(liker.userId).toString('hex');
    signTransaction(likeTx, liker.privateKey, likerPubHex);

    // ---- Step 1: Cast like (validateTx + mempool) ----
    const likesSvc = await importLikesService();
    const deps = makeEngineDeps(db, utxo);
    const result = likesSvc.castLike(deps, likeTx, 0);

    expect(result.castLikeResult).toBe('pending');
    expect(result.txId).toBeTruthy();

    // ---- Step 2: Mine block (mempool entry removed during finalizeBlock) ----
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = bc.createOrderingBlock() as Record<string, unknown> | null;
    expect(block).not.toBeNull();
    const blockHeight = block!.height as number;
    expect(blockHeight).toBe(1);

    // ---- Step 3: Apply UTXO tx (simulates block ingestion by verifier) ----
    const applied = await ingestTx(deps, likeTx, blockHeight);
    expect(applied).toBe(true);

    // ---- Step 4: Verify confirmed state ----
    // Like box exists
    const likeBoxes = utxo.getUnprocessedLockedLikeBoxes();
    const found = likeBoxes.find(
      (lb) =>
        lb.targetPostId === postId &&
        Buffer.from(lb.likerId).toString('hex') === likerPubHex,
    );
    expect(found).toBeDefined();
    expect(found!.value).toBe(LIKE_COST);

    // Old karma box consumed (check via deps, which filters by spent_at_block)
    expect(deps.getBox(karmaBox.id!)).toBeNull();

    // New karma box (change) exists
    const newKarma = utxo.getKarmaBox(liker.userId);
    expect(newKarma).not.toBeNull();
    expect(newKarma!.value).toBe(changeVal);
  });

  // -------------------------------------------------------------------------
  // 2. Sub-block + like tx confirmed together
  // -------------------------------------------------------------------------

  it('sub-block and like tx confirmed together in one block', async () => {
    const dbModule = await importDb();
    dbModule.initDb(':memory:');
    const db = dbModule.getDb();

    // ---- Setup ----
    const author = makeTestIdentity();
    const liker = makeTestIdentity();

    const identities = await importIdentities();
    identities.insertIdentity(author.userId, author.publicKey);
    identities.insertIdentity(liker.userId, liker.publicKey);

    const utxo = await importUtxo();
    const karmaBox = makeKarmaBox(100, liker.userId, 0);
    utxo.insertBox(karmaBox);

    const post = makePost(author.userId, 'multi-op test');
    const postId = computePostId(post);
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    // Insert sub-block into mempool
    const mempool = await importMempool();
    const subBlock: SubBlock = {
      subBlockId: postId,
      post,
      likeBoxes: [],
      producerId: author.userId,
      protocolVersion: PROTOCOL_VERSION,
    };
    mempool.insertSubBlock(subBlock, 1000);

    // Cast like via service
    const changeVal = karmaBox.value - LIKE_COST;
    const likeTx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [
        {
          boxType: 'karma',
          value: changeVal,
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
          targetPostId: postId,
          guard: 'epoch_tally',
        } as LikeBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const likerPubHex = Buffer.from(liker.userId).toString('hex');
    signTransaction(likeTx, liker.privateKey, likerPubHex);

    const likesSvc = await importLikesService();
    const deps = makeEngineDeps(db, utxo);
    const likeResult = likesSvc.castLike(deps, likeTx, 0);
    expect(likeResult.castLikeResult).toBe('pending');

    // ---- Mine block ----
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = bc.createOrderingBlock() as Record<string, unknown> | null;
    expect(block).not.toBeNull();
    const blockHeight = block!.height as number;

    // ---- Apply UTXO tx (simulates block ingestion by verifier) ----
    const applied = await ingestTx(deps, likeTx, blockHeight);
    expect(applied).toBe(true);

    // ---- Verify ----
    // Post confirmed (sub-block path)
    const confirmedPost = posts.getPost(postId);
    expect(confirmedPost).not.toBeNull();

    // Like box created (UTXO path)
    const likeBoxes = utxo.getUnprocessedLockedLikeBoxes();
    const found = likeBoxes.find(
      (lb) =>
        lb.targetPostId === postId &&
        Buffer.from(lb.likerId).toString('hex') === likerPubHex,
    );
    expect(found).toBeDefined();

    // Old karma consumed (check via deps, which filters by spent_at_block)
    expect(deps.getBox(karmaBox.id!)).toBeNull();

    // Block stored in ordering
    const ordering = await importOrdering();
    const storedBlock = ordering.getOrderingBlock(blockHeight);
    expect(storedBlock).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 3. Invite tx: validate → mempool → mine → apply → confirm
  // -------------------------------------------------------------------------

  it('invite tx flows through validate, mempool, mine, apply, and confirm', async () => {
    const dbModule = await importDb();
    dbModule.initDb(':memory:');
    const db = dbModule.getDb();

    // ---- Setup ----
    const inviter = makeTestIdentity();
    const invitee = makeTestIdentity();

    const identities = await importIdentities();
    identities.insertIdentity(inviter.userId, inviter.publicKey);
    identities.insertIdentity(invitee.userId, invitee.publicKey);

    const utxo = await importUtxo();
    const karmaBox = makeKarmaBox(100, inviter.userId, 0);
    utxo.insertBox(karmaBox);

    // Build invite tx with 3 outputs: karma change + invite + bond
    const changeVal = 100 - INVITE_KARMA_AMOUNT - INVITE_BOND_KARMA;
    const inviteTx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [
        {
          boxType: 'karma',
          value: changeVal,
          createdAtBlock: 0,
          owner: inviter.userId,
          guard: 'owner_signature',
          proofSource: 'invite_create',
          lastTouchBlock: 0,
        } as KarmaBox,
        {
          boxType: 'invite',
          value: INVITE_KARMA_AMOUNT,
          createdAtBlock: 0,
          inviterId: inviter.userId,
          inviteeId: invitee.userId,
          secretHash: new Uint8Array(32),
          guard: 'hash_preimage',
        } as InviteBox,
        {
          boxType: 'bond',
          value: INVITE_BOND_KARMA,
          createdAtBlock: 0,
          inviterId: inviter.userId,
          inviteePublicKey: new Uint8Array(0), // unset until claimed
          probationStartBlock: 0,
          probationEndBlock: 0,
          guard: 'owner_signature',
        } as BondBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const inviterPubHex = Buffer.from(inviter.userId).toString('hex');
    signTransaction(inviteTx, inviter.privateKey, inviterPubHex);

    // ---- Step 1: Create invite (validateTx + mempool) ----
    const invitesSvc = await importInvitesService();
    const deps = makeEngineDeps(db, utxo);
    const result = invitesSvc.createInvite(deps, inviteTx, 0);

    expect(result.status).toBe('pending');
    expect(result.txId).toBeTruthy();

    // ---- Step 2: Mine block ----
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = bc.createOrderingBlock() as Record<string, unknown> | null;
    expect(block).not.toBeNull();
    const blockHeight = block!.height as number;

    // ---- Step 3: Apply UTXO tx (simulates block ingestion by verifier) ----
    const applied = await ingestTx(deps, inviteTx, blockHeight);
    expect(applied).toBe(true);

    // ---- Step 4: Verify confirmed state ----
    // Old karma consumed (check via deps, which filters by spent_at_block)
    expect(deps.getBox(karmaBox.id!)).toBeNull();

    // Invite box created
    const inviteRows = db
      .prepare(
        "SELECT id FROM utxo_boxes WHERE box_type = 'invite' AND spent_at_block IS NULL",
      )
      .all() as Array<{ id: string }>;
    expect(inviteRows.length).toBe(1);

    // Bond box created
    const bondRows = db
      .prepare(
        "SELECT id FROM utxo_boxes WHERE box_type = 'bond' AND spent_at_block IS NULL",
      )
      .all() as Array<{ id: string }>;
    expect(bondRows.length).toBe(1);

    // New karma box for inviter (change)
    const newKarma = utxo.getKarmaBox(inviter.userId);
    expect(newKarma).not.toBeNull();
    expect(newKarma!.value).toBe(changeVal);
  });
});
