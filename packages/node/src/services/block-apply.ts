import { createHash, createPublicKey, verify } from 'crypto';
import * as validation from '@dagsocial/validation';
import { mintKarma } from './karma.js';
import { mintCredits } from './credits.js';
import { applyKarmaDecay } from './decay.js';
import {
  getMaturedVouchCooldowns,
  deleteVouchCooldown,
  insertVouchCooldown,
} from '../store/vouch-cooldowns.js';
import { VOUCH_COOLDOWN_BLOCKS, VOUCH_KARMA_AMOUNT } from '@dagsocial/types';
import { settlePruneUtxo } from './settle-prune-utxo.js';
import type { DecayDeps } from './decay.js';
import { config } from '../config.js';
import { computeBlockReward, computeSubBlockRoot, computeUtxoTxRoot, clearTemplate, computeEpochTally } from './block-creator.js';
import { expectedTarget } from './difficulty.js';
import { canonicalRewardsJson } from './epoch-canonical.js';
import { DagService } from './dag-service.js';
import { applyTx, validateTx } from './utxo-engine.js';
import { getSystemKeypair } from '../store/system.js';
import {
  getKarmaBox,
  getKarmaBoxes,
  getPost,
  insertStump,
  insertPostPlaceholder,
  insertBox,
  getBox,
  consumeBox,
  confirmPost,
  pruneSubtree,
  markLikeBoxesTallied,
  markFreeLikesProcessed,
  getCurrentHeight,
  createOrderingBlock as storeCreateOrderingBlock,
  getOrderingBlock,
  getPendingEntries,
  removeEntry,
  removeSubBlockEntries,
  insertBlockTopology,
  getSubtreeTopology,
  getTopologyAuthor,
} from '../store/index.js';
import { getDb } from '../store/db.js';
import {
  beginBlockJournal,
  finishBlockJournal,
  abortBlockJournal,
  recordConfirmedSubBlocks,
  recordAppliedUtxoTx,
  insertBlockJournal,
  purgeOldJournals,
} from '../store/journal.js';
import { tryGetAvlProver, applyBlockMutations, checkpointProver } from '../state/avl-prover.js';
import {
  encodeTx,
  decodeTx,
  PROTOCOL_VERSION,
  CREDIT_MINER_REWARD_DELAY,
  computeTxId,
  computeBoxId,
  leafHash,
  buildMerkleRoot,
  hexToBuf,
} from '@dagsocial/types';
import type { AnyBox, OrderingBlock, UtxoTransaction } from '@dagsocial/types';

function processVouchCooldowns(currentHeight: number): void {
  const matured = getMaturedVouchCooldowns(currentHeight);
  for (const row of matured) {
    mintKarma(row.voucherId, row.karmaAmount, currentHeight);
    deleteVouchCooldown(row.voucherId, row.targetId);
  }
}

/**
 * Signals "this block is invalid" from inside the transaction that wraps block
 * application. Thrown rather than returned because better-sqlite3 only rolls a
 * transaction back on a thrown error. Never escapes this module.
 */
class BlockRejected extends Error {}

/**
 * Apply an ordering block — all of it, or none of it.
 *
 * A block is a single unit of state transition, so every mutation it makes
 * (coinbase mint, sub-block confirmation, prune settlement, epoch tally, UTXO
 * transactions, decay) lives in one SQLite transaction. Any rejection — at any
 * step — rolls the whole thing back, leaving the node on the state it had
 * before the block arrived. Returns false for a rejected block; `reorg()`
 * nests this inside its own transaction, which SQLite handles as a savepoint.
 *
 * The funnel is total: no input makes this function throw. A block that causes
 * an unexpected exception is a block the node rejects, on the same terms as an
 * explicit rejection — transaction rolled back, journal dropped, `false`
 * returned, detail logged. That is not defensive padding. The gossip callback
 * is `async` and the net layer discards its promise, so a propagated throw
 * becomes an unhandled rejection, which exits the process on Node ≥ 15; and
 * because a rejected block is never stored, the node re-fetches it on restart
 * and dies again. One cheaply-mined block would otherwise be a permanent,
 * self-reapplying kill for every node that receives it.
 */
