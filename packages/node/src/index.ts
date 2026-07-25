import { loadConfig } from './config.js';
import { initDb, getDb, closeDb } from './store/db.js';
import { initSystemKeypair, ensureSystemKarmaBox } from './store/system.js';
import { startBlockCreator, stopBlockCreator, clearTemplate } from './services/block-creator.js';
import { createApp } from './server.js';
import { NetNode } from '@dagsocial/net';
import * as validation from '@dagsocial/validation';
import { verifyPostForRelay } from './services/verifier.js';
import { validateTx, revalidateTxInContext, applyTx } from './services/utxo-engine.js';
import { setNet } from './services/net-instance.js';
import { mintKarma } from './services/karma.js';
import { mintCredits } from './services/credits.js';
import { computeBlockReward } from './services/block-creator.js';
import {
  getIdentity,
  getKarmaBox,
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
  insertMempoolSubBlock,
  insertUtxoTx,
  getPendingEntries,
  removeEntry,
} from './store/index.js';
import { encodePost, PROTOCOL_VERSION, decodeTx, decodeSubBlock, computeTxId, computeBoxId } from '@dagsocial/types';
import type { AnyBox } from '@dagsocial/types';

const config = loadConfig();

// 1. Init DB
initDb(config.dbPath);

// 1a. Init system keypair (testnet faucet source). Must happen after DB init,
//     before any route that might need the system box.
const systemKeypair = initSystemKeypair();
if (config.networkMode === 'testnet') {
  const height = getCurrentHeight();
  ensureSystemKarmaBox(systemKeypair.publicKey, height);
  console.log(
    `System keypair: ${Buffer.from(systemKeypair.publicKey).toString('hex').slice(0, 12)}... ` +
    `(faucet source)`,
  );
}

// 2. Create NetNode
const net = new NetNode(
  {
    bootstrapPeers: config.bootstrapPeers,
    listenAddrs: config.listenAddrs,
    maxPeers: config.maxPeers,
    penaltyScoreThreshold: parseInt(process.env['PENALTY_SCORE_THRESHOLD'] ?? '500', 10),
    temporalBanDurationMs: parseInt(process.env['TEMPORAL_BAN_DURATION_MS'] ?? '3600000', 10),
    penaltySafeIntervalMs: parseInt(process.env['PENALTY_SAFE_INTERVAL_MS'] ?? '120000', 10),
    peerEvictionIntervalMs: parseInt(process.env['PEER_EVICTION_INTERVAL_MS'] ?? '3600000', 10),
    syncRequestTimeoutMs: parseInt(process.env['SYNC_REQUEST_TIMEOUT_MS'] ?? '10000', 10),
  },
  validation,
);
setNet(net);

// 3. Register Stage 2 handlers

net.onSubBlock((sb) => {
  const result = verifyPostForRelay(
    {
      getActiveChallenge: () => null, // challenges are node-local to origin
      getIdentity,
      getKarmaBox,
      getPost,
    },
    sb.post,
    0,
  );
  if (!result.valid) {
    console.warn(`Relayed sub-block rejected: ${result.error}`);
    return;
  }
  insertPost(sb.post, encodePost(sb.post));
  const currentHeight = getCurrentHeight();
  insertMempoolSubBlock(sb, currentHeight + 720);
  console.log(`Relayed sub-block queued in mempool: ${sb.subBlockId}`);
});

net.onOrderingBlock((block) => {
  applyOrderingBlock(block);
});

net.onTx((tx) => {
  const deps = {
    getBox,
    insertBox: () => {},
    consumeBox: () => {},
    getKarmaBox,
    getIdentity,
    runInTransaction: (fn: () => void) => fn(),
  };
  const currentHeight = getCurrentHeight();
  const result = validateTx(deps, tx, currentHeight);
  if (!result.valid) {
    console.warn(`Relayed tx rejected: ${result.error}`);
    return;
  }
  const expiresAtHeight = currentHeight + 720;
  insertUtxoTx(tx, null, expiresAtHeight);
  console.log(`Relayed tx queued in mempool: ${result.txId}`);
});

// 4. Start net
try {
  await net.start();
  console.log(`Net node started, peer ID: ${net.peerId()}`);

  // Register storage-backed sync handler (replaces the null placeholder
  // registered during NetNode.start())
  net.setSyncHandler((subBlockId: string) => {
    const entries = getPendingEntries(1000);
    for (const entry of entries) {
      if (entry.entryType !== 'subblock' || !entry.subblockCbor) continue;
      const sb = decodeSubBlock(entry.subblockCbor);
      if (sb.subBlockId === subBlockId) return sb;
    }
    return null;
  });
} catch (err) {
  console.warn(`Net startup failed (continuing without networking): ${String(err)}`);
}

