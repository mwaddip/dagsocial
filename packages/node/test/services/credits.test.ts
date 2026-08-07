import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'crypto';
import {
  computeBoxId,
  computeTxId,
  decodeTx,
  selectBoxes,
  MEMPOOL_EXPIRY_BLOCKS,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { CandidateOf, CreditBox, KarmaBox, UtxoTransaction } from '@dagsocial/types';
import { initDb, getDb, closeDb } from '../../src/store/db.js';
import {
  getBox,
  getBoxByProvenance,
  getCreditBoxes,
  getUnlockedCreditBoxes,
  getKarmaBox,
  getKarmaValue,
  insertBox,
  consumeBox,
} from '../../src/store/utxo.js';
import { hasActiveVouchCooldown } from '../../src/store/vouch-cooldowns.js';
import { getPendingEntries } from '../../src/store/mempool.js';
import { sendCredits } from '../../src/services/credits.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';
import { fixtureProvenance, rawPublicKey } from '../helpers.js';

function signTxId(
  tx: UtxoTransaction,
  privKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): Uint8Array {
  const txId = computeTxId(tx);
  const sig = cryptoSign(null, Buffer.from(txId, 'hex'), privKey);
  return new Uint8Array(sig);
}

/** The real store wired as engine deps — what server.ts hands the route. */
const engineDeps: UtxoEngineDeps = {
  getBox,
  getBoxByProvenance,
  insertBox,
  consumeBox,
  getKarmaBox,
  getKarmaValue,
  hasActiveVouchCooldown,
  runInTransaction: (fn) => fn(),
};

describe('sendCredits (validate + pool — P2-B phase 3)', () => {
  let alice: ReturnType<typeof generateKeyPairSync>;
  let bob: ReturnType<typeof generateKeyPairSync>;
  let alicePubKey: Uint8Array;
  let bobPubKey: Uint8Array;
  const HEIGHT = 100;

  beforeEach(() => {
    initDb(':memory:');
    alice = generateKeyPairSync('ed25519');
    bob = generateKeyPairSync('ed25519');
    alicePubKey = rawPublicKey(alice.publicKey);
    bobPubKey = rawPublicKey(bob.publicKey);
  });

  afterEach(() => {
    closeDb();
  });

  function seedCredits(value: bigint, lockedUntilBlock?: number): CreditBox {
    const box: CreditBox = {
      boxType: 'credit',
      value,
      owner: alicePubKey,
      guard: 'owner_signature',
      proofSource: HEIGHT - 10,
    };
    if (lockedUntilBlock !== undefined) {
      box.lockedUntilBlock = lockedUntilBlock;
    }
    Object.assign(box, fixtureProvenance(box, 1));
    box.id = computeBoxId(box);
    insertBox(box);
    return box;
  }

  /**
   * Build and sign the transfer the way the demo UI does
   * (`buildCreditTransferTx`): largest-first selection over unlocked boxes,
   * recipient output first, change output second when non-zero.
   */
  function buildSignedTransfer(amount: bigint): UtxoTransaction {
    const boxes = getUnlockedCreditBoxes(alicePubKey, HEIGHT);
    const selected = selectBoxes(boxes, amount);
    const total = selected.reduce((s, b) => s + b.value, 0n);
    const change = total - amount;

    const outputs: CandidateOf<CreditBox>[] = [{
      boxType: 'credit',
      value: amount,
      owner: bobPubKey,
      guard: 'owner_signature',
      proofSource: -1,
    }];
    if (change > 0n) {
      outputs.push({
        boxType: 'credit',
        value: change,
        owner: alicePubKey,
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
    tx.signatures[Buffer.from(alicePubKey).toString('hex')] = signTxId(tx, alice.privateKey);
    return tx;
  }

  /** Every pooled utxo_tx in the mempool, decoded. */
  function pooledTxs(): UtxoTransaction[] {
    return getPendingEntries(1000)
      .filter((e) => e.entryType === 'utxo_tx')
      .map((e) => decodeTx(e.utxoTxCbor!));
  }

  it('pools a valid transfer and answers pending — the UTXO set does not move', () => {
    const seeded = seedCredits(500n);
    const tx = buildSignedTransfer(400n);

    const result = sendCredits(engineDeps, tx, HEIGHT);

    expect(result.status).toBe('pending');
    expect(result.txId).toBe(computeTxId(tx));
    expect(result.expiresAtHeight).toBe(HEIGHT + MEMPOOL_EXPIRY_BLOCKS);
    expect(result.tx).toBe(tx);

    // The transfer sits in the mempool...
    const pooled = pooledTxs();
    expect(pooled).toHaveLength(1);
    expect(computeTxId(pooled[0]!)).toBe(result.txId);

    // ...and nowhere else: the input is still unspent, the outputs do not
    // exist, and no journal was opened. Credits move at block application.
    expect(getBox(seeded.id!)).not.toBeNull();
    expect(getCreditBoxes(bobPubKey)).toHaveLength(0);
    const aliceBoxes = getCreditBoxes(alicePubKey);
    expect(aliceBoxes).toHaveLength(1);
    expect(aliceBoxes[0]!.value).toBe(500n);
    const journals = getDb()
      .prepare('SELECT COUNT(*) AS n FROM block_journal')
      .get() as { n: number };
    expect(journals.n).toBe(0);
  });

  it('an exact-amount transfer (no change output) validates and pools', () => {
    seedCredits(500n);
    const tx = buildSignedTransfer(500n);
    expect(tx.outputs).toHaveLength(1);

    const result = sendCredits(engineDeps, tx, HEIGHT);
    expect(result.status).toBe('pending');
    expect(pooledTxs()).toHaveLength(1);
  });

  it('rejects an unsigned transfer — the guard check is validateTx, not a hand-rolled mirror', () => {
    const seeded = seedCredits(500n);
    const tx = buildSignedTransfer(400n);
    tx.signatures = {};

    expect(() => sendCredits(engineDeps, tx, HEIGHT)).toThrow(/Invalid credit transfer/);
    expect(pooledTxs()).toHaveLength(0);
    expect(getBox(seeded.id!)).not.toBeNull();
  });

  it('rejects a forged signature', () => {
    seedCredits(500n);
    const tx = buildSignedTransfer(400n);
    tx.signatures[Buffer.from(alicePubKey).toString('hex')] = new Uint8Array(64);

    expect(() => sendCredits(engineDeps, tx, HEIGHT)).toThrow(/Invalid credit transfer/);
    expect(pooledTxs()).toHaveLength(0);
  });

  it('rejects a value-inflating transfer (conservation)', () => {
    seedCredits(500n);
    const tx = buildSignedTransfer(400n);
    // Inflate the recipient output after selection: 500 in, 600 out.
    (tx.outputs[0] as CreditBox).value = 500n;
    tx.signatures = {};
    tx.signatures[Buffer.from(alicePubKey).toString('hex')] = signTxId(tx, alice.privateKey);

    expect(() => sendCredits(engineDeps, tx, HEIGHT)).toThrow(/Invalid credit transfer/);
    expect(pooledTxs()).toHaveLength(0);
  });

  it('rejects a spend of a nonexistent or already-spent input', () => {
    seedCredits(500n);
    const tx = buildSignedTransfer(400n);
    tx.inputs = ['ff'.repeat(32)];
    tx.signatures = {};
    tx.signatures[Buffer.from(alicePubKey).toString('hex')] = signTxId(tx, alice.privateKey);

    expect(() => sendCredits(engineDeps, tx, HEIGHT)).toThrow(/Invalid credit transfer/);
    expect(pooledTxs()).toHaveLength(0);
  });

  it('rejects non-credit outputs (route shape gate, before validation)', () => {
    const seeded = seedCredits(500n);
    const karmaOut: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 500n,
      owner: bobPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
    };
    const tx: UtxoTransaction = {
      inputs: [seeded.id!],
      outputs: [karmaOut],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    tx.signatures[Buffer.from(alicePubKey).toString('hex')] = signTxId(tx, alice.privateKey);

    expect(() => sendCredits(engineDeps, tx, HEIGHT))
      .toThrow('credit transfer outputs must all be CreditBoxes');
    expect(pooledTxs()).toHaveLength(0);
  });

  it('rejects an empty-output transfer (shape gate)', () => {
    const seeded = seedCredits(500n);
    const tx: UtxoTransaction = {
      inputs: [seeded.id!],
      outputs: [],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    tx.signatures[Buffer.from(alicePubKey).toString('hex')] = signTxId(tx, alice.privateKey);

    expect(() => sendCredits(engineDeps, tx, HEIGHT))
      .toThrow('credit transfer outputs must all be CreditBoxes');
  });

  it('a multi-box transfer pools with all selected inputs intact', () => {
    seedCredits(100n);
    seedCredits(50n);
    seedCredits(20n);
    seedCredits(10n);

    const tx = buildSignedTransfer(155n);
    expect(tx.inputs).toHaveLength(3); // largest-first: 100 + 50 + 20

    const result = sendCredits(engineDeps, tx, HEIGHT);
    expect(result.status).toBe('pending');

    // Still all unspent — settlement is the block's job.
    for (const id of tx.inputs) {
      expect(getBox(id)).not.toBeNull();
    }
  });

  // -------------------------------------------------------------------------
  // Spec G phase C4 — the txId is invariant under output provenance. Pinned
  // here so that if `computeTxId` ever stops stripping id/txId/index, one
  // test names the reason rather than a dozen signature checks breaking.
  // -------------------------------------------------------------------------

  it('computeTxId is invariant under output provenance', async () => {
    const { materializeOutput } = await import('../../src/services/utxo-engine.js');

    const candidate: CreditBox = {
      boxType: 'credit',
      value: 42n,
      owner: bobPubKey,
      guard: 'owner_signature',
      proofSource: -1,
    };
    const tx: UtxoTransaction = {
      inputs: ['ab'.repeat(32)],
      outputs: [{ ...candidate, id: computeBoxId(candidate) }],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    const bareTxId = computeTxId(tx);
    const materialized = { ...tx, outputs: [materializeOutput(candidate, bareTxId, 0)] };
    expect(computeTxId(materialized)).toBe(bareTxId);
  });
});
