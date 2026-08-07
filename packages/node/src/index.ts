import { loadConfig, isFaucetNetwork } from './config.js';
import { initDb, closeDb } from './store/db.js';
import { schemaVersion, writeSchemaVersion, CURRENT_SCHEMA_VERSION } from './store/meta.js';
import { getSystemKeypair, initSystemKeypair, ensureSystemKarmaBox, ensureFaucetCreditBox } from './store/system.js';
import { startBlockCreator, stopBlockCreator, setDagServiceForMiner } from './services/block-creator.js';
import { createApp, createAdminApp } from './server.js';
import {
  initJournal,
  emitServerStarting,
  emitServerReady,
  emitShutdownSignalReceived,
  emitServerShuttingDown,
} from './journal.js';
import { NetNode, type PostsEntry } from '@dagsocial/net';
import * as validation from '@dagsocial/validation';
import { verifyPostForRelay, type VerifierDeps } from './services/verifier.js';
import { sweepPlaceholders, hasPlaceholders, sweepStumps, hasMissingStumps } from './services/content-sweep.js';
import { validateTx } from './services/utxo-engine.js';
import { setNet } from './services/net-instance.js';
import { applyOrderingBlock } from './services/block-apply.js';
import { createAvlProver, bootstrapAvlProver } from './state/avl-prover.js';
import { DagService } from './services/dag-service.js';
import { SqlitePostStore } from './store/sqlite-store.js';
import { extendsOurTip, findForkPoint, reorg, MAX_REORG_DEPTH } from './services/fork-resolution.js';
import {
  getKarmaBox,
  getKarmaBoxes,
  getKarmaValue,
  getPost,
  insertPost,
  getBox,
  getBoxByProvenance,
  getUnspentBoxes,
  getCurrentHeight,
  insertMempoolSubBlock,
  insertUtxoTx,
  MempoolFullError,
  getOrderingBlock,
  insertStump,
  getStump,
  peerStorage,
} from './store/index.js';
import { getAllIdentityRecords, identityRecordKey } from './store/identity-records.js';
import { encodePost, cumulativeWork, MEMPOOL_EXPIRY_BLOCKS, subBlockFromPost, verifyPostId, VOUCH_COOLDOWN_BLOCKS } from '@dagsocial/types';
import type { BlockHeader, Stump } from '@dagsocial/types';

const config = loadConfig();
const startTime = Date.now();

// 0. Journal
initJournal();
emitServerStarting('1.0.0', config.networkType);

// 1. Init DB
initDb(config.dbPath);

// 1a. Schema version gate: refuse downgrade, run migrations on upgrade
const storedVersion = schemaVersion();
if (storedVersion > CURRENT_SCHEMA_VERSION) {
  console.error(
    `Database schema version is ${storedVersion} but this build expects ` +
    `${CURRENT_SCHEMA_VERSION}. Downgrade is not supported.`
  );
  process.exit(1);
}
if (storedVersion < CURRENT_SCHEMA_VERSION) {
  console.log(
    `Database schema version ${storedVersion} < ${CURRENT_SCHEMA_VERSION}, ` +
    `running migrations...`
  );
  // Future migrations go here, guarded by sentinel keys:
  // if (!metaHas('migration_xyz_v1')) { ...; metaPut('migration_xyz_v1', done); }
  writeSchemaVersion(CURRENT_SCHEMA_VERSION);
}

// ---------------------------------------------------------------------------
// Protocol constant sanity checks
// ---------------------------------------------------------------------------

function validateProtocolConstants(): void {
  const checks: Array<{ condition: boolean; message: string }> = [
    {
      condition: MAX_REORG_DEPTH >= VOUCH_COOLDOWN_BLOCKS,
      message:
        `MAX_REORG_DEPTH (${MAX_REORG_DEPTH}) must be less than ` +
        `VOUCH_COOLDOWN_BLOCKS (${VOUCH_COOLDOWN_BLOCKS}). ` +
        `Otherwise, cooldown maturation can be reorged without journaling, ` +
        `causing double karma mints and permanent cooldown loss.`,
    },
  ];

  for (const check of checks) {
    if (check.condition) {
      console.error(`Protocol constant invariant violated: ${check.message}`);
      process.exit(1);
    }
  }
}

// 1b. Protocol constant sanity checks
validateProtocolConstants();

