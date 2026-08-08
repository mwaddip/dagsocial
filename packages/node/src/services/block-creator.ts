import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  PROTOCOL_VERSION,
  CREDIT_FIXED_RATE_BLOCKS,
  CREDIT_INITIAL_REWARD,
  CREDIT_EPOCH_BLOCKS,
  CREDIT_REWARD_REDUCTION,
  CREDIT_TAIL_REWARD,
  CREDIT_MINER_REWARD_DELAY,
  CREDIT_TREASURY_PCT,
  EMPTY_STATE_ROOT,
  decodeTx,
  computeTxId,
  leafHash,
  buildMerkleRoot,
  serializePruneEntry,
  hexToBuf,
} from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  blockHash,
  computePowHash,
} from '@dagsocial/validation';
import type {
  OrderingBlock,
  BlockHeader,
  SubBlockTree,
  UtxoTxTree,
  CoinbaseOutput,
  Post,
  LikeBox,
} from '@dagsocial/types';
import type { Config } from '../config.js';
import { expectedTarget } from './difficulty.js';
import { getNet } from './net-instance.js';
import { applyOrderingBlock, computePostBlockStateRoot } from './block-apply.js';
import {
  getPendingEntries,
  purgeExpired,
  removeEntry,
  drainMempoolPrunes,
  type PoolEntry,
} from '../store/mempool.js';
import {
  getOrderingBlock,
  getCurrentHeight,
  getPost,
} from '../store/index.js';

// ---------------------------------------------------------------------------
// Merkle root computation
// ---------------------------------------------------------------------------

export function computeSubBlockRoot(tree: SubBlockTree): string {
  const leaves = [
    ...tree.subBlockEntries.map((entry) =>
      // `author` is part of the leaf preimage (audit H-3) — the block commits to
      // who authored each confirmed post, so prune authorship is checkable on a
      // node that never received the content. Key order is normative.
      leafHash('subblock', Buffer.from(JSON.stringify({
        postId: entry.postId,
        parentRefs: entry.parentRefs,
        author: entry.author,
      })))),
    ...tree.pruneEntries.map((entry) =>
      // Tag changed from 'stump' to 'prune' (intentional breaking change, per verifiable-prune spec)
      leafHash('prune', Buffer.from(serializePruneEntry(entry)))),
  ];
  return Buffer.from(buildMerkleRoot(leaves)).toString('hex');
}

