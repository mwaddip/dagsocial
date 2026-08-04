import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  PROTOCOL_VERSION,
  CREDIT_FIXED_RATE_BLOCKS,
  CREDIT_INITIAL_REWARD,
  CREDIT_EPOCH_BLOCKS,
  CREDIT_REWARD_REDUCTION,
  CREDIT_TAIL_REWARD,
  CREDIT_MINER_REWARD_DELAY,
  CREDIT_TREASURY_PCT,
  LIKE_THRESHOLD,
  LIKE_MAX_AUTHOR_REWARD,
  LIKE_COST,
  POST_LOCK_UNLOCK_PER_LIKES,
  EMPTY_STATE_ROOT,
  decodeTx,
  encodeTx,
  computeBoxId,
  computeTxId,
  leafHash,
  buildMerkleRoot,
  serializePruneEntry,
  hexToBuf,
} from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  blockHash,
  computePowHash,
} from '@dagsocial/validation';
import type {
  OrderingBlock,
  BlockHeader,
  SubBlockTree,
  UtxoTxTree,
  CoinbaseOutput,
  EpochTally,
  LikeReward,
  Post,
  LikeBox,
  PostLockBox,
  UtxoTransaction,
  AnyBox,
  PruneEntry,
  UserId,
} from '@dagsocial/types';
import type { Config } from '../config.js';
import { canonicalEpochTallyJson } from './epoch-canonical.js';
import { expectedTarget } from './difficulty.js';
import { getNet } from './net-instance.js';
import { revalidateTxInContext, applyTx } from './utxo-engine.js';
import { applyOrderingBlock } from './block-apply.js';
import { tryGetAvlProver } from '../state/avl-prover.js';
import { getDb } from '../store/db.js';
import {
  getPendingEntries,
  purgeExpired,
  removeEntry,
  drainMempoolPrunes,
  type PoolEntry,
} from '../store/mempool.js';
import {
  createOrderingBlock as storeCreateOrderingBlock,
  getOrderingBlock,
  getCurrentHeight,
  confirmPost,
  getUnprocessedLockedLikeBoxes,
  getUnprocessedFreeLikes,
  getBox,
  getKarmaBox,
  getPost,
  getUnspentPostLockBoxes,
  getPostTotalLikes,
} from '../store/index.js';

// ---------------------------------------------------------------------------
// Merkle root computation
// ---------------------------------------------------------------------------

export function computeSubBlockRoot(tree: SubBlockTree): string {
  const leaves = [
    ...tree.subBlockEntries.map((entry) =>
      // `author` is part of the leaf preimage (audit H-3) — the block commits to
      // who authored each confirmed post, so prune authorship is checkable on a
      // node that never received the content. Key order is normative.
      leafHash('subblock', Buffer.from(JSON.stringify({
        postId: entry.postId,
        parentRefs: entry.parentRefs,
        author: entry.author,
      })))),
    ...tree.pruneEntries.map((entry) =>
      // Tag changed from 'stump' to 'prune' (intentional breaking change, per verifiable-prune spec)
      leafHash('prune', Buffer.from(serializePruneEntry(entry)))),
  ];
  return Buffer.from(buildMerkleRoot(leaves)).toString('hex');
}

export function computeUtxoTxRoot(tree: UtxoTxTree): string {
  const leaves: Uint8Array[] = [
    ...tree.utxoTxIds.map((id) =>
      leafHash('utxotx', hexToBuf(id))),
    ...tree.likeBoxIds.map((id) =>
      leafHash('likebox', hexToBuf(id))),
    ...tree.coinbaseOutputs.map((o) =>
      // `value` is bigint — JSON.stringify throws on it, and this preimage is
      // consensus (utxoTxRoot leaf). Canonical decimal string, deterministic.
      leafHash('coinbase', Buffer.from(JSON.stringify({
        owner: Array.from(o.owner),
        value: o.value.toString(),
        lockedUntilBlock: o.lockedUntilBlock,
        isTreasury: o.isTreasury,
      })))),
  ];
  if (tree.epochTallyResults) {
    // Canonical, not insertion-order: the tally's key/row order differs between
    // honest nodes and does not survive a CBOR round-trip (audit C-6).
    leaves.push(
      leafHash('epoch', Buffer.from(canonicalEpochTallyJson(tree.epochTallyResults))),
    );
  }
  return Buffer.from(buildMerkleRoot(leaves)).toString('hex');
}

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
let dagService: import('./dag-service.js').DagService | undefined;

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

