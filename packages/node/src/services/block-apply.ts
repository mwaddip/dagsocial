import { createHash, createPublicKey, verify } from 'crypto';
import * as validation from '@dagsocial/validation';
import { mintKarma } from './karma.js';
import { mintCredits } from './credits.js';
import {
  coinbaseContext,
  likePayoutContext,
  postlockRemainderContext,
  postlockUnlockContext,
  vouchSettleContext,
  mintTxIdFor,
  MINT_OUTPUT_INDEX,
} from '../mint-provenance.js';
import { applyKarmaDecay } from './decay.js';
import {
  getMaturedVouchCooldowns,
  deleteVouchCooldown,
  insertVouchCooldown,
  hasActiveVouchCooldown,
} from '../store/vouch-cooldowns.js';
import { VOUCH_COOLDOWN_BLOCKS } from '@dagsocial/types';
import { settlePruneUtxo } from './settle-prune-utxo.js';
import type { DecayDeps } from './decay.js';
import { config } from '../config.js';
import { computeBlockReward, computeSubBlockRoot, computeUtxoTxRoot, clearTemplate } from './block-creator.js';
import { expectedTarget } from './difficulty.js';
import { DagService } from './dag-service.js';
import { applyTx, materializeOutput, validateTx } from './utxo-engine.js';
import { getSystemKeypair } from '../store/system.js';
import {
  getKarmaBox,
  getKarmaBoxes,
  getKarmaValue,
  getPost,
  insertStump,
  insertPostPlaceholder,
  insertBox,
  getBox,
  getBoxByProvenance,
  consumeBox,
  confirmPost,
  pruneSubtree,
  getCurrentHeight,
  createOrderingBlock as storeCreateOrderingBlock,
  getOrderingBlock,
  getPendingEntries,
  removeEntry,
  removeSubBlockEntries,
  insertBlockTopology,
  getSubtreeTopology,
  getTopologyAuthor,
  getIdentityRecord,
  putIdentityRecord,
  hasLikeRecord,
  insertLikeRecord,
  getLikeRecordCount,
  getPostLockBox,
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
import type { BlockJournal } from '../store/journal.js';
import { tryGetAvlProver, applyBlockMutations, checkpointProver } from '../state/avl-prover.js';
import type { RecordPut } from '../state/avl-prover.js';
import {
  encodeTx,
  decodeTx,
  PROTOCOL_VERSION,
  CREDIT_MINER_REWARD_DELAY,
  LIKES_PER_KARMA_PAYOUT,
  POST_LOCK_UNLOCK_PER_LIKES,
  computeTxId,
  computeBoxId,
  leafHash,
  buildMerkleRoot,
  hexToBuf,
} from '@dagsocial/types';
import type {
  AnyBox,
  KarmaBox,
  OrderingBlock,
  PostLockBox,
  UtxoTransaction,
} from '@dagsocial/types';

function processVouchCooldowns(currentHeight: number): void {
  const matured = getMaturedVouchCooldowns(currentHeight);
  for (const row of matured) {
    mintKarma(
      row.voucherId,
      row.karmaAmount,
      currentHeight,
      vouchSettleContext(row.voucherId, row.targetId),
    );
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
 * (coinbase mint, sub-block confirmation, prune settlement, UTXO transactions,
 * per-block like settlement, decay) lives in one SQLite transaction. Any rejection — at any
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
  // record automatically, and every rejection path below aborts it. The
  // lifecycle is owned here rather than by the mutation phase, so the
  // speculative caller (`computePostBlockStateRoot`) records identically.
  beginBlockJournal(block.header.height);

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

  // 6. Store the block
  storeCreateOrderingBlock(block);

  // 6. Clear the local mining template (this height is taken)
  clearTemplate();

  // 7–12b. Mutation phase — the block's state transition, run verbatim (at an
  // explicitly passed height) by the block creator to obtain the post-block
  // stateRoot before mining (H-6). It never touches the journal lifecycle, so
  // its rejections are turned into an abort here.
  if (!applyMutationPhase(block, block.header.height, dagService)) {
    abortBlockJournal();
    return false;
  }

  // 13. AVL state root update (skipped if prover not initialized)
  //
  // Nothing mutates boxes past §12b, so the journal is complete: close it and
  // derive the prover feed from its mutation log.
  const journal = finishBlockJournal();
  const handle = tryGetAvlProver();
  if (handle) {
    const { consumed, created, recordPuts } = proverFeedFromJournal(journal);
    const computedDigest = applyBlockMutations(handle.prover, consumed, created, recordPuts);

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

/**
 * The prover feed a finished journal implies — the one derivation both the
 * apply commit (§13) and the creator's speculative run use, so producer and
 * verifier can never disagree by construction.
 *
 * An insert later followed by a remove for the same boxId is a box that never
 * existed outside this block: the pair nets out (drop both); survivors keep
 * first-occurrence order, which `applyBlockMutations` then replaces with the
 * canonical one (M-12). Created-box bytes come from the journal's recorded
 * payload, never a store re-fetch: `getBox` returns null for a created-then-
 * consumed box and used to silently drop it.
 */
function proverFeedFromJournal(
  journal: BlockJournal,
): { consumed: string[]; created: AnyBox[]; recordPuts: RecordPut[] } {
  // Netting is per-kind and the two rules do NOT share a code path: boxes
  // cancel insert+remove pairs; records collapse to the last write per key.
  const cancelled = new Set<number>();
  const pendingInsertIndex = new Map<string, number>();
  for (let i = 0; i < journal.mutations.length; i++) {
    const m = journal.mutations[i]!;
    if (m.kind !== 'box') continue;
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
  // Insertion-ordered by key, so the last write to a key wins while the map
  // itself stays deterministic. Collapsing must happen here, where journal
  // application order is still authoritative: record puts are not commutative,
  // so `applyBlockMutations`' sort-by-key could not recover which write is
  // last. The journal keeps both entries regardless — rollback needs the
  // first's `replaced`.
  const recordByKey = new Map<string, RecordPut>();
  for (let i = 0; i < journal.mutations.length; i++) {
    if (cancelled.has(i)) continue;
    const m = journal.mutations[i]!;
    switch (m.kind) {
      case 'box':
        if (m.op === 'remove') consumed.push(m.boxId);
        else created.push(m.box!);
        break;
      case 'record':
        recordByKey.set(m.key, { key: m.key, record: m.record });
        break;
      default: {
        // Compile-time exhaustiveness, deliberately not a runtime throw: a new
        // committed entity kind that nobody feeds to the prover is silently
        // absent from the stateRoot, and no test can catch that — producer and
        // verifier omit it identically and agree on a digest over incomplete
        // state. This assignment is the only enforcement that invariant has.
        const _exhaustive: never = m;
        void _exhaustive;
        break;
      }
    }
  }
  return { consumed, created, recordPuts: [...recordByKey.values()] };
}

/**
 * Carries the speculative run's result out through the throw that forces
 * better-sqlite3 to roll the transaction back — the value and the rollback are
 * the same event, so neither can happen without the other.
 */
class SpeculativeRollback extends Error {
  constructor(readonly digestHex: string) {
    super('speculative state-root run rolled back');
  }
}

/**
 * What the speculative state-root run answered. The two non-computed arms are
 * deliberately not one `null`: they demand opposite reactions from the block
 * creator, and conflating them is exactly the P2-B 1c defect — a node mining
 * a body its own mutation phase had already rejected.
 */
export type StateRootSpeculation =
  /** The post-block digest the header must commit to. Mine over it. */
  | { kind: 'computed'; stateRoot: string }
  /** No usable prover — test-only; the caller writes `EMPTY_STATE_ROOT`. */
  | { kind: 'no-prover' }
  /** The body is invalid. Producing this block is forbidden. */
  | { kind: 'body-rejected' };

/**
 * The post-block AVL digest a candidate block's header must commit to as
 * `stateRoot` (H-6; NODE_INTERFACE "Post-block stateRoot"), as a
 * `StateRootSpeculation`.
 *
 * PoW covers the header, so the producer has to know this digest *before*
 * mining, and the only way to know it without a second implementation of the
 * state transition is to run the block's own body. That happens here: the
 * mutation phase, verbatim, at the block's height, inside a SQLite transaction
 * that is always rolled back. No `DagService` (its canonical-branch updates
 * are in-memory and would survive the rollback; they touch no UTXO box, so the
 * digest is unaffected), no block storage, no `clearTemplate`, no journal
 * persistence, no prover checkpoint.
 *
 * SQLite rollback does not reach the prover's in-memory tree, so the digest is
 * snapshotted up front and restored explicitly afterwards — the same asymmetry
 * the apply funnel handles for rejected blocks.
 *
 * The candidate carries a placeholder header (`powNonce` 0, empty signature):
 * the mutation phase reads neither, and takes its height as an argument.
 *
 * An unexpected throw maps to `body-rejected`, not to the proverless fallback:
 * the apply funnel treats the same throw as a rejection of the block, so a
 * body that crashes speculation is a body no node — this one included —
 * will apply.
 */
export function computePostBlockStateRoot(
  block: OrderingBlock,
  height: number,
): StateRootSpeculation {
  const handle = tryGetAvlProver();
  if (!handle) return { kind: 'no-prover' };
  const snapshot = handle.prover.digest();
  if (!snapshot) return { kind: 'no-prover' };

  try {
    getDb().transaction((): void => {
      beginBlockJournal(height);
      if (!applyMutationPhase(block, height, undefined)) throw new BlockRejected();
      const { consumed, created, recordPuts } = proverFeedFromJournal(finishBlockJournal());
      // The digest rides out on the throw: nothing this run did may survive.
      throw new SpeculativeRollback(
        Buffer.from(
          applyBlockMutations(handle.prover, consumed, created, recordPuts),
        ).toString('hex'),
      );
    })();
    throw new Error('unreachable: speculative run must exit via throw');
  } catch (err) {
    if (err instanceof SpeculativeRollback) {
      return { kind: 'computed', stateRoot: err.digestHex };
    }
    if (err instanceof BlockRejected) {
      console.warn(
        `stateRoot speculation at height ${height}: the body was rejected by its ` +
        `own mutation phase — the block cannot be produced`,
      );
      return { kind: 'body-rejected' };
    }
    console.error(`stateRoot speculation failed at height ${height}: ${String(err)}`);
    return { kind: 'body-rejected' };
  } finally {
    // The transaction is rolled back by the time this runs (better-sqlite3
    // issues ROLLBACK before re-throwing). These undo what it cannot reach.
    abortBlockJournal();
    const current = handle.prover.digest();
    if (!current || !Buffer.from(current).equals(Buffer.from(snapshot))) {
      handle.prover.rollback(snapshot);
    }
  }
}

/**
 * The block's state transition — everything between the header-dependent
 * validation and the commit (NODE_INTERFACE "Apply funnel: validation and
 * mutation phases").
 *
 * Height is a parameter rather than `block.header.height` because the block
 * creator runs this phase before its header exists, to compute the post-block
 * `stateRoot` it must commit to (H-6). The split is structural: there is no
 * "skip the checks" mode on the apply path, and the body-level rejections here
 * (prune verification, embedded-tx re-validation) reject on both paths
 * identically.
 *
 * Journal-lifecycle-free by contract: a journal is already open when this runs
 * and the caller finishes or aborts it, so both callers record the same way.
 */
function applyMutationPhase(
  block: OrderingBlock,
  height: number,
  dagService?: DagService,
): boolean {
  // All refs, independent of per-post confirm outcomes — same semantics as
  // the confirm loop in §7, which tolerates per-post failures.
  recordConfirmedSubBlocks([...block.subBlockTree.subBlockRefs]);

  // 7. Apply coinbase — mint credits for each output. The store choke point
  // journals both the pre-existing boxes the mint merges in and the new box.
  //
  // N mint events, not one N-output transaction: each output gets its own
  // subject and its own synthetic txId. That reflects what the code does — each
  // `mintCredits` call merges a *different* set of pre-existing credit boxes,
  // so the outputs share no input set and are not one transaction in any
  // meaningful sense (NODE_INTERFACE → "`index` is always 0 for mints").
  for (let i = 0; i < block.utxoTxTree.coinbaseOutputs.length; i++) {
    const out = block.utxoTxTree.coinbaseOutputs[i]!;
    mintCredits(out.owner, out.value, height, coinbaseContext(i), out.lockedUntilBlock);
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
          `Rejected block height=${height}: subBlockEntry author ` +
          `mismatch for ${subBlockId}`,
        );
        return false;
      }
      const realParents = localPost.parentRefs;
      const parentsMatch =
        Array.isArray(entry.parentRefs) &&
        entry.parentRefs.length === realParents.length &&
        entry.parentRefs.every((ref, j) => ref === realParents[j]);
      if (!parentsMatch) {
        console.warn(
          `Rejected block height=${height}: subBlockEntry parentRefs ` +
          `mismatch for ${subBlockId}`,
        );
        return false;
      }
    }

    try {
      confirmPost(subBlockId, height);
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
    insertBlockTopology(entry.postId, entry.parentRefs, entry.author, height);
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
        `Block ${height}: prune authorId does not match the ` +
        `recorded author of ${entry.rootPostHash}`,
      );
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
      console.error(`Block ${height}: invalid prune signature for ${entry.rootPostHash}`);
      return false;
    }

    // 3. Verify postId set against block_topology
    const topologyIds = getSubtreeTopology(entry.rootPostHash);
    const entryIds = new Set(entry.subtreePostIds);
    if (topologyIds.size !== entryIds.size ||
        ![...topologyIds].every(id => entryIds.has(id))) {
      console.error(`Block ${height}: prune postId set mismatch for ${entry.rootPostHash}`);
      return false;
    }

    // 4. Verify Merkle root
    const leaves = [...entry.subtreePostIds]
      .sort()
      .map(id => leafHash('stump', hexToBuf(id)));
    const computedRoot = Buffer.from(buildMerkleRoot(leaves)).toString('hex');
    const entryRoot = Buffer.from(entry.subtreeMerkleRoot).toString('hex');
    if (computedRoot !== entryRoot) {
      console.error(`Block ${height}: prune Merkle root mismatch for ${entry.rootPostHash}`);
      return false;
    }

    // 5. Settle UTXO — deterministic from post IDs
    try {
      settlePruneUtxo(entry.rootPostHash, entry.subtreePostIds, height);
    } catch (err) {
      console.error(`Block ${height}: prune settlement failed for ${entry.rootPostHash}: ${String(err)}`);
      return false;
    }

    // 6. Insert the Stump, then prune DAG content (when present)
    //
    // The stump is derived state — a projection of this verified entry — and
    // recording it is part of settlement: a node holding no DAG content for
    // the subtree records the same stump (NODE_INTERFACE "Stumps are derived
    // state"). Unconditional by construction: it must not sit behind any
    // content-dependent guard, so it runs before and outside the content
    // prune's try/catch.
    insertStump({
      rootPostHash: entry.rootPostHash,
      authorId: entry.authorId,
      replyCount: entry.subtreePostIds.length - 1, // exclude root
      upvoteCount: 0, // can be derived from like boxes if needed
      trigger: entry.trigger,
      protocolVersion: PROTOCOL_VERSION,
      compactedAtBlockHeight: height,
    });
    try {
      pruneSubtree(entry.rootPostHash);
    } catch (err) {
      console.warn(`Failed to prune DAG subtree for ${entry.rootPostHash}: ${String(err)}`);
      // Non-fatal — DAG content may not be present
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
    getBoxByProvenance,
    insertBox,
    consumeBox,
    getKarmaBox,
    // Bond settlement's unlock predicate reads the invitee's current summed
    // karma (P2-B phase 1). The store's getKarmaValue is the single
    // implementation shared with the pool and relay paths — a different read
    // here would be a consensus split, not a style difference (phase 1b).
    getKarmaValue,
    // The vouch cast's cooldown gate (P2-B phase 2) — same single-
    // implementation rule as getKarmaValue.
    hasActiveVouchCooldown,
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

    // `txId` here is the block's declared id, already checked byte-for-byte
    // against `computeTxId(tx)` above — so it is the real creating transaction,
    // not a re-derivation. Position in `tx.outputs` is the `index`.
    const outputs = tx.outputs.map((box, index) =>
      materializeOutput(box as AnyBox, txId, index),
    );
    queue.push({ txId, tx, outputs });
  }

  // P2-D per-block like accrual: in-memory, this invocation only — the
  // end-of-phase settlement (§11b) reads both maps. Local by design, so the
  // speculative (creator) run accrues and settles identically and its rollback
  // discards everything with it.
  const likesPerAuthor = new Map<string, number>(); // author hex → likes this block
  const likesPerPost = new Map<string, number>(); // post id → likes this block

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
      const revalidated = validateTx(utxoDeps, item.tx, height);
      if (!revalidated.valid) {
        console.warn(
          `Rejected block height=${height}: embedded UTXO tx ` +
          `${item.txId} failed re-validation: ${revalidated.error}`,
        );
        return false;
      }

      // P2-D like apply rules (NODE_INTERFACE "Per-block like settlement"):
      // re-checked at apply — consensus, not gateway courtesy — and BEFORE
      // applyTx, so a failing like never mutates state. Any failure rejects
      // the whole block, like any other invalid embedded tx.
      let likeToRecord: {
        targetPostId: string;
        likerId: Uint8Array;
        authorHex: string;
      } | null = null;
      if (item.tx.likeTarget !== undefined) {
        const targetPostId = item.tx.likeTarget;
        // Confirmed ⟺ a topology row exists, and its author — never
        // dag_posts.author — is who the like credits: placeholder rows carry
        // a zeroed author, and a like on a confirmed but content-less post
        // must credit the consensus-recorded author.
        const authorHex = getTopologyAuthor(targetPostId);
        if (authorHex === null) {
          console.warn(
            `Rejected block height=${height}: like tx ${item.txId} targets ` +
            `unconfirmed post ${targetPostId}`,
          );
          return false;
        }
        // Live at this height: likes on pruned posts are rejected by stated
        // rule — without it, dropping like-records at prune would reopen
        // duplicate likes on stumps. A pruned root comes back as a Stump
        // (no `content` field); a pruned non-root comes back as null (its
        // stump lookup misses); so anything but a Post rejects.
        const target = getPost(targetPostId);
        if (target === null || !('content' in target)) {
          console.warn(
            `Rejected block height=${height}: like tx ${item.txId} targets ` +
            `pruned or unknown post ${targetPostId}`,
          );
          return false;
        }
        // The liker is the karma inputs' owner, read from the input boxes —
        // never from the signature map. The gateway's one-signature rule is
        // gateway policy; a validator can embed a spare-signature like tx
        // directly, and it must still apply with the liker the owner state
        // names. validateTx above pinned every input to one karma owner, so
        // the first input names it.
        const likerId = (getBox(item.tx.inputs[0]!) as KarmaBox).owner;
        // One like per account per post, structurally: the key exists or it
        // does not. Applied likes earlier in this block already inserted
        // their record, so an intra-block duplicate fails here too.
        if (hasLikeRecord(targetPostId, likerId)) {
          console.warn(
            `Rejected block height=${height}: like tx ${item.txId} ` +
            `duplicates an existing like-record for ${targetPostId}`,
          );
          return false;
        }
        likeToRecord = { targetPostId, likerId, authorHex };
      }

      // Detect vouch unvouch before the VouchBox is consumed
      for (const inputId of item.tx.inputs) {
        const inputBox = getBox(inputId);
        if (inputBox && inputBox.boxType === 'vouch') {
          const vb = inputBox as import('@dagsocial/types').VouchBox;
          if (item.tx.outputs.length === 0) {
            // The store hook records the insertion side-record (including any
            // replaced escrow row) — a second push here would double-record.
            //
            // The escrow records the ACTUAL staked value, never the constant
            // (audit F-consensus-3): maturity re-mints exactly what the box
            // held, so the round trip is conservation-structural rather than
            // true by coincidence. With the cast pinned to VOUCH_KARMA_AMOUNT
            // the two agree for every post-pin vouch; a pre-pin box still
            // settles to what it actually locked.
            insertVouchCooldown(
              vb.voucherId,
              vb.targetId,
              height + VOUCH_COOLDOWN_BLOCKS,
              vb.value,
            );
          }
          // validateTx above pinned the unvouch shape to exactly one VouchBox
          // input (P2-B phase 4), so first-match is exhaustive, not lossy.
          break;
        }
      }

      applyTx(utxoDeps, item.tx, item.outputs, height);
      applied++;

      if (likeToRecord !== null) {
        // Journalled side-record (inverse: deleteLikeRecord), plus the
        // in-memory accrual §11b settles.
        insertLikeRecord(likeToRecord.targetPostId, likeToRecord.likerId, height);
        likesPerAuthor.set(
          likeToRecord.authorHex,
          (likesPerAuthor.get(likeToRecord.authorHex) ?? 0) + 1,
        );
        likesPerPost.set(
          likeToRecord.targetPostId,
          (likesPerPost.get(likeToRecord.targetPostId) ?? 0) + 1,
        );
      }

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
          `UTXO tx ${item.txId} in block ${height}: ` +
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
      `Block ${height}: ${queue.length} UTXO tx(s) could not be applied ` +
      `after ${MAX_PASSES} passes`,
    );
  }

  // 11b. Per-block like settlement (P2-D — NODE_INTERFACE "Per-block like
  // settlement"). Entirely derived — nothing rides in the block, so producer
  // and verifier cannot disagree on it. Order pinned by the contract:
  // embedded txs → author settlement → post-lock vesting → decay → vouch
  // cooldowns. Blocks with no likes run neither loop. All value arithmetic
  // bigint — a float intermediate is a consensus fork.
  const PAYOUT_X = BigInt(LIKES_PER_KARMA_PAYOUT);

  // Author settlement, ascending author-hex order (journal-order
  // canonicality; the mint ids are order-independent regardless).
  for (const authorHex of [...likesPerAuthor.keys()].sort()) {
    const author = new Uint8Array(Buffer.from(authorHex, 'hex'));
    const record = getIdentityRecord(author);
    const total = (record?.likeCarry ?? 0n) + BigInt(likesPerAuthor.get(authorHex)!);
    const paid = (total / PAYOUT_X) * (PAYOUT_X - 1n);
    const carry = total % PAYOUT_X;
    if (paid > 0n) {
      // One mint per author per block; per X likes the likers burned X, the
      // author receives X−1, 1 is gone — the deflation dial. The mint's
      // insertBox bumps the author's lastActivityBlock — known,
      // contract-recorded karma-econ behaviour (ARCHITECTURE §Likes), kept
      // as-is until the karma-economics track redefines the trigger.
      mintKarma(author, paid, height, likePayoutContext(author));
    }
    // Unconditional carry write, even at paid = 0: the carry changed, and the
    // record is in the stateRoot — two nodes can never disagree on the next
    // payout undetected. Re-read after the mint so the activity bump the
    // mint's choke point just wrote is preserved; a missing record means
    // maximally stale ({0, 0}), never "skip this owner".
    const after = getIdentityRecord(author);
    putIdentityRecord(author, {
      lastActivityBlock: after?.lastActivityBlock ?? 0,
      lastDecayBlock: after?.lastDecayBlock ?? 0,
      likeCarry: carry,
    });
  }

  // Post-lock vesting, ascending post-id order, for posts liked this block
  // that hold a live PostLockBox: the retired epoch schedule evaluated per
  // block.
  for (const postId of [...likesPerPost.keys()].sort()) {
    const lockBox = getPostLockBox(postId);
    if (!lockBox || !lockBox.id) continue;
    const totalLikes = BigInt(getLikeRecordCount(postId)); // lifetime, live post
    const alreadyUnlocked = lockBox.originalValue - lockBox.value;
    const shouldUnlock = totalLikes / BigInt(POST_LOCK_UNLOCK_PER_LIKES);
    const unlockable = shouldUnlock - alreadyUnlocked;
    const toUnlock = lockBox.value < unlockable ? lockBox.value : unlockable;
    if (toUnlock <= 0n) continue;
    consumeBox(lockBox.id, height);
    // The unlocked karma returns to the lock's owner — the author who locked
    // it: committed value-layer state, not a dag_posts read.
    mintKarma(lockBox.owner, toUnlock, height, postlockUnlockContext(postId));
    const remaining = lockBox.value - toUnlock;
    if (remaining > 0n) {
      // A fully-unlocked lock is consumed without a remainder. One remainder
      // per post per block, so (height, 'postlock-remainder', postId) cannot
      // repeat.
      const remainder: PostLockBox = {
        boxType: 'post_lock',
        value: remaining,
        originalValue: lockBox.originalValue,
        owner: lockBox.owner,
        targetPostId: postId,
        guard: 'block_apply',
        txId: mintTxIdFor(postlockRemainderContext(postId), height),
        index: MINT_OUTPUT_INDEX,
      };
      remainder.id = computeBoxId(remainder);
      insertBox(remainder);
    }
  }

  // 12. Apply periodic karma decay
  const decayDeps: DecayDeps = {
    getKarmaBoxes: (owner: Uint8Array) => getKarmaBoxes(owner),
    consumeBox,
    insertBox,
    // The decay clock now lives in committed state (Spec G D4), so decay reads
    // and writes it through the same injected seam as its box access. The store
    // primitives journal on their own — nothing here keeps parallel bookkeeping.
    getIdentityRecord,
    putIdentityRecord,
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
  applyKarmaDecay(decayDeps, height, {
    staleThresholdBlocks: config.karmaStaleThresholdBlocks,
    decayIntervalBlocks: config.karmaDecayIntervalBlocks,
    decayAmount: config.karmaDecayAmount,
    karmaMinimum: config.karmaMinimum,
  });

  // 12b. Process vouch cooldowns
  processVouchCooldowns(height);

  return true;
}
