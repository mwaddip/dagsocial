import { describe, it, expect } from 'vitest';
import { leafHash } from '@dagsocial/types';
import type { EpochTally, LikeReward, PostLockBox, UtxoTxTree } from '@dagsocial/types';
import {
  canonicalRewardsJson,
  canonicalEpochTallyJson,
} from '../../src/services/epoch-canonical.js';

// ---------------------------------------------------------------------------
// Builders
//
// Keys are deliberately non-numeric strings: JS objects order integer-like
// keys ascending regardless of insertion, which would hide the very bug these
// tests cover. Real postIds/likerIds are hex, so insertion order rules there.
// ---------------------------------------------------------------------------

function makeReward(
  targetPostId: string,
  likerIds: string[],
  authorReward = 1,
): LikeReward {
  const likerRefunds: Record<string, number> = {};
  for (const likerId of likerIds) likerRefunds[likerId] = 0;
  return {
    targetPostId,
    likeCount: likerIds.length,
    authorReward,
    likerRefunds,
  };
}

/** Rebuild an object with its keys in reverse insertion order. */
function reverseKeys<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).reverse()) out[key] = obj[key];
  return out as T;
}

function makePostLockBox(id: string, targetPostId: string, value: number): PostLockBox {
  return {
    id,
    boxType: 'post_lock',
    value,
    originalValue: 5,
    createdAtBlock: 7,
    owner: new Uint8Array([1, 2, 3, 4]),
    targetPostId,
    guard: 'epoch_tally',
  } as PostLockBox;
}

/**
 * A tally with every map and array populated, so a permutation exercises each
 * ordering-sensitive field at once.
 */
function makeTally(): EpochTally {
  const rewards: Record<string, LikeReward> = {};
  rewards['post-alpha'] = makeReward('post-alpha', ['ab', 'cd', 'ef'], 2);
  rewards['post-beta'] = makeReward('post-beta', ['cd'], 1);
  rewards['post-gamma'] = makeReward('post-gamma', [], 0);
  return {
    rewards,
    talliedLockedLikeBoxIds: ['box-3', 'box-1', 'box-2'],
    processedFreeLikeIds: ['free-2', 'free-1'],
    consumedPostLockBoxIds: ['lock-2', 'lock-1'],
    newPostLockBoxes: [
      makePostLockBox('lock-new-2', 'post-beta', 1),
      makePostLockBox('lock-new-1', 'post-alpha', 3),
    ],
  };
}

/**
 * The same logical tally as a node that received everything in the opposite
 * order would hold: every map rebuilt in reverse key order, every array
 * reversed.
 */
function reverseTallyOrder(tally: EpochTally): EpochTally {
  const rewards: Record<string, LikeReward> = {};
  for (const postId of Object.keys(tally.rewards).reverse()) {
    const reward = tally.rewards[postId]!;
    rewards[postId] = { ...reward, likerRefunds: reverseKeys(reward.likerRefunds) };
  }
  return {
    ...tally,
    rewards,
    talliedLockedLikeBoxIds: [...tally.talliedLockedLikeBoxIds].reverse(),
    processedFreeLikeIds: [...tally.processedFreeLikeIds].reverse(),
    consumedPostLockBoxIds: [...tally.consumedPostLockBoxIds].reverse(),
    newPostLockBoxes: [...tally.newPostLockBoxes].reverse(),
  };
}

