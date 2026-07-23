import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  PROTOCOL_VERSION,
  getUserId,
  computeBoxId,
  encodeOrderingBlock,
  EPOCH_BLOCKS,
  LIKE_THRESHOLD,
  LIKE_MAX_AUTHOR_REWARD,
  LIKE_COST,
  ORDERING_BLOCK_REWARD_CREDITS,
  POST_LOCK_UNLOCK_PER_LIKES,
} from '@dagsocial/types';
import type {
  OrderingBlock,
  EpochTally,
  LikeReward,
  KarmaBox,
  PostLockBox,
} from '@dagsocial/types';
import type { Config } from '../config.js';
import { getNet } from './net-instance.js';
import { mintKarma } from './karma.js';
import {
  getPendingSubBlocks,
  createOrderingBlock as storeCreateOrderingBlock,
  getOrderingBlock,
  getCurrentHeight,
  confirmSubBlock,
  confirmPost,
  getUnprocessedLockedLikeBoxes,
  markLikeBoxesTallied,
  getUnprocessedFreeLikes,
  markFreeLikesProcessed,
  insertBox,
  consumeBox,
  getKarmaBox,
  getPost,
  getIdentity,
  getUnspentPostLockBoxes,
  getPostTotalLikes,
} from '../store/index.js';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let config: Config;
let validatorPubKey: Uint8Array;
let validatorPrivKey: KeyObject;
let validatorId: string;
let intervalId: ReturnType<typeof setInterval> | null = null;
let pendingSubBlockCounter = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the ordering block creator.
 *
 * Generates an Ed25519 validator keypair (stored in module scope) and starts an
 * interval timer that fires at ORDERING_BLOCK_INTERVAL_MS.  The timer and
 * onSubBlockReceived() both call createOrderingBlock() to produce the next block.
 */
export function startBlockCreator(cfg: Config): void {
  config = cfg;

  // Generate validator keypair
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  validatorPubKey = new Uint8Array(pubDer.subarray(pubDer.length - 32));
  validatorPrivKey = privateKey;
  validatorId = getUserId(validatorPubKey);

  // Start interval timer
  intervalId = setInterval(() => {
    createOrderingBlock();
  }, config.orderingBlockIntervalMs);
}

/**
 * Stop the ordering block creator.
 *
 * Clears the interval timer. Does not destroy the validator keypair, so
 * startBlockCreator() can be called again later (generating a new keypair).
 */
