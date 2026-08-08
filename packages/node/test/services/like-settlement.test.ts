import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computePostId,
  computeTxId,
  computeMintTxId,
  computeBoxId,
  encodePost,
  PROTOCOL_VERSION,
  LIKES_PER_KARMA_PAYOUT,
  POST_LOCK_UNLOCK_PER_LIKES,
} from '@dagsocial/types';
import type {
  KarmaBox,
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
  makeKarmaBox,
  makeLikeTx,
  changeBoxOf,
  makeApplicableBlock,
  makePruneEntry,
  hex,
  type TestIdentity,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// P2-D N2b: per-block like settlement (NODE_INTERFACE "Per-block like
// settlement"; ARCHITECTURE §Likes). The settlement is entirely derived —
// nothing rides in the block — so what these tests pin is the one shared
// implementation both producer and verifier run:
//
//   - apply-time like rules (confirmed + live target, author from topology,
//     structural dedup, liker = karma input owner) — any failure rejects the
//     whole block;
//   - author settlement arithmetic (carry, integer payout, the §1.3.1
//     grouping-independence property) and mint identity;
//   - post-lock vesting per block;
//   - exact inverses for every new mutation class (apply → revert → re-apply
//     round-trips through the real reorg path, digest identity included).
//
// Blocks are hand-built via makeApplicableBlock — including its P2-D
// `utxoTxs` embedding, which is the validator-embeds-a-tx shape that
// bypasses every gateway. That is deliberate: apply-time rules are consensus,
// not gateway courtesy, so the suite reaches them without the gateway's help.
// ---------------------------------------------------------------------------

const X = BigInt(LIKES_PER_KARMA_PAYOUT);

type DbModule = {
  initDb: (path: string) => void;
  getDb: () => Database;
  closeDb: () => void;
};

async function importDb(): Promise<DbModule> {
  return (await import('../../src/store/db.js')) as unknown as DbModule;
}

async function importBlockApply() {
  return (await import('../../src/services/block-apply.js')) as unknown as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
  };
}

async function importForkResolution() {
  return (await import('../../src/services/fork-resolution.js')) as {
    reorg: (forkHeight: number, newBlocks: OrderingBlock[]) => void;
    revertBlock: (height: number) => unknown;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    getBox: (boxId: string) => { id?: string; value: bigint } | null;
    getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
    getPostLockBox: (targetPostId: string) => PostLockBox | null;
    getUnspentBoxes: () => import('@dagsocial/types').AnyBox[];
  };
}

async function importPosts() {
  return (await import('../../src/store/posts.js')) as {
    insertPost: (post: import('@dagsocial/types').Post, rawCbor: Uint8Array) => void;
    getPost: (id: string) => unknown;
  };
}

async function importLikeRecords() {
  return (await import('../../src/store/likes.js')) as {
    insertLikeRecord: (targetPostId: string, likerId: Uint8Array, blockHeight: number) => void;
    hasLikeRecord: (targetPostId: string, likerId: Uint8Array) => boolean;
    getLikeRecordCount: (postId: string) => number;
  };
}

async function importRecords() {
  return (await import('../../src/store/identity-records.js')) as {
    getIdentityRecord: (
      id: Uint8Array,
    ) => { lastActivityBlock: number; lastDecayBlock: number; likeCarry: bigint } | null;
  };
}

async function importJournalStore() {
  return (await import('../../src/store/journal.js')) as typeof import('../../src/store/journal.js');
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
  };
}

async function importAvl() {
  return (await import('../../src/state/avl-prover.js')) as typeof import('../../src/state/avl-prover.js');
}

// ---------------------------------------------------------------------------
// Harness (the journal-roundtrip idiom, extended with `like_records` — the
// suite's own mutation class must be part of DB identity or a revert that
// leaked a record would pass)
// ---------------------------------------------------------------------------

