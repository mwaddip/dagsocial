// ---------------------------------------------------------------------------
// P2-B phase 3 — a credit transfer is a transaction (audit F-consensus-7).
//
// These are the inverted before-legs: on the pre-fix HEAD, `sendCredits`
// applied `consumeBox`/`insertBox` directly with no block and no open journal,
// so a transfer entered no block, produced no journal entries, never reached
// the AVL feed — and a node that rebuilt its prover from `getUnspentBoxes()`
// at restart computed a different `stateRoot` than the network and rejected
// every later block (measured in the before-leg run: live digest b08e6036…,
// restart digest e4a33dfd…, honest block 3 rejected with a stateRoot
// mismatch). The fix pools the transfer instead; settlement is the block's
// job, so the journal, the AVL feed and a restart-rebuild all see it.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi } from 'vitest';
import { unlinkSync } from 'fs';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'crypto';
import {
  computeBoxId,
  computePostId,
  computeTxId,
  encodePost,
  selectBoxes,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type {
  CandidateOf,
  CreditBox,
  UtxoTransaction,
} from '@dagsocial/types';
import type Database from 'better-sqlite3';
import type { BlockJournal } from '../../src/store/journal.js';
import {
  fixtureProvenance,
  makeApplicableBlock,
  makePost,
  makeTestIdentity,
  rawPublicKey,
} from '../helpers.js';

// Same shape as block-apply.test.ts — small epoch, internal miner.
const testConfig = {
  port: 3000,
  dbPath: ':memory:',
  networkType: 'testnet' as const,
  nodeRole: 'miner' as const,
  postPowTargetBits: 20,
  challengeWindowBlocks: 10,
  orderingBlockIntervalMs: 60000,
  orderingBlockMinSubBlocks: 1,
  maxSubBlocksPerBlock: 1000,
  epochBlocks: 2,
  miningMode: 'internal' as const,
  orderingBlockPowTargetBits: 12,
  creditTreasuryPct: 10,
  treasuryPubKey: '',
  bootstrapPeers: [] as string[],
  listenAddrs: '/ip4/127.0.0.1/tcp/0',
  maxPeers: 50,
};

// ---------------------------------------------------------------------------
// Dynamic import helpers — fresh module world per test (vi.resetModules)
// ---------------------------------------------------------------------------

async function importDb() {
  return (await import('../../src/store/db.js')) as unknown as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importUtxo() {
  return await import('../../src/store/utxo.js');
}

async function importCredits() {
  return await import('../../src/services/credits.js');
}

async function importAvl() {
  return await import('../../src/state/avl-prover.js');
}

async function importBlockApply() {
  return await import('../../src/services/block-apply.js');
}

async function importBlockCreator() {
  return await import('../../src/services/block-creator.js');
}

async function importOrdering() {
  return await import('../../src/store/ordering.js');
}

async function importMempool() {
  return await import('../../src/store/mempool.js');
}

async function importPosts() {
  return await import('../../src/store/posts.js');
}

async function importIdentityRecords() {
  return await import('../../src/store/identity-records.js');
}

async function importJournalStore() {
  return await import('../../src/store/journal.js');
}

async function importVouchCooldowns() {
  return await import('../../src/store/vouch-cooldowns.js');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rmrf(path: string): void {
  for (const p of [path, path + '-wal', path + '-shm']) {
    try { unlinkSync(p); } catch { /* absent */ }
  }
}

function digestHex(handle: { prover: { digest(): Uint8Array | null } }): string {
  const d = handle.prover.digest();
  expect(d).not.toBeNull();
  return Buffer.from(d!).toString('hex');
}

/** Client-built transfer over the given unlocked boxes, signed by the sender. */
function buildSignedTransfer(
  unlocked: CreditBox[],
  from: Uint8Array,
  to: Uint8Array,
  amount: bigint,
  privateKey: KeyObject,
): UtxoTransaction {
  const selected = selectBoxes(unlocked, amount);
  const total = selected.reduce((s, b) => s + b.value, 0n);
  const change = total - amount;

  const outputs: CandidateOf<CreditBox>[] = [{
    boxType: 'credit',
    value: amount,
    owner: to,
    guard: 'owner_signature',
    proofSource: -1,
  }];
  if (change > 0n) {
    outputs.push({
      boxType: 'credit',
      value: change,
      owner: from,
      guard: 'owner_signature',
      proofSource: -1,
    });
  }

  const tx: UtxoTransaction = {
    inputs: selected.map((b) => b.id!),
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  const txId = computeTxId(tx);
  const sig = cryptoSign(null, Buffer.from(txId, 'hex'), privateKey);
  tx.signatures[Buffer.from(from).toString('hex')] = new Uint8Array(sig);
  return tx;
}

function seedCreditBox(
  insertBox: (box: CreditBox) => void,
  owner: Uint8Array,
  value: bigint,
): CreditBox {
  const box: CreditBox = {
    boxType: 'credit',
    value,
    owner,
    guard: 'owner_signature',
    proofSource: 0,
  };
  Object.assign(box, fixtureProvenance(box, 1));
  box.id = computeBoxId(box);
  insertBox(box);
  return box;
}

function boxMutations(journal: BlockJournal) {
  return journal.mutations.filter((m) => m.kind === 'box');
}

describe('credit transfers ride consensus (P2-B phase 3)', () => {
  // -------------------------------------------------------------------------
  // Settlement: pooled → mined → applied, with the journal carrying it
  // -------------------------------------------------------------------------

  it('a pooled transfer settles at the next block, through the journal', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const credits = await importCredits();
    const cooldowns = await importVouchCooldowns();
    const mempool = await importMempool();
    const posts = await importPosts();
    const bc = await importBlockCreator();
    const journalStore = await importJournalStore();

    const alice = generateKeyPairSync('ed25519');
    const alicePub = rawPublicKey(alice.publicKey);
    const bob = makeTestIdentity();
    const seeded = seedCreditBox(utxo.insertBox, alicePub, 500n);

    const engineDeps = {
      getBox: utxo.getBox,
      getBoxByProvenance: utxo.getBoxByProvenance,
      insertBox: utxo.insertBox,
      consumeBox: utxo.consumeBox,
      getKarmaBox: utxo.getKarmaBox,
      getKarmaValue: utxo.getKarmaValue,
      hasActiveVouchCooldown: cooldowns.hasActiveVouchCooldown,
      runInTransaction: (fn: () => void) => fn(),
    };

    // Pool the transfer — nothing settles yet.
    const tx = buildSignedTransfer(
      utxo.getUnlockedCreditBoxes(alicePub, 0),
      alicePub, bob.userId, 400n, alice.privateKey,
    );
    const pooled = credits.sendCredits(engineDeps, tx, 0);
    expect(pooled.status).toBe('pending');
    expect(utxo.getBox(seeded.id!)).not.toBeNull();
    expect(utxo.getCreditBoxes(bob.userId)).toHaveLength(0);

    // Mine: one sub-block to satisfy the block minimum, then create the block.
    const author = makeTestIdentity();
    const post = makePost(author.userId, 'settlement fixture');
    posts.insertPost(post, encodePost(post));
    mempool.insertSubBlock(computePostId(post), 1000);
    bc.startBlockCreator(testConfig);
    const block = bc.createOrderingBlock();
    bc.stopBlockCreator();
    expect(block).not.toBeNull();
    expect(block!.utxoTxTree.utxoTxIds).toContain(pooled.txId);

    // Settled now: input spent, outputs live under the transfer's provenance.
    expect(utxo.getBox(seeded.id!)).toBeNull();
    const bobBoxes = utxo.getCreditBoxes(bob.userId);
    expect(bobBoxes).toHaveLength(1);
    expect(bobBoxes[0]!.value).toBe(400n);
    expect(bobBoxes[0]!.txId).toBe(pooled.txId);
    expect(bobBoxes[0]!.index).toBe(0);
    const change = utxo.getCreditBoxes(alicePub).find((b) => b.value === 100n);
    expect(change).toBeDefined();
    expect(change!.txId).toBe(pooled.txId);
    expect(change!.index).toBe(1);

    // The journal carries both sides of the transfer — this is what the
    // direct-mutation path never produced, and what the AVL feed reads.
    const journal = journalStore.getBlockJournal(1);
    expect(journal).not.toBeNull();
    const muts = boxMutations(journal!);
    expect(muts.some((m) => m.op === 'remove' && m.boxId === seeded.id)).toBe(true);
    expect(muts.some((m) => m.op === 'insert' && m.boxId === bobBoxes[0]!.id)).toBe(true);
    expect(muts.some((m) => m.op === 'insert' && m.boxId === change!.id)).toBe(true);
    expect(journal!.appliedUtxoTxs.some((a) => a.txId === pooled.txId)).toBe(true);

    // The settled outputs round-trip byte-identically through the store —
    // the insert-time bytes are the read-back bytes.
    const { serializeBox } = await import('../../src/state/serialize-box.js');
    const inserted = muts.find((m) => m.op === 'insert' && m.boxId === bobBoxes[0]!.id)!;
    expect(Buffer.from(serializeBox(utxo.getBox(bobBoxes[0]!.id!)!)).toString('hex'))
      .toBe(Buffer.from(serializeBox(inserted.box!)).toString('hex'));

    db.closeDb();
  }, 30_000);

  // -------------------------------------------------------------------------
  // The restart-rebuild convergence — the inverted before-leg
  // -------------------------------------------------------------------------

  const FORK_DB = '/tmp/dagsocial-test-credits-consensus.sqlite';

  it('a mined transfer reaches the live tree, and a restart-rebuild reproduces its content', async () => {
    rmrf(FORK_DB);
    vi.resetModules();

    // ---- world A: the running node, which is also the honest network's view
    let db = await importDb();
    db.initDb(FORK_DB);
    let utxo = await importUtxo();
    const credits = await importCredits();
    const cooldowns = await importVouchCooldowns();
    const mempool = await importMempool();
    const posts = await importPosts();
    const bc = await importBlockCreator();
    const avl = await importAvl();
    const blockApply = await importBlockApply();
    let ordering = await importOrdering();
    const { serializeBox } = await import('../../src/state/serialize-box.js');

    const alice = generateKeyPairSync('ed25519');
    const alicePub = rawPublicKey(alice.publicKey);
    const bob = makeTestIdentity();
    const seeded = seedCreditBox(utxo.insertBox, alicePub, 500n);

    // src/index.ts wiring: singleton prover bootstrapped from unspent boxes.
    const handle = avl.createAvlProver();
    avl.bootstrapAvlProver(handle, utxo.getUnspentBoxes(), 0, []);

    // A block or two of honest history.
    expect(blockApply.applyOrderingBlock(await makeApplicableBlock())).toBe(true);
    expect(blockApply.applyOrderingBlock(await makeApplicableBlock({ height: 2 }))).toBe(true);

    // Pool the transfer, then mine it — the consensus path.
    const engineDeps = {
      getBox: utxo.getBox,
      getBoxByProvenance: utxo.getBoxByProvenance,
      insertBox: utxo.insertBox,
      consumeBox: utxo.consumeBox,
      getKarmaBox: utxo.getKarmaBox,
      getKarmaValue: utxo.getKarmaValue,
      hasActiveVouchCooldown: cooldowns.hasActiveVouchCooldown,
      runInTransaction: (fn: () => void) => fn(),
    };
    const tx = buildSignedTransfer(
      utxo.getUnlockedCreditBoxes(alicePub, 2),
      alicePub, bob.userId, 400n, alice.privateKey,
    );
    const pooled = credits.sendCredits(engineDeps, tx, 2);

    // The live prover has not moved yet: pooling settles nothing.
    const preBlockDigest = digestHex(handle);

    const author = makeTestIdentity();
    const post = makePost(author.userId, 'convergence fixture');
    posts.insertPost(post, encodePost(post));
    mempool.insertSubBlock(computePostId(post), 1000);
    bc.startBlockCreator(testConfig);
    const block3 = bc.createOrderingBlock();
    bc.stopBlockCreator();
    expect(block3).not.toBeNull();
    expect(block3!.utxoTxTree.utxoTxIds).toContain(pooled.txId);
    expect(ordering.getCurrentHeight()).toBe(3);

    // The transfer reached the AVL feed: the digest moved at the block, and
    // the live tree now authenticates the transfer outputs and has dropped
    // the spent input. On the pre-fix HEAD the digest did NOT move here —
    // the mutations bypassed the journal, so the tree never saw them.
    expect(digestHex(handle)).not.toBe(preBlockDigest);
    const bobBox = utxo.getCreditBoxes(bob.userId)[0]!;
    expect(bobBox.txId).toBe(pooled.txId);
    const bobLive = handle.prover.unauthenticatedLookup(Buffer.from(bobBox.id!, 'hex'));
    expect(bobLive).not.toBeNull();
    expect(Buffer.from(bobLive!).toString('hex'))
      .toBe(Buffer.from(serializeBox(bobBox)).toString('hex'));
    expect(handle.prover.unauthenticatedLookup(Buffer.from(seeded.id!, 'hex'))).toBeNull();

    // What the live tree authenticates for every unspent box — the content a
    // restart must reproduce.
    const unspentA = utxo.getUnspentBoxes();
    const liveContent = new Map(
      unspentA.map((b) => {
        const v = handle.prover.unauthenticatedLookup(Buffer.from(b.id!, 'hex'));
        expect(v, `live tree must hold ${b.id}`).not.toBeNull();
        return [b.id!, Buffer.from(v!).toString('hex')];
      }),
    );

    db.closeDb();

    // ---- world B: restart with an AVL rebuild from SQL (the wipe-deploy
    // step). Content-level assertions only, deliberately: the AVL+ tree's
    // *shape* is history-dependent (measured 2026-08-07: identical 7-box
    // content built incrementally vs sorted-rebuild matched digests in only
    // 6/10 rounds), so digest equality across a rebuild is not a property
    // the tree has for any set, transfer or no transfer — that latent
    // rebuild defect is Spec B territory, reported to main. What THIS unit
    // owns is that the box table and the tree agree on content, which the
    // pre-fix direct mutation broke: SQL held transferred boxes the tree
    // never saw.
    vi.resetModules();
    db = await importDb();
    db.initDb(FORK_DB);
    db.getDb().exec('DELETE FROM avl_tree_nodes; DELETE FROM avl_tree_versions;');

    const avlB = await importAvl();
    utxo = await importUtxo();
    const idr = await importIdentityRecords();
    ordering = await importOrdering();

    const handleB = avlB.createAvlProver();
    const currentHeight = ordering.getCurrentHeight();
    expect(currentHeight).toBe(3);
    const records = idr.getAllIdentityRecords().map((r) => ({
      key: idr.identityRecordKey(r.identityId),
      record: r.record,
    }));
    const unspentB = utxo.getUnspentBoxes();
    avlB.bootstrapAvlProver(handleB, unspentB, currentHeight, records);

    // Same box set...
    expect(unspentB.map((b) => b.id!).sort()).toEqual([...liveContent.keys()].sort());
    // ...authenticated with byte-identical values, spent input still gone.
    for (const [id, bytesHex] of liveContent) {
      const v = handleB.prover.unauthenticatedLookup(Buffer.from(id, 'hex'));
      expect(v, `rebuilt tree must hold ${id}`).not.toBeNull();
      expect(Buffer.from(v!).toString('hex')).toBe(bytesHex);
    }
    expect(handleB.prover.unauthenticatedLookup(Buffer.from(seeded.id!, 'hex'))).toBeNull();

    db.closeDb();
    rmrf(FORK_DB);
  }, 30_000);
});
