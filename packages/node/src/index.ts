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
import {
  getIdentity,
  getKarmaBox,
  getPost,
  insertPost,
  getBox,
  getCurrentHeight,
  insertMempoolSubBlock,
  insertUtxoTx,
  getPendingEntries,
} from './store/index.js';
import { encodePost, decodeSubBlock } from '@dagsocial/types';

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
