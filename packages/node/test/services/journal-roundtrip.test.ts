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
  computeTxId,
  encodePost,
  PROTOCOL_VERSION,
  LIKE_THRESHOLD,
  POST_LOCK_UNLOCK_PER_LIKES,
} from '@dagsocial/types';
import type {
  Post,
  LikeBox,
  KarmaBox,
  CreditBox,
  PostLockBox,
  OrderingBlock,
  UtxoTransaction,
} from '@dagsocial/types';
import type Database from 'better-sqlite3';
import {
  fixtureProvenance,
  signTransaction,
  makeTestIdentity,
  makePost,
  makeLikeBox,
  makeKarmaBox,
  makeApplicableBlock,
  makePruneEntry,
  hex,
  type TestIdentity,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// Spec B P1 acceptance: per-mutation-class apply → revert → re-apply
// round-trips (NODE_INTERFACE "Rollback (revertBlock)").
//
// Every test drives a REAL block through applyOrderingBlock — the funnel — so
// the journal under test is the one the store choke point recorded, never a
// hand-built fixture. Reverts go through the real reorg path. Three
// assertions per class:
//
//   1. DB identity — utxo_boxes plus the side tables (vouch_cooldowns,
//      dag_likes processed flags) equal their pre-block rows exactly.
//   2. Digest identity — with the ACTIVE prover singleton (the instance
//      tryGetAvlProver() hands to block-apply §13), the digest after revert
//      equals the pre-block digest.
//   3. Re-apply identity — applying the same block again succeeds and lands
//      on the same post-block digest as the first application.
//
// Fixture discipline: every seeded box is inserted BEFORE the prover is
// bootstrapped, so the AVL tree and the DB agree from height 0 on. After
// bootstrap, boxes only ever change through applied blocks. All reverts
// target fork heights ≥ 1 (height 0 holds two versions: the constructor's
// empty tree and the bootstrap tree).
// ---------------------------------------------------------------------------

const plainConfig = {
  port: 3000,
  dbPath: ':memory:',
  networkType: 'testnet' as const,
  nodeRole: 'miner' as const,
  postPowTargetBits: 20,
  challengeWindowBlocks: 10,
  orderingBlockIntervalMs: 60000,
  orderingBlockMinSubBlocks: 1,
  maxSubBlocksPerBlock: 1000,
  epochBlocks: 100, // no epoch boundary inside these tests
  miningMode: 'internal' as const,
  orderingBlockPowTargetBits: 12,
  creditTreasuryPct: 10,
  treasuryPubKey: '',
  bootstrapPeers: [] as string[],
  listenAddrs: '/ip4/127.0.0.1/tcp/0',
  maxPeers: 50,
};

const epochConfig = { ...plainConfig, epochBlocks: 2 }; // tally on block 3

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
  return (await import('../../src/services/block-creator.js')) as unknown as {
    startBlockCreator: (cfg: typeof plainConfig) => void;
    stopBlockCreator: () => void;
    createOrderingBlock: () => OrderingBlock | null;
  };
}

async function importBlockApply() {
  return (await import('../../src/services/block-apply.js')) as unknown as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
    computePostBlockStateRoot: (block: OrderingBlock, height: number) => string | null;
  };
}

async function importForkResolution() {
  return (await import('../../src/services/fork-resolution.js')) as unknown as {
    reorg: (forkHeight: number, newBlocks: OrderingBlock[]) => void;
  };
}

async function importAvl() {
  return (await import('../../src/state/avl-prover.js')) as
    typeof import('../../src/state/avl-prover.js');
}

async function importPosts() {
  return (await import('../../src/store/posts.js')) as {
    insertPost: (post: Post, rawCbor: Uint8Array) => void;
    getPost: (id: string) => Post | null;
  };
}

async function importMempool() {
  return (await import('../../src/store/mempool.js')) as {
    insertSubBlock: (postId: string, expiresAtHeight: number) => number;
    insertUtxoTx: (
      tx: UtxoTransaction,
      batchId: string | null,
      expiresAtHeight: number,
    ) => number;
    getPendingEntries: (limit: number) => Array<{ entryType: string }>;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    getBox: (boxId: string) => { id?: string; value: bigint } | null;
    getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
    getCreditBoxes: (owner: Uint8Array) => CreditBox[];
    getUnspentBoxes: () => import('@dagsocial/types').AnyBox[];
  };
}