function epochLeaf(tally: EpochTally): string {
  return Buffer.from(
    leafHash('epoch', Buffer.from(canonicalEpochTallyJson(tally))),
  ).toString('hex');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('canonical epoch-tally serialization (audit C-6)', () => {
  // -----------------------------------------------------------------------
  // 1. rewards key order
  // -----------------------------------------------------------------------

  it('serializes the same rewards set identically whatever the key order', () => {
    const alpha = makeReward('post-alpha', ['ab', 'cd'], 2);
    const beta = makeReward('post-beta', ['ef'], 1);
    const gamma = makeReward('post-gamma', [], 0);

    const nodeA: Record<string, LikeReward> = {};
    nodeA['post-alpha'] = alpha;
    nodeA['post-beta'] = beta;
    nodeA['post-gamma'] = gamma;

    const nodeB: Record<string, LikeReward> = {};
    nodeB['post-gamma'] = gamma;
    nodeB['post-alpha'] = alpha;
    nodeB['post-beta'] = beta;

    // Vacuity guard: the insertion-order serialization these two nodes used to
    // be compared with really does disagree, so the assertion below is not
    // passing for want of a difference.
    expect(JSON.stringify(nodeA)).not.toBe(JSON.stringify(nodeB));

    expect(canonicalRewardsJson(nodeA)).toBe(canonicalRewardsJson(nodeB));
  });

  // -----------------------------------------------------------------------
  // 2. nested likerRefunds key order
  // -----------------------------------------------------------------------

  it('serializes nested likerRefunds identically whatever the key order', () => {
    const nodeA: Record<string, LikeReward> = {
      'post-alpha': makeReward('post-alpha', ['ab', 'cd', 'ef'], 2),
    };
    const nodeB: Record<string, LikeReward> = {
      'post-alpha': makeReward('post-alpha', ['ef', 'ab', 'cd'], 2),
    };

    expect(JSON.stringify(nodeA)).not.toBe(JSON.stringify(nodeB));

    expect(canonicalRewardsJson(nodeA)).toBe(canonicalRewardsJson(nodeB));
  });

  // -----------------------------------------------------------------------
  // 3. Canonicalization must not erase a real difference
  // -----------------------------------------------------------------------

  it('still distinguishes tallies that differ in value, not just order', () => {
    const base: Record<string, LikeReward> = {
      'post-alpha': makeReward('post-alpha', ['ab', 'cd'], 2),
    };
    const differentAuthorReward: Record<string, LikeReward> = {
      'post-alpha': makeReward('post-alpha', ['ab', 'cd'], 3),
    };
    const differentLiker: Record<string, LikeReward> = {
      'post-alpha': makeReward('post-alpha', ['ab', 'ee'], 2),
    };
    const extraPost: Record<string, LikeReward> = {
      'post-alpha': makeReward('post-alpha', ['ab', 'cd'], 2),
      'post-beta': makeReward('post-beta', [], 0),
    };

    expect(canonicalRewardsJson(base)).not.toBe(canonicalRewardsJson(differentAuthorReward));
    expect(canonicalRewardsJson(base)).not.toBe(canonicalRewardsJson(differentLiker));
    expect(canonicalRewardsJson(base)).not.toBe(canonicalRewardsJson(extraPost));
  });

  // -----------------------------------------------------------------------
  // 4. Merkle leaf
  // -----------------------------------------------------------------------

  it('hashes a permuted tally to the same epoch Merkle leaf', () => {
    const local = makeTally();
    const peer = reverseTallyOrder(local);

    // Vacuity guard: this is exactly the preimage pair the old
    // `JSON.stringify` leaf produced two different hashes for.
    expect(JSON.stringify(local)).not.toBe(JSON.stringify(peer));

    expect(epochLeaf(peer)).toBe(epochLeaf(local));
  });

  it('hashes a logically different tally to a different epoch Merkle leaf', () => {
    const local = makeTally();
    const changed = makeTally();
    changed.rewards['post-alpha']!.authorReward = 9;

    expect(epochLeaf(changed)).not.toBe(epochLeaf(local));

    const extraBox = makeTally();
    extraBox.talliedLockedLikeBoxIds.push('box-4');
    expect(epochLeaf(extraBox)).not.toBe(epochLeaf(local));
  });

  // -----------------------------------------------------------------------
  // 5. Byte fields: Uint8Array and Buffer are the same value
  // -----------------------------------------------------------------------

  it('serializes Uint8Array and Buffer owners identically', () => {
    const withUint8 = makeTally();
    const withBuffer = makeTally();
    const owner = new Uint8Array([1, 2, 3, 4]);
    (withUint8.newPostLockBoxes[0] as PostLockBox).owner = owner;
    (withBuffer.newPostLockBoxes[0] as PostLockBox).owner =
      Buffer.from(owner) as unknown as Uint8Array;

    // `JSON.stringify` renders a Buffer as {"type":"Buffer","data":[…]} and a
    // Uint8Array as {"0":…}, so the naive preimage depends on which
    // representation the box happens to carry.
    expect(JSON.stringify(withUint8)).not.toBe(JSON.stringify(withBuffer));

    expect(canonicalEpochTallyJson(withBuffer)).toBe(canonicalEpochTallyJson(withUint8));
  });

  // -----------------------------------------------------------------------
  // 6. The whole utxoTxRoot, not just the leaf
  // -----------------------------------------------------------------------

  it('computes the same utxoTxRoot for a tree whose tally was ordered differently', async () => {
    const { computeUtxoTxRoot } = await import('../../src/services/block-creator.js');

    const local = makeTally();
    const baseTree: UtxoTxTree = {
      utxoTxIds: [],
      utxoTxs: [],
      likeBoxIds: [],
      coinbaseOutputs: [
        {
          owner: new Uint8Array(32),
          value: 100,
          lockedUntilBlock: 721,
          isTreasury: false,
        },
      ],
    };

    const localTree: UtxoTxTree = { ...baseTree, epochTallyResults: local };
    const peerTree: UtxoTxTree = { ...baseTree, epochTallyResults: reverseTallyOrder(local) };

    expect(computeUtxoTxRoot(peerTree)).toBe(computeUtxoTxRoot(localTree));

    const changed = makeTally();
    changed.rewards['post-beta']!.likeCount = 42;
    const changedTree: UtxoTxTree = { ...baseTree, epochTallyResults: changed };
    expect(computeUtxoTxRoot(changedTree)).not.toBe(computeUtxoTxRoot(localTree));
  });
});
