import { loadConfig } from './config.js';
import { initDb, getDb, closeDb } from './store/db.js';
import { startBlockCreator, stopBlockCreator } from './services/block-creator.js';
import { createApp } from './server.js';
import { NetNode } from '@dagsocial/net';
import * as validation from '@dagsocial/validation';
import { verifyPostForRelay } from './services/verifier.js';
import { validateAndApplyTx } from './services/utxo-engine.js';
import { setNet } from './services/net-instance.js';
import {
  getIdentity,
  getKarmaBox,
  getPost,
  insertPost,
  insertSubBlock,
  insertBox,
  getBox,
  consumeBox,
} from './store/index.js';
import { encodePost } from '@dagsocial/types';

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
  console.log(`Received ordering block height=${block.height} hash=${block.hash}`);
  // Full block application (chain fork handling) deferred to future task.
  // The local block creator owns ordering block production for now.
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
} catch (err) {
  console.warn(`Net startup failed (continuing without networking): ${String(err)}`);
}

// 5. Start HTTP server and block creator
startBlockCreator(config);
const app = createApp(config);
const server = app.listen(config.port, () => {
  console.log(`DAGsocial node listening on :${config.port}`);
});

// 6. Graceful shutdown
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