// 1c. Init system keypair (faucet source on the faucet-bearing networks). Must
//     happen after DB init, before any route that might need the system box.
//     The gate shares isFaucetNetwork with the /faucet mount and the
//     /credits/faucet handler — the three move together (NODE_INTERFACE
//     §Faucet): mounting without provisioning gives a faucet with nothing to
//     mint from.
const systemKeypair = initSystemKeypair();
if (isFaucetNetwork(config.networkType)) {
  const height = getCurrentHeight();
  ensureSystemKarmaBox(systemKeypair.publicKey, height);
  ensureFaucetCreditBox(systemKeypair.publicKey, height);
  console.log(
    `System keypair: ${Buffer.from(systemKeypair.publicKey).toString('hex').slice(0, 12)}... ` +
    `(faucet source)`,
  );
}

// 1c. Initialize AVL prover
const avlHandle = createAvlProver();
const currentHeight = getCurrentHeight();
// Only bootstrap if storage is empty — the PersistentBatchAVLProver
// constructor already loads existing state via rollback.
if (currentHeight > 0 && avlHandle.storage.version() === null) {
  const unspent = getUnspentBoxes();
  // The tree holds two committed entity kinds, so the rebuild feeds both
  // (Spec G phase D). Feeding only boxes would rebuild a tree missing every
  // identity record, and this node would then disagree on `stateRoot` with one
  // that never restarted.
  //
  // Key derivation stays at its single site in the store — `identityRecordKey`
  // — and the prover consumes the derived key rather than re-deriving it.
  const records = getAllIdentityRecords().map((r) => ({
    key: identityRecordKey(r.identityId),
    record: r.record,
  }));
  // Either kind alone is enough to make the empty tree wrong.
  if (unspent.length > 0 || records.length > 0) {
    bootstrapAvlProver(avlHandle, unspent, currentHeight, records);
    console.log(
      `AVL prover bootstrapped from ${unspent.length} unspent boxes and ` +
      `${records.length} identity records at height ${currentHeight}`,
    );
  }
}

// 2. Create NetNode
// The four discovery knobs are passed explicitly: NET_INTERFACE.md documents
// their defaults as binding only when node supplies them — unset, net's
// internal fallbacks silently govern instead.
const net = new NetNode(
  {
    // The profile's wire magic and post-PoW difficulty. Both are required in
    // NetConfig since P2-A phase 3b deleted net's `?? MAGIC_MAINNET` fallbacks
    // (NET_INTERFACE §Magic Bytes); net checks inbound gossip PoW against the
    // same profile difficulty the verifier enforces.
    magic: config.profile.magic,
    postPowTargetBits: config.postPowTargetBits,
    bootstrapPeers: config.bootstrapPeers,
    listenAddrs: config.listenAddrs,
    maxPeers: config.maxPeers,
    minPeers: parseInt(process.env['MIN_PEERS'] ?? '3', 10),
    peerDbCap: parseInt(process.env['PEER_DB_CAP'] ?? '1000', 10),
    outboundFillIntervalMs: parseInt(process.env['OUTBOUND_FILL_INTERVAL_MS'] ?? '30000', 10),
    outboundRedialCooldownMs: parseInt(process.env['OUTBOUND_REDIAL_COOLDOWN_MS'] ?? '60000', 10),
    penaltyScoreThreshold: parseInt(process.env['PENALTY_SCORE_THRESHOLD'] ?? '500', 10),
    temporalBanDurationMs: parseInt(process.env['TEMPORAL_BAN_DURATION_MS'] ?? '3600000', 10),
    penaltySafeIntervalMs: parseInt(process.env['PENALTY_SAFE_INTERVAL_MS'] ?? '120000', 10),
    syncRequestTimeoutMs: parseInt(process.env['SYNC_REQUEST_TIMEOUT_MS'] ?? '10000', 10),
  },
  validation,
  peerStorage,
);
setNet(net);

// Shared deps for verifier and content sweep
const deps = {
  getActiveChallenge: () => null as { challenge: Uint8Array; expiresAtBlock: number; userId: Uint8Array } | null,
  getKarmaBoxes,
  getPost,
};

// DagService — owns canonical branch population and DAG reorg logic
const postStore = new SqlitePostStore();
const dagService = new DagService(postStore);
setDagServiceForMiner(dagService);