function dumpState(db: Database) {
  return {
    boxes: db.prepare('SELECT * FROM utxo_boxes ORDER BY id').all(),
    likeRecords: db
      .prepare('SELECT * FROM like_records ORDER BY target_post_id, liker_id')
      .all(),
    identityRecords: db
      .prepare('SELECT * FROM identity_records ORDER BY identity_id')
      .all(),
  };
}

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

/** Apply → revert → re-apply for a settlement class block: DB identity
 *  (like_records included), digest identity, re-apply identity. */
async function assertRoundTrip(
  db: DbModule,
  handle: { prover: { digest(): Uint8Array | null } },
  pre: Snapshot,
  classBlock: OrderingBlock,
): Promise<void> {
  const postDigest = digestOf(handle);
  expect(Buffer.from(postDigest).equals(Buffer.from(pre.digest))).toBe(false);

  const forkResolution = await importForkResolution();
  forkResolution.reorg(pre.height, []);

  const ordering = await importOrdering();
  expect(ordering.getCurrentHeight()).toBe(pre.height);
  expect(dumpState(db.getDb())).toEqual(pre.state);
  expect(Buffer.from(digestOf(handle)).equals(Buffer.from(pre.digest))).toBe(true);

  // Re-apply must succeed and land on the same digest — the reorg flip-flop.
  const blockApply = await importBlockApply();
  expect(blockApply.applyOrderingBlock(classBlock)).toBe(true);
  expect(Buffer.from(digestOf(handle)).equals(Buffer.from(postDigest))).toBe(true);
}

/** Confirm `post` (whose content is already inserted) at the next height. */
async function confirmPostBlock(
  postId: string,
  author: TestIdentity,
  height = 1,
): Promise<OrderingBlock> {
  return makeApplicableBlock({
    height,
    subBlockEntries: [{ postId, parentRefs: [], author: hex(author.userId) }],
  });
}

/** n fresh likers, each with a seeded 2n karma box (nonce-distinct). */
async function seedLikers(n: number, nonceBase = 0): Promise<Array<{ id: TestIdentity; box: KarmaBox }>> {
  const utxo = await importUtxo();
  const likers: Array<{ id: TestIdentity; box: KarmaBox }> = [];
  for (let i = 0; i < n; i++) {
    const id = makeTestIdentity();
    const box = makeKarmaBox(2n, id.userId, 0, nonceBase + i);
    utxo.insertBox(box);
    likers.push({ id, box });
  }
  return likers;
}

function seedPostLock(value: bigint, author: TestIdentity, postId: string): PostLockBox {
  const lockBox: PostLockBox = {
    boxType: 'post_lock',
    value,
    originalValue: value,
    owner: author.userId,
    targetPostId: postId,
    guard: 'epoch_tally',
  };
  Object.assign(lockBox, fixtureProvenance(lockBox, 1));
  lockBox.id = computeBoxId(lockBox);
  return lockBox;
}

