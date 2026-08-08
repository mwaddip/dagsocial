import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeBoxId, computeMintTxId, PROTOCOL_VERSION } from '@dagsocial/types';
import type {
  PostLockBox,
  KarmaBox,
  OrderingBlock,
  Post,
  Stump,
} from '@dagsocial/types';
import type { BlockJournal, BoxMutation } from '../../src/store/journal.js';
import type Database from 'better-sqlite3';
import {
  fixtureProvenance,
  makeApplicableBlock,
  makePruneEntry,
  makeTestIdentity,
  hex,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// Dynamic import helpers (module-level DB state requires reset + fresh import)
// ---------------------------------------------------------------------------

async function importDb() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importTopology() {
  const mod = await import('../../src/store/topology.js');
  return mod as {
    insertBlockTopology: (
      postId: string,
      parentRefs: string[],
      author: string,
      blockHeight: number,
    ) => void;
    getSubtreeTopology: (rootPostId: string) => Set<string>;
    getTopologyAuthor: (postId: string) => string | null;
    rollbackBlockTopology: (blockHeight: number) => void;
  };
}

async function importUtxo() {
  const mod = await import('../../src/store/utxo.js');
  return mod as {
    insertBox: (box: unknown) => void;
    getBox: (boxId: string) => unknown;
    getPostLockBox: (targetPostId: string) => PostLockBox | null;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
  };
}

async function importLikes() {
  const mod = await import('../../src/store/likes.js');
  return mod as {
    insertLikeRecord: (targetPostId: string, likerId: Uint8Array, blockHeight: number) => void;
    hasLikeRecord: (targetPostId: string, likerId: Uint8Array) => boolean;
  };
}

async function importSettlePruneUtxo() {
  const mod = await import('../../src/services/settle-prune-utxo.js');
  // ⚠ Hand-maintained mirror of the real arity. `tsconfig.json` has
  // `include: ["src"]`, so nothing type-checks this cast against the function
  // it describes — when `settlePruneUtxo` gained `rootPostHash`, this signature
  // and every call below had to be updated by hand, and only the test run would
  // have caught a miss. Change the source signature, change this too.
  return mod as {
    settlePruneUtxo: (
      rootPostHash: string,
      postIds: string[],
      blockHeight: number,
    ) => void;
  };
}

async function importJournal() {
  const mod = await import('../../src/store/journal.js');
  return mod as {
    beginBlockJournal: (height: number) => void;
    finishBlockJournal: () => BlockJournal;
  };
}

/**
 * Run `fn` with a block journal open at `height` and return the finished
 * journal — the record-once log the store choke point filled while it ran.
 */
async function journaled(height: number, fn: () => void): Promise<BlockJournal> {
  const journal = await importJournal();
  journal.beginBlockJournal(height);
  fn();
  return journal.finishBlockJournal();
}

/** boxIds of box 'remove' mutations, in application order. */
function removedIds(journal: BlockJournal): string[] {
  return journal.mutations
    .filter((m) => m.kind === 'box' && m.op === 'remove')
    .map((m) => (m as BoxMutation).boxId);
}

/** boxIds of box 'insert' mutations, in application order. */
function insertedIds(journal: BlockJournal): string[] {
  return journal.mutations
    .filter((m) => m.kind === 'box' && m.op === 'insert')
    .map((m) => (m as BoxMutation).boxId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserId(label: string): Uint8Array {
  const buf = Buffer.alloc(32);
  buf.write(label, 0, Math.min(label.length, 32), 'utf-8');
  return new Uint8Array(buf);
}

function makePostLockBox(
  value: number,
  owner: Uint8Array,
  targetPostId: string,
  seed: number,
): PostLockBox {
  const box: PostLockBox = {
    boxType: 'post_lock',
    value,
    originalValue: value,
    owner,
    targetPostId,
    guard: 'block_apply',
  };
  Object.assign(box, fixtureProvenance(box, seed));
  box.id = computeBoxId(box);
  return box;
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
  box.id = computeBoxId(box);
  return box;
}

/** Consensus-carried author for topology fixtures (hex(32)). */
const AUTHOR_HEX = 'ab'.repeat(32);

/** Check if a box ID is spent in the utxo_boxes table. */
function boxIsSpent(db: Database.Database, boxId: string): boolean {
  const row = db
    .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
    .get(boxId) as { spent_at_block: number | null } | undefined;
  return row != null && row.spent_at_block !== null;
}

// ---------------------------------------------------------------------------
// Tests: block_topology
// ---------------------------------------------------------------------------

describe('block_topology', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('getSubtreeTopology computes transitive closure via CTE', async () => {
    const { insertBlockTopology, getSubtreeTopology } = await importTopology();

    // Chain: root1 -> reply1 -> reply2
    insertBlockTopology('root1', [], AUTHOR_HEX, 1);
    insertBlockTopology('reply1', ['root1'], AUTHOR_HEX, 2);
    insertBlockTopology('reply2', ['reply1'], AUTHOR_HEX, 2);

    const subtree = getSubtreeTopology('root1');
    expect(subtree).toEqual(new Set(['root1', 'reply1', 'reply2']));
  });

  it('getSubtreeTopology returns only root when no replies', async () => {
    const { insertBlockTopology, getSubtreeTopology } = await importTopology();
    insertBlockTopology('root1', [], AUTHOR_HEX, 1);

    const subtree = getSubtreeTopology('root1');
    expect(subtree).toEqual(new Set(['root1']));
  });

  it('getSubtreeTopology returns empty set for unknown root', async () => {
    const { getSubtreeTopology } = await importTopology();

    const subtree = getSubtreeTopology('nonexistent');
    expect(subtree.size).toBe(0);
  });

  it('insertBlockTopology is idempotent', async () => {
    const { insertBlockTopology, getSubtreeTopology } = await importTopology();

    insertBlockTopology('root1', [], AUTHOR_HEX, 1);
    insertBlockTopology('root1', [], AUTHOR_HEX, 1); // Duplicate call
    insertBlockTopology('reply1', ['root1'], AUTHOR_HEX, 2);

    const subtree = getSubtreeTopology('root1');
    expect(subtree).toEqual(new Set(['root1', 'reply1']));
  });

  it('getSubtreeTopology handles branching children', async () => {
    const { insertBlockTopology, getSubtreeTopology } = await importTopology();

    // root -> child1
    // root -> child2
    insertBlockTopology('root', [], AUTHOR_HEX, 1);
    insertBlockTopology('child1', ['root'], AUTHOR_HEX, 2);
    insertBlockTopology('child2', ['root'], AUTHOR_HEX, 2);

    const subtree = getSubtreeTopology('root');
    expect(subtree).toEqual(new Set(['root', 'child1', 'child2']));
  });

  it('getSubtreeTopology does not follow upward references', async () => {
    const { insertBlockTopology, getSubtreeTopology } = await importTopology();

    // Two independent root posts
    insertBlockTopology('rootA', [], AUTHOR_HEX, 1);
    insertBlockTopology('rootB', [], AUTHOR_HEX, 1);

    const subtree = getSubtreeTopology('rootA');
    expect(subtree).toEqual(new Set(['rootA']));
  });

  it('getTopologyAuthor returns the recorded author', async () => {
    const { insertBlockTopology, getTopologyAuthor } = await importTopology();
    insertBlockTopology('root1', [], AUTHOR_HEX, 1);

    expect(getTopologyAuthor('root1')).toBe(AUTHOR_HEX);
  });

  it('getTopologyAuthor returns null for a post no block has confirmed', async () => {
    const { getTopologyAuthor } = await importTopology();

    expect(getTopologyAuthor('nonexistent')).toBeNull();
  });

  it('getTopologyAuthor keeps the first confirming block author (idempotent insert)', async () => {
    const { insertBlockTopology, getTopologyAuthor } = await importTopology();
    insertBlockTopology('root1', [], AUTHOR_HEX, 1);
    insertBlockTopology('root1', [], 'cd'.repeat(32), 2); // later block, same postId

    expect(getTopologyAuthor('root1')).toBe(AUTHOR_HEX);
  });

  it('getTopologyAuthor returns null again after the height is rolled back', async () => {
    const { insertBlockTopology, getTopologyAuthor, rollbackBlockTopology } =
      await importTopology();
    insertBlockTopology('root1', [], AUTHOR_HEX, 7);
    expect(getTopologyAuthor('root1')).toBe(AUTHOR_HEX);

    rollbackBlockTopology(7);
    expect(getTopologyAuthor('root1')).toBeNull();
  });

  it('rollbackBlockTopology removes entries at given height', async () => {
    const { insertBlockTopology, getSubtreeTopology, rollbackBlockTopology } =
      await importTopology();

    insertBlockTopology('root1', [], AUTHOR_HEX, 1);
    insertBlockTopology('reply1', ['root1'], AUTHOR_HEX, 2);
    insertBlockTopology('reply2', ['reply1'], AUTHOR_HEX, 3);

    // Roll back height 2 entries
    rollbackBlockTopology(2);

    const subtree = getSubtreeTopology('root1');
    // reply1 at height 2 should be gone; reply2 (parent_refs 'reply1') has
    // no incoming edge from an existing post, so CTE stops at root1
    expect(subtree).toEqual(new Set(['root1']));
  });
});

// ---------------------------------------------------------------------------
// Tests: settlePruneUtxo
// ---------------------------------------------------------------------------

describe('settlePruneUtxo', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('consumes PostLockBox and mints refund karma for author', async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const rootPostId = 'a'.repeat(64);
    const authorId = makeUserId('author1');

    // Insert a PostLockBox for the author, plus pre-existing karma the refund
    // mint will merge in (seeded outside the journal, like any pre-block state)
    const lockBox = makePostLockBox(100, authorId, rootPostId, 1);
    utxo.insertBox(lockBox);
    const oldKarma = makeKarmaBox(40n, authorId, 1);
    utxo.insertBox(oldKarma);

    const journal = await journaled(10, () => settlePruneUtxo(rootPostId, [rootPostId], 10));

    // PostLockBox consumed
    expect(removedIds(journal)).toContain(lockBox.id);

    // The pre-existing karma box the mint merged in is journaled too — the
    // merge-consume the old hand-maintained journal lost (value-loss on reorg)
    expect(removedIds(journal)).toContain(oldKarma.id);

    // PostLockBox marked spent in DB
    const db = getDb();
    expect(boxIsSpent(db, lockBox.id!)).toBe(true);

    // Merged karma refund box created with old + refund value, its bytes in
    // the journal payload
    const mintedKarma = journal.mutations.find(
      (m) => m.kind === 'box' && m.op === 'insert' && (m.box as KarmaBox).boxType === 'karma',
    ) as BoxMutation | undefined;
    expect(mintedKarma).toBeDefined();
    expect((mintedKarma!.box as KarmaBox).value).toBe(140n);
  });

  it('handles empty postId list', async () => {
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const journal = await journaled(5, () => settlePruneUtxo('0'.repeat(64), [], 5));
    expect(journal.mutations.length).toBe(0);
  });

  it('skips already-spent boxes', async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const rootPostId = 'c'.repeat(64);
    const authorId = makeUserId('author2');

    // Insert a PostLockBox and spend it beforehand
    const lockBox = makePostLockBox(50, authorId, rootPostId, 1);
    utxo.insertBox(lockBox);
    utxo.consumeBox(lockBox.id!, 5); // Already spent at block 5

    const journal = await journaled(10, () => settlePruneUtxo(rootPostId, [rootPostId], 10));

    // Already-spent box should not be re-consumed, and no refund karma minted
    // (getPostLockBox returns only unspent boxes, so it returns null)
    expect(journal.mutations.length).toBe(0);
  });

  it('aggregates refunds per author across multiple posts', async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const postId1 = 'p'.repeat(64);
    const postId2 = 'q'.repeat(64);
    const authorId = makeUserId('author3');

    // Two PostLockBoxes for the same author on two posts
    const lb1 = makePostLockBox(100, authorId, postId1, 1);
    const lb2 = makePostLockBox(50, authorId, postId2, 1);
    utxo.insertBox(lb1);
    utxo.insertBox(lb2);

    const journal = await journaled(10, () =>
      settlePruneUtxo(postId1, [postId1, postId2], 10),
    );

    // Both lock boxes consumed
    expect(removedIds(journal)).toContain(lb1.id);
    expect(removedIds(journal)).toContain(lb2.id);

    // One refund box for the author, values aggregated: 100 + 50 = 150
    expect(insertedIds(journal).length).toBe(1);
    const db = getDb();
    const row = db
      .prepare("SELECT value, owner FROM utxo_boxes WHERE id = ? AND box_type = 'karma'")
      .get(insertedIds(journal)[0]!) as { value: number; owner: Buffer };
    expect(row.value).toBe(150);
    expect(Buffer.from(row.owner).equals(Buffer.from(authorId))).toBe(true);
  });

  it('handles posts with no PostLockBox', async () => {
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const postId = 'e'.repeat(64);
    const journal = await journaled(10, () => settlePruneUtxo(postId, [postId], 10));
    expect(journal.mutations.length).toBe(0);
  });

  it('PostLockBox with zero value is not consumed', async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const rootPostId = 'f'.repeat(64);
    const authorId = makeUserId('author4');

    const lockBox = makePostLockBox(0, authorId, rootPostId, 1);
    utxo.insertBox(lockBox);

    const journal = await journaled(10, () => settlePruneUtxo(rootPostId, [rootPostId], 10));

    // Zero-value box is skipped (lockBox.value > 0 check)
    expect(removedIds(journal)).not.toContain(lockBox.id);
    expect(journal.mutations.length).toBe(0);
  });

  // N3b: the subtree's like-records die with the prune, and every doomed row
  // is captured as a `likeRecordDeletions` side-record so a reverted prune
  // restores them exactly.
  it("deletes the subtree's like-records and journals every deleted row", async () => {
    const likes = await importLikes();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const rootId = 'a'.repeat(64);
    const replyId = 'b'.repeat(64);
    const likerA = makeUserId('likerA');
    const likerB = makeUserId('likerB');

    // Applied by "earlier blocks": seeded outside any journal, so the
    // seeding itself records nothing.
    likes.insertLikeRecord(rootId, likerA, 3);
    likes.insertLikeRecord(rootId, likerB, 5);
    likes.insertLikeRecord(replyId, likerA, 7);

    const journal = await journaled(10, () =>
      settlePruneUtxo(rootId, [rootId, replyId], 10),
    );

    // Records died with the prune
    expect(likes.hasLikeRecord(rootId, likerA)).toBe(false);
    expect(likes.hasLikeRecord(rootId, likerB)).toBe(false);
    expect(likes.hasLikeRecord(replyId, likerA)).toBe(false);

    // Every doomed row captured, all three columns, capture order pinned by
    // the primary key
    expect(journal.likeRecordDeletions).toEqual([
      { targetPostId: rootId, likerId: likerA, appliedAtBlock: 3 },
      { targetPostId: rootId, likerId: likerB, appliedAtBlock: 5 },
      { targetPostId: replyId, likerId: likerA, appliedAtBlock: 7 },
    ]);
  });

  it('leaves like-records outside the subtree alone and journals exactly the subtree rows', async () => {
    const likes = await importLikes();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const prunedId = 'a'.repeat(64);
    const otherId = 'f'.repeat(64);
    const liker = makeUserId('liker5');

    likes.insertLikeRecord(prunedId, liker, 2);
    likes.insertLikeRecord(otherId, liker, 4);

    const journal = await journaled(10, () => settlePruneUtxo(prunedId, [prunedId], 10));

    // The unrelated post's record survives, unjournalled; the subtree row is
    // the exact deletion set.
    expect(likes.hasLikeRecord(otherId, liker)).toBe(true);
    expect(journal.likeRecordDeletions).toEqual([
      { targetPostId: prunedId, likerId: liker, appliedAtBlock: 2 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tests: prune refund provenance (Spec G phase G2a)
// ---------------------------------------------------------------------------

/**
 * The subject the contract's reason/subject table pins, built here **without**
 * calling the encoder — `utf8(rootPostHash)` ‖ raw key, 96 bytes. Deriving the
 * expectation independently is what makes these tests fail when the encoder
 * drops `rootPostHash` rather than move with it.
 */
function expectedSubject(rootPostHash: string, key: Uint8Array): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from(rootPostHash, 'utf-8'), Buffer.from(key)]));
}

/** Every karma row the settlement left behind, oldest insert first. */
function karmaRows(db: Database.Database): Array<{
  tx_id: string | null;
  output_index: number | null;
  value: number;
}> {
  return db
    .prepare(
      `SELECT tx_id, output_index, value FROM utxo_boxes
       WHERE box_type = 'karma' ORDER BY value ASC`,
    )
    .all() as Array<{ tx_id: string | null; output_index: number | null; value: number }>;
}

describe('settlePruneUtxo — refund provenance', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
  });

  afterEach(() => {
    vi.resetModules();
  });

  // The load-bearing case for `rootPostHash`. `block-apply.ts` calls settlement
  // once per prune entry, so two entries in one block are two calls at one
  // height. An author refunded by both would, on a subject of just the owner,
  // derive the same mintTxId twice at index 0 — tripping
  // UNIQUE(tx_id, output_index) and rejecting a legitimate block.
  it('two prune entries at one height refunding the same author both apply', async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const rootA = 'a'.repeat(64);
    const rootB = 'b'.repeat(64);
    const authorId = makeUserId('author-in-both-subtrees');

    utxo.insertBox(makePostLockBox(100, authorId, rootA, 1));
    utxo.insertBox(makePostLockBox(50, authorId, rootB, 1));

    // One journal, one height, two entries — exactly the loop in block-apply.
    const journal = await journaled(10, () => {
      settlePruneUtxo(rootA, [rootA], 10);
      settlePruneUtxo(rootB, [rootB], 10);
    });

    // Second mint merges the first, so the survivor holds 100 + 50.
    const rows = karmaRows(getDb());
    expect(rows.map((r) => r.value)).toEqual([100, 150]);

    // Both rows persist — the merge marks the first spent, it does not delete
    // the row — so the two mints must occupy distinct provenance keys.
    expect(rows.map((r) => r.tx_id)).toEqual([
      computeMintTxId(10, 'prune-refund-author', expectedSubject(rootA, authorId)),
      computeMintTxId(10, 'prune-refund-author', expectedSubject(rootB, authorId)),
    ]);
    expect(rows.map((r) => r.output_index)).toEqual([0, 0]);
    expect(insertedIds(journal).length).toBe(2);
  });

  // N3b/T2b: the liker leg is gone — a like's karma was burned at cast and is
  // deliberately unrecoverable, so a prune refunds no liker. The subtree's
  // post WAS liked (like-record seeded), so a stray liker mint — whatever it
  // were derived from — would land in this table and fail the exact-set
  // assertion below. (The named-id tripwire that stood here until T2b died
  // with the retired reason: its mint id is no longer derivable. The
  // exact-set assertion subsumes it.)
  it('a liked subtree settles to exactly the author mint — no liker leg', async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const likes = await importLikes();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const root = 'c'.repeat(64);
    const authorId = makeUserId('author-liked');
    const likerId = makeUserId('liker-liked');

    utxo.insertBox(makePostLockBox(100, authorId, root, 1));
    likes.insertLikeRecord(root, likerId, 3);

    await journaled(10, () => settlePruneUtxo(root, [root], 10));

    // Exactly one mint: the author's — an exact-set assertion, so any stray
    // second mint fails it regardless of what it would be derived from.
    const rows = karmaRows(getDb());
    expect(rows.map((r) => r.tx_id)).toEqual([
      computeMintTxId(10, 'prune-refund-author', expectedSubject(root, authorId)),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Integration test: full prune lifecycle (UTXO path)
// ---------------------------------------------------------------------------

describe('Full prune lifecycle (UTXO settlement path)', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('full lifecycle: create posts, prune, verify author refund', async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const topology = await importTopology();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const rootId = 'a'.repeat(64);
    const replyId = 'b'.repeat(64);
    const authorId = makeUserId('author1');

    // 1. Seed block_topology: root has no parents, reply has root as parent
    const authorHex = Buffer.from(authorId).toString('hex');
    topology.insertBlockTopology(rootId, [], authorHex, 1);
    topology.insertBlockTopology(replyId, [rootId], authorHex, 2);

    // 2. Verify subtree includes both posts
    const subtree = topology.getSubtreeTopology(rootId);
    expect(subtree).toEqual(new Set([rootId, replyId]));

    // 3. Seed UTXO: PostLockBox for each post
    const lb1 = makePostLockBox(50, authorId, rootId, 1);
    const lb2 = makePostLockBox(50, authorId, replyId, 1);
    utxo.insertBox(lb1);
    utxo.insertBox(lb2);

    // 4. Apply settlement
    const journal = await journaled(10, () =>
      settlePruneUtxo(rootId, [rootId, replyId], 10),
    );

    // 5. Verify PostLockBoxes consumed
    expect(removedIds(journal)).toContain(lb1.id);
    expect(removedIds(journal)).toContain(lb2.id);

    // 6. Verify karma refunded: author gets 50+50=100
    const db = getDb();
    const createdBoxes = insertedIds(journal).map(
      (boxId) =>
        db
          .prepare('SELECT * FROM utxo_boxes WHERE id = ?')
          .get(boxId) as {
          value: number;
          owner: Buffer;
          box_type: string;
        } | undefined,
    ).filter(Boolean);

    const authorBox = createdBoxes.find(
      (b) => b && Buffer.from(b.owner).equals(Buffer.from(authorId)),
    );
    expect(authorBox).toBeDefined();
    expect(authorBox!.value).toBe(100);

    // 7. Verify all original boxes are marked spent
    expect(boxIsSpent(db, lb1.id!)).toBe(true);
    expect(boxIsSpent(db, lb2.id!)).toBe(true);

    // 8. Verify getPostLockBox returns null (box now spent)
    expect(utxo.getPostLockBox(rootId)).toBeNull();
    expect(utxo.getPostLockBox(replyId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: stump insert is structural at settlement (P2-F F1)
// ---------------------------------------------------------------------------

describe('prune settlement stump insert (P2-F F1)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('../../src/store/posts.js');
    vi.resetModules();
  });

  async function importBlockApply() {
    return (await import('../../src/services/block-apply.js')) as {
      applyOrderingBlock: (block: OrderingBlock) => boolean;
    };
  }

  async function importStumps() {
    return (await import('../../src/store/stumps.js')) as {
      getStump: (id: string) => Stump | null;
    };
  }

  async function importPostsStore() {
    return (await import('../../src/store/posts.js')) as {
      getPost: (id: string) => Post | Stump | null;
    };
  }

  async function importOrderingStore() {
    return (await import('../../src/store/ordering.js')) as {
      getCurrentHeight: () => number;
    };
  }

  // Pins the contract obligation (NODE_INTERFACE "Pruning" step 4;
  // ARCHITECTURE §3 lifecycle step 7): a node holding no DAG content for the
  // subtree records the same stump at settlement, every field derived from
  // the verified entry or the carrying block's height. This passes before
  // the P2-F F1 change too — the pre-change insert was unconditional only
  // incidentally (pruneSubtree returns silently on zero rows) — so it pins
  // the obligation rather than reproducing a bug.
  it('records the stump at settlement on a node holding no DAG content', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const rootId = 'a1'.repeat(32);
    const replyId = 'b2'.repeat(32);

    const blockApply = await importBlockApply();

    // Height 1 confirms root + reply as consensus entries. No post content is
    // ever inserted — confirmation creates placeholders, which is all a
    // content-less node holds.
    const confirmBlock = await makeApplicableBlock({
      subBlockEntries: [
        { postId: rootId, parentRefs: [], author: hex(author.userId) },
        { postId: replyId, parentRefs: [rootId], author: hex(author.userId) },
      ],
    });
    expect(blockApply.applyOrderingBlock(confirmBlock)).toBe(true);

    // Placeholder, not content — the content-less premise, pinned.
    const posts = await importPostsStore();
    const beforePrune = posts.getPost(rootId);
    expect(beforePrune).not.toBeNull();
    expect((beforePrune as Post).content).toBe('');

    // Height 2 settles the prune.
    const pruneBlock = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(rootId, [rootId, replyId], author)],
    });
    expect(blockApply.applyOrderingBlock(pruneBlock)).toBe(true);

    const { getStump } = await importStumps();
    const stump = getStump(rootId);
    expect(stump).not.toBeNull();
    expect(stump!.rootPostHash).toBe(rootId);
    expect(hex(stump!.authorId)).toBe(hex(author.userId));
    expect(stump!.replyCount).toBe(1); // subtreePostIds.length - 1
    expect(stump!.trigger).toBe('author');
    expect(stump!.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(stump!.compactedAtBlockHeight).toBe(2); // the carrying block's height
  });

  // The discriminating case for P2-F F1: the stump insert is structural —
  // not behind the content prune. With pruneSubtree forced to throw, the
  // block still applies (content-prune failure stays non-fatal) AND the
  // stump row exists. Before the change (insertStump after pruneSubtree
  // inside one try/catch) the throw skipped the insert: the block applied
  // with the stump silently missing.
  it('records the stump even when pruneSubtree throws (structural independence)', async () => {
    vi.doMock('../../src/store/posts.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('../../src/store/posts.js')>();
      return {
        ...orig,
        pruneSubtree: (): void => {
          throw new Error('forced pruneSubtree failure (test seam)');
        },
      };
    });

    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const rootId = 'c3'.repeat(32);

    const blockApply = await importBlockApply();
    const confirmBlock = await makeApplicableBlock({
      subBlockEntries: [
        { postId: rootId, parentRefs: [], author: hex(author.userId) },
      ],
    });
    expect(blockApply.applyOrderingBlock(confirmBlock)).toBe(true);

    const pruneBlock = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(rootId, [rootId], author)],
    });
    expect(blockApply.applyOrderingBlock(pruneBlock)).toBe(true);

    const ordering = await importOrderingStore();
    expect(ordering.getCurrentHeight()).toBe(2);

    const { getStump } = await importStumps();
    const stump = getStump(rootId);
    expect(stump).not.toBeNull();
    expect(stump!.compactedAtBlockHeight).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: prune apply → revert restores like-records (P2-D N3b)
// ---------------------------------------------------------------------------

describe('prune apply-then-revert (P2-D N3b, real settle path)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function importBlockApply() {
    return (await import('../../src/services/block-apply.js')) as {
      applyOrderingBlock: (block: OrderingBlock) => boolean;
    };
  }

  async function importForkResolution() {
    return (await import('../../src/services/fork-resolution.js')) as {
      revertBlock: (height: number) => unknown;
    };
  }

  // N2b pinned the likeRecordDeletions inverse against a hand-built journal;
  // this closes the loop end-to-end: the journal is produced by the REAL
  // prune path (applyOrderingBlock → settlePruneUtxo →
  // deleteLikeRecordsForPosts), then revertBlock replays it and the exact
  // rows return.
  it("a reverted prune block restores the subtree's like-records exactly (all three columns)", async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const likerA = makeTestIdentity();
    const likerB = makeTestIdentity();
    const rootId = 'd4'.repeat(32);
    const replyId = 'e5'.repeat(32);

    const blockApply = await importBlockApply();
    const likes = await importLikes();
    const forkResolution = await importForkResolution();

    // Height 1 confirms root + reply as consensus entries.
    const confirmBlock = await makeApplicableBlock({
      subBlockEntries: [
        { postId: rootId, parentRefs: [], author: hex(author.userId) },
        { postId: replyId, parentRefs: [rootId], author: hex(author.userId) },
      ],
    });
    expect(blockApply.applyOrderingBlock(confirmBlock)).toBe(true);

    // Like-records applied by earlier blocks — seeded via the store with no
    // journal open, exactly the state a node holds before the prune block.
    likes.insertLikeRecord(rootId, likerA.userId, 1);
    likes.insertLikeRecord(rootId, likerB.userId, 1);
    likes.insertLikeRecord(replyId, likerA.userId, 1);

    // Height 2 prunes the subtree through the real apply path.
    const pruneBlock = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(rootId, [rootId, replyId], author)],
    });
    expect(blockApply.applyOrderingBlock(pruneBlock)).toBe(true);

    // The subtree's records died with the prune.
    expect(likes.hasLikeRecord(rootId, likerA.userId)).toBe(false);
    expect(likes.hasLikeRecord(rootId, likerB.userId)).toBe(false);
    expect(likes.hasLikeRecord(replyId, likerA.userId)).toBe(false);

    // Revert the prune block: the journalled deletions replay through
    // restoreLikeRecord and the exact rows return.
    forkResolution.revertBlock(2);

    const rows = db
      .getDb()
      .prepare(
        'SELECT target_post_id, liker_id, applied_at_block FROM like_records ORDER BY target_post_id, liker_id',
      )
      .all() as Array<{ target_post_id: string; liker_id: Buffer; applied_at_block: number }>;
    const restored = rows.map((r) => ({
      targetPostId: r.target_post_id,
      likerId: r.liker_id.toString('hex'),
      appliedAtBlock: r.applied_at_block,
    }));
    // Liker keys are random, so sort the expectation the way the query sorts
    // rows (hex order = BLOB byte order).
    const expected = [
      { targetPostId: rootId, likerId: hex(likerA.userId), appliedAtBlock: 1 },
      { targetPostId: rootId, likerId: hex(likerB.userId), appliedAtBlock: 1 },
      { targetPostId: replyId, likerId: hex(likerA.userId), appliedAtBlock: 1 },
    ].sort((a, b) =>
      a.targetPostId !== b.targetPostId
        ? a.targetPostId < b.targetPostId
          ? -1
          : 1
        : a.likerId < b.likerId
          ? -1
          : 1,
    );
    expect(restored).toEqual(expected);
  });
});
