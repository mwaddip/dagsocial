import { createHash, createPublicKey, verify } from 'crypto';
import * as validation from '@dagsocial/validation';
import { mintKarma } from './karma.js';
import { mintCredits } from './credits.js';
import { applyKarmaDecay } from './decay.js';
import {
  getMaturedVouchCooldowns,
  deleteVouchCooldown,
  insertVouchCooldown,
} from '../store/vouch-cooldowns.js';
import { VOUCH_COOLDOWN_BLOCKS, VOUCH_KARMA_AMOUNT } from '@dagsocial/types';
import { settlePruneUtxo } from './settle-prune-utxo.js';
import type { DecayDeps } from './decay.js';
import { config } from '../config.js';
import { computeBlockReward, computeSubBlockRoot, computeUtxoTxRoot, clearTemplate, computeEpochTally } from './block-creator.js';
import { DagService } from './dag-service.js';
import { revalidateTxInContext, applyTx } from './utxo-engine.js';
import {
  getKarmaBox,
  getKarmaBoxes,
  getCreditBoxes,
  getPost,
  insertStump,
  insertPostPlaceholder,
  insertBox,
  getBox,
  consumeBox,
  confirmPost,
  pruneSubtree,
  markLikeBoxesTallied,
  markFreeLikesProcessed,
  getCurrentHeight,
  createOrderingBlock as storeCreateOrderingBlock,
  getOrderingBlock,
  getPendingEntries,
  removeEntry,
  insertBlockTopology,
  getSubtreeTopology,
} from '../store/index.js';
import { getDb } from '../store/db.js';
import { insertBlockJournal, purgeOldJournals } from '../store/journal.js';
import { tryGetAvlProver, applyBlockMutations, checkpointProver } from '../state/avl-prover.js';
import {
  encodeTx,
  decodeTx,
  PROTOCOL_VERSION,
  computeTxId,
  computeBoxId,
  leafHash,
  buildMerkleRoot,
  hexToBuf,
} from '@dagsocial/types';
import type { AnyBox, BlockJournal, OrderingBlock, UtxoTransaction } from '@dagsocial/types';

let currentJournal: BlockJournal | null = null;

export function getCurrentJournal(): BlockJournal | null {
  return currentJournal;
}

function processVouchCooldowns(currentHeight: number): void {
  const matured = getMaturedVouchCooldowns(currentHeight);
  for (const row of matured) {
    mintKarma(row.voucherId, row.karmaAmount, currentHeight);
    deleteVouchCooldown(row.voucherId, row.targetId);
  }
}