export function applyOrderingBlock(block: OrderingBlock, dagService?: DagService): boolean {
  // Structure first, before any field of `block` is read. Until this returns
  // valid, nothing about the object's shape is known: the fields below are
  // decoded CBOR from an untrusted producer, and `pruneEntries` in particular
  // reaches `Buffer.from` and `createHash().update()` further down, which throw
  // on a number or a plain object. This used to run only in the gossip topic
  // validator, so the pull-sync path — CBOR-decode straight into the apply
  // handler — arrived here with fields of arbitrary type. Enforcing it in the
  // funnel makes the guarantee path-independent, as already done for the PoW
  // target (M-2), coinbase maturity (M-3), and the validator signature (H-1).
  const structure = validation.verifyOrderingBlockStructure(block);
  if (!structure.valid) {
    console.warn(`Rejected block: invalid structure: ${structure.error}`);
    return false;
  }
  // SQLite rollback does not reach the AVL prover's in-memory state, so the
  // funnel snapshots the digest before the transaction and restores it on
  // every rejection path — explicit rejection (including the stateRoot
  // mismatch, whose §13-local rollback this replaces) and the totality catch.
  const avlHandle = tryGetAvlProver();
  const preDigest = avlHandle ? avlHandle.prover.digest() : null;
  const restoreProver = (): void => {
    if (!avlHandle || !preDigest) return;
    const current = avlHandle.prover.digest();
    if (current && Buffer.from(current).equals(Buffer.from(preDigest))) return;
    avlHandle.prover.rollback(preDigest);
  };
  try {
    return getDb().transaction(() => {
      if (!applyBlockBody(block, dagService)) throw new BlockRejected();
      return true;
    })();
  } catch (err) {
    if (err instanceof BlockRejected) {
      restoreProver();
      return false;
    }
    // better-sqlite3 has already rolled the transaction back by the time the
    // throw surfaces here (it issues ROLLBACK, or ROLLBACK TO for the nested
    // reorg savepoint, before re-throwing), so the node is on its pre-block
    // state. What is left is to drop the half-built journal (a no-op if the
    // body already finished it), restore the prover, and answer the caller
    // the same way an explicit rejection does.
    console.error(
      `Rejected block height=${block.header.height}: unexpected failure during apply: ${String(err)}`,
    );
    abortBlockJournal();
    restoreProver();
    return false;
  }
}