describe('per-block like settlement (P2-D N2b)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  // -------------------------------------------------------------------------
  // Arithmetic
  // -------------------------------------------------------------------------

  it('4 likes pay 0 and carry 4; the 5th in the next block pays 4 and zeroes the carry', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const records = await importRecords();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const post = makePost(author.userId, 'arithmetic target');
    const postId = computePostId(post);
    posts.insertPost(post, encodePost(post));

    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postId, author))).toBe(true);

    const likers = await seedLikers(5);
    const fourLikes = likers
      .slice(0, 4)
      .map((l) => makeLikeTx(l.id, l.box, postId));
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 2, utxoTxs: fourLikes }),
      ),
    ).toBe(true);

    // paid 0 — no karma minted to the author; carry 4 written unconditionally.
    expect(utxo.getKarmaBox(author.userId)).toBeNull();
    expect(records.getIdentityRecord(author.userId)).toMatchObject({ likeCarry: 4n });

    const fifth = makeLikeTx(likers[4]!.id, likers[4]!.box, postId);
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 3, utxoTxs: [fifth] }),
      ),
    ).toBe(true);

    // total 5 → paid (5/5)·4 = 4, carry 0.
    const paidBox = utxo.getKarmaBox(author.userId);
    expect(paidBox).not.toBeNull();
    expect(paidBox!.value).toBe(4n);
    expect(records.getIdentityRecord(author.userId)).toMatchObject({ likeCarry: 0n });
  });

  it('grouping independence (§1.3.1): the same 13 likes split any way pay the same total', async () => {
    const SPLITS: number[][] = [[13], [4, 9], [5, 5, 3]];
    const outcomes: Array<{ paid: bigint; carry: bigint }> = [];

    for (const split of SPLITS) {
      vi.resetModules();
      const db = await importDb();
      db.initDb(':memory:');
      const utxo = await importUtxo();
      const posts = await importPosts();
      const records = await importRecords();
      const blockApply = await importBlockApply();

      const author = makeTestIdentity();
      const post = makePost(author.userId, 'grouping target');
      const postId = computePostId(post);
      posts.insertPost(post, encodePost(post));
      expect(blockApply.applyOrderingBlock(await confirmPostBlock(postId, author))).toBe(true);

      let nonce = 0;
      let height = 1;
      for (const n of split) {
        const likers = await seedLikers(n, nonce);
        nonce += n;
        height += 1;
        const likeTxs = likers.map((l) => makeLikeTx(l.id, l.box, postId));
        expect(
          blockApply.applyOrderingBlock(
            await makeApplicableBlock({ height, utxoTxs: likeTxs }),
          ),
        ).toBe(true);
      }

      outcomes.push({
        paid: utxo.getKarmaBox(author.userId)?.value ?? 0n,
        carry: records.getIdentityRecord(author.userId)?.likeCarry ?? -1n,
      });
    }

    // 13 = 2·5 + 3 → paid 2·(5−1) = 8, carry 3 — whatever the grouping.
    for (const o of outcomes) {
      expect(o.paid).toBe((13n / X) * (X - 1n));
      expect(o.carry).toBe(13n % X);
    }
  });

  // -------------------------------------------------------------------------
  // Mint identity
  // -------------------------------------------------------------------------

  it('one like-payout mint per author per block: two authors → two mints, with pinned mint ids', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();

    const authorA = makeTestIdentity();
    const authorB = makeTestIdentity();
    const postA = makePost(authorA.userId, 'author A target');
    const postB = makePost(authorB.userId, 'author B target');
    const postAId = computePostId(postA);
    const postBId = computePostId(postB);
    posts.insertPost(postA, encodePost(postA));
    posts.insertPost(postB, encodePost(postB));

    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({
          subBlockEntries: [
            { postId: postAId, parentRefs: [], author: hex(authorA.userId) },
            { postId: postBId, parentRefs: [], author: hex(authorB.userId) },
          ],
        }),
      ),
    ).toBe(true);

    const likersA = await seedLikers(LIKES_PER_KARMA_PAYOUT, 0);
    const likersB = await seedLikers(LIKES_PER_KARMA_PAYOUT, 100);
    const likeTxs = [
      ...likersA.map((l) => makeLikeTx(l.id, l.box, postAId)),
      ...likersB.map((l) => makeLikeTx(l.id, l.box, postBId)),
    ];
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 2, utxoTxs: likeTxs }),
      ),
    ).toBe(true);

    // Each author: one 4n mint whose synthetic txId is
    // (height, 'like-payout', raw author bytes) — the pinned identity.
    const boxA = utxo.getKarmaBox(authorA.userId);
    const boxB = utxo.getKarmaBox(authorB.userId);
    expect(boxA!.value).toBe(X - 1n);
    expect(boxB!.value).toBe(X - 1n);
    expect(boxA!.txId).toBe(computeMintTxId(2, 'like-payout', authorA.userId));
    expect(boxB!.txId).toBe(computeMintTxId(2, 'like-payout', authorB.userId));
  });

  it('likes on two posts of one author in one block consolidate into ONE mint', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const post1 = makePost(author.userId, 'consolidation target 1');
    const post2 = makePost(author.userId, 'consolidation target 2');
    const post1Id = computePostId(post1);
    const post2Id = computePostId(post2);
    posts.insertPost(post1, encodePost(post1));
    posts.insertPost(post2, encodePost(post2));

    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({
          subBlockEntries: [
            { postId: post1Id, parentRefs: [], author: hex(author.userId) },
            { postId: post2Id, parentRefs: [], author: hex(author.userId) },
          ],
        }),
      ),
    ).toBe(true);

    const likers = await seedLikers(LIKES_PER_KARMA_PAYOUT);
    const likeTxs = [
      ...likers.slice(0, 3).map((l) => makeLikeTx(l.id, l.box, post1Id)),
      ...likers.slice(3).map((l) => makeLikeTx(l.id, l.box, post2Id)),
    ];
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 2, utxoTxs: likeTxs }),
      ),
    ).toBe(true);

    // 3 + 2 likes accrue per AUTHOR (design track §1.3.1) → one 4n mint. A
    // per-post settlement would have derived the same (height, reason,
    // subject) twice and tripped UNIQUE(tx_id, output_index), rejecting the
    // block — so applying at all is itself part of the property.
    const journal = await importJournalStore();
    const payoutTxId = computeMintTxId(2, 'like-payout', author.userId);
    const payoutInserts = journal
      .getBlockJournal(2)!
      .mutations.filter(
        (m) =>
          m.kind === 'box' &&
          m.op === 'insert' &&
          (m.box as KarmaBox).txId === payoutTxId,
      );
    expect(payoutInserts).toHaveLength(1);
    expect(utxo.getKarmaBox(author.userId)!.value).toBe(X - 1n);
  });

  // -------------------------------------------------------------------------
  // Dedup at apply
  // -------------------------------------------------------------------------

  it('two like txs for one (liker, target) in one block reject the whole block', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const likeRecords = await importLikeRecords();
    const ordering = await importOrdering();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const post = makePost(author.userId, 'same-block dedup target');
    const postId = computePostId(post);
    posts.insertPost(post, encodePost(post));
    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postId, author))).toBe(true);

    const liker = makeTestIdentity();
    const box1 = makeKarmaBox(2n, liker.userId, 0, 0);
    const box2 = makeKarmaBox(2n, liker.userId, 0, 1);
    utxo.insertBox(box1);
    utxo.insertBox(box2);

    const tx1 = makeLikeTx(liker, box1, postId);
    const tx2 = makeLikeTx(liker, box2, postId);
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 2, utxoTxs: [tx1, tx2] }),
      ),
    ).toBe(false);

    // All-or-nothing: the first like's effects rolled back with the block.
    expect(ordering.getCurrentHeight()).toBe(1);
    expect(utxo.getBox(box1.id!)).not.toBeNull();
    expect(utxo.getBox(box2.id!)).not.toBeNull();
    expect(likeRecords.hasLikeRecord(postId, liker.userId)).toBe(false);
  });

  it('a like confirmed in block N rejects the same (liker, target) in block N+1 — the N1→N2 window is closed', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const likeRecords = await importLikeRecords();
    const records = await importRecords();
    const ordering = await importOrdering();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const post = makePost(author.userId, 'cross-block dedup target');
    const postId = computePostId(post);
    posts.insertPost(post, encodePost(post));
    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postId, author))).toBe(true);

    const liker = makeTestIdentity();
    const box1 = makeKarmaBox(2n, liker.userId, 0, 0);
    const box2 = makeKarmaBox(2n, liker.userId, 0, 1);
    utxo.insertBox(box1);
    utxo.insertBox(box2);

    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 2, utxoTxs: [makeLikeTx(liker, box1, postId)] }),
      ),
    ).toBe(true);
    expect(likeRecords.hasLikeRecord(postId, liker.userId)).toBe(true);

    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 3, utxoTxs: [makeLikeTx(liker, box2, postId)] }),
      ),
    ).toBe(false);

    expect(ordering.getCurrentHeight()).toBe(2);
    expect(utxo.getBox(box2.id!)).not.toBeNull();
    expect(records.getIdentityRecord(author.userId)).toMatchObject({ likeCarry: 1n });
  });

  // -------------------------------------------------------------------------
  // Target liveness and author resolution
  // -------------------------------------------------------------------------

  it('a like on a pruned target rejects the block — the stump discriminator against a real stump row', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const ordering = await importOrdering();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const post = makePost(author.userId, 'pruned target');
    const postId = computePostId(post);
    posts.insertPost(post, encodePost(post));
    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postId, author))).toBe(true);

    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({
          height: 2,
          pruneEntries: [makePruneEntry(postId, [postId], author)],
        }),
      ),
    ).toBe(true);

    // A real stump row: getPost resolves the pruned root to a Stump —
    // detected as the absence of `content` / the presence of `rootPostHash`.
    // ('subtreeMerkleRoot' does NOT exist on Stump — the N1 report's dead
    // discriminator; this assertion is against the live field set.)
    const resolved = posts.getPost(postId) as Record<string, unknown>;
    expect(resolved).not.toBeNull();
    expect('content' in resolved).toBe(false);
    expect('rootPostHash' in resolved).toBe(true);

    const liker = makeTestIdentity();
    const box = makeKarmaBox(2n, liker.userId, 0);
    utxo.insertBox(box);
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 3, utxoTxs: [makeLikeTx(liker, box, postId)] }),
      ),
    ).toBe(false);
    expect(ordering.getCurrentHeight()).toBe(2);
    expect(utxo.getBox(box.id!)).not.toBeNull();
  });

  it('a like on a confirmed content-less post credits the topology author, not the zeroed placeholder author', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const records = await importRecords();
    const blockApply = await importBlockApply();

    // The block confirms a post whose content never arrived: apply creates a
    // placeholder row with a ZEROED author. The topology author is the real
    // one, and the settlement must credit it.
    const author = makeTestIdentity();
    const post = makePost(author.userId, 'content that never arrives');
    const postId = computePostId(post);
    // Deliberately NO posts.insertPost.

    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postId, author))).toBe(true);
    const placeholder = posts.getPost(postId) as { content: string; author: Uint8Array };
    expect(placeholder.content).toBe('');
    expect(Buffer.from(placeholder.author).equals(Buffer.alloc(32))).toBe(true);

    const liker = makeTestIdentity();
    const box = makeKarmaBox(2n, liker.userId, 0);
    utxo.insertBox(box);
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 2, utxoTxs: [makeLikeTx(liker, box, postId)] }),
      ),
    ).toBe(true);

    // The real author accrued; the zero key accrued nothing.
    expect(records.getIdentityRecord(author.userId)).toMatchObject({ likeCarry: 1n });
    expect(records.getIdentityRecord(new Uint8Array(32))).toBeNull();
  });

  it('a spare-signature like tx embedded directly in a block applies, with the liker = the karma input owner', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const likeRecords = await importLikeRecords();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const post = makePost(author.userId, 'spare signature target');
    const postId = computePostId(post);
    posts.insertPost(post, encodePost(post));
    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postId, author))).toBe(true);

    const liker = makeTestIdentity();
    const spare = makeTestIdentity();
    const box = makeKarmaBox(2n, liker.userId, 0);
    utxo.insertBox(box);

    // The gateway's one-signature rule is gateway policy: a validator can
    // embed a like tx carrying a spare signature directly. The spare entry is
    // FIRST in the map, so a settlement that read the signature map instead
    // of the input boxes would resolve the wrong liker.
    const tx: UtxoTransaction = {
      inputs: [box.id!],
      outputs: [
        {
          boxType: 'karma',
          value: 1n,
          owner: liker.userId,
          guard: 'owner_signature',
          proofSource: 'like_op',
        },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: postId,
    };
    signTransaction(tx, spare.privateKey, hex(spare.userId)); // spare, first
    signTransaction(tx, liker.privateKey, hex(liker.userId)); // owner
    expect(Object.keys(tx.signatures)[0]).toBe(hex(spare.userId));

    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 2, utxoTxs: [tx] }),
      ),
    ).toBe(true);

    expect(likeRecords.hasLikeRecord(postId, liker.userId)).toBe(true);
    expect(likeRecords.hasLikeRecord(postId, spare.userId)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Same-block exclusion
  // -------------------------------------------------------------------------

  it('a block carrying prune(P) + like(P) is rejected deterministically', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const ordering = await importOrdering();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const post = makePost(author.userId, 'same-block exclusion target');
    const postId = computePostId(post);
    posts.insertPost(post, encodePost(post));
    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postId, author))).toBe(true);

    const liker = makeTestIdentity();
    const box = makeKarmaBox(2n, liker.userId, 0);
    utxo.insertBox(box);

    // Prune settlement (§8c) runs before embedded txs (§11), so the like
    // finds a stump: invalid tx, whole block rejected.
    const block = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(postId, [postId], author)],
      utxoTxs: [makeLikeTx(liker, box, postId)],
    });
    expect(blockApply.applyOrderingBlock(block)).toBe(false);
    // Deterministic: the same block rejects again, not just once.
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    // All-or-nothing: the prune's own effects rolled back too.
    expect(ordering.getCurrentHeight()).toBe(1);
    const live = posts.getPost(postId) as Record<string, unknown>;
    expect('content' in live).toBe(true);
    expect(utxo.getBox(box.id!)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Post-lock vesting
  // -------------------------------------------------------------------------

  it('vesting crosses POST_LOCK_UNLOCK_PER_LIKES in the block it crosses, not before', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const likeRecords = await importLikeRecords();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const post = makePost(author.userId, 'vesting crossing target');
    const postId = computePostId(post);
    posts.insertPost(post, encodePost(post));

    const lockBox = seedPostLock(3n, author, postId);
    utxo.insertBox(lockBox);

    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postId, author))).toBe(true);

    // 9 likes: 9 / 10 = 0 → no vest, lock untouched.
    const nine = await seedLikers(POST_LOCK_UNLOCK_PER_LIKES - 1);
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({
          height: 2,
          utxoTxs: nine.map((l) => makeLikeTx(l.id, l.box, postId)),
        }),
      ),
    ).toBe(true);
    expect(utxo.getBox(lockBox.id!)).not.toBeNull();

    // The 10th like crosses the threshold → unlock 1 in THIS block.
    const [tenth] = await seedLikers(1, 50);
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({
          height: 3,
          utxoTxs: [makeLikeTx(tenth!.id, tenth!.box, postId)],
        }),
      ),
    ).toBe(true);

    expect(likeRecords.getLikeRecordCount(postId)).toBe(POST_LOCK_UNLOCK_PER_LIKES);
    expect(utxo.getBox(lockBox.id!)).toBeNull();
    const remainder = utxo.getPostLockBox(postId);
    expect(remainder).not.toBeNull();
    expect(remainder!.value).toBe(2n);
    expect(remainder!.originalValue).toBe(3n);
    expect(remainder!.txId).toBe(computeMintTxId(3, 'postlock-remainder', Buffer.from(postId)));

    // Author karma: block 2 paid 4 (9 likes → carry 4); block 3 total 4+1=5
    // → payout 4 (merging the 4) then unlock 1 → 9n, provenance = the LAST
    // merge, the postlock-unlock mint (settlement order: payout before
    // vesting).
    const authorBox = utxo.getKarmaBox(author.userId);
    expect(authorBox!.value).toBe(9n);
    expect(authorBox!.txId).toBe(computeMintTxId(3, 'postlock-unlock', Buffer.from(postId)));
  });

  it('a fully-unlocked lock is consumed without a remainder box', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const post = makePost(author.userId, 'full unlock target');
    const postId = computePostId(post);
    posts.insertPost(post, encodePost(post));

    const lockBox = seedPostLock(1n, author, postId);
    utxo.insertBox(lockBox);

    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postId, author))).toBe(true);

    const likers = await seedLikers(POST_LOCK_UNLOCK_PER_LIKES);
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({
          height: 2,
          utxoTxs: likers.map((l) => makeLikeTx(l.id, l.box, postId)),
        }),
      ),
    ).toBe(true);

    // toUnlock = min(1, 10/10 − 0) = 1 = value → consumed, nothing re-minted.
    expect(utxo.getBox(lockBox.id!)).toBeNull();
    expect(utxo.getPostLockBox(postId)).toBeNull();
    // 10 likes → payout 8, then the unlock 1 merges in → 9n.
    expect(utxo.getKarmaBox(author.userId)!.value).toBe(9n);
  });

  // -------------------------------------------------------------------------
  // Apply-then-revert, per new mutation class (active prover: DB identity,
  // digest identity, re-apply identity)
  // -------------------------------------------------------------------------

  it('round-trip: record inserts and the carry write (paid 0) revert exactly', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const records = await importRecords();

    const author = makeTestIdentity();
    const post = makePost(author.userId, 'round-trip carry target');
    const postId = computePostId(post);
    posts.insertPost(post, encodePost(post));
    // Everything seeded before bootstrap so tree and DB agree from height 0.
    const likers = await seedLikers(4);

    const handle = await activateProver();
    const blockApply = await importBlockApply();

    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postId, author))).toBe(true);
    const pre = takeSnapshot(db, handle, 1);
    expect(records.getIdentityRecord(author.userId)).toBeNull(); // non-vacuity

    const classBlock = await makeApplicableBlock({
      height: 2,
      utxoTxs: likers.map((l) => makeLikeTx(l.id, l.box, postId)),
    });
    expect(blockApply.applyOrderingBlock(classBlock)).toBe(true);
    expect(records.getIdentityRecord(author.userId)).toMatchObject({ likeCarry: 4n });
    expect(
      (dumpState(db.getDb()).likeRecords as Array<unknown>).length,
    ).toBe(4);

    await assertRoundTrip(db, handle, pre, classBlock);
    // Re-applied state holds the records and carry again, with the likers'
    // seed boxes spent by the burns once more.
    expect(records.getIdentityRecord(author.userId)).toMatchObject({ likeCarry: 4n });
    for (const l of likers) {
      expect(utxo.getBox(l.box.id!)).toBeNull();
    }
  });

  it('round-trip: the payout mint restores merge-consumed pre-existing karma and the prior carry', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const records = await importRecords();

    const author = makeTestIdentity();
    const post = makePost(author.userId, 'round-trip payout target');
    const postId = computePostId(post);
    posts.insertPost(post, encodePost(post));
    const authorKarma = makeKarmaBox(100n, author.userId, 0, 999);
    utxo.insertBox(authorKarma);
    const likers = await seedLikers(5);

    const handle = await activateProver();
    const blockApply = await importBlockApply();

    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postId, author))).toBe(true);
    // Block 2: 4 likes → carry 4, no mint.
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({
          height: 2,
          utxoTxs: likers.slice(0, 4).map((l) => makeLikeTx(l.id, l.box, postId)),
        }),
      ),
    ).toBe(true);
    const pre = takeSnapshot(db, handle, 2);
    expect(records.getIdentityRecord(author.userId)).toMatchObject({ likeCarry: 4n });

    // Block 3: the 5th like → paid 4, merging the author's 100n box.
    const classBlock = await makeApplicableBlock({
      height: 3,
      utxoTxs: [makeLikeTx(likers[4]!.id, likers[4]!.box, postId)],
    });
    expect(blockApply.applyOrderingBlock(classBlock)).toBe(true);
    expect(utxo.getBox(authorKarma.id!)).toBeNull(); // merged in
    const merged = utxo.getKarmaBox(author.userId);
    expect(merged!.value).toBe(104n);
    expect(merged!.txId).toBe(computeMintTxId(3, 'like-payout', author.userId));
    expect(records.getIdentityRecord(author.userId)).toMatchObject({ likeCarry: 0n });

    await assertRoundTrip(db, handle, pre, classBlock);
    expect(utxo.getKarmaBox(author.userId)!.value).toBe(104n); // re-applied
  });

  it('round-trip: the vesting swap (consume + unlock mint + remainder re-mint) reverts exactly', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();

    const author = makeTestIdentity();
    const post = makePost(author.userId, 'round-trip vesting target');
    const postId = computePostId(post);
    posts.insertPost(post, encodePost(post));
    const lockBox = seedPostLock(3n, author, postId);
    utxo.insertBox(lockBox);
    const likers = await seedLikers(POST_LOCK_UNLOCK_PER_LIKES);

    const handle = await activateProver();
    const blockApply = await importBlockApply();

    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postId, author))).toBe(true);
    const pre = takeSnapshot(db, handle, 1);

    const classBlock = await makeApplicableBlock({
      height: 2,
      utxoTxs: likers.map((l) => makeLikeTx(l.id, l.box, postId)),
    });
    expect(blockApply.applyOrderingBlock(classBlock)).toBe(true);

    // The swap happened: lock consumed, 2n remainder, author at 8 + 1 = 9n.
    expect(utxo.getBox(lockBox.id!)).toBeNull();
    expect(utxo.getPostLockBox(postId)!.value).toBe(2n);
    expect(utxo.getKarmaBox(author.userId)!.value).toBe(9n);

    await assertRoundTrip(db, handle, pre, classBlock);
    // Reverted-then-reapplied state again shows the swap.
    expect(utxo.getPostLockBox(postId)!.value).toBe(2n);
  });

  it('revertBlock restores prune-deleted like-records (all three columns) and removes inserted ones', async () => {
    // The likeRecordDeletions inverse, seeded via direct store calls: the
    // prune-time producer (settle-prune-utxo) is N3 — this pins the revert
    // machinery it will rely on. One journal carries BOTH inverse classes for
    // DIFFERENT records (the same-block exclusion only forbids them for the
    // same record).
    const db = await importDb();
    db.initDb(':memory:');
    const likes = await import('../../src/store/likes.js');
    const journalStore = await importJournalStore();
    const forkResolution = await importForkResolution();

    const likerA = makeTestIdentity();
    const likerB = makeTestIdentity();
    const prunedPost = 'aa'.repeat(32);
    const likedPost = 'bb'.repeat(32);

    // Post-block state: the block at height 7 pruned P (deleting A's and B's
    // records on P, captured in the journal) and inserted B's record on Q.
    likes.insertLikeRecord(likedPost, likerB.userId, 7); // no journal open — not recorded
    journalStore.insertBlockJournal({
      blockHeight: 7,
      mutations: [],
      confirmedSubBlockIds: [],
      appliedUtxoTxs: [],
      likeRecordInsertions: [{ targetPostId: likedPost, likerId: likerB.userId }],
      likeRecordDeletions: [
        { targetPostId: prunedPost, likerId: likerA.userId, appliedAtBlock: 3 },
        { targetPostId: prunedPost, likerId: likerB.userId, appliedAtBlock: 5 },
      ],
      vouchCooldownInsertions: [],
      vouchCooldownDeletions: [],
    });

    forkResolution.revertBlock(7);

    // Deleted records restored exactly — original applied heights included.
    const rows = db
      .getDb()
      .prepare(
        'SELECT target_post_id, liker_id, applied_at_block FROM like_records ORDER BY target_post_id, liker_id',
      )
      .all() as Array<{ target_post_id: string; liker_id: Buffer; applied_at_block: number }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.target_post_id === prunedPost)).toBe(true);
    const byLiker = new Map(rows.map((r) => [r.liker_id.toString('hex'), r.applied_at_block]));
    expect(byLiker.get(hex(likerA.userId))).toBe(3);
    expect(byLiker.get(hex(likerB.userId))).toBe(5);
    // The inserted record is gone.
    expect(likes.hasLikeRecord(likedPost, likerB.userId)).toBe(false);
  });
});