export function computeUtxoTxRoot(tree: UtxoTxTree): string {
  const leaves: Uint8Array[] = [
    ...tree.utxoTxIds.map((id) =>
      leafHash('utxotx', hexToBuf(id))),
    ...tree.coinbaseOutputs.map((o) =>
      // `value` is bigint — JSON.stringify throws on it, and this preimage is
      // consensus (utxoTxRoot leaf). Canonical decimal string, deterministic.
      leafHash('coinbase', Buffer.from(JSON.stringify({
        owner: Array.from(o.owner),
        value: o.value.toString(),
        lockedUntilBlock: o.lockedUntilBlock,
        isTreasury: o.isTreasury,
      })))),
  ];
  return Buffer.from(buildMerkleRoot(leaves)).toString('hex');
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let config: Config;
let validatorPubKey: Uint8Array;
let validatorPrivKey: KeyObject;
let validatorId: Uint8Array;
let intervalId: ReturnType<typeof setInterval> | null = null;
let pendingSubBlockCounter = 0;
let currentTemplate: OrderingBlock | null = null;   // For external mining mode
let confirmedRowids: Set<number> = new Set();       // Mempool rowids included in current block
let dagService: import('./dag-service.js').DagService | undefined;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startBlockCreator(cfg: Config): void {
  config = cfg;

  // Generate validator keypair
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  validatorPubKey = new Uint8Array(pubDer.subarray(pubDer.length - 32));
  validatorPrivKey = privateKey;
  validatorId = validatorPubKey;

  // Start interval timer
  intervalId = setInterval(() => {
    createOrderingBlock();
  }, config.orderingBlockIntervalMs);
}

export function stopBlockCreator(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

export function setDagServiceForMiner(ds: import('./dag-service.js').DagService): void {
  dagService = ds;
}

export function onSubBlockReceived(): void {
  if (!config) return;
  pendingSubBlockCounter++;
  if (pendingSubBlockCounter >= config.orderingBlockMinSubBlocks) {
    createOrderingBlock();
  }
}

// ---------------------------------------------------------------------------
// Miner pubkey override (external mining)
// ---------------------------------------------------------------------------

let currentMinerPubkey: Uint8Array | null = null;

/**
 * Set the pubkey that receives coinbase rewards. Called when an external
 * miner requests a template with their own wallet address.
 * Pass null to revert to the node's validator key.
 */
export function setMinerPubkey(pubkey: Uint8Array | null): void {
  currentMinerPubkey = pubkey;
}

/**
 * Return the current block template for external miners.
 * Returns null if no template has been built yet or the block creator
 * is in internal mode.
 */
export function getCurrentTemplate(): OrderingBlock | null {
  return currentTemplate;
}

/**
 * Clear the current template. Called when a relayed block arrives so the
 * block creator builds a fresh template for the next height.
 */
export function clearTemplate(): void {
  currentTemplate = null;
  pendingSubBlockCounter = 0;
}

/**
 * Submit a mined nonce from an external miner.
 * Verifies PoW, finalizes the block, stores it, and broadcasts.
 * Returns the finalized block hash on success, null on failure.
 */
export function submitMinedBlock(powNonce: number, submittedHeight: number): string | null {
  const tpl = currentTemplate;
  // Reject if no template, wrong height, or height already mined
  if (!tpl || tpl.header.height !== submittedHeight || getCurrentHeight() >= submittedHeight) {
    return null;
  }

  // Build header with the submitted nonce
  const header: BlockHeader = {
    ...tpl.header,
    powNonce,
  };

  // Verify PoW against the header
  if (!verifyOrderingBlockPoW(header)) {
    return null;
  }

  // Sign the header hash
  const hh = blockHash(header);
  const sig = cryptoSign(null, Buffer.from(hh, 'hex'), validatorPrivKey);

  const block: OrderingBlock = {
    header,
    subBlockTree: tpl.subBlockTree,
    utxoTxTree: tpl.utxoTxTree,
    validatorSignature: new Uint8Array(sig),
  };

  // Finalize and broadcast
  finalizeBlock(block);

  return hh;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

/**
 * Compute the block reward at a given height using Ergo-style linear decay.
 */
export function computeBlockReward(height: number): bigint {
  if (height <= 0) return 0n;
  if (height <= CREDIT_FIXED_RATE_BLOCKS) {
    return CREDIT_INITIAL_REWARD;
  }
  const epochs = Math.floor(
    (height - CREDIT_FIXED_RATE_BLOCKS - 1) / CREDIT_EPOCH_BLOCKS,
  ) + 1;
  const reward = CREDIT_INITIAL_REWARD - BigInt(epochs) * CREDIT_REWARD_REDUCTION;
  return reward > CREDIT_TAIL_REWARD ? reward : CREDIT_TAIL_REWARD;
}

// ---------------------------------------------------------------------------
// PoW mining (internal mode)
// ---------------------------------------------------------------------------

function encodeLE64(n: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

function solvePoW(powPreimage: Buffer, targetBits: number): number {
  let nonce = 0;
  while (true) {
    const nonceBuf = encodeLE64(nonce);
    const hash = createHash('blake2b512')
      .update(powPreimage)
      .update(nonceBuf)
      .digest()
      .subarray(0, 32);
    let bits = 0;
    for (let i = 0; i < 32 && bits < targetBits; i++) {
      if (hash[i] === 0) { bits += 8; continue; }
      let mask = 0x80;
      while ((hash[i]! & mask) === 0 && bits < targetBits) { bits++; mask >>= 1; }
      break;
    }
    if (bits >= targetBits) return nonce;
    nonce++;
  }
}

// ---------------------------------------------------------------------------
// Core block creation
// ---------------------------------------------------------------------------

export function createOrderingBlock(): OrderingBlock | null {
  const currentHeight = getCurrentHeight();
  const newHeight = currentHeight + 1;

  // 1. Purge expired mempool entries
  purgeExpired(currentHeight);

  // 2. Get pending entries from mempool
  const entries = getPendingEntries(config.maxSubBlocksPerBlock);

  // 3. Separate sub-blocks and standalone UTXO transactions
  const subBlockEntries = entries.filter((e) => e.entryType === 'subblock');
  const standaloneUtxoTxs = entries.filter(
    (e) => e.entryType === 'utxo_tx' && e.batchId === null,
  );

  // 4. Resolve sub-block metadata from dag_posts (mempool now stores postId, not CBOR)
  const resolvedSubBlocks: Array<{ subBlockId: string; post: Post; likeBoxes: LikeBox[] }> = [];
  for (const entry of subBlockEntries) {
    if (!entry.subblockId) continue;
    const post = getPost(entry.subblockId);
    if (!post || !('author' in post)) continue; // skip if content not yet arrived
    resolvedSubBlocks.push({
      subBlockId: entry.subblockId,
      post,
      likeBoxes: [],
    });
  }

  // 5. Resolve batch entries — collect linked UTXO payloads per batch
  const batchMap = new Map<string, PoolEntry[]>();
  for (const e of entries) {
    if (e.batchId) {
      if (!batchMap.has(e.batchId)) batchMap.set(e.batchId, []);
      batchMap.get(e.batchId)!.push(e);
    }
  }

  // 7. Standalone UTXO entries → utxoTxIds
  const utxoTxIds = standaloneUtxoTxs.map((e) => {
    const tx = decodeTx(e.utxoTxCbor!);
    return computeTxId(tx);
  });

  // 7b. Batch-linked UTXO entries → utxoTxIds
  // These were grouped by batch_id in step 5 but never decoded/added to the block.
  for (const [, batchEntries] of batchMap) {
    for (const entry of batchEntries) {
      if (entry.entryType === 'utxo_tx' && entry.utxoTxCbor) {
        const tx = decodeTx(entry.utxoTxCbor);
        utxoTxIds.push(computeTxId(tx));
      }
    }
  }

  // 11. Always produce a block — miners need coinbase rewards even when
  //     there is no user work.  The block will be empty but still carries
  //     credit emission.

  // 12. Track confirmed rowids for finalizeBlock cleanup
  confirmedRowids = new Set<number>();
  for (const e of subBlockEntries) {
    confirmedRowids.add(e.rowid);
  }
  for (const e of standaloneUtxoTxs) {
    confirmedRowids.add(e.rowid);
  }
  // Also track batch entries
  for (const [, batchEntries] of batchMap) {
    for (const e of batchEntries) {
      confirmedRowids.add(e.rowid);
    }
  }

  // 13. Compute coinbase
  const coinbaseOutputs = buildCoinbaseOutputs(newHeight);

  // 14. Difficulty — fixed by the height schedule, and enforced at apply
  const powTargetBits = expectedTarget(newHeight);

  // 16. Previous block hash
  const prevBlock = currentHeight > 0 ? getOrderingBlock(currentHeight) : null;
  const prevBlockHash = prevBlock
    ? blockHash(prevBlock.header)
    : '0000000000000000000000000000000000000000000000000000000000000000';

  const subBlockRefs = resolvedSubBlocks.map((sb) => sb.subBlockId);

  // Build subBlockEntries for the block (committed in the Merkle tree).
  // Both parentRefs and author are read off the resolved post — never off a
  // client-supplied claim — so an honest producer's entries always match the
  // content other nodes verify them against (audit H-3).
  const subBlockEntriesForBlock = resolvedSubBlocks.map((sb) => ({
    postId: sb.subBlockId,
    parentRefs: (sb.post as Post).parentRefs ?? [],
    author: Buffer.from((sb.post as Post).author).toString('hex'),
  }));

  // Collect UTXO tx CBOR for inline storage, matching the utxoTxIds order:
  // 1. standalone entries, 2. batch-linked entries
  const utxoTxCbors: Uint8Array[] = [];

  // Standalone UTXO txs
  for (const entry of standaloneUtxoTxs) {
    utxoTxCbors.push(entry.utxoTxCbor!);
  }

  // Batch-linked UTXO entries
  for (const [, batchEntries] of batchMap) {
    for (const entry of batchEntries) {
      if (entry.entryType === 'utxo_tx' && entry.utxoTxCbor) {
        utxoTxCbors.push(entry.utxoTxCbor);
      }
    }
  }

  // Drain queued prune entries for block inclusion
  const MAX_PRUNES_PER_BLOCK = 32;
  const pruneEntries = drainMempoolPrunes(MAX_PRUNES_PER_BLOCK);

  // 17. Build the body trees
  const subBlockTree: SubBlockTree = {
    subBlockRefs,
    subBlockEntries: subBlockEntriesForBlock,
    pruneEntries,
  };
  const utxoTxTree: UtxoTxTree = {
    utxoTxIds,
    utxoTxs: utxoTxCbors,
    likeBoxIds: [],
    coinbaseOutputs,
  };

  // 18. Compute Merkle roots
  const subBlockRoot = computeSubBlockRoot(subBlockTree);
  const utxoTxRoot = computeUtxoTxRoot(utxoTxTree);

  // 19. Build header template (powNonce=0). `stateRoot` is a placeholder here
  // and is replaced in 19b — the speculative run needs a whole candidate block,
  // and the mutation phase reads neither the nonce nor the signature.
  const headerTemplate: BlockHeader = {
    protocolVersion: PROTOCOL_VERSION,
    height: newHeight,
    prevBlockHash,
    subBlockRoot,
    utxoTxRoot,
    stateRoot: EMPTY_STATE_ROOT,
    validatorId,
    powNonce: 0,
    powTargetBits,
    createdAt: Date.now(),
  };
  const candidate: OrderingBlock = {
    header: headerTemplate,
    subBlockTree,
    utxoTxTree,
    validatorSignature: new Uint8Array(64),
  };

  // 19b. Compute the POST-block state root (H-6) — the digest this block's own
  // body produces, obtained by running that body through the apply path's
  // mutation phase and rolling everything back. Never the current (pre-block)
  // digest: apply compares against the post-mutation digest, so a pre-block
  // root can never verify. PoW covers the header, so this must be known before
  // mining. A node with no prover falls back to EMPTY_STATE_ROOT — test-only,
  // since production initializes one at startup, and a peer running with
  // VERIFY_STATE_ROOT on rejects such a block, which is correct.
  const speculation = computePostBlockStateRoot(candidate, newHeight);

  // 19c. A body the mutation phase rejected must not be mined or templated
  // (P2-B 1c): the PoW would be spent on a block this node's own apply — and
  // every peer's — rejects. Reachable with unmutated code: a pooled tx whose
  // validity reads third-party state (a bond settlement's threshold leg) goes
  // stale in the pool while its inputs stay live. Evict what the body included
  // — the same cleanup a rejected finalize runs — or the next interval
  // rebuilds this exact body: purgeExpired cannot break that loop, because it
  // keys on a chain height that stops advancing.
  if (speculation.kind === 'body-rejected') {
    console.warn(
      `Not producing block at height ${newHeight}: its own mutation phase ` +
      `rejected the body; evicting ${confirmedRowids.size} mempool entries`,
    );
    for (const rowid of confirmedRowids) {
      removeEntry(rowid);
    }
    pendingSubBlockCounter = 0;
    currentTemplate = null;
    confirmedRowids = new Set();
    return null;
  }

  headerTemplate.stateRoot =
    speculation.kind === 'computed' ? speculation.stateRoot : EMPTY_STATE_ROOT;

  // 21. Internal vs external mining
  if (config.miningMode === 'external') {
    // Store the full block template (header + bodies) for external miners.
    // Its stateRoot is this height's post-block digest, so the template stops
    // being submittable once a competing block moves the pre-state — which is
    // exactly what clearTemplate() on apply guarantees.
    currentTemplate = candidate;
    return null; // Block not finalized yet
  }

  // 22. Internal: mine PoW against the header
  const powPreimage = computePowHash(headerTemplate);
  const powNonce = solvePoW(powPreimage, powTargetBits);

  const header: BlockHeader = {
    ...headerTemplate,
    powNonce,
  };

  // 23. Sign the header hash
  const hh = blockHash(header);
  const sig = cryptoSign(null, Buffer.from(hh, 'hex'), validatorPrivKey);

  const block: OrderingBlock = {
    header,
    subBlockTree,
    utxoTxTree,
    validatorSignature: new Uint8Array(sig),
  };

  // 24. Finalize
  finalizeBlock(block);

  return block;
}

// ---------------------------------------------------------------------------
// Block finalization (shared between internal and external mining)
// ---------------------------------------------------------------------------

function finalizeBlock(block: OrderingBlock): void {
  // applyOrderingBlock handles validation, storage, coinbase, confirmations,
  // UTXO tx application, journal recording, and basic mempool cleanup
  const applied = applyOrderingBlock(block, dagService);

  // Clean up any remaining mempool entries that applyOrderingBlock didn't
  // remove (e.g. UTXO txs that were attached to sub-blocks and removed
  // from utxoTxIds). Double-removal is harmless.
  //
  // This runs even when the block was rejected: whatever made it invalid came
  // out of the mempool, so leaving those entries in place would rebuild the
  // same rejected block every interval and stall the chain.
  for (const rowid of confirmedRowids) {
    removeEntry(rowid);
  }

  // Broadcast (not handled by applyOrderingBlock) — only for a block we
  // ourselves accepted. Peers apply the same rules, so gossiping a block our
  // own validation rejected can only waste their bandwidth.
  const net = getNet();
  if (net && applied) {
    net.broadcastOrderingBlock(block).catch((err: Error) => {
      console.warn(`Failed to broadcast ordering block: ${err.message}`);
    });
  }

  // Reset state
  pendingSubBlockCounter = 0;
  currentTemplate = null;
  confirmedRowids = new Set();
}

// ---------------------------------------------------------------------------
// Coinbase
// ---------------------------------------------------------------------------

function buildCoinbaseOutputs(height: number): CoinbaseOutput[] {
  const reward = computeBlockReward(height);
  const outputs: CoinbaseOutput[] = [];

  const treasuryPct = config.creditTreasuryPct;
  let treasuryAmount = 0n;
  let minerAmount = reward;

  if (treasuryPct > 0 && config.treasuryPubKey.length === 64) {
    treasuryAmount = (reward * BigInt(treasuryPct)) / 100n;
    minerAmount = reward - treasuryAmount;
  }

  const lockedUntilBlock = height + CREDIT_MINER_REWARD_DELAY;

  // Miner output — use external miner's pubkey if provided, else validator key
  outputs.push({
    owner: currentMinerPubkey ?? validatorId,
    value: minerAmount,
    lockedUntilBlock,
    isTreasury: false,
  });

  // Treasury output (if configured)
  if (treasuryAmount > 0n) {
    const treasuryKey = new Uint8Array(Buffer.from(config.treasuryPubKey, 'hex'));
    outputs.push({
      owner: treasuryKey,
      value: treasuryAmount,
      lockedUntilBlock,
      isTreasury: true,
    });
  }

  return outputs;
}
