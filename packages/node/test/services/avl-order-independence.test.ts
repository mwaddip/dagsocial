import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computePostId, encodePost, LIKE_THRESHOLD } from '@dagsocial/types';
import type { OrderingBlock } from '@dagsocial/types';
import type Database from 'better-sqlite3';
import { uid, makePost, makeLikeBox } from '../helpers.js';

// ---------------------------------------------------------------------------
// Spec B P2 acceptance (M-12) — the audit escalation scenario, made
// permanent: two nodes holding the same posts and likes, but with the like
// boxes inserted into their DBs in different row orders, build/apply the
// same epoch block and end at the identical AVL digest.
//
// Node A seeds the like boxes in creation order and builds the chain with
// the production block creator (which also applies each block). Node B — a
// fresh module universe via vi.resetModules() — seeds the identical boxes
// in reversed row order and applies node A's blocks, the gossip path.
//
// The divergence this pins enters through the bootstrap feed:
// getUnspentBoxes orders by created_at_block, and same-height boxes tie, so
// SQLite resolves them by rowid — i.e. the order the rows were written. The
// two nodes therefore bootstrap the identical box set in opposite orders,
// and an unsorted feed builds two differently-shaped AVL trees.
//
// Fixture discipline, both parts learned by measuring an unsorted prover:
//
//  - The like boxes must SURVIVE to the comparison. With ≥ 2×LIKE_THRESHOLD
//    likes the epoch tally spends every like box, and the two trees
//    reconverge on the small remainder: the assertion then holds with or
//    without the sort, pinning nothing. LIKE_THRESHOLD + 1 likes still mint
//    an author reward (floor(6/5) = 1) but sit under the spend threshold, so
//    the divergently-ordered boxes are still in both trees at the end.
//
//  - The box ids must be FIXED, not random. Whether two insertion orders of
//    the same keys produce differently-shaped AVL trees depends on the key
//    values; with per-run random identities some draws collide and the
//    unsorted prover passes by luck. Deterministic ids (uid() + a fixed post
//    timestamp) make the pre-fix failure reproducible.
//
// The guards below fail loudly if either property stops holding.
// ---------------------------------------------------------------------------

const epochConfig = {
  port: 3000,
  dbPath: ':memory:',
  networkMode: 'testnet' as const,
  nodeRole: 'miner' as const,
  postPowTargetBits: 20,
  challengeWindowBlocks: 10,
  orderingBlockIntervalMs: 60000,
  orderingBlockMinSubBlocks: 1,
  maxSubBlocksPerBlock: 1000,
  epochBlocks: 2, // tally on block 3
  miningMode: 'internal' as const,
  orderingBlockPowTargetBits: 12,
  creditInitialReward: 100,
  creditTreasuryPct: 10,
  treasuryPubKey: '',
  bootstrapPeers: [] as string[],
  listenAddrs: '/ip4/127.0.0.1/tcp/0',
  maxPeers: 50,
};

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
    startBlockCreator: (cfg: typeof epochConfig) => void;
    stopBlockCreator: () => void;
    createOrderingBlock: () => OrderingBlock | null;
  };
}

async function importBlockApply() {
  return (await import('../../src/services/block-apply.js')) as unknown as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
  };
}

async function importAvl() {
  return (await import('../../src/state/avl-prover.js')) as
    typeof import('../../src/state/avl-prover.js');
}

async function importPosts() {
  return (await import('../../src/store/posts.js')) as {
    insertPost: (post: import('@dagsocial/types').Post, rawCbor: Uint8Array) => void;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    getBox: (boxId: string) => { id?: string } | null;
    getKarmaBox: (owner: Uint8Array) => { value: bigint } | null;
    getUnspentBoxes: () => import('@dagsocial/types').AnyBox[];
  };
}

/**
 * Activate the AVL prover singleton on the current universe's DB and
 * bootstrap the seeded boxes — the production startup wiring from
 * src/index.ts (same shape as the journal round-trip harness).
 */
async function activateProver() {
  const avlMod = await importAvl();
  const utxo = await importUtxo();
  const handle = avlMod.createAvlProver();
  const unspent = utxo.getUnspentBoxes();
  expect(unspent.length).toBeGreaterThan(0);
  avlMod.bootstrapAvlProver(handle, unspent, 0);
  expect(avlMod.tryGetAvlProver()).not.toBeNull();
  return {
    handle,
    // The order the prover WOULD have seen without the sort — returned so the
    // test can assert the two nodes really presented divergent input.
    feedOrder: unspent.map((b) => b.id!),
    // Captured before any block: this isolates the bootstrap feed from every
    // later mutation, so it is the assertion the bootstrap sort owns outright.
    bootstrapDigest: new Uint8Array(handle.prover.digest()!),
  };
}