async function importLikes() {
  return (await import('../../src/store/likes.js')) as {
    insertLike: (targetPostId: string, likerId: Uint8Array) => string;
  };
}

async function importVouch() {
  return (await import('../../src/store/vouch-cooldowns.js')) as {
    insertVouchCooldown: (
      voucherId: Uint8Array,
      targetId: Uint8Array,
      releaseAtBlock: number,
      karmaAmount: bigint,
    ) => void;
    getVouchCooldowns: (
      voucherId: Uint8Array,
    ) => Array<{ targetId: Uint8Array; releaseAtBlock: number; karmaAmount: bigint }>;
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** utxo_boxes + every side table a mutation class touches, in stable order. */
function dumpState(db: Database) {
  return {
    boxes: db.prepare('SELECT * FROM utxo_boxes ORDER BY id').all(),
    vouches: db
      .prepare('SELECT * FROM vouch_cooldowns ORDER BY voucher_id, target_id')
      .all(),
    freeLikes: db.prepare('SELECT * FROM dag_likes ORDER BY id').all(),
    // Spec G phase D: identity records are the second **committed** entity, so
    // "DB identity after revert" has to cover them. Every class that mints
    // non-decay karma now writes one, which is most of them — leaving this out
    // would let a record survive a revert unnoticed in all of them.
    identityRecords: db
      .prepare('SELECT * FROM identity_records ORDER BY identity_id')
      .all(),
  };
}

/** Persisted journal rows — the speculative state-root run must add none. */
function journalHeights(db: Database): number[] {
  return (
    db.prepare('SELECT block_height FROM block_journal ORDER BY block_height').all() as Array<{
      block_height: number;
    }>
  ).map((r) => r.block_height);
}

/**
 * Activate the AVL prover singleton on the test DB and (when boxes were
 * seeded) bootstrap them into the tree — the production startup wiring from
 * src/index.ts. Returns the handle whose digest §13 of block-apply advances.
 */
async function activateProver() {
  const avlMod = await importAvl();
  const utxo = await importUtxo();
  const handle = avlMod.createAvlProver();
  const unspent = utxo.getUnspentBoxes();
  if (unspent.length > 0) {
    avlMod.bootstrapAvlProver(handle, unspent, 0, []);
  }
  expect(avlMod.tryGetAvlProver()).not.toBeNull();
  return handle;
}

function digestOf(handle: { prover: { digest(): Uint8Array | null } }): Uint8Array {
  const d = handle.prover.digest();
  expect(d).not.toBeNull();
  return new Uint8Array(d!);
}

interface Snapshot {
  height: number;
  state: ReturnType<typeof dumpState>;
  digest: Uint8Array;
}

function takeSnapshot(
  db: DbModule,
  handle: { prover: { digest(): Uint8Array | null } },
  height: number,
): Snapshot {
  return { height, state: dumpState(db.getDb()), digest: digestOf(handle) };
}

/**
 * The shared tail of every class test: revert the class block through the
 * real reorg path and check all three P1 acceptance properties, plus the
 * P3/H-6 property that rides on the same restored pre-state — the digest the
 * producer computes speculatively equals the one the real apply produces.
 */
async function assertRoundTrip(
  db: DbModule,
  handle: { prover: { digest(): Uint8Array | null } },
  pre: Snapshot,
  classBlock: OrderingBlock,
): Promise<void> {
  const postDigest = digestOf(handle);
  // Non-vacuity: the class block must have moved the prover.
  expect(Buffer.from(postDigest).equals(Buffer.from(pre.digest))).toBe(false);

  // Revert through the real reorg path.
  const forkResolution = await importForkResolution();
  forkResolution.reorg(pre.height, []);

  const ordering = await importOrdering();
  expect(ordering.getCurrentHeight()).toBe(pre.height);

  // 1. DB identity — exact pre-block rows, spent markers included.
  expect(dumpState(db.getDb())).toEqual(pre.state);

  // 2. Digest identity — the active prover is back at the pre-block digest.
  expect(Buffer.from(digestOf(handle)).equals(Buffer.from(pre.digest))).toBe(true);

  // 2b. Speculation identity (P3/H-6) — on this restored pre-state, the digest
  //     the producer computes *without applying anything* is the digest step 3
  //     below actually lands on. That is what makes `header.stateRoot`
  //     checkable: producer and verifier run one implementation of the state
  //     transition, not two.
  const blockApply = await importBlockApply();
  const journalsBefore = journalHeights(db.getDb());
  const speculative = blockApply.computePostBlockStateRoot(
    classBlock,
    classBlock.header.height,
  );
  expect(speculative).toBe(Buffer.from(postDigest).toString('hex'));
  // …and it is what the producer committed to before mining, so a verifier
  // running VERIFY_STATE_ROOT accepts exactly the blocks a producer builds.
  expect(classBlock.header.stateRoot).toBe(speculative);

  // 2c. …and it left no trace: its transaction rolled back, the prover was
  //     restored by hand (SQLite rollback cannot reach it), and it persisted
  //     no journal row.
  expect(dumpState(db.getDb())).toEqual(pre.state);
  expect(Buffer.from(digestOf(handle)).equals(Buffer.from(pre.digest))).toBe(true);
  expect(journalHeights(db.getDb())).toEqual(journalsBefore);

  // 3. Re-apply identity — the same block applies again onto the restored
  //    state and lands on the same post-block digest.
  expect(blockApply.applyOrderingBlock(classBlock)).toBe(true);
  expect(Buffer.from(digestOf(handle)).equals(Buffer.from(postDigest))).toBe(true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('journal round-trip per mutation class (P1 acceptance)', () => {
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
  // Coinbase — the mint merges the owner's pre-existing credit box; revert
  // must restore the merged-in original (the merge-consume value-loss fix).
  // -----------------------------------------------------------------------

  it('coinbase: merge-consumed credit originals restored', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const minerB = makeTestIdentity();
    const utxo = await importUtxo();
    const seeded: CreditBox = {
      boxType: 'credit',
      value: 100n,
      owner: minerB.userId,
      guard: 'owner_signature',
      proofSource: 0,
    };
    Object.assign(seeded, fixtureProvenance(seeded, 1));
    seeded.id = computeBoxId(seeded);
    utxo.insertBox(seeded);

    const handle = await activateProver();
    const blockApply = await importBlockApply();

    // Baseline block 1 pays a fresh miner — minerB's box is untouched.
    expect(blockApply.applyOrderingBlock(await makeApplicableBlock())).toBe(true);
    const pre = takeSnapshot(db, handle, 1);

    // Class block: coinbase paying minerB — mintCredits consumes the seeded
    // box and creates one merged box.
    const classBlock = await makeApplicableBlock({ height: 2, miner: minerB });
    expect(blockApply.applyOrderingBlock(classBlock)).toBe(true);

    expect(utxo.getBox(seeded.id!)).toBeNull(); // merged in (spent)
    const merged = utxo.getCreditBoxes(minerB.userId);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.value).toBeGreaterThan(100n);

    await assertRoundTrip(db, handle, pre, classBlock);
  });

  // -----------------------------------------------------------------------
  // Epoch author-mint — reward mint merges the author's pre-existing karma.
  // -----------------------------------------------------------------------

  it('epoch author-mint: merged karma originals restored', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const utxo = await importUtxo();
    const posts = await importPosts();

    const authorStart = makeKarmaBox(100n, author.userId, 0);
    utxo.insertBox(authorStart);

    const post = makePost(author.userId, 'author-mint round-trip');
    const postId = computePostId(post);
    posts.insertPost(post, encodePost(post));

    // 6 locked likes: floor(6/5) = 1 author reward, but 6 < 2×LIKE_THRESHOLD
    // so no like box is tallied — the only box mutations besides coinbase
    // are the author's merge-consume + merged insert.
    for (let i = 0; i < LIKE_THRESHOLD + 1; i++) {
      const liker = makeTestIdentity();
      utxo.insertBox(makeLikeBox(liker.userId, postId, 0));
    }

    const handle = await activateProver();
    const bc = await importBlockCreator();
    bc.startBlockCreator(epochConfig);

    bc.createOrderingBlock(); // height 1
    bc.createOrderingBlock(); // height 2
    const pre = takeSnapshot(db, handle, 2);

    const classBlock = bc.createOrderingBlock(); // height 3 — epoch tally
    expect(classBlock).not.toBeNull();
    expect(classBlock!.utxoTxTree.epochTallyResults).toBeDefined();

    expect(utxo.getBox(authorStart.id!)).toBeNull();
    const held = utxo.getKarmaBox(author.userId);
    expect(held).not.toBeNull();
    expect(held!.value).toBe(101n); // 100 merged + 1 reward

    await assertRoundTrip(db, handle, pre, classBlock!);
  });

  // -----------------------------------------------------------------------
  // Like-tally (H-5) — tallied like boxes are spent by the epoch and must
  // come back unspent on revert.
  // -----------------------------------------------------------------------

  it('like-tally: tallied like boxes restored unspent', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const utxo = await importUtxo();
    const posts = await importPosts();

    const post = makePost(author.userId, 'like-tally round-trip');
    const postId = computePostId(post);
    posts.insertPost(post, encodePost(post));

    // ≥ 2×LIKE_THRESHOLD likes → the tally spends every like box (H-5).
    const likeBoxes: LikeBox[] = [];
    for (let i = 0; i < 2 * LIKE_THRESHOLD; i++) {
      const liker = makeTestIdentity();
      const lb = makeLikeBox(liker.userId, postId, 0);
      utxo.insertBox(lb);
      likeBoxes.push(lb);
    }

    const handle = await activateProver();
    const bc = await importBlockCreator();
    bc.startBlockCreator(epochConfig);

    bc.createOrderingBlock(); // height 1
    bc.createOrderingBlock(); // height 2
    const pre = takeSnapshot(db, handle, 2);

    const classBlock = bc.createOrderingBlock(); // height 3 — epoch tally
    expect(classBlock).not.toBeNull();

    for (const lb of likeBoxes) {
      expect(utxo.getBox(lb.id!)).toBeNull(); // really spent in the DB
    }

    await assertRoundTrip(db, handle, pre, classBlock!);
  });

  // -----------------------------------------------------------------------
  // Post-lock swap — the epoch consumes the lock box and inserts the
  // remainder replacement; free likes drive the unlock so the dag_likes
  // processed flags round-trip too.
  // -----------------------------------------------------------------------

  it('post-lock swap: consumed lock box and processed free likes restored', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const utxo = await importUtxo();
    const posts = await importPosts();
    const likes = await importLikes();

    const post = makePost(author.userId, 'post-lock round-trip');
    const postId = computePostId(post);
    posts.insertPost(post, encodePost(post));

    const lockBox: PostLockBox = {
      boxType: 'post_lock',
      value: 30n,
      originalValue: 30n,
      owner: author.userId,
      targetPostId: postId,
      guard: 'epoch_tally',
    };
    Object.assign(lockBox, fixtureProvenance(lockBox, 1));
    lockBox.id = computeBoxId(lockBox);
    utxo.insertBox(lockBox);

    // POST_LOCK_UNLOCK_PER_LIKES free likes → unlock 1 karma at the epoch;
    // no locked like boxes, so the lock swap is the only tally box effect.
    for (let i = 0; i < POST_LOCK_UNLOCK_PER_LIKES; i++) {
      likes.insertLike(postId, makeTestIdentity().userId);
    }

    const handle = await activateProver();
    const bc = await importBlockCreator();
    bc.startBlockCreator(epochConfig);

    bc.createOrderingBlock(); // height 1
    bc.createOrderingBlock(); // height 2
    const pre = takeSnapshot(db, handle, 2);
    // Pre-block: every free like is unprocessed.
    expect(
      (pre.state.freeLikes as Array<{ processed: number }>).every((r) => r.processed === 0),
    ).toBe(true);

    const classBlock = bc.createOrderingBlock(); // height 3 — epoch tally
    expect(classBlock).not.toBeNull();

    // Swap happened: old lock box spent, replacement carries the remainder.
    expect(utxo.getBox(lockBox.id!)).toBeNull();
    const replacement = dumpState(db.getDb()).boxes.find(
      (r) =>
        (r as { box_type: string }).box_type === 'post_lock' &&
        (r as { spent_at_block: number | null }).spent_at_block === null,
    ) as { value: number | bigint } | undefined;
    expect(replacement).toBeDefined();
    expect(BigInt(replacement!.value)).toBe(29n);
    // Free likes consumed by the tally.
    const processedNow = dumpState(db.getDb()).freeLikes as Array<{ processed: number }>;
    expect(processedNow.every((r) => r.processed === 1)).toBe(true);

    await assertRoundTrip(db, handle, pre, classBlock!);
  });

  // -----------------------------------------------------------------------
  // User tx — a signed credit transfer embedded in the block.
  // -----------------------------------------------------------------------

  it('user-tx: credit transfer inputs unspent and outputs gone after revert', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const sender = makeTestIdentity();
    const recipient = makeTestIdentity();
    const utxo = await importUtxo();

    const senderBox: CreditBox = {
      boxType: 'credit',
      value: 100n,
      owner: sender.userId,
      guard: 'owner_signature',
      proofSource: 0,
    };
    Object.assign(senderBox, fixtureProvenance(senderBox, 1));
    senderBox.id = computeBoxId(senderBox);
    utxo.insertBox(senderBox);

    const handle = await activateProver();
    const bc = await importBlockCreator();
    bc.startBlockCreator(plainConfig);

    bc.createOrderingBlock(); // height 1 baseline
    const pre = takeSnapshot(db, handle, 1);

    // Signed, value-conserving credit transfer: 40 to the recipient, 60 change.
    const tx: UtxoTransaction = {
      inputs: [senderBox.id!],
      outputs: [
        {
          boxType: 'credit',
          value: 40n,
          owner: recipient.userId,
          guard: 'owner_signature',
          proofSource: -1,
        } as CreditBox,
        {
          boxType: 'credit',
          value: 60n,
          owner: sender.userId,
          guard: 'owner_signature',
          proofSource: -1,
        } as CreditBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, sender.privateKey, hex(sender.userId));

    const mempool = await importMempool();
    mempool.insertUtxoTx(tx, null, 1000);

    const classBlock = bc.createOrderingBlock(); // height 2 carries the tx
    expect(classBlock).not.toBeNull();
    expect(classBlock!.utxoTxTree.utxoTxIds).toContain(computeTxId(tx));

    expect(utxo.getBox(senderBox.id!)).toBeNull(); // spent
    expect(utxo.getCreditBoxes(recipient.userId)).toHaveLength(1);

    await assertRoundTrip(db, handle, pre, classBlock!);
  });

  // -----------------------------------------------------------------------
  // Prune settlement — consumes PostLockBox + LikeBox and merge-mints the
  // refunds; revert restores the settled rows exactly. (Extends the Phase B
  // block-apply revert test with digest + re-apply identity.)
  // -----------------------------------------------------------------------

  it('prune settlement: settled boxes and merge-consumed karma restored', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const liker = makeTestIdentity();
    const utxo = await importUtxo();
    const posts = await importPosts();

    const post = makePost(author.userId, 'prune round-trip victim');
    const postId = computePostId(post);
    posts.insertPost(post, encodePost(post));

    // Everything a settlement touches, seeded before bootstrap: the author's
    // karma (merge target), the post's lock box, and a locked like.
    const authorKarma = makeKarmaBox(20n, author.userId, 0);
    utxo.insertBox(authorKarma);
    const lockBox: PostLockBox = {
      boxType: 'post_lock',
      value: 30n,
      originalValue: 30n,
      owner: author.userId,
      targetPostId: postId,
      guard: 'epoch_tally',
    };
    Object.assign(lockBox, fixtureProvenance(lockBox, 1));
    lockBox.id = computeBoxId(lockBox);
    utxo.insertBox(lockBox);
    const likeBox = makeLikeBox(liker.userId, postId, 0);
    utxo.insertBox(likeBox);

    const handle = await activateProver();
    const blockApply = await importBlockApply();

    // Block 1 confirms the post — prune authorization reads block_topology.
    const confirmBlock = await makeApplicableBlock({
      subBlockEntries: [{ postId, parentRefs: [], author: hex(author.userId) }],
    });
    expect(blockApply.applyOrderingBlock(confirmBlock)).toBe(true);
    const pre = takeSnapshot(db, handle, 1);

    const classBlock = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(postId, [postId], author)],
    });
    expect(blockApply.applyOrderingBlock(classBlock)).toBe(true);

    // Settled: lock + like + the author's pre-existing karma all consumed.
    expect(utxo.getBox(lockBox.id!)).toBeNull();
    expect(utxo.getBox(likeBox.id!)).toBeNull();
    expect(utxo.getBox(authorKarma.id!)).toBeNull();
    // Refunds minted: author 20+30 merged, liker 2.
    expect(utxo.getKarmaBox(author.userId)!.value).toBe(50n);
    expect(utxo.getKarmaBox(liker.userId)!.value).toBe(2n);
    // All three consumptions are in the journal the revert below replays.
    const journalStore = (await import('../../src/store/journal.js')) as {
      getBlockJournal: (h: number) => import('../../src/store/journal.js').BlockJournal | null;
    };
    const saved = journalStore.getBlockJournal(2)!;
    expect(
      saved.mutations
        .filter((m) => m.kind === 'box' && m.op === 'remove')
        .map((m) => (m as { boxId: string }).boxId),
    ).toEqual(expect.arrayContaining([lockBox.id, likeBox.id, authorKarma.id]));

    await assertRoundTrip(db, handle, pre, classBlock);

    // The re-applied block leaves the same settled state again.
    expect(utxo.getKarmaBox(author.userId)!.value).toBe(50n);
    expect(utxo.getBox(lockBox.id!)).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Vouch-cooldown mint (H-7) — the matured escrow row is deleted and its
  // karma merge-minted; revert restores the escrow row and the original box.
  // (Extends the Phase B fork-resolution revert test with the reorg path,
  // digest identity, and re-apply identity.)
  // -----------------------------------------------------------------------

  it('vouch-cooldown mint: escrow row and merged karma originals restored', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const voucher = makeTestIdentity();
    const target = makeTestIdentity();
    const utxo = await importUtxo();
    const vouch = await importVouch();

    const oldKarma = makeKarmaBox(50n, voucher.userId, 0);
    utxo.insertBox(oldKarma);
    // Matures at height 2 — block 1 leaves it untouched.
    vouch.insertVouchCooldown(voucher.userId, target.userId, 2, 7n);

    const handle = await activateProver();
    const blockApply = await importBlockApply();

    expect(blockApply.applyOrderingBlock(await makeApplicableBlock())).toBe(true);
    expect(vouch.getVouchCooldowns(voucher.userId)).toHaveLength(1); // not yet matured
    const pre = takeSnapshot(db, handle, 1);

    const classBlock = await makeApplicableBlock({ height: 2 });
    expect(blockApply.applyOrderingBlock(classBlock)).toBe(true);

    // Mint happened: old box spent, merged 57n box, escrow row gone.
    expect(utxo.getBox(oldKarma.id!)).toBeNull();
    const merged = utxo.getKarmaBox(voucher.userId);
    expect(merged).not.toBeNull();
    expect(merged!.value).toBe(57n);
    expect(vouch.getVouchCooldowns(voucher.userId)).toHaveLength(0);

    await assertRoundTrip(db, handle, pre, classBlock);

    // The re-applied block leaves the same applied state again.
    expect(utxo.getKarmaBox(voucher.userId)!.value).toBe(57n);
    expect(vouch.getVouchCooldowns(voucher.userId)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Decay — block-level, reached by shrinking the thresholds through a
  // test-local mock of the config module so a 4-block chain crosses the
  // staleness window. The env overrides these tests used before P2-A were
  // the consensus violation the network profile removed; a module mock is a
  // seam only a test can reach — a running node has no equivalent.
  // -----------------------------------------------------------------------

  it('decay: consumed karma boxes and the decay-burn box round-trip', async () => {
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

      const idle = makeTestIdentity();
      const utxo = await importUtxo();
      const oldBox = makeKarmaBox(50n, idle.userId, 0);
      utxo.insertBox(oldBox);

      const handle = await activateProver();
      const bc = await importBlockCreator();
      bc.startBlockCreator(plainConfig);

      // Heights 1–3: currentHeight ≤ threshold → staleness guard skips decay.
      bc.createOrderingBlock();
      bc.createOrderingBlock();
      bc.createOrderingBlock();
      expect(utxo.getBox(oldBox.id!)).not.toBeNull();
      const pre = takeSnapshot(db, handle, 3);

      // Height 4 > threshold 3: stale, owes 4 periods × 5 = 20, capped at
      // value − minimum = 40 → burn 20, one consolidated decay-burn box.
      const classBlock = bc.createOrderingBlock();
      expect(classBlock).not.toBeNull();

      expect(utxo.getBox(oldBox.id!)).toBeNull();
      const burned = utxo.getKarmaBox(idle.userId);
      expect(burned).not.toBeNull();
      expect(burned!.value).toBe(30n);
      expect((burned as KarmaBox & { decayBurn?: boolean }).decayBurn).toBe(true);

      await assertRoundTrip(db, handle, pre, classBlock!);
    } finally {
      vi.doUnmock('../../src/config.js');
    }
  });

  it('identity record: two puts to one key in one block reach the tree as the LAST value', async () => {
    // The record mutation class, and with it the coverage gap phase B's report
    // §5 handed forward.
    //
    // Phase B built `proverFeedFromJournal`'s record arm — including the
    // collapse-duplicates-to-last-write rule — and could not test it: nothing
    // populated records, so deleting the arm outright killed nothing. This is
    // the first block that writes the same record key **twice**.
    //
    // Two puts in one block need decay and a karma mint for the same owner at
    // one height, which the mutation phase's ordering makes reachable:
    // `applyKarmaDecay` (block-apply.ts:1018) writes `lastDecayBlock`, then
    // `processVouchCooldowns` (:1026) mints and `insertBox` writes
    // `lastActivityBlock`. Journal order carries which came last; a sort by key
    // cannot, which is why the collapse lives in the feed and not in
    // `applyBlockMutations`.
    // Thresholds shrunk through a test-local config mock — see the section
    // comment above for why this replaced the env overrides.
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

      const idle = makeTestIdentity();
      const target = makeTestIdentity();
      const utxo = await importUtxo();
      utxo.insertBox(makeKarmaBox(50n, idle.userId, 0));

      const vouchStore = await import('../../src/store/vouch-cooldowns.js');
      const recordStore = await import('../../src/store/identity-records.js');
      const { VOUCH_KARMA_AMOUNT } = await import('@dagsocial/types');
      // Matures at height 4 — the same block decay first fires in.
      vouchStore.insertVouchCooldown(idle.userId, target.userId, 4, VOUCH_KARMA_AMOUNT);

      const handle = await activateProver();
      const bc = await importBlockCreator();
      bc.startBlockCreator(plainConfig);

      bc.createOrderingBlock();
      bc.createOrderingBlock();
      bc.createOrderingBlock();
      const pre = takeSnapshot(db, handle, 3);
      // Non-vacuity: no record exists yet, so the class block creates one.
      expect(recordStore.getIdentityRecord(idle.userId)).toBeNull();

      const classBlock = bc.createOrderingBlock();
      expect(classBlock).not.toBeNull();

      // Both writes happened, in that order.
      const journalStore = await import('../../src/store/journal.js');
      const recordMutations = journalStore
        .getBlockJournal(4)!
        .mutations.filter((m) => m.kind === 'record');
      expect(recordMutations).toHaveLength(2);
      expect(recordMutations[0]).toMatchObject({ record: { lastDecayBlock: 4 } });
      expect(recordMutations[1]).toMatchObject({
        record: { lastActivityBlock: 4, lastDecayBlock: 4 },
      });

      // The TREE holds the last write, not the first. Read it back through the
      // prover, which is the only place the collapse can be observed.
      const key = Buffer.from(recordStore.identityRecordKey(idle.userId), 'hex');
      const serialize = await import('../../src/state/serialize-box.js');
      const lookup = handle.prover.performOneOperation({ tag: 'Lookup', key });
      expect(lookup.success).toBe(true);
      expect(lookup.value).toBeTruthy();
      expect(serialize.deserializeIdentityRecord(lookup.value!)).toEqual({
        lastActivityBlock: 4,
        lastDecayBlock: 4,
      });
      // The lookup above recorded proof directions; drop them so the digest
      // comparisons below see the same prover state the block left behind.
      handle.prover.prover.generateProof();

      // Round-trip. Assertion 1 (DB identity) now covers `identity_records`,
      // and `pre.state` has none — so a revert that restored the intra-block
      // intermediate instead of "absent" fails there, which is exactly the
      // reverse-replay property. `assertRoundTrip` re-applies at the end.
      await assertRoundTrip(db, handle, pre, classBlock!);

      // Re-apply landed the record back on the last write, not the first.
      expect(recordStore.getIdentityRecord(idle.userId)).toEqual({
        lastActivityBlock: 4,
        lastDecayBlock: 4,
      });
    } finally {
      vi.doUnmock('../../src/config.js');
    }
  });
});
