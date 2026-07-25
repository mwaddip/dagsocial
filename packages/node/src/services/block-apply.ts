import * as validation from '@dagsocial/validation';
import { mintKarma } from './karma.js';
import { mintCredits } from './credits.js';
import { computeBlockReward, computeSubBlockRoot, computeUtxoTxRoot, clearTemplate } from './block-creator.js';
import { revalidateTxInContext, applyTx } from './utxo-engine.js';
import {
  getIdentity,
  getKarmaBox,
  getPost,
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
} from '@dagsocial/types';
import type { AnyBox, BlockJournal, OrderingBlock } from '@dagsocial/types';

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
  };

  // Populate subBlockCbors from mempool entries
  if (block.subBlockTree.subBlockRefs.length > 0) {
    const pendingEntries = getPendingEntries(1000);
    for (const subBlockId of block.subBlockTree.subBlockRefs) {
      const match = pendingEntries.find((e) => {
        if (e.entryType !== 'subblock' || !e.subblockCbor) return false;
        try {
          const sb = decodeSubBlock(e.subblockCbor);
          return sb.subBlockId === subBlockId;
        } catch {
          return false;
        }
      });
      if (match?.subblockCbor) {
        currentJournal.subBlockCbors.push({
          subBlockId,
          cbor: match.subblockCbor,
        });
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

  // 7. Confirm sub-blocks and their posts, then remove from mempool
  for (const subBlockId of block.subBlockTree.subBlockRefs) {
    try {
      confirmPost(subBlockId, block.header.height);
    } catch (err) {
      console.warn(`Failed to confirm sub-block ${subBlockId}: ${String(err)}`);
    }
  }
  // Remove confirmed sub-block entries from mempool
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
          currentJournal.karmaMints.push({ userId: post.author, amount: reward.authorReward });
          mintKarma(post.author, reward.authorReward, block.header.height);
        }
      }

      // Liker refunds (locked likes that met threshold)
      for (const likerId of Object.keys(reward.likerRefunds)) {
        const refund = reward.likerRefunds[likerId];
        if (refund !== undefined && refund !== 0) {
          const likerBytes = new Uint8Array(Buffer.from(likerId, "hex"));
          currentJournal.karmaMints.push({ userId: likerBytes, amount: refund });
          mintKarma(likerBytes, refund, block.header.height);
        }
      }

      // Post lock karma unlocked
      if (reward.postLockKarmaUnlocked && reward.postLockKarmaUnlocked > 0) {
        const post = getPost(postId);
        if (post && 'author' in post) {
          currentJournal.karmaMints.push({ userId: post.author, amount: reward.postLockKarmaUnlocked });
          mintKarma(post.author, reward.postLockKarmaUnlocked, block.header.height);
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
    getIdentity,
    runInTransaction: (fn: () => void) => {
      getDb().transaction(fn)();
    },
  };
  for (const txId of block.utxoTxTree.utxoTxIds) {
    // Look up in local mempool
    const entries = getPendingEntries(1000);
    const entry = entries.find((e) => {
      if (e.entryType !== 'utxo_tx' || !e.utxoTxCbor) return false;
      const tx = decodeTx(e.utxoTxCbor);
      return computeTxId(tx) === txId;
    });
    if (!entry) {
      // Already applied by a prior block or not in our mempool
      continue;
    }
    const tx = decodeTx(entry.utxoTxCbor!);
    const revalResult = revalidateTxInContext(utxoDeps, tx, block.header.height);
    if (!revalResult.valid) {
      console.warn(`UTXO tx ${txId} failed revalidation: ${revalResult.error}`);
      removeEntry(entry.rowid);
      continue;
    }
    const computedOutputs = tx.outputs.map((box) => ({
      ...box,
      id: computeBoxId(box),
    })) as AnyBox[];
    applyTx(utxoDeps, tx, computedOutputs, block.header.height);
    removeEntry(entry.rowid);

    // Record in journal
    currentJournal.appliedUtxoTxs.push({
      txId,
      txCbor: encodeTx(tx),
      inputBoxIds: tx.inputs,
      outputBoxIds: computedOutputs.map((o) => o.id!),
    });
  }

  // 11. Persist journal and purge old ones
  insertBlockJournal(currentJournal);
  purgeOldJournals(block.header.height - 20);
  currentJournal = null;

  console.log(`Applied ordering block height=${block.header.height} hash=${validation.blockHash(block.header)} (${block.subBlockTree.subBlockRefs.length} sub-blocks)`);
  return true;
}
