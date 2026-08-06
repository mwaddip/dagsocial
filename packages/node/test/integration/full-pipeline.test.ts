/**
 * Full-pipeline integration tests: validate → mempool → mine → confirm.
 *
 * These tests exercise the complete lifecycle of UTXO transactions (likes,
 * invites) through validation, mempool insertion, block mining, and state
 * confirmation.  The block creator applies UTXO transactions during
 * finalizeBlock, so no manual ingestion step is needed.
 */
import {
  fixtureProvenance, rawPublicKey, signTransaction } from '../helpers.js';
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
  computeCandidateBoxId,
  computeTxId,
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
  networkType: 'testnet' as const,
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
    insertSubBlock: (postId: string, expiresAtHeight: number, batchId?: string | null) => number;
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

function makeKarmaBox(value: bigint, owner: Uint8Array, seed: number): KarmaBox {
  // `seed` was `createdAtBlock` before phase G3b deleted the field. It is no
  // longer a box property — it only varies the fixture's synthetic provenance,
  // so two boxes that differ solely by the height a caller passed still get
  // distinct ids rather than colliding on UNIQUE(tx_id, output_index).
  const box: KarmaBox = {
    boxType: 'karma',
    value,
    owner,
    guard: 'owner_signature',
    proofSource: 'genesis',
  };
  Object.assign(box, fixtureProvenance(box, seed));
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


    const utxo = await importUtxo();
    const karmaBox = makeKarmaBox(100n, liker.userId, 0);
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
          owner: liker.userId,
          guard: 'owner_signature',
          proofSource: 'like_op',
        } as KarmaBox,
        {
          boxType: 'like',
          value: LIKE_COST,
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
    const blockHeight = (block!.header as Record<string, unknown>).height as number;
    expect(blockHeight).toBe(1);

    // ---- Step 3: Verify confirmed state (UTXO txs applied by block creator) ----
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


    const utxo = await importUtxo();
    const karmaBox = makeKarmaBox(100n, liker.userId, 0);
    utxo.insertBox(karmaBox);

    const post = makePost(author.userId, 'multi-op test');
    const postId = computePostId(post);
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    // Insert sub-block into mempool
    const mempool = await importMempool();
    mempool.insertSubBlock(postId, 1000);

    // Cast like via service
    const changeVal = karmaBox.value - LIKE_COST;
    const likeTx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [
        {
          boxType: 'karma',
          value: changeVal,
          owner: liker.userId,
          guard: 'owner_signature',
          proofSource: 'like_op',
        } as KarmaBox,
        {
          boxType: 'like',
          value: LIKE_COST,
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
    const blockHeight = (block!.header as Record<string, unknown>).height as number;

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


    const utxo = await importUtxo();
    const karmaBox = makeKarmaBox(100n, inviter.userId, 0);
    utxo.insertBox(karmaBox);

    // Build invite tx with 3 outputs: karma change + invite + bond
    const changeVal = 100n - INVITE_KARMA_AMOUNT - INVITE_BOND_KARMA;
    const inviteTx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [
        {
          boxType: 'karma',
          value: changeVal,
          owner: inviter.userId,
          guard: 'owner_signature',
          proofSource: 'invite_create',
        } as KarmaBox,
        {
          boxType: 'invite',
          value: INVITE_KARMA_AMOUNT,
          inviterId: inviter.userId,
          inviteeId: invitee.userId,
          secretHash: new Uint8Array(32),
          guard: 'hash_preimage',
        } as InviteBox,
        {
          boxType: 'bond',
          value: INVITE_BOND_KARMA,
          inviterId: inviter.userId,
          // The invite is output 1 of this transaction ([karma, invite, bond]).
          inviteOutputIndex: 1,
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
    const blockHeight = (block!.header as Record<string, unknown>).height as number;

    // ---- Step 3: Verify confirmed state (UTXO txs applied by block creator) ----
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
  // -------------------------------------------------------------------------
  // 4. Predicted-id flows through a real block funnel (Spec G phase G3b)
  //
  // These are the two flows that got `p3a-box-id-parked` pulled as a functional
  // regression, and they are the reason provenance-derived identity exists. The
  // shape they need is NOT symmetric, because Option 1 changed what each one
  // depends on:
  //
  //   - the UNLIKE path still genuinely predicts a box id and spends it later,
  //     so what it needs is an EXACTNESS test — the id cached at signing time is
  //     the id block application stores.
  //   - the INVITE path no longer predicts anything. Its bond names an output
  //     index, so what it needs is the opposite: proof that a bond pointing at
  //     the wrong output is REJECTED AT CREATE, which is the property pairing by
  //     index buys and the thing that makes a mispaired bond inexpressible
  //     rather than late-failing as a dangling reference.
  // -------------------------------------------------------------------------

  it('unlike: the LikeBox id predicted at signing time is the id the block stores, and it spends', async () => {
    const dbModule = await importDb();
    dbModule.initDb(':memory:');
    const db = dbModule.getDb();

    const author = makeTestIdentity();
    const liker = makeTestIdentity();
    const utxo = await importUtxo();
    const karmaBox = makeKarmaBox(100n, liker.userId, 0);
    utxo.insertBox(karmaBox);

    const post = makePost(author.userId, 'unlike prediction test');
    const postId = computePostId(post);
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const likeTx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [
        {
          boxType: 'karma', value: karmaBox.value - LIKE_COST, owner: liker.userId,
          guard: 'owner_signature', proofSource: 'like_op',
        },
        {
          boxType: 'like', value: LIKE_COST, likerId: liker.userId,
          targetPostId: postId, guard: 'epoch_tally',
        },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const likerPubHex = Buffer.from(liker.userId).toString('hex');
    signTransaction(likeTx, liker.privateKey, likerPubHex);

    // What the demo UI does at signing time: derive the LikeBox id from the
    // transaction's OWN id and the output's position, and cache it. Nothing
    // about the ledger is consulted — this is a pure client-side prediction,
    // made before the transaction has been seen by anyone.
    const signedTxId = computeTxId(likeTx);
    const predictedLikeBoxId = computeCandidateBoxId(likeTx.outputs[1]!, signedTxId, 1);

    const likesSvc = await importLikesService();
    const deps = makeEngineDeps(db, utxo);
    expect(likesSvc.castLike(deps, likeTx, 0).castLikeResult).toBe('pending');

    // Through a real block funnel — mined and applied, not hand-inserted.
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    expect(bc.createOrderingBlock()).not.toBeNull();

    // EXACT, not merely resolvable: the stored box carries the predicted id.
    const storedLike = deps.getBox(predictedLikeBoxId);
    expect(storedLike).not.toBeNull();
    expect(storedLike!.boxType).toBe('like');
    expect((storedLike as LikeBox).targetPostId).toBe(postId);

    // And the prediction is ACTIONABLE, which is the point — the unlike path
    // spends the box by the id it cached, having never read it back from the
    // node. Under the parked branch's settled-height derivation this input did
    // not resolve, which is exactly how that regression presented.
    expect(storedLike!.id).toBe(predictedLikeBoxId);
    const unlikeTx: UtxoTransaction = {
      inputs: [predictedLikeBoxId],
      outputs: [
        {
          boxType: 'karma', value: LIKE_COST, owner: liker.userId,
          guard: 'owner_signature', proofSource: 'unlike',
        },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(unlikeTx, liker.privateKey, likerPubHex);
    const engine = await import('../../src/services/utxo-engine.js');
    const unlikeResult = engine.validateTx(deps, unlikeTx, 1);
    expect(unlikeResult.error).toBeUndefined();
    expect(unlikeResult.valid).toBe(true);
  });

  it('invite: a bond naming the wrong output index is rejected at create — and the right one still applies', async () => {
    const dbModule = await importDb();
    dbModule.initDb(':memory:');
    const db = dbModule.getDb();

    const inviter = makeTestIdentity();
    const utxo = await importUtxo();
    const invitesSvc = await importInvitesService();
    const deps = makeEngineDeps(db, utxo);

    const secretHash = new Uint8Array(32).fill(0x5a);
    const total = INVITE_KARMA_AMOUNT + INVITE_BOND_KARMA;

    // outputs are [karma, invite, bond] — the invite is at index 1.
    const buildInviteTx = (inviteOutputIndex: number, karmaIn: KarmaBox): UtxoTransaction => {
      const tx: UtxoTransaction = {
        inputs: [karmaIn.id!],
        outputs: [
          {
            boxType: 'karma', value: karmaIn.value - total, owner: inviter.userId,
            guard: 'owner_signature', proofSource: 'invite-create',
          },
          {
            boxType: 'invite', value: INVITE_KARMA_AMOUNT, secretHash,
            inviterId: inviter.userId, guard: 'hash_preimage_with_bond',
          },
          {
            boxType: 'bond', value: INVITE_BOND_KARMA, inviterId: inviter.userId,
            inviteOutputIndex,
            inviteePublicKey: new Uint8Array(0),
            probationStartBlock: 0, probationEndBlock: 0, guard: 'bond_dual',
          },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      signTransaction(tx, inviter.privateKey, Buffer.from(inviter.userId).toString('hex'));
      return tx;
    };

    // ---- The property Option 1 buys: a mispaired bond cannot be created ----
    //
    // Index 0 is the KARMA output, not the invite. Before Option 1 this field
    // was a BoxId that nothing validated at create, so a wrong value surfaced
    // one transaction later as "InviteBox not found for bond commit" — a
    // dangling reference. It is now a rejected transaction.
    const karmaA = makeKarmaBox(100n, inviter.userId, 0);
    utxo.insertBox(karmaA);
    expect(() => invitesSvc.createInvite(deps, buildInviteTx(0, karmaA), 0))
      .toThrow(/inviteOutputIndex must address the InviteBox output/);

    // Out of range entirely — the same rejection, not a crash on undefined.
    expect(() => invitesSvc.createInvite(deps, buildInviteTx(7, karmaA), 0))
      .toThrow(/inviteOutputIndex must address the InviteBox output/);

    // ---- Non-vacuity control: the CORRECT index still applies cleanly ----
    //
    // Without this the rejection test above would pass just as well against an
    // implementation that rejected every invite. This is the same fixture and
    // the same funnel, differing only in the field under test.
    const correct = buildInviteTx(1, karmaA);
    expect(invitesSvc.createInvite(deps, correct, 0).status).toBe('pending');

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    expect(bc.createOrderingBlock()).not.toBeNull();

    // Applied: the karma is consumed and both boxes exist.
    expect(deps.getBox(karmaA.id!)).toBeNull();
    const storedBond = db
      .prepare("SELECT id, tx_id, output_index FROM utxo_boxes WHERE box_type = 'bond' AND spent_at_block IS NULL")
      .get() as { id: string; tx_id: string; output_index: number };
    expect(storedBond).toBeDefined();

    // And the pairing RESOLVES the way the commit path will resolve it: the
    // bond's own txId plus its `inviteOutputIndex` names the InviteBox that
    // shipped with it. This is the assertion that the index is meaningful
    // rather than merely present.
    const bondBox = deps.getBox(storedBond.id) as BondBox;
    const paired = utxo.getBoxByProvenance(bondBox.txId, bondBox.inviteOutputIndex);
    expect(paired).not.toBeNull();
    expect(paired!.boxType).toBe('invite');
    expect((paired as InviteBox).secretHash).toEqual(secretHash);
  });
});