// 5. Start block creator (miner only) and HTTP server
if (config.nodeRole === 'miner') {
  startBlockCreator(config);
  console.log(`Node role: miner — producing ordering blocks`);
} else {
  console.log(`Node role: server — applying inbound ordering blocks`);
}

const app = createApp(config);
const server = app.listen(config.port, () => {
  console.log(`DAGsocial node listening on :${config.port}`);
});

// 6. Block application (server role)
// ---------------------------------------------------------------------------

function applyOrderingBlock(block: import('@dagsocial/types').OrderingBlock): void {
  const currentHeight = getCurrentHeight();

  // 1. Chain-link check
  if (currentHeight === 0) {
    // Genesis: prevBlockHash must be all zeros
    if (block.header.prevBlockHash !== '0000000000000000000000000000000000000000000000000000000000000000') {
      console.warn(`Rejected block height=${block.header.height}: genesis prevBlockHash mismatch`);
      return;
    }
    if (block.header.height !== 1) {
      console.warn(`Rejected block: first block must have height=1, got ${block.header.height}`);
      return;
    }
  } else {
    const prevBlock = getOrderingBlock(currentHeight);
    if (!prevBlock) {
      console.warn(`Rejected block height=${block.header.height}: cannot find previous block at height=${currentHeight}`);
      return;
    }
    if (block.header.prevBlockHash !== validation.blockHash(prevBlock.header)) {
      console.warn(`Rejected block height=${block.header.height}: prevBlockHash mismatch`);
      return;
    }
    if (block.header.height !== currentHeight + 1) {
      console.warn(`Rejected block height=${block.header.height}: expected ${currentHeight + 1}`);
      return;
    }
  }

  // 2. Protocol version
  if (block.header.protocolVersion !== PROTOCOL_VERSION) {
    console.warn(`Rejected block height=${block.header.height}: unsupported protocol version ${block.header.protocolVersion}`);
    return;
  }

  // 3. PoW verification
  if (!validation.verifyOrderingBlockPoW(block.header)) {
    console.warn(`Rejected block height=${block.header.height}: PoW invalid`);
    return;
  }

  // 4. Verify coinbase reward matches emission schedule
  const expectedReward = computeBlockReward(block.header.height);
  const totalCoinbase = block.utxoTxTree.coinbaseOutputs.reduce((sum, o) => sum + o.value, 0);
  if (totalCoinbase !== expectedReward) {
    console.warn(
      `Rejected block height=${block.header.height}: coinbase value ${totalCoinbase} != expected ${expectedReward}`,
    );
    return;
  }

  // 5. Store the block
  storeCreateOrderingBlock(block);

  // 6. Clear the local mining template (this height is taken)
  clearTemplate();

  // 7. Apply coinbase — mint credits for each output
  for (const out of block.utxoTxTree.coinbaseOutputs) {
    mintCredits(out.owner, out.value, block.header.height, out.lockedUntilBlock);
  }

  // 7. Confirm sub-blocks and their posts
  for (const subBlockId of block.subBlockTree.subBlockRefs) {
    try {
      confirmPost(subBlockId, block.header.height);
    } catch (err) {
      console.warn(`Failed to confirm sub-block ${subBlockId}: ${String(err)}`);
    }
  }

  // 8. Mark standalone like boxes as tallied
  if (block.utxoTxTree.likeBoxIds.length > 0) {
    markLikeBoxesTallied(block.utxoTxTree.likeBoxIds);
  }

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
          mintKarma(post.author, reward.authorReward, block.header.height);
        }
      }

      // Liker refunds (locked likes that met threshold)
      for (const likerId of Object.keys(reward.likerRefunds)) {
        const refund = reward.likerRefunds[likerId];
        if (refund !== undefined && refund !== 0) {
          mintKarma(new Uint8Array(Buffer.from(likerId, "hex")), refund, block.header.height);
        }
      }

      // Post lock karma unlocked
      if (reward.postLockKarmaUnlocked && reward.postLockKarmaUnlocked > 0) {
        const post = getPost(postId);
        if (post && 'author' in post) {
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
  }

  console.log(`Applied ordering block height=${block.header.height} hash=${validation.blockHash(block.header)} (${block.subBlockTree.subBlockRefs.length} sub-blocks)`);
}

// 7. Graceful shutdown
process.on('SIGINT', () => {
  stopBlockCreator();
  net.stop().catch((err: unknown) => console.warn(`Net stop error: ${String(err)}`));
  closeDb();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopBlockCreator();
  net.stop().catch((err: unknown) => console.warn(`Net stop error: ${String(err)}`));
  closeDb();
  server.close();
  process.exit(0);
});