export function setDagServiceForMiner(ds: import('./dag-service.js').DagService): void {
  dagService = ds;
}

export function onSubBlockReceived(): void {
  if (!config) return;
  pendingSubBlockCounter++;
  if (pendingSubBlockCounter >= config.orderingBlockMinSubBlocks) {
    createOrderingBlock();
  }
}

// ---------------------------------------------------------------------------
// Miner pubkey override (external mining)
// ---------------------------------------------------------------------------

let currentMinerPubkey: Uint8Array | null = null;

/**
 * Set the pubkey that receives coinbase rewards. Called when an external
 * miner requests a template with their own wallet address.
 * Pass null to revert to the node's validator key.
 */
export function setMinerPubkey(pubkey: Uint8Array | null): void {
  currentMinerPubkey = pubkey;
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
  if (!tpl || tpl.header.height !== submittedHeight || getCurrentHeight() >= submittedHeight) {
    return null;
  }

  // Build header with the submitted nonce
  const header: BlockHeader = {
    ...tpl.header,
    powNonce,
  };

  // Verify PoW against the header
  if (!verifyOrderingBlockPoW(header)) {
    return null;
  }

  // Sign the header hash
  const hh = blockHash(header);
  const sig = cryptoSign(null, Buffer.from(hh, 'hex'), validatorPrivKey);

  const block: OrderingBlock = {
    header,
    subBlockTree: tpl.subBlockTree,
    utxoTxTree: tpl.utxoTxTree,
    validatorSignature: new Uint8Array(sig),
  };

  // Finalize and broadcast
  finalizeBlock(block);

  return hh;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

/**
 * Compute the block reward at a given height using Ergo-style linear decay.
 */
export function computeBlockReward(height: number): bigint {
  if (height <= 0) return 0n;
  if (height <= CREDIT_FIXED_RATE_BLOCKS) {
    return CREDIT_INITIAL_REWARD;
  }
  const epochs = Math.floor(
    (height - CREDIT_FIXED_RATE_BLOCKS - 1) / CREDIT_EPOCH_BLOCKS,
  ) + 1;
  const reward = CREDIT_INITIAL_REWARD - BigInt(epochs) * CREDIT_REWARD_REDUCTION;
  return reward > CREDIT_TAIL_REWARD ? reward : CREDIT_TAIL_REWARD;
}

// ---------------------------------------------------------------------------
// PoW mining (internal mode)
// ---------------------------------------------------------------------------

function encodeLE64(n: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

function solvePoW(powPreimage: Buffer, targetBits: number): number {
  let nonce = 0;
  while (true) {
    const nonceBuf = encodeLE64(nonce);
    const hash = createHash('blake2b512')
      .update(powPreimage)
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

  // 4. Resolve sub-block metadata from dag_posts (mempool now stores postId, not CBOR)
  const resolvedSubBlocks: Array<{ subBlockId: string; post: Post; likeBoxes: LikeBox[] }> = [];
  for (const entry of subBlockEntries) {
    if (!entry.subblockId) continue;
    const post = getPost(entry.subblockId);
    if (!post || !('author' in post)) continue; // skip if content not yet arrived
    resolvedSubBlocks.push({
      subBlockId: entry.subblockId,
      post,
      likeBoxes: [],
    });
  }

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
      const matchingSb = resolvedSubBlocks.find((sb) => sb.subBlockId === targetPostId);
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

  // 7a. Matched UTXO entries (attached to sub-blocks) → also apply them
  for (const entry of standaloneUtxoTxs) {
    if (matchedUtxoRowids.has(entry.rowid)) {
      const tx = decodeTx(entry.utxoTxCbor!);
      utxoTxIds.push(computeTxId(tx));
    }
  }

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
    resolvedSubBlocks.flatMap((sb) => sb.likeBoxes.map((lb) => lb.id!)),
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

  // 14. Difficulty — fixed by the height schedule, and enforced at apply
  const powTargetBits = expectedTarget(newHeight);

  // 15. Epoch tally
  let epochTallyResults: EpochTally | undefined;
  if (isEpochBoundary) {
    epochTallyResults = computeEpochTally(newHeight);
  }

  // 16. Previous block hash
  const prevBlock = currentHeight > 0 ? getOrderingBlock(currentHeight) : null;
  const prevBlockHash = prevBlock
    ? blockHash(prevBlock.header)
    : '0000000000000000000000000000000000000000000000000000000000000000';

  const subBlockRefs = resolvedSubBlocks.map((sb) => sb.subBlockId);

  // Build subBlockEntries for the block (committed in the Merkle tree).
  // Both parentRefs and author are read off the resolved post — never off a
  // client-supplied claim — so an honest producer's entries always match the
  // content other nodes verify them against (audit H-3).
  const subBlockEntriesForBlock = resolvedSubBlocks.map((sb) => ({
    postId: sb.subBlockId,
    parentRefs: (sb.post as Post).parentRefs ?? [],
    author: Buffer.from((sb.post as Post).author).toString('hex'),
  }));

  // Collect UTXO tx CBOR for inline storage, matching the utxoTxIds order:
  // 1. remainingUtxoTxs IDs, 2. matchedUtxoRowids IDs, 3. batch-linked entries
  const utxoTxCbors: Uint8Array[] = [];

  // Standalone UTXO txs that were not matched to sub-blocks
  for (const entry of remainingUtxoTxs) {
    utxoTxCbors.push(entry.utxoTxCbor!);
  }

  // Matched UTXO entries (attached to sub-blocks)
  for (const entry of standaloneUtxoTxs) {
    if (matchedUtxoRowids.has(entry.rowid)) {
      utxoTxCbors.push(entry.utxoTxCbor!);
    }
  }

  // Batch-linked UTXO entries
  for (const [, batchEntries] of batchMap) {
    for (const entry of batchEntries) {
      if (entry.entryType === 'utxo_tx' && entry.utxoTxCbor) {
        utxoTxCbors.push(entry.utxoTxCbor);
      }
    }
  }

  // Drain queued prune entries for block inclusion
  const MAX_PRUNES_PER_BLOCK = 32;
  const pruneEntries = drainMempoolPrunes(MAX_PRUNES_PER_BLOCK);

  // 17. Build the body trees
  const subBlockTree: SubBlockTree = {
    subBlockRefs,
    subBlockEntries: subBlockEntriesForBlock,
    pruneEntries,
  };
  const utxoTxTree: UtxoTxTree = {
    utxoTxIds,
    utxoTxs: utxoTxCbors,
    likeBoxIds: allLikeBoxIds,
    coinbaseOutputs,
  };
  if (epochTallyResults) {
    utxoTxTree.epochTallyResults = epochTallyResults;
  }

  // 18. Compute Merkle roots
  const subBlockRoot = computeSubBlockRoot(subBlockTree);
  const utxoTxRoot = computeUtxoTxRoot(utxoTxTree);

  // 19. Compute current AVL state root
  let stateRoot = EMPTY_STATE_ROOT; // fallback if prover not initialized
  const handle = tryGetAvlProver();
  if (handle) {
    const digest = handle.prover.digest();
    if (digest) {
      stateRoot = Buffer.from(digest).toString('hex');
    }
  }

  // 20. Build header template (powNonce=0)
  const headerTemplate: BlockHeader = {
    protocolVersion: PROTOCOL_VERSION,
    height: newHeight,
    prevBlockHash,
    subBlockRoot,
    utxoTxRoot,
    stateRoot,
    validatorId,
    powNonce: 0,
    powTargetBits,
    createdAt: Date.now(),
  };

  // 21. Internal vs external mining
  if (config.miningMode === 'external') {
    // Store the full block template (header + bodies) for external miners
    const template: OrderingBlock = {
      header: headerTemplate,
      subBlockTree,
      utxoTxTree,
      validatorSignature: new Uint8Array(64),
    };
    currentTemplate = template;
    return null; // Block not finalized yet
  }

  // 22. Internal: mine PoW against the header
  const powPreimage = computePowHash(headerTemplate);
  const powNonce = solvePoW(powPreimage, powTargetBits);

  const header: BlockHeader = {
    ...headerTemplate,
    powNonce,
  };

  // 23. Sign the header hash
  const hh = blockHash(header);
  const sig = cryptoSign(null, Buffer.from(hh, 'hex'), validatorPrivKey);

  const block: OrderingBlock = {
    header,
    subBlockTree,
    utxoTxTree,
    validatorSignature: new Uint8Array(sig),
  };

  // 24. Finalize
  finalizeBlock(block);

  return block;
}

// ---------------------------------------------------------------------------
// Block finalization (shared between internal and external mining)
// ---------------------------------------------------------------------------

function finalizeBlock(block: OrderingBlock): void {
  // applyOrderingBlock handles validation, storage, coinbase, confirmations,
  // UTXO tx application, journal recording, and basic mempool cleanup
  const applied = applyOrderingBlock(block, dagService);

  // Clean up any remaining mempool entries that applyOrderingBlock didn't
  // remove (e.g. UTXO txs that were attached to sub-blocks and removed
  // from utxoTxIds). Double-removal is harmless.
  //
  // This runs even when the block was rejected: whatever made it invalid came
  // out of the mempool, so leaving those entries in place would rebuild the
  // same rejected block every interval and stall the chain.
  for (const rowid of confirmedRowids) {
    removeEntry(rowid);
  }

  // Broadcast (not handled by applyOrderingBlock) — only for a block we
  // ourselves accepted. Peers apply the same rules, so gossiping a block our
  // own validation rejected can only waste their bandwidth.
  const net = getNet();
  if (net && applied) {
    net.broadcastOrderingBlock(block).catch((err: Error) => {
      console.warn(`Failed to broadcast ordering block: ${err.message}`);
    });
  }

  // Reset state
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
  let treasuryAmount = 0n;
  let minerAmount = reward;

  if (treasuryPct > 0 && config.treasuryPubKey.length === 64) {
    treasuryAmount = (reward * BigInt(treasuryPct)) / 100n;
    minerAmount = reward - treasuryAmount;
  }

  const lockedUntilBlock = height + CREDIT_MINER_REWARD_DELAY;

  // Miner output — use external miner's pubkey if provided, else validator key
  outputs.push({
    owner: currentMinerPubkey ?? validatorId,
    value: minerAmount,
    lockedUntilBlock,
    isTreasury: false,
  });

  // Treasury output (if configured)
  if (treasuryAmount > 0n) {
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

export function computeEpochTally(blockHeight: number): EpochTally {
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

    // Count math in number, then BigInt the step count before the bigint min.
    const rewardSteps = BigInt(Math.floor(totalLikeCount / LIKE_THRESHOLD));
    const authorReward =
      rewardSteps < LIKE_MAX_AUTHOR_REWARD ? rewardSteps : LIKE_MAX_AUTHOR_REWARD;

    const likerRefunds: Record<string, bigint> = {};
    const thresholdMet = totalLikeCount >= 2 * LIKE_THRESHOLD;

    for (const lb of locked) {
      if (thresholdMet) {
        if (lb.id) allLockedBoxIds.push(lb.id);
        // mintKarma is handled by applyOrderingBlock from epochTallyResults
        likerRefunds[Buffer.from(lb.likerId).toString('hex')] = 0n;
      }
    }

    if (authorReward > 0n) {
      // mintKarma is handled by applyOrderingBlock from epochTallyResults
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

  // Side effects deferred to applyOrderingBlock so all nodes (not just
  // the miner) mark boxes tallied, process free likes, and update post
  // lock boxes.  The IDs are carried in the EpochTally and committed via
  // the Merkle root — the receiver verifies by recomputing locally.

  const consumedPostLockBoxIds: string[] = [];
  const newPostLockBoxes: PostLockBox[] = [];

  // Process post lock boxes
  const postLockBoxes = getUnspentPostLockBoxes();
  for (const plb of postLockBoxes) {
    if (!plb.id) continue;

    const totalLikes = getPostTotalLikes(plb.targetPostId);
    const alreadyUnlocked = plb.originalValue - plb.value;
    // Like counts are number; the unlock step count converts to bigint before
    // mixing with box values.
    const shouldUnlock = BigInt(Math.floor(totalLikes / POST_LOCK_UNLOCK_PER_LIKES));
    const unlockable = shouldUnlock - alreadyUnlocked;
    const toUnlock = plb.value < unlockable ? plb.value : unlockable;

    if (toUnlock <= 0n) continue;

    const remainingLocked = plb.value - toUnlock;

    consumedPostLockBoxIds.push(plb.id);

    if (remainingLocked > 0n) {
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
      newPostLockBoxes.push(newPlb);
    }

    // mintKarma for post lock unlock is handled by applyOrderingBlock from epochTallyResults

    if (!rewards[plb.targetPostId]) {
      rewards[plb.targetPostId] = {
        targetPostId: plb.targetPostId,
        likeCount: 0,
        authorReward: 0n,
        likerRefunds: {},
      };
    }
    rewards[plb.targetPostId]!.postLockKarmaUnlocked =
      (rewards[plb.targetPostId]!.postLockKarmaUnlocked ?? 0n) + toUnlock;
  }

  return {
    rewards,
    talliedLockedLikeBoxIds: allLockedBoxIds,
    processedFreeLikeIds: allFreeLikeIds,
    consumedPostLockBoxIds,
    newPostLockBoxes,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


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