export function applyOrderingBlock(block: OrderingBlock, dagService?: DagService): boolean {
  const currentHeight = getCurrentHeight();

  // Initialize journal
  currentJournal = {
    blockHeight: block.header.height,
    creditBoxIds: [],
    confirmedSubBlockIds: [...block.subBlockTree.subBlockRefs],
    talliedLikeBoxIds: [...block.utxoTxTree.likeBoxIds],
    karmaMints: [],
    appliedUtxoTxs: [],
    decayBurns: [],
    consumedBoxIds: [],
    createdBoxIds: [],
  };

  // 1. Chain-link check
  if (currentHeight === 0) {
    // Genesis: prevBlockHash must be all zeros
    if (block.header.prevBlockHash !== '0000000000000000000000000000000000000000000000000000000000000000') {
      console.warn(`Rejected block height=${block.header.height}: genesis prevBlockHash mismatch`);
      currentJournal = null;
      return false;
    }
    if (block.header.height !== 1) {
      console.warn(`Rejected block: first block must have height=1, got ${block.header.height}`);
      currentJournal = null;
      return false;
    }
  } else {
    const prevBlock = getOrderingBlock(currentHeight);
    if (!prevBlock) {
      console.warn(`Rejected block height=${block.header.height}: cannot find previous block at height=${currentHeight}`);
      currentJournal = null;
      return false;
    }
    if (block.header.prevBlockHash !== validation.blockHash(prevBlock.header)) {
      console.warn(`Rejected block height=${block.header.height}: prevBlockHash mismatch`);
      currentJournal = null;
      return false;
    }
    if (block.header.height !== currentHeight + 1) {
      console.warn(`Rejected block height=${block.header.height}: expected ${currentHeight + 1}`);
      currentJournal = null;
      return false;
    }
  }

  // 2. Protocol version
  if (block.header.protocolVersion !== PROTOCOL_VERSION) {
    console.warn(`Rejected block height=${block.header.height}: unsupported protocol version ${block.header.protocolVersion}`);
    currentJournal = null;
    return false;
  }

  // 3. PoW verification
  if (!validation.verifyOrderingBlockPoW(block.header)) {
    console.warn(`Rejected block height=${block.header.height}: PoW invalid`);
    currentJournal = null;
    return false;
  }

  // 4. Merkle root verification
  const computedSubRoot = computeSubBlockRoot(block.subBlockTree);
  const computedUtxoRoot = computeUtxoTxRoot(block.utxoTxTree);
  if (computedSubRoot !== block.header.subBlockRoot) {
    console.warn(`Rejected block height=${block.header.height}: subBlockRoot mismatch`);
    currentJournal = null;
    return false;
  }
  if (computedUtxoRoot !== block.header.utxoTxRoot) {
    console.warn(`Rejected block height=${block.header.height}: utxoTxRoot mismatch`);
    currentJournal = null;
    return false;
  }

  // 5. Verify coinbase reward matches emission schedule
  const expectedReward = computeBlockReward(block.header.height);
  const totalCoinbase = block.utxoTxTree.coinbaseOutputs.reduce((sum, o) => sum + o.value, 0);
  if (totalCoinbase !== expectedReward) {
    console.warn(
      `Rejected block height=${block.header.height}: coinbase value ${totalCoinbase} != expected ${expectedReward}`,
    );
    currentJournal = null;
    return false;
  }

  // 5. Verify epoch tally results (before storing the block)
  // The Merkle root commits to epochTallyResults, so they can't be
  // fabricated.  But we must also verify the results are correct for
  // the current UTXO state — a malicious miner could commit to valid
  // (Merkle-matching) but incorrect (state-divergent) results.
  if (block.utxoTxTree.epochTallyResults) {
    const localTally = computeEpochTally(block.header.height);
    const blockRewards = JSON.stringify(block.utxoTxTree.epochTallyResults.rewards);
    const localRewards = JSON.stringify(localTally.rewards);
    if (blockRewards !== localRewards) {
      console.warn(
        `Rejected block height=${block.header.height}: epoch tally mismatch`,
      );
      currentJournal = null;
      return false;
    }
  }

  // 6. Store the block
  storeCreateOrderingBlock(block);

  // 6. Clear the local mining template (this height is taken)
  clearTemplate();

  // 7. Apply coinbase — mint credits for each output
  for (const out of block.utxoTxTree.coinbaseOutputs) {
    // Track existing credit boxes that will be consumed by mintCredits
    const existingCredits = getCreditBoxes(out.owner);
    for (const cb of existingCredits) {
      if (cb.id) currentJournal.consumedBoxIds.push(cb.id);
    }
    const boxId = mintCredits(out.owner, out.value, block.header.height, out.lockedUntilBlock);
    if (boxId) {
      currentJournal.creditBoxIds.push(boxId);
      currentJournal.createdBoxIds.push(boxId);
    }
  }

  // 7. Confirm sub-blocks — create placeholders if post doesn't exist
  for (let i = 0; i < block.subBlockTree.subBlockEntries.length; i++) {
    const entry = block.subBlockTree.subBlockEntries[i]!;
    const subBlockId = entry.postId;

    // Create placeholder row if post doesn't exist yet
    if (!getPost(subBlockId)) {
      insertPostPlaceholder(subBlockId, entry.parentRefs);
    }

    try {
      confirmPost(subBlockId, block.header.height);
    } catch (err) {
      console.warn(`Failed to confirm sub-block ${subBlockId}: ${String(err)}`);
    }
  }

  // Still remove confirmed entries from local mempool (if we have them)
  if (block.subBlockTree.subBlockRefs.length > 0) {
    const entriesAfter = getPendingEntries(1000);
    for (const subBlockId of block.subBlockTree.subBlockRefs) {
      const match = entriesAfter.find((e) =>
        e.entryType === 'subblock' && e.subblockId === subBlockId,
      );
      if (match) {
        removeEntry(match.rowid);
      }
    }
  }

  // 8. Compute DAG scores and evaluate canonical tip
  if (dagService) {
    let bestScore = 0;
    let bestId: string | null = null;

    for (const entry of block.subBlockTree.subBlockEntries) {
      let maxParent = 0;
      for (const pid of entry.parentRefs) {
        const ps = dagService.getScore(pid);
        if (ps !== null && ps > maxParent) {
          maxParent = ps;
        }
      }
      const score = maxParent + 1; // uniform weight: ownWork = 1
      dagService.saveScore(entry.postId, score);

      if (score > bestScore) {
        bestScore = score;
        bestId = entry.postId;
      }
    }

    if (bestId !== null) {
      try {
        const plan = dagService.buildReorgPlan(bestId, bestScore);
        if (plan) {
          dagService.switchToBranch(plan);
        }
      } catch (err) {
        console.error(`DagService reorg evaluation failed: ${String(err)}`);
      }
    }
  }

  // 8b. Populate block_topology from this block's subBlockEntries
  for (const entry of block.subBlockTree.subBlockEntries) {
    insertBlockTopology(entry.postId, entry.parentRefs, block.header.height);
  }

  // 8c. Process prune entries from this block
  // Five verification + settlement steps per entry:
  //   1. Verify Ed25519 author signature over (rootPostHash || subtreeMerkleRoot)
  //   2. Verify postId set against block_topology (deterministic, no DAG walk)
  //   3. Verify Merkle root from entry.subtreePostIds
  //   4. Settle UTXO — consume PostLockBox + LikeBox, mint refund karma
  //   5. Prune DAG content, insert simplified Stump for historical record
  for (const entry of block.subBlockTree.pruneEntries) {
    // 1. Verify authorization
    const rootBytes = Buffer.from(entry.subtreeMerkleRoot);
    const payload = createHash('blake2b512')
      .update(entry.rootPostHash)
      .update(rootBytes)
      .digest()
      .subarray(0, 32);

    const authorKeyBytes = Buffer.from(entry.authorId);
    const keyObject = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: authorKeyBytes.toString('base64url'),
      },
      format: 'jwk',
    });

    const sigBytes = Buffer.from(entry.authorSignature);
    if (!verify(null, payload, keyObject, sigBytes)) {
      console.error(`Block ${block.header.height}: invalid prune signature for ${entry.rootPostHash}`);
      currentJournal = null;
      return false;
    }

    // 2. Verify postId set against block_topology
    const topologyIds = getSubtreeTopology(entry.rootPostHash);
    const entryIds = new Set(entry.subtreePostIds);
    if (topologyIds.size !== entryIds.size ||
        ![...topologyIds].every(id => entryIds.has(id))) {
      console.error(`Block ${block.header.height}: prune postId set mismatch for ${entry.rootPostHash}`);
      currentJournal = null;
      return false;
    }

    // 3. Verify Merkle root
    const leaves = [...entry.subtreePostIds]
      .sort()
      .map(id => leafHash('stump', hexToBuf(id)));
    const computedRoot = Buffer.from(buildMerkleRoot(leaves)).toString('hex');
    const entryRoot = Buffer.from(entry.subtreeMerkleRoot).toString('hex');
    if (computedRoot !== entryRoot) {
      console.error(`Block ${block.header.height}: prune Merkle root mismatch for ${entry.rootPostHash}`);
      currentJournal = null;
      return false;
    }

    // 4. Settle UTXO — deterministic from post IDs
    try {
      settlePruneUtxo(entry.subtreePostIds, block.header.height, currentJournal);
    } catch (err) {
      console.error(`Block ${block.header.height}: prune settlement failed for ${entry.rootPostHash}: ${String(err)}`);
      currentJournal = null;
      return false;
    }

    // 5. Prune DAG content (when present)
    try {
      pruneSubtree(entry.rootPostHash);
      // Insert simplified Stump for historical record
      insertStump({
        rootPostHash: entry.rootPostHash,
        authorId: entry.authorId,
        replyCount: entry.subtreePostIds.length - 1, // exclude root
        upvoteCount: 0, // can be derived from like boxes if needed
        trigger: entry.trigger,
        protocolVersion: PROTOCOL_VERSION,
        compactedAtBlockHeight: block.header.height,
      });
    } catch (err) {
      console.warn(`Failed to prune DAG subtree for ${entry.rootPostHash}: ${String(err)}`);
      // Non-fatal — DAG content may not be present
    }
  }

  // 9. Standalone like boxes are tallied by computeEpochTally at epoch
  // boundaries.  The computation was verified before block storage (§5);
  // here we apply the karma mints and the UTXO/bookkeeping side effects.

  // 10. Apply epoch tally results
  if (block.utxoTxTree.epochTallyResults) {
    const tally = computeEpochTally(block.header.height);
    const rewards = tally.rewards;

    for (const postId of Object.keys(rewards)) {
      const reward = rewards[postId];
      if (!reward) continue;

      // Author reward
      if (reward.authorReward > 0) {
        const post = getPost(postId);
        if (post && 'author' in post) {
          const existingKarma = getKarmaBoxes(post.author);
          for (const kb of existingKarma) {
            if (kb.id) currentJournal.consumedBoxIds.push(kb.id);
          }
          const boxId = mintKarma(post.author, reward.authorReward, block.header.height);
          if (boxId) currentJournal.createdBoxIds.push(boxId);
          currentJournal.karmaMints.push({ userId: post.author, amount: reward.authorReward, boxId });
        }
      }

      // Liker refunds (locked likes that met threshold)
      for (const likerId of Object.keys(reward.likerRefunds)) {
        const refund = reward.likerRefunds[likerId];
        if (refund !== undefined && refund !== 0) {
          const likerBytes = new Uint8Array(Buffer.from(likerId, "hex"));
          const existingKarma = getKarmaBoxes(likerBytes);
          for (const kb of existingKarma) {
            if (kb.id) currentJournal.consumedBoxIds.push(kb.id);
          }
          const boxId = mintKarma(likerBytes, refund, block.header.height);
          if (boxId) currentJournal.createdBoxIds.push(boxId);
          currentJournal.karmaMints.push({ userId: likerBytes, amount: refund, boxId });
        }
      }

      // Post lock karma unlocked
      if (reward.postLockKarmaUnlocked && reward.postLockKarmaUnlocked > 0) {
        const post = getPost(postId);
        if (post && 'author' in post) {
          const existingKarma = getKarmaBoxes(post.author);
          for (const kb of existingKarma) {
            if (kb.id) currentJournal.consumedBoxIds.push(kb.id);
          }
          const boxId = mintKarma(post.author, reward.postLockKarmaUnlocked, block.header.height);
          if (boxId) currentJournal.createdBoxIds.push(boxId);
          currentJournal.karmaMints.push({ userId: post.author, amount: reward.postLockKarmaUnlocked, boxId });
        }
      }
    }

    // Apply side effects that were previously only run on the miner's node.
    // These must run on every node so the UTXO state stays consistent.

    // Mark like boxes as tallied (prevents double-counting in later epochs)
    if (tally.talliedLockedLikeBoxIds.length > 0) {
      markLikeBoxesTallied(tally.talliedLockedLikeBoxIds);
    }

    // Mark free likes as processed
    if (tally.processedFreeLikeIds.length > 0) {
      markFreeLikesProcessed(tally.processedFreeLikeIds);
    }

    // Consume old post lock boxes and insert replacement boxes
    for (const boxId of tally.consumedPostLockBoxIds) {
      consumeBox(boxId, block.header.height);
      currentJournal.consumedBoxIds.push(boxId);
    }
    for (const newBox of tally.newPostLockBoxes) {
      insertBox(newBox);
      if (newBox.id) currentJournal.createdBoxIds.push(newBox.id);
    }
  }

  // 11. Apply UTXO transactions from the block
  const utxoDeps = {
    getBox,
    insertBox,
    consumeBox,
    getKarmaBox,
    runInTransaction: (fn: () => void) => {
      getDb().transaction(fn)();
    },
  };
  const pendingEntries = getPendingEntries(1000);
  for (let i = 0; i < block.utxoTxTree.utxoTxIds.length; i++) {
    const txId = block.utxoTxTree.utxoTxIds[i]!;
    const txCbor = block.utxoTxTree.utxoTxs[i];

    if (!txCbor) {
      console.warn(`UTXO tx ${txId} missing CBOR in block`);
      continue;
    }

    let tx: UtxoTransaction;
    try {
      tx = decodeTx(txCbor);
    } catch (err) {
      console.warn(`Failed to decode UTXO tx ${txId} from block: ${String(err)}`);
      continue;
    }

    // Verify the CBOR decodes to the declared utxoTxIds entry.
    // Prevents a malicious miner from swapping UTXO tx CBOR entries.
    const decodedTxId = computeTxId(tx);
    if (decodedTxId !== txId) {
      console.warn(
        `Rejected UTXO tx ${txId}: CBOR decodes to ${decodedTxId}`,
      );
      continue;
    }

    const revalResult = revalidateTxInContext(utxoDeps, tx, block.header.height);
    if (!revalResult.valid) {
      console.warn(`UTXO tx ${txId} failed revalidation: ${revalResult.error}`);
      // Remove from local mempool if present (stale entry)
      const mempoolEntry = pendingEntries.find((e) => {
        if (e.entryType !== 'utxo_tx' || !e.utxoTxCbor) return false;
        const et = decodeTx(e.utxoTxCbor);
        return computeTxId(et) === txId;
      });
      if (mempoolEntry) removeEntry(mempoolEntry.rowid);
      continue;
    }
    const computedOutputs = tx.outputs.map((box) => ({
      ...box,
      id: computeBoxId(box),
    })) as AnyBox[];

    // Detect vouch unvouch before the VouchBox is consumed
    for (const inputId of tx.inputs) {
      const inputBox = getBox(inputId);
      if (inputBox && inputBox.boxType === 'vouch') {
        const vb = inputBox as import('@dagsocial/types').VouchBox;
        if (tx.outputs.length === 0) {
          insertVouchCooldown(
            vb.voucherId,
            vb.targetId,
            block.header.height + VOUCH_COOLDOWN_BLOCKS,
            VOUCH_KARMA_AMOUNT,
          );
        }
        break;
      }
    }

    applyTx(utxoDeps, tx, computedOutputs, block.header.height);

    // Remove from local mempool if present
    const mempoolEntry = pendingEntries.find((e) => {
      if (e.entryType !== 'utxo_tx' || !e.utxoTxCbor) return false;
      const et = decodeTx(e.utxoTxCbor);
      return computeTxId(et) === txId;
    });
    if (mempoolEntry) removeEntry(mempoolEntry.rowid);

    // Record in journal
    const appliedTx = {
      txId,
      txCbor: encodeTx(tx),
      inputBoxIds: tx.inputs,
      outputBoxIds: computedOutputs.map((o) => o.id!),
    };
    currentJournal.appliedUtxoTxs.push(appliedTx);
    currentJournal.consumedBoxIds.push(...appliedTx.inputBoxIds);
    currentJournal.createdBoxIds.push(...appliedTx.outputBoxIds);
  }

  // 12. Apply periodic karma decay
  const decayDeps: DecayDeps = {
    getKarmaBoxes: (owner: Uint8Array) => getKarmaBoxes(owner),
    consumeBox,
    insertBox,
    getKarmaOwners: () => {
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT DISTINCT owner FROM utxo_boxes
           WHERE box_type = 'karma' AND spent_at_block IS NULL`,
        )
        .all() as { owner: Buffer }[];
      return rows.map((r) => new Uint8Array(r.owner));
    },
  };
  const journalEntries = applyKarmaDecay(decayDeps, block.header.height, {
    staleThresholdBlocks: config.karmaStaleThresholdBlocks,
    decayIntervalBlocks: config.karmaDecayIntervalBlocks,
    decayAmount: config.karmaDecayAmount,
    karmaMinimum: config.karmaMinimum,
  });
  currentJournal.decayBurns.push(...journalEntries);

  // Track decay mutations
  for (const burn of currentJournal.decayBurns) {
    currentJournal.consumedBoxIds.push(...burn.consumedBoxIds);
    currentJournal.createdBoxIds.push(burn.newBoxId);
  }

  // 12b. Process vouch cooldowns
  processVouchCooldowns(block.header.height);

  // 13. AVL state root update (skipped if prover not initialized)
  const handle = tryGetAvlProver();
  if (handle) {
    // Snapshot pre-mutation digest for rollback on verification failure
    const preMutationDigest = handle.prover.digest();

    // Collect all consumed box IDs (deduplicated)
    const allConsumed = new Set(currentJournal.consumedBoxIds);

    // Collect all created boxes by fetching from store
    const allCreated: AnyBox[] = [];
    for (const boxId of currentJournal.createdBoxIds) {
      const box = getBox(boxId);
      if (box) allCreated.push(box);
    }

    // Apply to prover
    const computedDigest = applyBlockMutations(
      handle.prover,
      [...allConsumed],
      allCreated,
    );

    // Verify against block header (gated)
    if (config.verifyStateRoot) {
      const expectedHex = Buffer.from(computedDigest).toString('hex');
      if (block.header.stateRoot !== expectedHex) {
        console.warn(
          `stateRoot mismatch at height ${block.header.height}: ` +
          `computed=${expectedHex.slice(0, 16)}... ` +
          `header=${block.header.stateRoot.slice(0, 16)}...`,
        );
        // Roll back prover to pre-mutation state
        if (preMutationDigest) {
          handle.prover.rollback(preMutationDigest);
        }
        currentJournal = null;
        return false;
      }
    }

    // Checkpoint prover state at this height
    checkpointProver(handle, block.header.height);
  }

  // 14. Persist journal and purge old ones
  insertBlockJournal(currentJournal);
  purgeOldJournals(block.header.height - 20);
  currentJournal = null;

  console.log(`Applied ordering block height=${block.header.height} hash=${validation.blockHash(block.header)} (${block.subBlockTree.subBlockRefs.length} sub-blocks)`);
  return true;
}
