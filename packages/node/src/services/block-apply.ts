import * as validation from '@dagsocial/validation';
import { mintKarma } from './karma.js';
import { mintCredits } from './credits.js';
import { applyKarmaDecay } from './decay.js';
import type { DecayDeps } from './decay.js';
import { config } from '../config.js';
import { computeBlockReward, computeSubBlockRoot, computeUtxoTxRoot, clearTemplate } from './block-creator.js';
import { revalidateTxInContext, applyTx } from './utxo-engine.js';
import {
  getKarmaBox,
  getKarmaBoxes,
  getPost,
  insertPost,
  insertBox,
  getBox,
  consumeBox,
  confirmPost,
  markLikeBoxesTallied,
  getCurrentHeight,
  createOrderingBlock as storeCreateOrderingBlock,
  getOrderingBlock,
  getPendingEntries,
  removeEntry,
} from '../store/index.js';
import { getDb } from '../store/db.js';
import { insertBlockJournal, purgeOldJournals } from '../store/journal.js';
import {
  encodeTx,
  decodeTx,
  decodeSubBlock,
  PROTOCOL_VERSION,
  computeTxId,
  computeBoxId,
  encodePost,
} from '@dagsocial/types';
import type { AnyBox, BlockJournal, OrderingBlock, UtxoTransaction } from '@dagsocial/types';

let currentJournal: BlockJournal | null = null;

export function getCurrentJournal(): BlockJournal | null {
  return currentJournal;
}

export function applyOrderingBlock(block: OrderingBlock): boolean {
  const currentHeight = getCurrentHeight();

  // Initialize journal
  currentJournal = {
    blockHeight: block.header.height,
    creditBoxIds: [],
    confirmedSubBlockIds: [...block.subBlockTree.subBlockRefs],
    subBlockCbors: [],
    talliedLikeBoxIds: [...block.utxoTxTree.likeBoxIds],
    karmaMints: [],
    appliedUtxoTxs: [],
    decayBurns: [],
  };

  // Populate subBlockCbors from the block itself (self-contained)
  if (block.subBlockTree.subBlockRefs.length > 0) {
    for (let i = 0; i < block.subBlockTree.subBlockRefs.length; i++) {
      const subBlockId = block.subBlockTree.subBlockRefs[i]!;
      const cbor = block.subBlockTree.subBlocks[i];
      if (cbor) {
        currentJournal.subBlockCbors.push({ subBlockId, cbor });
      }
    }
  }

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

  // 5. Store the block
  storeCreateOrderingBlock(block);

  // 6. Clear the local mining template (this height is taken)
  clearTemplate();

  // 7. Apply coinbase — mint credits for each output
  for (const out of block.utxoTxTree.coinbaseOutputs) {
    const boxId = mintCredits(out.owner, out.value, block.header.height, out.lockedUntilBlock);
    if (boxId) {
      currentJournal.creditBoxIds.push(boxId);
    }
  }

  // 7. Confirm sub-blocks and their posts — decode from block, not mempool
  for (let i = 0; i < block.subBlockTree.subBlockRefs.length; i++) {
    const subBlockId = block.subBlockTree.subBlockRefs[i]!;
    const subBlockCbor = block.subBlockTree.subBlocks[i];

    // Insert post if we don't already have it (e.g., from gossip)
    if (subBlockCbor && !getPost(subBlockId)) {
      try {
        const sb = decodeSubBlock(subBlockCbor);
        // Verify the CBOR decodes to the declared subBlockRefs ID.
        // Prevents a malicious miner from swapping CBOR entries or
        // injecting content under a different post ID.
        if (sb.subBlockId !== subBlockId) {
          console.warn(
            `Sub-block CBOR mismatch: refs[${i}]=${subBlockId}, CBOR decodes to ${sb.subBlockId}`,
          );
          // Don't insert mismatched content. Fall through to confirmPost
          // (which will no-op if the post doesn't exist).
        } else {
          insertPost(sb.post, encodePost(sb.post));
        }
      } catch (err) {
        console.warn(`Failed to decode sub-block ${subBlockId} from block: ${String(err)}`);
      }
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
      const match = entriesAfter.find((e) => {
        if (e.entryType !== 'subblock' || !e.subblockCbor) return false;
        try {
          const sb = decodeSubBlock(e.subblockCbor);
          return sb.subBlockId === subBlockId;
        } catch {
          return false;
        }
      });
      if (match) {
        removeEntry(match.rowid);
      }
    }
  }

  // 8. Standalone like boxes are tallied by runEpochTally at epoch boundaries
  // (called inside createOrderingBlock before finalizeBlock delegates here).
  // Only record them in the journal for revert tracking.

  // 9. Apply epoch tally results
  if (block.utxoTxTree.epochTallyResults) {
    const rewards = block.utxoTxTree.epochTallyResults.rewards;
    for (const postId of Object.keys(rewards)) {
      const reward = rewards[postId];
      if (!reward) continue;

      // Author reward
      if (reward.authorReward > 0) {
        const post = getPost(postId);
        if (post && 'author' in post) {
          const boxId = mintKarma(post.author, reward.authorReward, block.header.height);
          currentJournal.karmaMints.push({ userId: post.author, amount: reward.authorReward, boxId });
        }
      }

      // Liker refunds (locked likes that met threshold)
      for (const likerId of Object.keys(reward.likerRefunds)) {
        const refund = reward.likerRefunds[likerId];
        if (refund !== undefined && refund !== 0) {
          const likerBytes = new Uint8Array(Buffer.from(likerId, "hex"));
          const boxId = mintKarma(likerBytes, refund, block.header.height);
          currentJournal.karmaMints.push({ userId: likerBytes, amount: refund, boxId });
        }
      }

      // Post lock karma unlocked
      if (reward.postLockKarmaUnlocked && reward.postLockKarmaUnlocked > 0) {
        const post = getPost(postId);
        if (post && 'author' in post) {
          const boxId = mintKarma(post.author, reward.postLockKarmaUnlocked, block.header.height);
          currentJournal.karmaMints.push({ userId: post.author, amount: reward.postLockKarmaUnlocked, boxId });
        }
      }
    }
  }

  // 10. Apply UTXO transactions from the block
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
    applyTx(utxoDeps, tx, computedOutputs, block.header.height);

    // Remove from local mempool if present
    const mempoolEntry = pendingEntries.find((e) => {
      if (e.entryType !== 'utxo_tx' || !e.utxoTxCbor) return false;
      const et = decodeTx(e.utxoTxCbor);
      return computeTxId(et) === txId;
    });
    if (mempoolEntry) removeEntry(mempoolEntry.rowid);

    // Record in journal
    currentJournal.appliedUtxoTxs.push({
      txId,
      txCbor: encodeTx(tx),
      inputBoxIds: tx.inputs,
      outputBoxIds: computedOutputs.map((o) => o.id!),
    });
  }

  // 11. Apply periodic karma decay
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

  // 12. Persist journal and purge old ones
  insertBlockJournal(currentJournal);
  purgeOldJournals(block.header.height - 20);
  currentJournal = null;

  console.log(`Applied ordering block height=${block.header.height} hash=${validation.blockHash(block.header)} (${block.subBlockTree.subBlockRefs.length} sub-blocks)`);
  return true;
}