describe('AVL digest order-independence across nodes (P2 acceptance)', () => {
  beforeEach(() => {
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

  it('different like-box row orders: same epoch block, identical digest', async () => {
    // Shared fixture data — fixed values, valid across both module universes.
    const authorId = uid('p2-order-author');
    // makePost stamps Date.now(); pinning it pins postId, hence every like
    // box id, hence the AVL shapes this test compares.
    const post = { ...makePost(authorId, 'order-independence victim'), timestamp: 1 };
    const postId = computePostId(post);
    const rawPost = encodePost(post);
    // Under 2×LIKE_THRESHOLD: rewards the author but leaves the like boxes
    // unspent, so they survive into the compared digest (see header).
    const likeBoxes = Array.from({ length: LIKE_THRESHOLD + 1 }, (_, i) =>
      makeLikeBox(uid(`p2-order-liker-${i}`), postId, 0),
    );

    // ---- Node A: like boxes in creation order; builds the chain. ----
    const dbA = await importDb();
    dbA.initDb(':memory:');
    (await importPosts()).insertPost(post, rawPost);
    const utxoA = await importUtxo();
    for (const lb of likeBoxes) utxoA.insertBox(lb);

    const {
      handle: handleA,
      feedOrder: feedA,
      bootstrapDigest: bootA,
    } = await activateProver();
    const bcA = await importBlockCreator();
    bcA.startBlockCreator(epochConfig);

    const b1 = bcA.createOrderingBlock();
    const b2 = bcA.createOrderingBlock();
    const b3 = bcA.createOrderingBlock(); // height 3 — epoch tally
    expect(b1).not.toBeNull();
    expect(b2).not.toBeNull();
    expect(b3).not.toBeNull();
    expect(b3!.utxoTxTree.epochTallyResults).toBeDefined();
    // The epoch did real work: the author was rewarded...
    expect(utxoA.getKarmaBox(authorId)?.value).toBe(1n);
    // ...and the like boxes survived it, so they are still in the tree whose
    // digest is compared below. Without this the two trees reconverge on the
    // remainder and the final assertion holds even unsorted.
    for (const lb of likeBoxes) expect(utxoA.getBox(lb.id!)).not.toBeNull();

    const digestA = new Uint8Array(handleA.prover.digest()!);
    bcA.stopBlockCreator();

    // ---- Node B: identical boxes, reversed row order; applies A's blocks
    // (the gossip path — §5 verifies the carried tally, §10 recomputes and
    // applies it from node B's own DB). ----
    vi.resetModules();
    const dbB = await importDb();
    dbB.initDb(':memory:');
    (await importPosts()).insertPost(post, rawPost);
    const utxoB = await importUtxo();
    for (const lb of [...likeBoxes].reverse()) utxoB.insertBox(lb);

    const {
      handle: handleB,
      feedOrder: feedB,
      bootstrapDigest: bootB,
    } = await activateProver();
    // Non-vacuity: the two nodes really did present the same box set to the
    // prover in different orders — the condition the sort has to neutralize.
    expect([...feedB].sort()).toEqual([...feedA].sort());
    expect(feedB).not.toEqual(feedA);

    // The bootstrap sort, isolated: same set, opposite feed order, one digest.
    expect(Buffer.from(bootA).equals(Buffer.from(bootB))).toBe(true);

    const applyB = await importBlockApply();
    expect(applyB.applyOrderingBlock(b1!)).toBe(true);
    expect(applyB.applyOrderingBlock(b2!)).toBe(true);
    expect(applyB.applyOrderingBlock(b3!)).toBe(true);
    expect(utxoB.getKarmaBox(authorId)?.value).toBe(1n);
    for (const lb of likeBoxes) expect(utxoB.getBox(lb.id!)).not.toBeNull();

    const digestB = new Uint8Array(handleB.prover.digest()!);

    // End to end: two nodes, same posts and likes, different row order, one
    // chain — the audit escalation scenario, and the same digest.
    expect(Buffer.from(digestA).equals(Buffer.from(digestB))).toBe(true);
  });
});