// 3. Register Stage 2 handlers

net.onSubBlock((sb) => {
  const result = verifyPostForRelay(deps, sb.post, 0);
  if (!result.valid) {
    console.warn(`Relayed sub-block rejected: ${result.error}`);
    return;
  }
  // Verify post ID matches claimed subBlockId (defense-in-depth)
  if (!verifyPostId(sb.post, sb.subBlockId)) {
    console.warn(`Relayed sub-block rejected: post ID mismatch for ${sb.subBlockId}`);
    return;
  }
  insertPost(sb.post, encodePost(sb.post));
  const currentHeight = getCurrentHeight();
  try {
    insertMempoolSubBlock(sb.subBlockId, currentHeight + MEMPOOL_EXPIRY_BLOCKS);
  } catch (err) {
    if (err instanceof MempoolFullError) {
      console.warn(`Relayed sub-block dropped, mempool full: ${sb.subBlockId}`);
      return;
    }
    throw err;
  }
  // Re-broadcast to other peers (gap 5)
  net.broadcastSubBlock(sb).catch((err: Error) => {
    console.warn(`Failed to relay sub-block ${sb.subBlockId}: ${err.message}`);
  });
  console.log(`Relayed sub-block queued in mempool: ${sb.subBlockId}`);
});

net.onOrderingBlock(async (block) => {
  const currentHeight = getCurrentHeight();

  // Genesis or extends our tip: apply normally
  if (currentHeight === 0 || extendsOurTip(block)) {
    applyOrderingBlock(block, dagService);
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

    reorg(forkHeight, newBlocks, dagService);
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
    getBoxByProvenance,
    insertBox: () => {},
    consumeBox: () => {},
    getKarmaBox,
    getKarmaBoxes,
    // Bond settlement's unlock predicate (P2-B phase 1). Relay validation has
    // to reach the same verdict the block path will — the store's getKarmaValue
    // is the single implementation all three paths share (phase 1b).
    getKarmaValue,
    runInTransaction: (fn: () => void) => fn(),
    isSystemBox: (boxId: string) => {
      const sysKey = getSystemKeypair();
      if (!sysKey) return false;
      const box = getBox(boxId);
      if (!box || box.boxType !== 'karma') return false;
      return Buffer.from((box as import('@dagsocial/types').KarmaBox).owner).equals(
        Buffer.from(sysKey.publicKey),
      );
    },
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
  const expiresAtHeight = currentHeight + MEMPOOL_EXPIRY_BLOCKS;
  try {
    insertUtxoTx(tx, null, expiresAtHeight);
  } catch (err) {
    if (err instanceof MempoolFullError) {
      console.warn(`Relayed tx dropped, mempool full: ${result.txId}`);
      return;
    }
    throw err;
  }
  console.log(`Relayed tx queued in mempool: ${result.txId}`);
});

net.onStump((stump) => {
  if (getStump(stump.rootPostHash)) return;
  insertStump(stump);
  console.log(`Relayed stump stored: ${stump.rootPostHash}`);
});

  // Register blocks handler — bridges sync machine's pull path
  // (ModifierResponse) to the node's applyOrderingBlock pipeline.
  net.setBlocksHandler((block) => {
    applyOrderingBlock(block, dagService);
  });
  net.setHeadersHandler(getOrderingBlock);

// 4. Start net
try {
  await net.start();
  console.log(`Net node started, peer ID: ${net.peerId()}`);

  // Register storage-backed sync handler (replaces the null placeholder
  // registered during NetNode.start())
  net.setSyncHandler((subBlockId: string) => {
    const post = getPost(subBlockId);
    if (!post || !('content' in post) || !post.content) return null;
    return subBlockFromPost(post, subBlockId);
  });

  // Register posts handler for GetPosts requests — skip missing and placeholder posts.
  // Validate IDs are 64-char hex before querying (reject malformed).
  net.setPostsHandler((postIds: string[]) => {
    const HEX64 = /^[0-9a-f]{64}$/;
    const entries: PostsEntry[] = [];
    for (const postId of postIds) {
      if (!HEX64.test(postId)) continue;
      const post = getPost(postId);
      if (!post || !('content' in post) || !post.content) continue;
      entries.push({ postId, post, likeBoxes: [] });
    }
    return entries;
  });

  // Register stumps handler for GetStumps requests
  net.setStumpsHandler((stumpIds: string[]) => {
    const HEX64 = /^[0-9a-f]{64}$/;
    const entries: Array<{ stumpId: string; stump: Stump }> = [];
    for (const stumpId of stumpIds) {
      if (!HEX64.test(stumpId)) continue;
      const stump = getStump(stumpId);
      if (!stump) continue;
      entries.push({ stumpId, stump });
    }
    return entries;
  });


} catch (err) {
  console.warn(`Net startup failed (continuing without networking): ${String(err)}`);
}

function runContentSweep(net: NetNode, deps: VerifierDeps): void {
  if (hasPlaceholders()) {
    console.log('[content-sweep] Sweeping placeholders...');
    sweepPlaceholders(net, deps).then((result) => {
      if (result.success) {
        console.log('[content-sweep] All placeholders resolved.');
      } else {
        console.warn(
          `[content-sweep] Sweep incomplete: ${result.remaining} placeholders remain after retries.`,
        );
      }
    }).catch((err: Error) => {
      console.error(`[content-sweep] Sweep failed: ${err.message}`);
    });
  }
  if (hasMissingStumps()) {
    console.log('[content-sweep] Sweeping missing stumps...');
    sweepStumps(net).then((result) => {
      if (result.success) {
        console.log('[content-sweep] All stumps resolved.');
      } else {
        console.warn(`[content-sweep] Stump sweep incomplete: ${result.remaining} stumps remain.`);
      }
    }).catch((err: Error) => {
      console.error(`[content-sweep] Stump sweep failed: ${err.message}`);
    });
  }
}

// Register content sweep on sync completion
net.onSyncComplete(() => runContentSweep(net, deps));

// Re-run content sweep when a new peer becomes active
net.onPeerActive((_peerId: string) => runContentSweep(net, deps));

// Sweep on startup if placeholders already exist
runContentSweep(net, deps);

// Periodic sweep to catch placeholders that were created after sync
// completed (race between sync finishing and handler registration).
const SWEEP_INTERVAL_MS = 30_000;
setInterval(() => {
  if (hasPlaceholders() || hasMissingStumps()) {
    runContentSweep(net, deps);
  }
}, SWEEP_INTERVAL_MS);

// Re-run content sweep when a new peer becomes active and we have pending placeholders
net.onPeerActive((_peerId: string) => {
  if (hasPlaceholders()) {
    console.log('[content-sweep] New peer active, retrying placeholder sweep...');
    sweepPlaceholders(net, deps).catch((err: Error) => {
      console.error(`[content-sweep] Sweep failed: ${err.message}`);
    });
  }
  if (hasMissingStumps()) {
    console.log('[content-sweep] New peer active, retrying stump sweep...');
    sweepStumps(net).catch((err: Error) => {
      console.error(`[content-sweep] Stump sweep failed: ${err.message}`);
    });
  }
});

// 5. Start block creator (miner only) and HTTP server
if (config.nodeRole === 'miner') {
  startBlockCreator(config);
  console.log(`Node role: miner — producing ordering blocks`);
} else {
  console.log(`Node role: server — applying inbound ordering blocks`);
}

const app = createApp(config);
const adminServer = createAdminApp(config);
const server = app.listen(config.port, () => {
  emitServerReady(
    `0.0.0.0:${config.port}`,
    `${config.adminBindAddress}:${config.adminPort}`,
    Date.now() - startTime,
  );
  console.log(`DAGsocial node listening on :${config.port}`);
});

// 6. Block application (server role) — delegated to block-apply.ts
// ---------------------------------------------------------------------------

// 7. Graceful shutdown
process.on('SIGINT', () => {
  emitShutdownSignalReceived('SIGINT');
  stopBlockCreator();
  net.stop().catch((err: unknown) => console.warn(`Net stop error: ${String(err)}`));
  closeDb();
  server.close();
  adminServer.close();
  emitServerShuttingDown('SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  emitShutdownSignalReceived('SIGTERM');
  stopBlockCreator();
  net.stop().catch((err: unknown) => console.warn(`Net stop error: ${String(err)}`));
  closeDb();
  server.close();
  adminServer.close();
  emitServerShuttingDown('SIGTERM');
  process.exit(0);
});
