import { loadConfig, isFaucetNetwork } from './config.js';
import { initDb, closeDb } from './store/db.js';
import { ensureSchemaVersion } from './store/meta.js';
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
import { sweepPlaceholders, hasPlaceholders } from './services/content-sweep.js';
import { validateTx } from './services/utxo-engine.js';
import { setNet } from './services/net-instance.js';
import { applyOrderingBlock } from './services/block-apply.js';
import { createAvlProver } from './state/avl-prover.js';
import { DagService } from './services/dag-service.js';
import { SqlitePostStore } from './store/sqlite-store.js';
import { extendsOurTip, findForkPoint, reorg, MAX_REORG_DEPTH } from './services/fork-resolution.js';
import {
  getKarmaBox,
  getKarmaBoxes,
  getKarmaValue,
  hasActiveVouchCooldown,
  getPost,
  insertPost,
  getBox,
  getBoxByProvenance,
  getCurrentHeight,
  insertMempoolSubBlock,
  insertUtxoTx,
  MempoolFullError,
  getOrderingBlock,
  peerStorage,
} from './store/index.js';
import { encodePost, cumulativeWork, MEMPOOL_EXPIRY_BLOCKS, subBlockFromPost, verifyPostId, VOUCH_COOLDOWN_BLOCKS } from '@dagsocial/types';
import type { BlockHeader } from '@dagsocial/types';

const config = loadConfig();
const startTime = Date.now();

// 0. Journal
initJournal();
emitServerStarting('1.0.0', config.networkType);

// 1. Init DB
initDb(config.dbPath);

// 1a. Schema version gate: stamp a fresh DB, refuse any stamped mismatch —
// downgrade OR stale (P2-D N2a: the previous < branch stamped a stale DB as
// current with zero migrations registered, which defeated the counter: the
// tables kept their old shape and the node ran until the first read of a
// missing column instead of failing here). Logic and any future migrations
// live in ensureSchemaVersion, where tests can reach them.
try {
  ensureSchemaVersion();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
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
//
// There is deliberately no rebuild-from-UTXO-set path here (NODE_INTERFACE →
// the SUPERSEDED note on `bootstrapAvlProver`, 2026-08-07). The branch that
// guarded one was doubly dead: its trigger — `storage.version() === null`
// after `createAvlProver()` — is statically false under @ergots/avltree
// 0.4.0, whose PersistentBatchAVLProver constructor writes the empty-tree
// version to empty storage and throws if `version()` is still null after;
// and the rebuild it guarded was unsound anyway — AVL+ tree shape is
// history-dependent, so a tree rebuilt by re-inserting a set forks against
// one grown incrementally to the same content (measured: identical content
// agreed on the digest in 6 of 10 rounds). The sound restart path is the
// persisted tree the constructor loads. Operational consequence: AVL storage
// must never be wiped independently of the chain — wiping both together is
// the only supported reset.
createAvlProver();

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
    // The vouch cast's cooldown gate (P2-B phase 2) — same rule.
    hasActiveVouchCooldown,
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
  if (hasPlaceholders()) {
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
