import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { computeBoxId, computeTxId, selectBoxes, PROTOCOL_VERSION } from '@dagsocial/types';
import type { CreditBox, UtxoTransaction } from '@dagsocial/types';
import { initDb, closeDb } from '../../src/store/db.js';
import { insertBox, getCreditBoxes, getUnlockedCreditBoxes } from '../../src/store/utxo.js';
import { sendCredits } from '../../src/services/credits.js';
import { fixtureProvenance } from '../helpers.js';

function rawPublicKey(keyObj: ReturnType<typeof generateKeyPairSync>['publicKey']): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

function signTxId(
  tx: UtxoTransaction,
  privKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): Uint8Array {
  const txId = computeTxId(tx);
  const sig = cryptoSign(null, Buffer.from(txId, 'hex'), privKey);
  return new Uint8Array(sig);
}

describe('sendCredits', () => {
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

  /** Build and sign a transfer tx the same way sendCredits will internally. */
  function buildSignedTransfer(amount: bigint): { signature: Uint8Array } {
    const boxes = getUnlockedCreditBoxes(alicePubKey, HEIGHT);
    const selected = selectBoxes(boxes, amount);
    const total = selected.reduce((s, b) => s + b.value, 0n);
    const change = total - amount;

    const outputs: CreditBox[] = [{
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
      outputs: outputs.map((b) => ({ ...b, id: computeBoxId(b) })),
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    const signature = signTxId(tx, alice.privateKey);
    return { signature };
  }

  it('transfers credits from alice to bob', () => {
    seedCredits(500n);
    seedCredits(300n);

    const { signature } = buildSignedTransfer(400n);
    const result = sendCredits(alicePubKey, bobPubKey, 400n, signature, HEIGHT);

    expect(result.sent).toBe(400n);
    expect(result.change).toBe(100n); // 500 - 400 = 100 (largest-first picks the 500 box only)
    expect(result.boxesConsumed).toBe(1);
    expect(typeof result.txId).toBe('string');

    // Alice: 300 box untouched + 100 change = 400 total across 2 boxes
    const aliceBoxes = getCreditBoxes(alicePubKey);
    const aliceTotal = aliceBoxes.reduce((s, b) => s + b.value, 0n);
    expect(aliceTotal).toBe(400n);

    const bobBoxes = getCreditBoxes(bobPubKey);
    expect(bobBoxes).toHaveLength(1);
    expect(bobBoxes[0]!.value).toBe(400n);
  });

  // -------------------------------------------------------------------------
  // Spec G phase C4 — provenance is attached AFTER the txId is computed
  // -------------------------------------------------------------------------

  it('transferred boxes carry the real txId and their output positions', () => {
    seedCredits(500n);
    const { signature } = buildSignedTransfer(400n);
    const result = sendCredits(alicePubKey, bobPubKey, 400n, signature, HEIGHT);

    // Output 0 is the recipient, output 1 the change — the positions
    // `sendCredits` builds them in.
    const recipient = getCreditBoxes(bobPubKey)[0]!;
    const change = getCreditBoxes(alicePubKey).find((b) => b.value === 100n)!;

    expect(recipient.txId).toBe(result.txId);
    expect(change.txId).toBe(result.txId);
    expect(recipient.index).toBe(0);
    expect(change.index).toBe(1);
  });

  it('computeTxId is invariant under output provenance', async () => {
    // This is what makes the "attach after, never before" ordering *safe* — and
    // also what makes getting it backwards **silent**. `computeTxId` routes
    // outputs through `canonicalBoxBytes`, which strips id/txId/index, so a
    // builder that attached provenance first would still produce the same txId
    // and nothing would fail. Pinned here so that if the strip is ever removed,
    // one test names the reason rather than a dozen signature checks breaking.
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

  it('transferred boxes round-trip byte-identically through the store', async () => {
    const { serializeBox } = await import('../../src/state/serialize-box.js');
    const { getBox } = await import('../../src/store/utxo.js');

    seedCredits(500n);
    const { signature } = buildSignedTransfer(400n);
    sendCredits(alicePubKey, bobPubKey, 400n, signature, HEIGHT);

    const recipient = getCreditBoxes(bobPubKey)[0]!;
    const keys = Object.keys(recipient).filter((k) => k !== 'id');
    expect(keys.slice(-2)).toEqual(['txId', 'index']);

    // rowToBox reconstruction vs. itself is trivially equal; the assertion that
    // bites is that the producer put provenance where rowToBox puts it, which
    // the key-order check above pins.
    expect(Buffer.from(serializeBox(getBox(recipient.id!)!)).toString('hex')).toBe(
      Buffer.from(serializeBox(recipient)).toString('hex'),
    );
  });

  it('exact-amount transfer produces no change', () => {
    seedCredits(500n);
    const { signature } = buildSignedTransfer(500n);
    const result = sendCredits(alicePubKey, bobPubKey, 500n, signature, HEIGHT);

    expect(result.sent).toBe(500n);
    expect(result.change).toBe(0n);
    expect(result.boxesConsumed).toBe(1);
    expect(getCreditBoxes(alicePubKey)).toHaveLength(0);
    expect(getCreditBoxes(bobPubKey)[0]!.value).toBe(500n);
  });

  it('skips locked boxes', () => {
    seedCredits(200n, 200);
    seedCredits(300n);

    const { signature } = buildSignedTransfer(100n);
    const result = sendCredits(alicePubKey, bobPubKey, 100n, signature, HEIGHT);

    expect(result.boxesConsumed).toBe(1);
    expect(result.change).toBe(200n);

    const aliceBoxes = getCreditBoxes(alicePubKey);
    const lockedBox = aliceBoxes.find(b => b.lockedUntilBlock === 200);
    expect(lockedBox).toBeDefined();
    expect(lockedBox!.value).toBe(200n);
  });

  it('rejects insufficient balance', () => {
    seedCredits(50n);
    const badSig = new Uint8Array(64);
    expect(() => sendCredits(alicePubKey, bobPubKey, 100n, badSig, HEIGHT))
      .toThrow('Insufficient total value');
  });

  it('rejects bad signature', () => {
    seedCredits(500n);
    const badSig = new Uint8Array(64);
    expect(() => sendCredits(alicePubKey, bobPubKey, 100n, badSig, HEIGHT))
      .toThrow('invalid signature');
  });

  it('rejects zero or negative amount', () => {
    expect(() => sendCredits(alicePubKey, bobPubKey, 0n, new Uint8Array(64), HEIGHT))
      .toThrow('amount must be positive');
    expect(() => sendCredits(alicePubKey, bobPubKey, -5n, new Uint8Array(64), HEIGHT))
      .toThrow('amount must be positive');
  });

  it('transfer from multi-box wallet selects correctly', () => {
    seedCredits(100n);
    seedCredits(50n);
    seedCredits(20n);
    seedCredits(10n);

    const { signature } = buildSignedTransfer(155n);
    const result = sendCredits(alicePubKey, bobPubKey, 155n, signature, HEIGHT);

    expect(result.sent).toBe(155n);
    expect(result.change).toBe(15n);
    expect(result.boxesConsumed).toBe(3);
  });
});