export function stopBlockCreator(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/**
 * Signal that a sub-block was received from a user.
 *
 * Increments an internal counter and triggers immediate block creation if the
 * counter reaches ORDERING_BLOCK_MIN_SUB_BLOCKS.  After a successful block
 * creation the counter is reset to 0 inside createOrderingBlock().
 */
export function onSubBlockReceived(): void {
  // No-op if block creator is not running (server mode)
  if (!config) return;
  pendingSubBlockCounter++;
  if (pendingSubBlockCounter >= config.orderingBlockMinSubBlocks) {
    createOrderingBlock();
  }
}

// ---------------------------------------------------------------------------
// Core block creation
// ---------------------------------------------------------------------------

/**
 * Produce the next ordering block.
 *
 * Returns the newly created OrderingBlock, or null if there is nothing to
 * confirm (no pending sub-blocks, no standalone like boxes, and not an epoch
 * boundary).
 */
export function createOrderingBlock(): OrderingBlock | null {
  const currentHeight = getCurrentHeight();
  const newHeight = currentHeight + 1;

  // 1. Collect pending sub-blocks (oldest first, up to limit)
  const subBlocks = getPendingSubBlocks(config.maxSubBlocksPerBlock);

  // 2. Collect standalone unprocessed locked like boxes
  const standaloneLikes = getUnprocessedLockedLikeBoxes();

  // 3. Deduplicate: remove like box IDs that already ride inside a sub-block
  const subBlockLikeIds = new Set<string>();
  for (const sb of subBlocks) {
    for (const lb of sb.likeBoxes) {
      if (lb.id) subBlockLikeIds.add(lb.id);
    }
  }
  const dedupedStandaloneLikeIds: string[] = [];
  for (const lb of standaloneLikes) {
    if (lb.id && !subBlockLikeIds.has(lb.id)) {
      dedupedStandaloneLikeIds.push(lb.id);
    }
  }

  // 4. Determine if this is an epoch boundary
  //    Epoch tally runs when currentHeight > 0 and currentHeight % EPOCH_BLOCKS === 0
  const isEpochBoundary =
    currentHeight > 0 && currentHeight % config.epochBlocks === 0;

  // 5. Guard: nothing to confirm
  if (
    subBlocks.length === 0 &&
    dedupedStandaloneLikeIds.length === 0 &&
    !isEpochBoundary
  ) {
    return null;
  }

  // 6. Run epoch tally (consumes all unprocessed locked likes + free likes)
  let epochTallyResults: EpochTally | undefined;
  if (isEpochBoundary) {
    epochTallyResults = runEpochTally(newHeight);
  }

  // 7. Previous block hash
  const prevBlock = currentHeight > 0 ? getOrderingBlock(currentHeight) : null;
  const prevBlockHash = prevBlock
    ? prevBlock.hash
    : '0000000000000000000000000000000000000000000000000000000000000000';

  const subBlockRefs = subBlocks.map((sb) => sb.subBlockId);

  // 8. Build block template (with placeholder hash and signature for hashing)
  const blockForHash: OrderingBlock = {
    height: newHeight,
    hash: '',
    prevBlockHash,
    subBlockRefs,
    likeBoxIds: dedupedStandaloneLikeIds,
    utxoTxIds: [],
    stumpIds: [],
    validatorId,
    validatorSignature: new Uint8Array(64),
    protocolVersion: PROTOCOL_VERSION,
    createdAt: Date.now(),
  };

  if (epochTallyResults) {
    (blockForHash as unknown as Record<string, unknown>).epochTallyResults =
      epochTallyResults;
  }

  // 9. Compute block hash over CBOR-serialized block
  const serialized = encodeOrderingBlock(blockForHash);
  const blockHash = createHash('blake2b512')
    .update(Buffer.from(serialized))
    .digest()
    .subarray(0, 32)
    .toString('hex');

  // 10. Sign with validator key
  const sig = cryptoSign(
    null,
    Buffer.from(blockHash, 'hex'),
    validatorPrivKey,
  );

  // 11. Finalize block
  const block: OrderingBlock = {
    height: newHeight,
    hash: blockHash,
    prevBlockHash,
    subBlockRefs,
    likeBoxIds: dedupedStandaloneLikeIds,
    utxoTxIds: [],
    stumpIds: [],
    validatorId,
    validatorSignature: new Uint8Array(sig),
    protocolVersion: PROTOCOL_VERSION,
    createdAt: blockForHash.createdAt,
  };

  if (epochTallyResults) {
    block.epochTallyResults = epochTallyResults;
  }

  // 12. Store block
  storeCreateOrderingBlock(block);

  // Broadcast ordering block to peers (fire-and-forget)
  const net = getNet();
  if (net) {
    net.broadcastOrderingBlock(block).catch((err: Error) => {
      console.warn(`Failed to broadcast ordering block: ${err.message}`);
    });
  }

  // 13. Confirm sub-blocks and their posts
  for (const sb of subBlocks) {
    confirmSubBlock(sb.subBlockId, newHeight);
    confirmPost(sb.subBlockId, newHeight);
  }

  // 14. Reset sub-block counter
  pendingSubBlockCounter = 0;

  return block;
}

// ---------------------------------------------------------------------------
// Epoch tally
// ---------------------------------------------------------------------------

/**
 * Process all unprocessed locked like boxes and free likes at an epoch
 * boundary, compute author rewards and liker refunds, and update the UTXO
 * ledger.
 *
 * Called by createOrderingBlock() when currentHeight % EPOCH_BLOCKS === 0.
 * Returns the EpochTally structure to be recorded in the ordering block.
 */
function runEpochTally(blockHeight: number): EpochTally {
  // 1. Collect all unprocessed locked like boxes
  const lockedLikes = getUnprocessedLockedLikeBoxes();

  // 2. Collect all unprocessed free likes
  const freeLikes = getUnprocessedFreeLikes();

  // 3. Group by targetPostId
  type LockedLikeBox = ReturnType<typeof getUnprocessedLockedLikeBoxes>[number];
  type FreeLike = ReturnType<typeof getUnprocessedFreeLikes>[number];

  const groups = new Map<
    string,
    { locked: LockedLikeBox[]; free: FreeLike[] }
  >();

  for (const lb of lockedLikes) {
    const group = groups.get(lb.targetPostId);
    if (group) {
      group.locked.push(lb);
    } else {
      groups.set(lb.targetPostId, { locked: [lb], free: [] });
    }
  }

  for (const fl of freeLikes) {
    const group = groups.get(fl.targetPostId);
    if (group) {
      group.free.push(fl);
    } else {
      groups.set(fl.targetPostId, { locked: [], free: [fl] });
    }
  }

  const rewards: Record<string, LikeReward> = {};
  const allLockedBoxIds: string[] = [];
  const allFreeLikeIds: string[] = [];

  for (const [targetPostId, { locked, free }] of groups) {
    const totalLikeCount = locked.length + free.length;

    // 4a. Author reward
    const authorReward = Math.min(
      Math.floor(totalLikeCount / LIKE_THRESHOLD),
      LIKE_MAX_AUTHOR_REWARD,
    );

    // 4b. Liker refunds (locked like boxes only)
    // Only unlock when 2x threshold is met. Otherwise roll over to next epoch.
    const likerRefunds: Record<string, number> = {};
    const thresholdMet = totalLikeCount >= 2 * LIKE_THRESHOLD;

    for (const lb of locked) {
      if (thresholdMet) {
        // Unlock: return full 2 karma to liker, consume the like box
        if (lb.id) allLockedBoxIds.push(lb.id);
        mintKarma(lb.likerId, LIKE_COST, blockHeight);
        likerRefunds[lb.likerId] = 0; // net zero: paid 2, refunded 2
      }
      // Below threshold: leave locked — rolls over to next epoch.
      // Like box is NOT consumed, NOT added to allLockedBoxIds.
    }

    // 4c. Mint author reward
    if (authorReward > 0) {
      const authorId = getPostAuthorId(targetPostId);
      if (authorId) {
        mintKarma(authorId, authorReward, blockHeight);
      }
    }

    // 4d. Free likes — mark for processing
    for (const fl of free) {
      allFreeLikeIds.push(fl.id);
    }

    rewards[targetPostId] = {
      targetPostId,
      likeCount: totalLikeCount,
      authorReward,
      likerRefunds,
    };
  }

  // 5. Mark locked like boxes as tallied (spent)
  markLikeBoxesTallied(allLockedBoxIds);

  // 6. Mark free likes as processed
  markFreeLikesProcessed(allFreeLikeIds);

  // 7. Process post lock boxes — unlock karma based on cumulative likes
  const postLockBoxes = getUnspentPostLockBoxes();
  for (const plb of postLockBoxes) {
    if (!plb.id) continue;

    const totalLikes = getPostTotalLikes(plb.targetPostId);
    const alreadyUnlocked = plb.originalValue - plb.value;
    const shouldUnlock = Math.floor(totalLikes / POST_LOCK_UNLOCK_PER_LIKES);
    const toUnlock = Math.min(plb.value, shouldUnlock - alreadyUnlocked);

    if (toUnlock <= 0) continue;

    const remainingLocked = plb.value - toUnlock;

    // Consume old post lock box
    consumeBox(plb.id, blockHeight);

    if (remainingLocked > 0) {
      // Create reduced post lock box
      const newPlb: PostLockBox = {
        boxType: 'post_lock',
        value: remainingLocked,
        originalValue: plb.originalValue,
        createdAtBlock: blockHeight,
        owner: plb.owner,
        targetPostId: plb.targetPostId,
        guard: 'epoch_tally',
      };
      newPlb.id = computeBoxId(newPlb);
      insertBox(newPlb);
    }

    // Refund unlocked karma to the post author
    const post = getPost(plb.targetPostId);
    if (post && !('subtreeMerkleRoot' in post)) {
      const authorId = post.author;
      mintKarma(authorId, toUnlock, blockHeight);
    }

    // Record unlock in epoch tally
    if (!rewards[plb.targetPostId]) {
      rewards[plb.targetPostId] = {
        targetPostId: plb.targetPostId,
        likeCount: 0,
        authorReward: 0,
        likerRefunds: {},
      };
    }
    rewards[plb.targetPostId]!.postLockKarmaUnlocked =
      (rewards[plb.targetPostId]!.postLockKarmaUnlocked ?? 0) + toUnlock;
  }

  return { rewards };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the author userId of a post.
 *
 * Returns null if the post does not exist in the store.
 */
function getPostAuthorId(postId: string): string | null {
  const post = getPost(postId);
  if (!post) return null;

  // Post has an `author` field; Stump has `authorId`
  if ('author' in post) {
    return post.author;
  }
  return null;
}
