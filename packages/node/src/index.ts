import { loadConfig } from './config.js';
import { initDb, getDb, closeDb } from './store/db.js';
import { startBlockCreator, stopBlockCreator } from './services/block-creator.js';
import { createApp } from './server.js';
import { NetNode } from '@dagsocial/net';
import * as validation from '@dagsocial/validation';
import { verifyPostForRelay } from './services/verifier.js';
import { validateAndApplyTx } from './services/utxo-engine.js';
import { setNet } from './services/net-instance.js';
import { mintKarma } from './services/karma.js';
import {
  getIdentity,
  getKarmaBox,
  getPost,
  insertPost,
  insertSubBlock,
  getSubBlock,
  insertBox,
  getBox,
  consumeBox,
  confirmSubBlock,
  confirmPost,
  markLikeBoxesTallied,
  getCurrentHeight,
  createOrderingBlock as storeCreateOrderingBlock,
  getOrderingBlock,
} from './store/index.js';
import { encodePost, PROTOCOL_VERSION } from '@dagsocial/types';

const config = loadConfig();

// 1. Init DB
initDb(config.dbPath);

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
  // Store post and sub-block
  insertPost(sb.post, encodePost(sb.post));
  insertSubBlock(sb);
  // Store like boxes
  for (const lb of sb.likeBoxes) {
    insertBox(lb);
  }
});

net.onOrderingBlock((block) => {
  applyOrderingBlock(block);
});

net.onTx((tx) => {
  const deps = {
    getBox,
    insertBox,
    consumeBox,
    getKarmaBox,
    getIdentity,
    runInTransaction: (fn: () => void) => {
      getDb().transaction(fn)();
    },
  };
  const result = validateAndApplyTx(deps, tx, 0);
  if (!result.valid) {
    console.warn(`Relayed tx rejected: ${result.error}`);
    return;
  }
  console.log(`Relayed tx accepted: ${tx.inputs.length} inputs`);
});

// 4. Start net
try {
  await net.start();
  console.log(`Net node started, peer ID: ${net.peerId()}`);

  // Register storage-backed sync handler (replaces the null placeholder
  // registered during NetNode.start())
  net.setSyncHandler((subBlockId: string) => {
    const sb = getSubBlock(subBlockId);
    return sb ?? null;
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
    if (block.prevBlockHash !== '0000000000000000000000000000000000000000000000000000000000000000') {
      console.warn(`Rejected block height=${block.height}: genesis prevBlockHash mismatch`);
      return;
    }
    if (block.height !== 1) {
      console.warn(`Rejected block: first block must have height=1, got ${block.height}`);
      return;
    }
  } else {
    const prevBlock = getOrderingBlock(currentHeight);
    if (!prevBlock) {
      console.warn(`Rejected block height=${block.height}: cannot find previous block at height=${currentHeight}`);
      return;
    }
    if (block.prevBlockHash !== prevBlock.hash) {
      console.warn(`Rejected block height=${block.height}: prevBlockHash mismatch`);
      return;
    }
    if (block.height !== currentHeight + 1) {
      console.warn(`Rejected block height=${block.height}: expected ${currentHeight + 1}`);
      return;
    }
  }

  // 2. Protocol version
  if (block.protocolVersion !== PROTOCOL_VERSION) {
    console.warn(`Rejected block height=${block.height}: unsupported protocol version ${block.protocolVersion}`);
    return;
  }

  // 3. Store the block
  storeCreateOrderingBlock(block);

  // 4. Confirm sub-blocks and their posts
  for (const subBlockId of block.subBlockRefs) {
    try {
      confirmSubBlock(subBlockId, block.height);
      confirmPost(subBlockId, block.height);
    } catch (err) {
      console.warn(`Failed to confirm sub-block ${subBlockId}: ${String(err)}`);
    }
  }

  // 5. Mark standalone like boxes as tallied
  if (block.likeBoxIds.length > 0) {
    markLikeBoxesTallied(block.likeBoxIds);
  }

  // 6. Apply epoch tally results
  if (block.epochTallyResults) {
    const rewards = block.epochTallyResults.rewards;
    for (const postId of Object.keys(rewards)) {
      const reward = rewards[postId];
      if (!reward) continue;

      // Author reward
      if (reward.authorReward > 0) {
        const post = getPost(postId);
        if (post && 'author' in post) {
          mintKarma(post.author, reward.authorReward, block.height);
        }
      }

      // Liker refunds (locked likes that met threshold)
      for (const likerId of Object.keys(reward.likerRefunds)) {
        const refund = reward.likerRefunds[likerId];
        if (refund !== undefined && refund !== 0) {
          mintKarma(likerId, refund, block.height);
        }
      }

      // Post lock karma unlocked
      if (reward.postLockKarmaUnlocked && reward.postLockKarmaUnlocked > 0) {
        const post = getPost(postId);
        if (post && 'author' in post) {
          mintKarma(post.author, reward.postLockKarmaUnlocked, block.height);
        }
      }
    }
  }

  console.log(`Applied ordering block height=${block.height} hash=${block.hash} (${block.subBlockRefs.length} sub-blocks)`);
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