function applyBlockBody(block: OrderingBlock, dagService?: DagService): boolean {
  const currentHeight = getCurrentHeight();

  // Open the record-once journal: from here on the store mutation primitives
  // record automatically, and every rejection path below aborts it.
  beginBlockJournal(block.header.height);
  // All refs, independent of per-post confirm outcomes — same semantics as
  // the confirm loop in §7, which tolerates per-post failures.
  recordConfirmedSubBlocks([...block.subBlockTree.subBlockRefs]);

  // 1. Chain-link check
  if (currentHeight === 0) {
    // Genesis: prevBlockHash must be all zeros
    if (block.header.prevBlockHash !== '0000000000000000000000000000000000000000000000000000000000000000') {
      console.warn(`Rejected block height=${block.header.height}: genesis prevBlockHash mismatch`);
      abortBlockJournal();
      return false;
    }
    if (block.header.height !== 1) {
      console.warn(`Rejected block: first block must have height=1, got ${block.header.height}`);
      abortBlockJournal();
      return false;
    }
  } else {
    const prevBlock = getOrderingBlock(currentHeight);
    if (!prevBlock) {
      console.warn(`Rejected block height=${block.header.height}: cannot find previous block at height=${currentHeight}`);
      abortBlockJournal();
      return false;
    }
    if (block.header.prevBlockHash !== validation.blockHash(prevBlock.header)) {
      console.warn(`Rejected block height=${block.header.height}: prevBlockHash mismatch`);
      abortBlockJournal();
      return false;
    }
    if (block.header.height !== currentHeight + 1) {
      console.warn(`Rejected block height=${block.header.height}: expected ${currentHeight + 1}`);
      abortBlockJournal();
      return false;
    }
  }

  // 2. Protocol version
  if (block.header.protocolVersion !== PROTOCOL_VERSION) {
    console.warn(`Rejected block height=${block.header.height}: unsupported protocol version ${block.header.protocolVersion}`);
    abortBlockJournal();
    return false;
  }

  // 3. PoW verification
  //
  // The scheduled target is checked first, because `verifyOrderingBlockPoW`
  // only checks the solution against the header's *own* `powTargetBits`: a
  // producer that writes the floor target into its header mines a near-free
  // block that satisfies its own claim, and every node accepts it. The target
  // is a deterministic function of height (MINING contract, invariant 4), and
  // every path into the chain — gossip, sync, reorg — funnels through here, so
  // this is where the schedule can be enforced for all of them.
  const scheduledTarget = expectedTarget(block.header.height);
  if (block.header.powTargetBits !== scheduledTarget) {
    console.warn(
      `Rejected block height=${block.header.height}: powTargetBits ` +
      `${block.header.powTargetBits} != scheduled ${scheduledTarget}`,
    );
    abortBlockJournal();
    return false;
  }
  if (!validation.verifyOrderingBlockPoW(block.header)) {
    console.warn(`Rejected block height=${block.header.height}: PoW invalid`);
    abortBlockJournal();
    return false;
  }

  // 3b. Validator signature (H-1)
  //
  // PoW proves work was spent; it does not prove who spent it. Without this,
  // any miner forges a block under any validatorId. Runs in applyBlockBody — the
  // funnel every apply path (gossip, sync, reorg) passes through — so no path skips it.
  if (!validation.verifyValidatorSignature(block.header, block.validatorSignature)) {
    console.warn(`Rejected block height=${block.header.height}: validator signature invalid`);
    abortBlockJournal();
    return false;
  }

  // 4. Merkle root verification
  const computedSubRoot = computeSubBlockRoot(block.subBlockTree);
  const computedUtxoRoot = computeUtxoTxRoot(block.utxoTxTree);
  if (computedSubRoot !== block.header.subBlockRoot) {
    console.warn(`Rejected block height=${block.header.height}: subBlockRoot mismatch`);
    abortBlockJournal();
    return false;
  }
  if (computedUtxoRoot !== block.header.utxoTxRoot) {
    console.warn(`Rejected block height=${block.header.height}: utxoTxRoot mismatch`);
    abortBlockJournal();
    return false;
  }

  // 5. Verify coinbase reward matches emission schedule
  const expectedReward = computeBlockReward(block.header.height);
  const totalCoinbase = block.utxoTxTree.coinbaseOutputs.reduce((sum, o) => sum + o.value, 0n);
  if (totalCoinbase !== expectedReward) {
    console.warn(
      `Rejected block height=${block.header.height}: coinbase value ${totalCoinbase} != expected ${expectedReward}`,
    );
    abortBlockJournal();
    return false;
  }

  // 5b. Verify coinbase maturity locks
  //
  // The value check above says nothing about *when* the credits become
  // spendable, and each output's `lockedUntilBlock` travels into `mintCredits`
  // below exactly as the producer wrote it — so an unchecked `0` mints a
  // coinbase spendable in the block that created it, bypassing the 720-block
  // maturity delay entirely. The lock is a pure function of height (MINING
  // contract, invariant 3); the gossip validator's `>= height` bound is both
  // weaker than that and absent from the sync/reorg path.
  const expectedLock = block.header.height + CREDIT_MINER_REWARD_DELAY;
  for (const out of block.utxoTxTree.coinbaseOutputs) {
    if (out.lockedUntilBlock !== expectedLock) {
      console.warn(
        `Rejected block height=${block.header.height}: coinbase lockedUntilBlock ` +
        `${out.lockedUntilBlock} != expected ${expectedLock}`,
      );
      abortBlockJournal();
      return false;
    }
  }

  // 5. Verify epoch tally results (before storing the block)
  // The Merkle root commits to epochTallyResults, so they can't be
  // fabricated.  But we must also verify the results are correct for
  // the current UTXO state — a malicious miner could commit to valid
  // (Merkle-matching) but incorrect (state-divergent) results.
  //
  // Compared canonically: the miner's key order is its own gossip/row order,
  // and it arrives here through a CBOR round-trip that preserves it, so an
  // insertion-order compare rejects logically identical tallies (audit C-6).
  if (block.utxoTxTree.epochTallyResults) {
    const localTally = computeEpochTally(block.header.height);
    const blockRewards = canonicalRewardsJson(block.utxoTxTree.epochTallyResults.rewards);
    const localRewards = canonicalRewardsJson(localTally.rewards);
    if (blockRewards !== localRewards) {
      console.warn(
        `Rejected block height=${block.header.height}: epoch tally mismatch`,
      );
      abortBlockJournal();
      return false;
    }
  }

  // 6. Store the block
  storeCreateOrderingBlock(block);

  // 6. Clear the local mining template (this height is taken)
  clearTemplate();

  // 7. Apply coinbase — mint credits for each output. The store choke point
  // journals both the pre-existing boxes the mint merges in and the new box.
  for (const out of block.utxoTxTree.coinbaseOutputs) {
    mintCredits(out.owner, out.value, block.header.height, out.lockedUntilBlock);
  }

  // 7. Confirm sub-blocks — create placeholders if post doesn't exist
  //
  // Entry-vs-post verification (H-3): `author` and `parentRefs` are both
  // postId-preimage fields, so any node holding the content can check the
  // block's claim against it. Nodes that do reject a lying entry, which keeps
  // it out of the canonical chain for everyone; a node lacking the content
  // accepts the entry as claimed and inherits the guarantee through PoW weight.
  // Unchecked, a producer could graft a victim's post under their own root (via
  // parentRefs) or claim its authorship outright — and then prune it "as author".
  for (let i = 0; i < block.subBlockTree.subBlockEntries.length; i++) {
    const entry = block.subBlockTree.subBlockEntries[i]!;
    const subBlockId = entry.postId;

    const localPost = getPost(subBlockId);
    if (!localPost) {
      // Content hasn't arrived — record the claim, verify it if it ever does.
      insertPostPlaceholder(subBlockId, entry.parentRefs);
    } else if ('content' in localPost && localPost.content !== '') {
      // Real content (not a placeholder, not a stump) — the claim is checkable.
      const realAuthor = Buffer.from(localPost.author).toString('hex');
      if (entry.author !== realAuthor) {
        console.warn(
          `Rejected block height=${block.header.height}: subBlockEntry author ` +
          `mismatch for ${subBlockId}`,
        );
        abortBlockJournal();
        return false;
      }
      const realParents = localPost.parentRefs;
      const parentsMatch =
        Array.isArray(entry.parentRefs) &&
        entry.parentRefs.length === realParents.length &&
        entry.parentRefs.every((ref, j) => ref === realParents[j]);
      if (!parentsMatch) {
        console.warn(
          `Rejected block height=${block.header.height}: subBlockEntry parentRefs ` +
          `mismatch for ${subBlockId}`,
        );
        abortBlockJournal();
        return false;
      }
    }

    try {
      confirmPost(subBlockId, block.header.height);
    } catch (err) {
      console.warn(`Failed to confirm sub-block ${subBlockId}: ${String(err)}`);
    }
  }

  // Still remove confirmed entries from local mempool (if we have them).
  // One DELETE keyed by subblock_id — the former fetch-1000-and-find loop
  // silently stopped removing entries past row 1000 (audit M-8, bookkeeping
  // only: those entries lingered until expiry, no consensus effect).
  removeSubBlockEntries(block.subBlockTree.subBlockRefs);

  // 8. Compute DAG scores and evaluate canonical tip
  if (dagService) {
    let bestScore = 0;
    let bestId: string | null = null;

    for (const entry of block.subBlockTree.subBlockEntries) {
      let maxParent = 0;
      for (const pid of entry.parentRefs) {
        const ps = dagService.getScore(pid);
        if (ps !== null && ps > maxParent) {
          maxParent = ps;
        }
      }
      const score = maxParent + 1; // uniform weight: ownWork = 1
      dagService.saveScore(entry.postId, score);

      if (score > bestScore) {
        bestScore = score;
        bestId = entry.postId;
      }
    }

    if (bestId !== null) {
      try {
        const plan = dagService.buildReorgPlan(bestId, bestScore);
        if (plan) {
          dagService.switchToBranch(plan);
        }
      } catch (err) {
        console.error(`DagService reorg evaluation failed: ${String(err)}`);
      }
    }
  }

  // 8b. Populate block_topology from this block's subBlockEntries
  // Consensus data only (verified against local content above where we hold it)
  // — this, not dag_posts.author, is the authority for prune authorization.
  for (const entry of block.subBlockTree.subBlockEntries) {
    insertBlockTopology(entry.postId, entry.parentRefs, entry.author, block.header.height);
  }

  // 8c. Process prune entries from this block
  // Six verification + settlement steps per entry:
  //   1. Bind authorId to the root's consensus-recorded author (block_topology)
  //   2. Verify Ed25519 author signature over (rootPostHash || subtreeMerkleRoot)
  //   3. Verify postId set against block_topology (deterministic, no DAG walk)
  //   4. Verify Merkle root from entry.subtreePostIds
  //   5. Settle UTXO — consume PostLockBox + LikeBox, mint refund karma
  //   6. Prune DAG content, insert simplified Stump for historical record
  for (const entry of block.subBlockTree.pruneEntries) {
    // 1. Authorship binding (H-3)
    //
    // The signature check below proves the entry was signed *by* authorId; it
    // says nothing about authorId being the root's author. Without this bind,
    // any miner signs blake2b(root ‖ merkleRoot) with their own key and prunes
    // an arbitrary victim's subtree network-wide. block_topology is the
    // authority — it is built from block data alone, so a node that synced from
    // ordering blocks and holds no DAG content reaches the same verdict. A root
    // no applied block has confirmed has no recorded author and is not prunable
    // (this also forecloses the unconfirmed-root/empty-subtree edge).
    //
    // First, before any Buffer.from on adversarial fields: it is the cheapest
    // check and the only total one.
    const recordedAuthor =
      typeof entry.rootPostHash === 'string' ? getTopologyAuthor(entry.rootPostHash) : null;
    // authorId is UserId (raw 32 bytes) at runtime — CBOR preserves the bytes.
    const claimedAuthor =
      entry.authorId instanceof Uint8Array
        ? Buffer.from(entry.authorId).toString('hex')
        : null;
    if (recordedAuthor === null || recordedAuthor !== claimedAuthor) {
      console.error(
        `Block ${block.header.height}: prune authorId does not match the ` +
        `recorded author of ${entry.rootPostHash}`,
      );
      abortBlockJournal();
      return false;
    }

    // 2. Verify authorization
    const rootBytes = Buffer.from(entry.subtreeMerkleRoot);
    const payload = createHash('blake2b512')
      .update(entry.rootPostHash)
      .update(rootBytes)
      .digest()
      .subarray(0, 32);

    const authorKeyBytes = Buffer.from(entry.authorId);
    const keyObject = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: authorKeyBytes.toString('base64url'),
      },
      format: 'jwk',
    });

    const sigBytes = Buffer.from(entry.authorSignature);
    if (!verify(null, payload, keyObject, sigBytes)) {
      console.error(`Block ${block.header.height}: invalid prune signature for ${entry.rootPostHash}`);
      abortBlockJournal();
      return false;
    }

    // 3. Verify postId set against block_topology
    const topologyIds = getSubtreeTopology(entry.rootPostHash);
    const entryIds = new Set(entry.subtreePostIds);
    if (topologyIds.size !== entryIds.size ||
        ![...topologyIds].every(id => entryIds.has(id))) {
      console.error(`Block ${block.header.height}: prune postId set mismatch for ${entry.rootPostHash}`);
      abortBlockJournal();
      return false;
    }

    // 4. Verify Merkle root
    const leaves = [...entry.subtreePostIds]
      .sort()
      .map(id => leafHash('stump', hexToBuf(id)));
    const computedRoot = Buffer.from(buildMerkleRoot(leaves)).toString('hex');
    const entryRoot = Buffer.from(entry.subtreeMerkleRoot).toString('hex');
    if (computedRoot !== entryRoot) {
      console.error(`Block ${block.header.height}: prune Merkle root mismatch for ${entry.rootPostHash}`);
      abortBlockJournal();
      return false;
    }

    // 5. Settle UTXO — deterministic from post IDs
    try {
      settlePruneUtxo(entry.subtreePostIds, block.header.height);
    } catch (err) {
      console.error(`Block ${block.header.height}: prune settlement failed for ${entry.rootPostHash}: ${String(err)}`);
      abortBlockJournal();
      return false;
    }

    // 6. Prune DAG content (when present)
    try {
      pruneSubtree(entry.rootPostHash);
      // Insert simplified Stump for historical record
      insertStump({
        rootPostHash: entry.rootPostHash,
        authorId: entry.authorId,
        replyCount: entry.subtreePostIds.length - 1, // exclude root
        upvoteCount: 0, // can be derived from like boxes if needed
        trigger: entry.trigger,
        protocolVersion: PROTOCOL_VERSION,
        compactedAtBlockHeight: block.header.height,
      });
    } catch (err) {
      console.warn(`Failed to prune DAG subtree for ${entry.rootPostHash}: ${String(err)}`);
      // Non-fatal — DAG content may not be present
    }
  }

  // 9. Standalone like boxes are tallied by computeEpochTally at epoch
  // boundaries.  The computation was verified before block storage (§5);
  // here we apply the karma mints and the UTXO/bookkeeping side effects.

  // 10. Apply epoch tally results
  if (block.utxoTxTree.epochTallyResults) {
    const tally = computeEpochTally(block.header.height);
    const rewards = tally.rewards;

    for (const postId of Object.keys(rewards)) {
      const reward = rewards[postId];
      if (!reward) continue;

      // Author reward — the choke point journals the merge-consumed
      // pre-existing karma boxes and the minted box.
      if (reward.authorReward > 0n) {
        const post = getPost(postId);
        if (post && 'author' in post) {
          mintKarma(post.author, reward.authorReward, block.header.height);
        }
      }

      // Liker refunds (locked likes that met threshold)
      for (const likerId of Object.keys(reward.likerRefunds)) {
        const refund = reward.likerRefunds[likerId];
        if (refund !== undefined && refund !== 0n) {
          const likerBytes = new Uint8Array(Buffer.from(likerId, "hex"));
          mintKarma(likerBytes, refund, block.header.height);
        }
      }

      // Post lock karma unlocked
      if (reward.postLockKarmaUnlocked && reward.postLockKarmaUnlocked > 0n) {
        const post = getPost(postId);
        if (post && 'author' in post) {
          mintKarma(post.author, reward.postLockKarmaUnlocked, block.header.height);
        }
      }
    }

    // Apply side effects that were previously only run on the miner's node.
    // These must run on every node so the UTXO state stays consistent.

    // Mark like boxes as tallied (prevents double-counting in later epochs)
    if (tally.talliedLockedLikeBoxIds.length > 0) {
      markLikeBoxesTallied(tally.talliedLockedLikeBoxIds);
    }

    // Mark free likes as processed
    if (tally.processedFreeLikeIds.length > 0) {
      markFreeLikesProcessed(tally.processedFreeLikeIds);
    }

    // Consume old post lock boxes and insert replacement boxes
    for (const boxId of tally.consumedPostLockBoxIds) {
      consumeBox(boxId, block.header.height);
    }
    for (const newBox of tally.newPostLockBoxes) {
      insertBox(newBox);
    }
  }

  // 11. Apply UTXO transactions from the block.
  //
  // Two distinct failure modes, deliberately handled differently:
  //
  //  - Inputs not present yet → defer and retry. A tx may consume a box
  //    created by an earlier tx in the same block, and block order does not
  //    have to be dependency order, so the loop makes repeated passes until it
  //    stops making progress. Txs whose inputs never appear are skipped.
  //
  //  - Inputs present but the tx is invalid → reject the whole block. Validator
  //    selection is permissionless PoW, so the producer is untrusted and
  //    nothing about an embedded tx may be assumed: it may never have passed
  //    pool entry or relay validation on any node. Once a tx's inputs are all
  //    present it is fully decidable, so it is re-validated here in full —
  //    signatures, guards, transitions, conservation — and a failure means the
  //    block itself is malformed. A valid block cannot contain an invalid tx.
  const utxoDeps = {
    getBox,
    insertBox,
    consumeBox,
    getKarmaBox,
    runInTransaction: (fn: () => void) => {
      getDb().transaction(fn)();
    },
    // The faucet grant is the one transaction allowed to move karma between
    // owners, and `checkTransitions` recognises it by the system box. Without
    // this the re-validation below would reject every block carrying a grant.
    // Consensus-safe: the system keypair is a protocol constant, so every node
    // classifies the same box the same way.
    isSystemBox: (boxId: string): boolean => {
      const sysKey = getSystemKeypair();
      if (!sysKey) return false;
      const box = getBox(boxId);
      if (!box || box.boxType !== 'karma') return false;
      return Buffer.from((box as import('@dagsocial/types').KarmaBox).owner).equals(
        Buffer.from(sysKey.publicKey),
      );
    },
  };
  const pendingEntries = getPendingEntries(1000);

  // Decode and validate all txs first (CBOR / txId checks are fatal).
  interface QueuedTx {
    txId: string;
    tx: UtxoTransaction;
    outputs: AnyBox[];
  }
  const queue: QueuedTx[] = [];
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

    const decodedTxId = computeTxId(tx);
    if (decodedTxId !== txId) {
      console.warn(`Rejected UTXO tx ${txId}: CBOR decodes to ${decodedTxId}`);
      continue;
    }

    const outputs = tx.outputs.map((box) => ({
      ...box,
      id: computeBoxId(box),
    })) as AnyBox[];
    queue.push({ txId, tx, outputs });
  }

  // Multi-pass: try to apply txs, retrying those whose inputs aren't
  // available yet (may have been created by an earlier tx in this block).
  const MAX_PASSES = 20;
  for (let pass = 0; pass < MAX_PASSES && queue.length > 0; pass++) {
    const remaining: QueuedTx[] = [];
    let applied = 0;

    for (const item of queue) {
      const allInputsExist = item.tx.inputs.every((id) => getBox(id) !== null);
      if (!allInputsExist) {
        remaining.push(item);
        continue;
      }

      // Every input is present, so the verdict cannot change on a later pass:
      // full re-validation, and anything it rejects rejects the block. Testing
      // presence first is what keeps the two cases apart — the only reason
      // validateTx could still fail on liveness is a tx that lists the same
      // input twice, which is malformed, not deferrable.
      const revalidated = validateTx(utxoDeps, item.tx, block.header.height);
      if (!revalidated.valid) {
        console.warn(
          `Rejected block height=${block.header.height}: embedded UTXO tx ` +
          `${item.txId} failed re-validation: ${revalidated.error}`,
        );
        abortBlockJournal();
        return false;
      }

      // Detect vouch unvouch before the VouchBox is consumed
      for (const inputId of item.tx.inputs) {
        const inputBox = getBox(inputId);
        if (inputBox && inputBox.boxType === 'vouch') {
          const vb = inputBox as import('@dagsocial/types').VouchBox;
          if (item.tx.outputs.length === 0) {
            // The store hook records the insertion side-record (including any
            // replaced escrow row) — a second push here would double-record.
            insertVouchCooldown(
              vb.voucherId,
              vb.targetId,
              block.header.height + VOUCH_COOLDOWN_BLOCKS,
              VOUCH_KARMA_AMOUNT,
            );
          }
          break;
        }
      }

      applyTx(utxoDeps, item.tx, item.outputs, block.header.height);
      applied++;

      // Remove from local mempool if present
      const mempoolEntry = pendingEntries.find((e) => {
        if (e.entryType !== 'utxo_tx' || !e.utxoTxCbor) return false;
        const et = decodeTx(e.utxoTxCbor);
        return computeTxId(et) === item.txId;
      });
      if (mempoolEntry) removeEntry(mempoolEntry.rowid);

      // Box mutations are journaled by the store choke point; the tx itself
      // is kept for mempool re-insertion on reorg.
      recordAppliedUtxoTx(item.txId, encodeTx(item.tx));
    }

    if (applied === 0) {
      // No progress — remaining txs have inputs that truly don't exist.
      for (const item of remaining) {
        console.warn(
          `UTXO tx ${item.txId} in block ${block.header.height}: ` +
          `input liveness check failed after ${pass + 1} passes, skipping`,
        );
      }
      break;
    }
    queue.length = 0;
    queue.push(...remaining);
  }

  if (queue.length > 0) {
    console.warn(
      `Block ${block.header.height}: ${queue.length} UTXO tx(s) could not be applied ` +
      `after ${MAX_PASSES} passes`,
    );
  }

  // 12. Apply periodic karma decay
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
  // Its box mutations flow through the deps' store consumeBox/insertBox and
  // are journaled at the choke point; the per-owner return value is unused
  // here (the decay service keeps it for its own tests).
  applyKarmaDecay(decayDeps, block.header.height, {
    staleThresholdBlocks: config.karmaStaleThresholdBlocks,
    decayIntervalBlocks: config.karmaDecayIntervalBlocks,
    decayAmount: config.karmaDecayAmount,
    karmaMinimum: config.karmaMinimum,
  });

  // 12b. Process vouch cooldowns
  processVouchCooldowns(block.header.height);

  // 13. AVL state root update (skipped if prover not initialized)
  //
  // Nothing mutates boxes past §12b, so the journal is complete: close it and
  // derive the prover feed from its mutation log. An insert later followed by
  // a remove for the same boxId is a box that never existed outside this
  // block — the pair nets out (drop both); survivors keep first-occurrence
  // order. Created-box bytes come from the journal's recorded payload, never
  // a store re-fetch: getBox returns null for a created-then-consumed box and
  // used to silently drop it. (Canonical boxId ordering is Spec B P2.)
  const journal = finishBlockJournal();
  const handle = tryGetAvlProver();
  if (handle) {
    const cancelled = new Set<number>();
    const pendingInsertIndex = new Map<string, number>();
    for (let i = 0; i < journal.mutations.length; i++) {
      const m = journal.mutations[i]!;
      if (m.op === 'insert') {
        pendingInsertIndex.set(m.boxId, i);
      } else {
        const insertIdx = pendingInsertIndex.get(m.boxId);
        if (insertIdx !== undefined) {
          cancelled.add(insertIdx);
          cancelled.add(i);
          pendingInsertIndex.delete(m.boxId);
        }
      }
    }
    const consumed: string[] = [];
    const created: AnyBox[] = [];
    for (let i = 0; i < journal.mutations.length; i++) {
      if (cancelled.has(i)) continue;
      const m = journal.mutations[i]!;
      if (m.op === 'remove') consumed.push(m.boxId);
      else created.push(m.box!);
    }

    const computedDigest = applyBlockMutations(handle.prover, consumed, created);

    // Verify against block header (gated). The prover is restored by the
    // funnel's single rollback point, not here.
    if (config.verifyStateRoot) {
      const expectedHex = Buffer.from(computedDigest).toString('hex');
      if (block.header.stateRoot !== expectedHex) {
        console.warn(
          `stateRoot mismatch at height ${block.header.height}: ` +
          `computed=${expectedHex.slice(0, 16)}... ` +
          `header=${block.header.stateRoot.slice(0, 16)}...`,
        );
        abortBlockJournal();
        return false;
      }
    }

    // Checkpoint prover state at this height
    checkpointProver(handle, block.header.height);
  }

  // 14. Persist journal and purge old ones
  insertBlockJournal(journal);
  purgeOldJournals(block.header.height - 20);

  console.log(`Applied ordering block height=${block.header.height} hash=${validation.blockHash(block.header)} (${block.subBlockTree.subBlockRefs.length} sub-blocks)`);
  return true;
}
