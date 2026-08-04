import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeBoxId } from '@dagsocial/types';
import type {
  PostLockBox,
  LikeBox,
  KarmaBox,
} from '@dagsocial/types';
import type { BlockJournal } from '../../src/store/journal.js';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Dynamic import helpers (module-level DB state requires reset + fresh import)
// ---------------------------------------------------------------------------

async function importDb() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database;
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
    getUnspentLikeBoxes: (targetPostId: string) => LikeBox[];
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
  };
}

async function importSettlePruneUtxo() {
  const mod = await import('../../src/services/settle-prune-utxo.js');
  return mod as {
    settlePruneUtxo: (postIds: string[], blockHeight: number) => void;
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

/** boxIds of 'remove' mutations, in application order. */
function removedIds(journal: BlockJournal): string[] {
  return journal.mutations.filter((m) => m.op === 'remove').map((m) => m.boxId);
}

/** boxIds of 'insert' mutations, in application order. */
function insertedIds(journal: BlockJournal): string[] {
  return journal.mutations.filter((m) => m.op === 'insert').map((m) => m.boxId);
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
  createdAtBlock: number,
): PostLockBox {
  const box: PostLockBox = {
    boxType: 'post_lock',
    value,
    createdAtBlock,
    originalValue: value,
    owner,
    targetPostId,
    guard: 'epoch_tally',
  };
  box.id = computeBoxId(box);
  return box;
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
  box.id = computeBoxId(box);
  return box;
}

function makeKarmaBox(
  value: bigint,
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
  box.id = computeBoxId(box);
  return box;
}

/** Consensus-carried author for topology fixtures (hex(32)). */
const AUTHOR_HEX = 'ab'.repeat(32);

/** Check if a box ID is spent in the utxo_boxes table. */
function boxIsSpent(db: Database, boxId: string): boolean {
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

    const journal = await journaled(10, () => settlePruneUtxo([rootPostId], 10));

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
      (m) => m.op === 'insert' && (m.box as KarmaBox).boxType === 'karma',
    );
    expect(mintedKarma).toBeDefined();
    expect((mintedKarma!.box as KarmaBox).value).toBe(140n);
  });

  it('consumes LikeBox and mints refund karma for liker', async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const rootPostId = 'b'.repeat(64);
    const likerId = makeUserId('liker1');

    // Insert a LikeBox
    const likeBox = makeLikeBox(likerId, rootPostId, 1);
    utxo.insertBox(likeBox);

    const journal = await journaled(10, () => settlePruneUtxo([rootPostId], 10));

    // LikeBox consumed
    expect(removedIds(journal)).toContain(likeBox.id);

    // LikeBox marked spent in DB
    const db = getDb();
    expect(boxIsSpent(db, likeBox.id!)).toBe(true);

    // Karma refund box created for liker
    expect(insertedIds(journal).length).toBeGreaterThanOrEqual(1);
  });

  it('handles empty postId list', async () => {
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const journal = await journaled(5, () => settlePruneUtxo([], 5));
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

    const journal = await journaled(10, () => settlePruneUtxo([rootPostId], 10));

    // Already-spent box should not be re-consumed, and no refund karma minted
    // (getPostLockBox returns only unspent boxes, so it returns null)
    expect(journal.mutations.length).toBe(0);
  });

  it('skips already-spent LikeBoxes', async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const rootPostId = 'd'.repeat(64);
    const likerId = makeUserId('liker2');

    // Insert a LikeBox and spend it beforehand
    const likeBox = makeLikeBox(likerId, rootPostId, 1);
    utxo.insertBox(likeBox);
    utxo.consumeBox(likeBox.id!, 3); // Already spent

    const journal = await journaled(10, () => settlePruneUtxo([rootPostId], 10));

    expect(removedIds(journal)).not.toContain(likeBox.id);
    expect(journal.mutations.length).toBe(0);
  });

  it('aggregates refunds per user across multiple posts', async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const postId1 = 'p'.repeat(64);
    const postId2 = 'q'.repeat(64);
    const authorId = makeUserId('author3');
    const likerId = makeUserId('liker3');

    // Two PostLockBoxes for the same author on two posts
    const lb1 = makePostLockBox(100, authorId, postId1, 1);
    const lb2 = makePostLockBox(50, authorId, postId2, 1);
    utxo.insertBox(lb1);
    utxo.insertBox(lb2);

    // Two LikeBoxes from the same liker on two posts
    const like1 = makeLikeBox(likerId, postId1, 1);
    const like2 = makeLikeBox(likerId, postId2, 1);
    utxo.insertBox(like1);
    utxo.insertBox(like2);

    const journal = await journaled(10, () =>
      settlePruneUtxo([postId1, postId2], 10),
    );

    // All four boxes consumed
    expect(removedIds(journal)).toContain(lb1.id);
    expect(removedIds(journal)).toContain(lb2.id);
    expect(removedIds(journal)).toContain(like1.id);
    expect(removedIds(journal)).toContain(like2.id);

    // Refund karma created (one per user, values aggregated)
    // Author: 100 + 50 = 150, Liker: 2 + 2 = 4
    expect(insertedIds(journal).length).toBeGreaterThanOrEqual(2);

    // Verify the created karma box values
    const db = getDb();
    for (const boxId of insertedIds(journal)) {
      const row = db
        .prepare(
          "SELECT value, owner FROM utxo_boxes WHERE id = ? AND box_type = 'karma'",
        )
        .get(boxId) as { value: number; owner: Buffer } | undefined;
      if (row) {
        const ownerHex = Buffer.from(row.owner).toString('hex');
        const authorHex = Buffer.from(authorId).toString('hex');
        const likerHex = Buffer.from(likerId).toString('hex');
        if (ownerHex === authorHex) {
          expect(row.value).toBe(150);
        } else if (ownerHex === likerHex) {
          expect(row.value).toBe(4);
        }
      }
    }
  });

  it('handles posts with no PostLockBox or LikeBoxes', async () => {
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const postId = 'e'.repeat(64);
    const journal = await journaled(10, () => settlePruneUtxo([postId], 10));
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

    const journal = await journaled(10, () => settlePruneUtxo([rootPostId], 10));

    // Zero-value box is skipped (lockBox.value > 0 check)
    expect(removedIds(journal)).not.toContain(lockBox.id);
    expect(journal.mutations.length).toBe(0);
  });

  it('LikeBoxes from different posts are not cross-consumed', async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const targetPostId = 'g'.repeat(64);
    const otherPostId = 'h'.repeat(64);
    const likerId = makeUserId('liker4');

    // Insert a LikeBox targeting a different post
    const otherLikeBox = makeLikeBox(likerId, otherPostId, 1);
    utxo.insertBox(otherLikeBox);

    const journal = await journaled(10, () =>
      settlePruneUtxo([targetPostId], 10),
    );

    // LikeBox for otherPostId should not be consumed
    expect(removedIds(journal)).not.toContain(otherLikeBox.id);
    // Box should remain unspent
    const db = getDb();
    expect(boxIsSpent(db, otherLikeBox.id!)).toBe(false);
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

  it('full lifecycle: create posts, like, prune, verify refunds', async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const topology = await importTopology();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const rootId = 'a'.repeat(64);
    const replyId = 'b'.repeat(64);
    const authorId = makeUserId('author1');
    const likerId = makeUserId('liker1');

    // 1. Seed block_topology: root has no parents, reply has root as parent
    const authorHex = Buffer.from(authorId).toString('hex');
    topology.insertBlockTopology(rootId, [], authorHex, 1);
    topology.insertBlockTopology(replyId, [rootId], authorHex, 2);

    // 2. Verify subtree includes both posts
    const subtree = topology.getSubtreeTopology(rootId);
    expect(subtree).toEqual(new Set([rootId, replyId]));

    // 3. Seed UTXO: PostLockBox for each post + LikeBox on root
    const lb1 = makePostLockBox(50, authorId, rootId, 1);
    const lb2 = makePostLockBox(50, authorId, replyId, 1);
    const lk1 = makeLikeBox(likerId, rootId, 1);
    utxo.insertBox(lb1);
    utxo.insertBox(lb2);
    utxo.insertBox(lk1);

    // 4. Apply settlement
    const journal = await journaled(10, () =>
      settlePruneUtxo([rootId, replyId], 10),
    );

    // 5. Verify PostLockBoxes consumed
    expect(removedIds(journal)).toContain(lb1.id);
    expect(removedIds(journal)).toContain(lb2.id);

    // 6. Verify LikeBox consumed
    expect(removedIds(journal)).toContain(lk1.id);

    // 7. Verify karma refunded: author gets 50+50=100, liker gets 2
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
    const likerBox = createdBoxes.find(
      (b) => b && Buffer.from(b.owner).equals(Buffer.from(likerId)),
    );
    expect(authorBox).toBeDefined();
    expect(authorBox!.value).toBe(100);
    expect(likerBox).toBeDefined();
    expect(likerBox!.value).toBe(2);

    // 8. Verify all original boxes are marked spent
    expect(boxIsSpent(db, lb1.id!)).toBe(true);
    expect(boxIsSpent(db, lb2.id!)).toBe(true);
    expect(boxIsSpent(db, lk1.id!)).toBe(true);

    // 9. Verify getPostLockBox returns null (box now spent)
    expect(utxo.getPostLockBox(rootId)).toBeNull();
    expect(utxo.getPostLockBox(replyId)).toBeNull();

    // 10. Verify getUnspentLikeBoxes returns empty (like now spent)
    expect(utxo.getUnspentLikeBoxes(rootId)).toEqual([]);
  });
});
