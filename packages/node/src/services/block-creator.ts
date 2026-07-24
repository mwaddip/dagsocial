import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  PROTOCOL_VERSION,
  computeBoxId,
  computeTxId,
  encodeOrderingBlock,
  decodeSubBlock,
  decodeTx,
  EPOCH_BLOCKS,
  LIKE_THRESHOLD,
  LIKE_MAX_AUTHOR_REWARD,
  LIKE_COST,
  CREDIT_FIXED_RATE_BLOCKS,
  CREDIT_INITIAL_REWARD,
  CREDIT_EPOCH_BLOCKS,
  CREDIT_REWARD_REDUCTION,
  CREDIT_TAIL_REWARD,
  CREDIT_MINER_REWARD_DELAY,
  POST_LOCK_UNLOCK_PER_LIKES,
} from '@dagsocial/types';
import type {
  OrderingBlock,
  CoinbaseOutput,
  EpochTally,
  LikeReward,
  AnyBox,
  KarmaBox,
  PostLockBox,
  UtxoTransaction,
  LikeBox,
  UserId,
} from '@dagsocial/types';
import { verifyOrderingBlockPoW, computeBlockBodyHash } from '@dagsocial/validation';
import type { Config } from '../config.js';
import { getNet } from './net-instance.js';
import { mintKarma } from './karma.js';
import { mintCredits } from './credits.js';
import { revalidateTxInContext, applyTx } from './utxo-engine.js';
import { getDb } from '../store/db.js';
import {
  getPendingEntries,
  purgeExpired,
  removeEntry,
  removeBatch,
  type PoolEntry,
} from '../store/mempool.js';
import {
  createOrderingBlock as storeCreateOrderingBlock,
  getOrderingBlock,
  getCurrentHeight,
  confirmPost,
  getUnprocessedLockedLikeBoxes,
  markLikeBoxesTallied,
  getUnprocessedFreeLikes,
  markFreeLikesProcessed,
  insertBox,
  consumeBox,
  getBox,
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
let validatorId: Uint8Array;
let intervalId: ReturnType<typeof setInterval> | null = null;
let pendingSubBlockCounter = 0;
let currentTemplate: OrderingBlock | null = null;   // For external mining mode
let confirmedRowids: Set<number> = new Set();       // Mempool rowids included in current block
let difficultyWindowStartMs: number | null = null;   // Timestamp of first block in current epoch
let difficultyWindowStartTarget: number | null = null; // Target bits of first block in current epoch

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startBlockCreator(cfg: Config): void {
  config = cfg;

  // Generate validator keypair
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  validatorPubKey = new Uint8Array(pubDer.subarray(pubDer.length - 32));
  validatorPrivKey = privateKey;
  validatorId = validatorPubKey;

  // Initialize difficulty tracking from last epoch boundary
  initDifficultyWindow();

  // Start interval timer
  intervalId = setInterval(() => {
    createOrderingBlock();
  }, config.orderingBlockIntervalMs);
}

export function stopBlockCreator(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

export function onSubBlockReceived(): void {
  if (!config) return;
  pendingSubBlockCounter++;
  if (pendingSubBlockCounter >= config.orderingBlockMinSubBlocks) {
    createOrderingBlock();
  }
}

/**
 * Return the current block template for external miners.
 * Returns null if no template has been built yet or the block creator
 * is in internal mode.
 */
export function getCurrentTemplate(): OrderingBlock | null {
  return currentTemplate;
}

/**
 * Clear the current template. Called when a relayed block arrives so the
 * block creator builds a fresh template for the next height.
 */
export function clearTemplate(): void {
  currentTemplate = null;
  pendingSubBlockCounter = 0;
}

/**
 * Submit a mined nonce from an external miner.
 * Verifies PoW, finalizes the block, stores it, and broadcasts.
 * Returns the finalized block hash on success, null on failure.
 */
export function submitMinedBlock(powNonce: number, submittedHeight: number): string | null {
  const tpl = currentTemplate;
  // Reject if no template, wrong height, or height already mined
  if (!tpl || tpl.height !== submittedHeight || getCurrentHeight() >= submittedHeight) {
    return null;
  }

  // Build block with the submitted nonce
  const block: OrderingBlock = {
    ...tpl,
    powNonce,
  };

  // Verify PoW
  if (!verifyOrderingBlockPoW(block)) {
    return null;
  }

  // Sign the body hash (covers everything except the signature itself)
  const bodyHash = computeBlockBodyHash(block);
  const sig = cryptoSign(null, bodyHash, validatorPrivKey);
  block.validatorSignature = new Uint8Array(sig);

  // Compute final block hash
  block.hash = createHash('blake2b512')
    .update(Buffer.from(encodeOrderingBlock(block)))
    .digest()
    .subarray(0, 32)
    .toString('hex');

  // Finalize and broadcast
  finalizeBlock(block);

  return block.hash;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

/**
 * Compute the block reward at a given height using Ergo-style linear decay.
 */
export function computeBlockReward(height: number): number {
  if (height <= 0) return 0;
  if (height <= CREDIT_FIXED_RATE_BLOCKS) {
    return CREDIT_INITIAL_REWARD;
  }
  const epochs = Math.floor(
    (height - CREDIT_FIXED_RATE_BLOCKS - 1) / CREDIT_EPOCH_BLOCKS,
  ) + 1;
  const reward = CREDIT_INITIAL_REWARD - epochs * CREDIT_REWARD_REDUCTION;
  return Math.max(reward, CREDIT_TAIL_REWARD);
}

// ---------------------------------------------------------------------------
// Difficulty adjustment
// ---------------------------------------------------------------------------

function initDifficultyWindow(): void {
  // Start tracking from the current tip
  const currentHeight = getCurrentHeight();
  if (currentHeight > 0) {
    const lastBlock = getOrderingBlock(currentHeight);
    if (lastBlock) {
      difficultyWindowStartTarget = lastBlock.powTargetBits;
      difficultyWindowStartMs = lastBlock.createdAt;
    }
  }
  if (difficultyWindowStartTarget === null) {
    difficultyWindowStartTarget = config.orderingBlockPowTargetBits;
  }
}

function adjustDifficulty(currentHeight: number): number {
  if (!difficultyWindowStartMs || !difficultyWindowStartTarget) {
    return config.orderingBlockPowTargetBits;
  }

  // Only adjust at epoch boundaries
  if (currentHeight % CREDIT_EPOCH_BLOCKS !== 0) {
    return difficultyWindowStartTarget;
  }

  const now = Date.now();
  const actualDuration = now - difficultyWindowStartMs;
  const expectedDuration = CREDIT_EPOCH_BLOCKS * 60_000; // 60s blocks

  const ratio = actualDuration / expectedDuration;
  const newTarget = Math.round(difficultyWindowStartTarget * ratio);

  // Clamp to ±50%
  const clamped = Math.max(
    Math.min(newTarget, Math.ceil(difficultyWindowStartTarget * 1.5)),
    Math.floor(difficultyWindowStartTarget * 0.5),
  );

  // Floor at 4
  const final = Math.max(clamped, 4);

  // Reset window
  difficultyWindowStartMs = now;
  difficultyWindowStartTarget = final;

  return final;
}

// ---------------------------------------------------------------------------
// PoW mining (internal mode)
// ---------------------------------------------------------------------------

function encodeLE64(n: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

function solvePoW(bodyHash: Buffer, targetBits: number): number {
  let nonce = 0;
  while (true) {
    const nonceBuf = encodeLE64(nonce);
    const hash = createHash('blake2b512')
      .update(bodyHash)
      .update(nonceBuf)
      .digest()
      .subarray(0, 32);
    let bits = 0;
    for (let i = 0; i < 32 && bits < targetBits; i++) {
      if (hash[i] === 0) { bits += 8; continue; }
      let mask = 0x80;
      while ((hash[i]! & mask) === 0 && bits < targetBits) { bits++; mask >>= 1; }
      break;
    }
    if (bits >= targetBits) return nonce;
    nonce++;
  }
}

// ---------------------------------------------------------------------------
// Core block creation
// ---------------------------------------------------------------------------

export function createOrderingBlock(): OrderingBlock | null {
  const currentHeight = getCurrentHeight();
  const newHeight = currentHeight + 1;

  // 1. Purge expired mempool entries
  purgeExpired(currentHeight);

  // 2. Get pending entries from mempool
  const entries = getPendingEntries(config.maxSubBlocksPerBlock);

  // 3. Separate sub-blocks and standalone UTXO transactions
  const subBlockEntries = entries.filter((e) => e.entryType === 'subblock');
  const standaloneUtxoTxs = entries.filter(
    (e) => e.entryType === 'utxo_tx' && e.batchId === null,
  );

  // 4. Decode sub-blocks from CBOR
  const subBlocks = subBlockEntries.map((e) => decodeSubBlock(e.subblockCbor!));

  // 5. Resolve batch entries — collect linked UTXO payloads per batch
  const batchMap = new Map<string, PoolEntry[]>();
  for (const e of entries) {
    if (e.batchId) {
      if (!batchMap.has(e.batchId)) batchMap.set(e.batchId, []);
      batchMap.get(e.batchId)!.push(e);
    }
  }

  // 6. Attach standalone likes to matching sub-blocks by targetPostId
  const matchedUtxoRowids = new Set<number>();
  for (const entry of standaloneUtxoTxs) {
    const tx = decodeTx(entry.utxoTxCbor!);
    const targetPostId = extractLikeTarget(tx);
    if (targetPostId) {
      const matchingSb = subBlocks.find((sb) => sb.subBlockId === targetPostId);
      if (matchingSb) {
        // Attach like boxes from this tx to the sub-block
        for (const output of tx.outputs) {
          if (output.boxType === 'like') {
            matchingSb.likeBoxes.push(output as LikeBox);
          }
        }
        matchedUtxoRowids.add(entry.rowid);
      }
    }
  }

  // 7. Remaining standalone UTXO entries → utxoTxIds
  const remainingUtxoTxs = standaloneUtxoTxs.filter(
    (e) => !matchedUtxoRowids.has(e.rowid),
  );
  const utxoTxIds = remainingUtxoTxs.map((e) => {
    const tx = decodeTx(e.utxoTxCbor!);
    return computeTxId(tx);
  });

  // 7b. Batch-linked UTXO entries → utxoTxIds
  // These were grouped by batch_id in step 5 but never decoded/added to the block.
  for (const [, batchEntries] of batchMap) {
    for (const entry of batchEntries) {
      if (entry.entryType === 'utxo_tx' && entry.utxoTxCbor) {
        const tx = decodeTx(entry.utxoTxCbor);
        utxoTxIds.push(computeTxId(tx));
      }
    }
  }

  // 8. Collect standalone unprocessed locked like boxes
  const standaloneLikes = getUnprocessedLockedLikeBoxes();

  // 9. Deduplicate like boxes (a like box in both sub-block and standalone pool)
  const sbLikeIds = new Set(
    subBlocks.flatMap((sb) => sb.likeBoxes.map((lb) => lb.id!)),
  );
  const filteredStandaloneLikes = standaloneLikes.filter(
    (lb) => !sbLikeIds.has(lb.id!),
  );

  const allLikeBoxIds = filteredStandaloneLikes.map((lb) => lb.id!);

  // 10. Epoch boundary?
  const isEpochBoundary =
    currentHeight > 0 && currentHeight % config.epochBlocks === 0;

  // 11. Always produce a block — miners need coinbase rewards even when
  //     there is no user work.  The block will be empty but still carries
  //     credit emission and (at epoch boundaries) an epoch tally.

  // 12. Track confirmed rowids for finalizeBlock cleanup
  confirmedRowids = new Set<number>();
  for (const e of subBlockEntries) {
    confirmedRowids.add(e.rowid);
  }
  for (const e of standaloneUtxoTxs) {
    if (matchedUtxoRowids.has(e.rowid)) {
      confirmedRowids.add(e.rowid);
    }
  }
  for (const e of remainingUtxoTxs) {
    confirmedRowids.add(e.rowid);
  }
  // Also track batch entries
  for (const [, batchEntries] of batchMap) {
    for (const e of batchEntries) {
      confirmedRowids.add(e.rowid);
    }
  }

  // 13. Compute coinbase
  const coinbaseOutputs = buildCoinbaseOutputs(newHeight);

  // 14. Difficulty adjustment
  const powTargetBits = adjustDifficulty(currentHeight);

  // 15. Epoch tally
  let epochTallyResults: EpochTally | undefined;
  if (isEpochBoundary) {
    epochTallyResults = runEpochTally(newHeight);
  }

  // 16. Previous block hash
  const prevBlock = currentHeight > 0 ? getOrderingBlock(currentHeight) : null;
  const prevBlockHash = prevBlock
    ? prevBlock.hash
    : '0000000000000000000000000000000000000000000000000000000000000000';

  const subBlockRefs = subBlocks.map((sb) => sb.subBlockId);

  // 17. Build block template (powNonce=0, empty signature)
  const template: OrderingBlock = {
    height: newHeight,
    hash: '',
    prevBlockHash,
    subBlockRefs,
    likeBoxIds: allLikeBoxIds,
    utxoTxIds,
    stumpIds: [],
    validatorId,
    validatorSignature: new Uint8Array(64),
    powNonce: 0,
    powTargetBits,
    coinbaseOutputs,
    protocolVersion: PROTOCOL_VERSION,
    createdAt: Date.now(),
  };

  if (epochTallyResults) {
    template.epochTallyResults = epochTallyResults;
  }

  // 18. Internal vs external mining
  if (config.miningMode === 'external') {
    // Store template for external miners, don't mine
    currentTemplate = template;
    return null; // Block not finalized yet
  }

  // 19. Internal: mine PoW
  const bodyHash = computeBlockBodyHash(template);
  const powNonce = solvePoW(bodyHash, powTargetBits);

  const block: OrderingBlock = {
    ...template,
    powNonce,
  };

  // 20. Sign the body hash
  const sig = cryptoSign(null, bodyHash, validatorPrivKey);
  block.validatorSignature = new Uint8Array(sig);

  // 21. Compute final hash
  block.hash = createHash('blake2b512')
    .update(Buffer.from(encodeOrderingBlock(block)))
    .digest()
    .subarray(0, 32)
    .toString('hex');

  // 22. Finalize
  finalizeBlock(block);

  return block;
}

// ---------------------------------------------------------------------------
// Block finalization (shared between internal and external mining)
// ---------------------------------------------------------------------------

function finalizeBlock(block: OrderingBlock): void {
  // 1. Store block
  storeCreateOrderingBlock(block);

  // 2. Apply coinbase — mint credits for each output
  for (const out of block.coinbaseOutputs) {
    mintCredits(out.owner, out.value, block.height, out.lockedUntilBlock);
  }

  // 3. Broadcast
  const net = getNet();
  if (net) {
    net.broadcastOrderingBlock(block).catch((err: Error) => {
      console.warn(`Failed to broadcast ordering block: ${err.message}`);
    });
  }

  // 4. Confirm sub-blocks and their posts
  for (const sbId of block.subBlockRefs) {
    confirmPost(sbId, block.height);
  }

  // 4b. Apply UTXO transactions locally (so we don't rely on gossip loopback)
  // This applies txs that were confirmed in this block.  If a tx was already
  // applied by a relayed block from the other node, skip it (idempotent).
  const utxoDeps = {
    getBox,
    insertBox: (box: AnyBox) => {
      // Skip if already exists (may have been applied via relayed block)
      if (getBox(box.id!)) return;
      insertBox(box);
    },
    consumeBox: (id: string, atBlock: number) => {
      // Only consume if still unspent
      if (!getBox(id)) return;
      consumeBox(id, atBlock);
    },
    getKarmaBox,
    getIdentity,
    runInTransaction: (fn: () => void) => {
      getDb().transaction(fn)();
    },
  };
  const allEntries = getPendingEntries(1000);
  for (const rowid of confirmedRowids) {
    const entry = allEntries.find((e) => e.rowid === rowid);
    if (!entry || entry.entryType !== 'utxo_tx' || !entry.utxoTxCbor) continue;
    const tx = decodeTx(entry.utxoTxCbor);
    const revalResult = revalidateTxInContext(utxoDeps, tx, block.height);
    if (!revalResult.valid) {
      console.warn(`UTXO tx revalidation failed at block ${block.height}: ${revalResult.error}`);
      continue;
    }
    const outputsWithIds = tx.outputs.map((box) => ({
      ...box,
      id: computeBoxId(box),
    }));
    applyTx(utxoDeps, tx, outputsWithIds, block.height);
  }

  // 5. Remove confirmed entries from mempool
  for (const rowid of confirmedRowids) {
    removeEntry(rowid);
  }

  // 6. Reset state
  pendingSubBlockCounter = 0;
  currentTemplate = null;
  confirmedRowids = new Set();
}

// ---------------------------------------------------------------------------
// Coinbase
// ---------------------------------------------------------------------------

function buildCoinbaseOutputs(height: number): CoinbaseOutput[] {
  const reward = computeBlockReward(height);
  const outputs: CoinbaseOutput[] = [];

  const treasuryPct = config.creditTreasuryPct;
  let treasuryAmount = 0;
  let minerAmount = reward;

  if (treasuryPct > 0 && config.treasuryPubKey.length === 64) {
    treasuryAmount = Math.floor((reward * treasuryPct) / 100);
    minerAmount = reward - treasuryAmount;
  }

  const lockedUntilBlock = height + CREDIT_MINER_REWARD_DELAY;

  // Miner output
  outputs.push({
    owner: validatorId,
    value: minerAmount,
    lockedUntilBlock,
    isTreasury: false,
  });

  // Treasury output (if configured)
  if (treasuryAmount > 0) {
    const treasuryKey = new Uint8Array(Buffer.from(config.treasuryPubKey, 'hex'));
    outputs.push({
      owner: treasuryKey,
      value: treasuryAmount,
      lockedUntilBlock,
      isTreasury: true,
    });
  }

  return outputs;
}

// ---------------------------------------------------------------------------
// Epoch tally
// ---------------------------------------------------------------------------

function runEpochTally(blockHeight: number): EpochTally {
  const lockedLikes = getUnprocessedLockedLikeBoxes();
  const freeLikes = getUnprocessedFreeLikes();

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

    const authorReward = Math.min(
      Math.floor(totalLikeCount / LIKE_THRESHOLD),
      LIKE_MAX_AUTHOR_REWARD,
    );

    const likerRefunds: Record<string, number> = {};
    const thresholdMet = totalLikeCount >= 2 * LIKE_THRESHOLD;

    for (const lb of locked) {
      if (thresholdMet) {
        if (lb.id) allLockedBoxIds.push(lb.id);
        mintKarma(lb.likerId, LIKE_COST, blockHeight);
        likerRefunds[Buffer.from(lb.likerId).toString('hex')] = 0;
      }
    }

    if (authorReward > 0) {
      const authorId = getPostAuthorId(targetPostId);
      if (authorId) {
        mintKarma(authorId, authorReward, blockHeight);
      }
    }

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

  markLikeBoxesTallied(allLockedBoxIds);
  markFreeLikesProcessed(allFreeLikeIds);

  // Process post lock boxes
  const postLockBoxes = getUnspentPostLockBoxes();
  for (const plb of postLockBoxes) {
    if (!plb.id) continue;

    const totalLikes = getPostTotalLikes(plb.targetPostId);
    const alreadyUnlocked = plb.originalValue - plb.value;
    const shouldUnlock = Math.floor(totalLikes / POST_LOCK_UNLOCK_PER_LIKES);
    const toUnlock = Math.min(plb.value, shouldUnlock - alreadyUnlocked);

    if (toUnlock <= 0) continue;

    const remainingLocked = plb.value - toUnlock;

    consumeBox(plb.id, blockHeight);

    if (remainingLocked > 0) {
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

    const post = getPost(plb.targetPostId);
    if (post && !('subtreeMerkleRoot' in post)) {
      const authorId = post.author;
      mintKarma(authorId, toUnlock, blockHeight);
    }

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

function getPostAuthorId(postId: string): UserId | null {
  const post = getPost(postId);
  if (!post) return null;
  if ('author' in post) {
    return post.author as UserId;
  }
  return null;
}

/**
 * Extract the targetPostId from a UTXO transaction if it contains a LikeBox
 * output. Returns null if no like box is found in the outputs.
 */
function extractLikeTarget(tx: UtxoTransaction): string | null {
  for (const output of tx.outputs) {
    if (output.boxType === 'like') {
      return output.targetPostId || null;
    }
  }
  return null;
}
