import { loadConfig } from './config.js';
import { initDb, closeDb } from './store/db.js';
import { initSystemKeypair, ensureSystemKarmaBox } from './store/system.js';
import { startBlockCreator, stopBlockCreator } from './services/block-creator.js';
import { createApp } from './server.js';
import { NetNode } from '@dagsocial/net';
import * as validation from '@dagsocial/validation';
import { verifyPostForRelay } from './services/verifier.js';
import { validateTx } from './services/utxo-engine.js';
import { setNet } from './services/net-instance.js';
import { applyOrderingBlock } from './services/block-apply.js';
import { extendsOurTip, findForkPoint, reorg, MAX_REORG_DEPTH } from './services/fork-resolution.js';
import {
  getIdentity,
  getKarmaBox,
  getKarmaBoxes,
  getPost,
  insertPost,
  getBox,
  getCurrentHeight,
  insertMempoolSubBlock,
  insertUtxoTx,
  getPendingEntries,
  getOrderingBlock,
} from './store/index.js';
import { encodePost, decodeSubBlock, cumulativeWork } from '@dagsocial/types';
import type { BlockHeader } from '@dagsocial/types';

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
      getKarmaBoxes,
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

net.onOrderingBlock(async (block) => {
  const currentHeight = getCurrentHeight();

  // Genesis or extends our tip: apply normally
  if (currentHeight === 0 || extendsOurTip(block)) {
    applyOrderingBlock(block);
    return;
  }

  // Fork detected
  console.log(
    `Fork detected: our height=${currentHeight}, ` +
    `competing block height=${block.header.height}`,
  );

  const peers = net.peers();
  if (peers.length === 0) {
    console.warn('Fork resolution failed: no connected peers');
    return;
  }
  const peerId = peers[0]!.id;

  try {
    // Request headers from competing tip going backward (newest-first)
    const theirHeaders = await net.requestHeaders(
      block.header.height,
      MAX_REORG_DEPTH * 2,
      peerId,
    );
    if (theirHeaders.length === 0) {
      console.warn('Fork resolution failed: no headers from peer');
      return;
    }

    const ourTip = getOrderingBlock(currentHeight);
    if (!ourTip) {
      console.warn('Fork resolution failed: cannot retrieve our tip');
      return;
    }

    const forkHeight = findForkPoint(ourTip.header, theirHeaders);
    if (forkHeight === null) {
      console.warn(
        `Fork resolution failed: no common ancestor within ${MAX_REORG_DEPTH} blocks`,
      );
      return;
    }

    // Build our chain headers from fork+1 to current tip
    const ourHeaders: BlockHeader[] = [];
    for (let h = forkHeight + 1; h <= currentHeight; h++) {
      const b = getOrderingBlock(h);
      if (b) ourHeaders.push(b.header);
    }

    // Extract competing chain headers above fork point (theirHeaders is newest-first)
    const theirChainHeaders = theirHeaders
      .filter((h) => h.height > forkHeight)
      .reverse(); // chronological order for cumulativeWork

    const ourWork = cumulativeWork(ourHeaders);
    const theirWork = cumulativeWork(theirChainHeaders);

    if (theirWork <= ourWork) {
      console.log(
        `Fork resolution: our chain has more or equal work ` +
        `(ours=${ourWork}, theirs=${theirWork}), ignoring`,
      );
      return;
    }

    console.log(
      `Fork resolution: competing chain has more work ` +
      `(ours=${ourWork}, theirs=${theirWork}), reorging...`,
    );

    // Request blocks from fork+1 to competing tip
    const theirTipHeight = theirHeaders[0]!.height;
    const newBlocks = await net.requestBlocks(
      forkHeight + 1,
      theirTipHeight,
      peerId,
    );

    // Re-check tip — our chain may have advanced during the async requests
    const heightNow = getCurrentHeight();
    if (heightNow !== currentHeight) {
      console.warn(
        `Tip changed during fork resolution ` +
        `(was ${currentHeight}, now ${heightNow}), aborting reorg`,
      );
      return;
    }

    reorg(forkHeight, newBlocks);
    console.log(
      `Reorg complete: new tip at height=${forkHeight + newBlocks.length}`,
    );
  } catch (err) {
    console.warn(`Fork resolution error: ${String(err)}`);
  }
});

net.onTx((tx) => {
  const deps = {
    getBox,
    insertBox: () => {},
    consumeBox: () => {},
    getKarmaBox,
    getKarmaBoxes,
    getIdentity,
    runInTransaction: (fn: () => void) => fn(),
  };
  const currentHeight = getCurrentHeight();
  const result = validateTx(deps, tx, currentHeight);
  if (!result.valid) {
    // Boxes referenced by relayed txs may not have arrived yet via header sync.
    // The tx will be included in the ordering block that carries the boxes.
    // Only log at debug level — this is expected during normal operation.
    if (result.error?.includes('Missing or invalid owner signature') || result.error?.includes('not found')) {
      // silently skip — tx will arrive via block sync
    } else {
      console.warn(`Relayed tx rejected: ${result.error}`);
    }
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

  // Register headers handler for fork resolution sync
  net.setHeadersHandler(getOrderingBlock);
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

// 6. Block application (server role) — delegated to block-apply.ts
// ---------------------------------------------------------------------------

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
