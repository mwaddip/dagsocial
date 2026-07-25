import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { computeBoxId, computeTxId, selectBoxes, PROTOCOL_VERSION } from '@dagsocial/types';
import type { CreditBox, UtxoTransaction } from '@dagsocial/types';
import { initDb, closeDb } from '../../src/store/db.js';
import { insertBox, getCreditBoxes, getUnlockedCreditBoxes } from '../../src/store/utxo.js';
import { sendCredits } from '../../src/services/credits.js';

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

  function seedCredits(value: number, lockedUntilBlock?: number): CreditBox {
    const box: CreditBox = {
      boxType: 'credit',
      value,
      createdAtBlock: HEIGHT - 10,
      owner: alicePubKey,
      guard: 'owner_signature',
      proofSource: HEIGHT - 10,
    };
    if (lockedUntilBlock !== undefined) {
      box.lockedUntilBlock = lockedUntilBlock;
    }
    box.id = computeBoxId(box);
    insertBox(box);
    return box;
  }

  /** Build and sign a transfer tx the same way sendCredits will internally. */
  function buildSignedTransfer(amount: number): { signature: Uint8Array } {
    const boxes = getUnlockedCreditBoxes(alicePubKey, HEIGHT);
    const selected = selectBoxes(boxes, amount);
    const total = selected.reduce((s, b) => s + b.value, 0);
    const change = total - amount;

    const outputs: CreditBox[] = [{
      boxType: 'credit',
      value: amount,
      createdAtBlock: HEIGHT,
      owner: bobPubKey,
      guard: 'owner_signature',
      proofSource: -1,
    }];
    if (change > 0) {
      outputs.push({
        boxType: 'credit',
        value: change,
        createdAtBlock: HEIGHT,
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
    seedCredits(500);
    seedCredits(300);

    const { signature } = buildSignedTransfer(400);
    const result = sendCredits(alicePubKey, bobPubKey, 400, signature, HEIGHT);

    expect(result.sent).toBe(400);
    expect(result.change).toBe(100); // 500 - 400 = 100 (largest-first picks the 500 box only)
    expect(result.boxesConsumed).toBe(1);
    expect(typeof result.txId).toBe('string');

    // Alice: 300 box untouched + 100 change = 400 total across 2 boxes
    const aliceBoxes = getCreditBoxes(alicePubKey);
    const aliceTotal = aliceBoxes.reduce((s, b) => s + b.value, 0);
    expect(aliceTotal).toBe(400);

    const bobBoxes = getCreditBoxes(bobPubKey);
    expect(bobBoxes).toHaveLength(1);
    expect(bobBoxes[0]!.value).toBe(400);
  });

  it('exact-amount transfer produces no change', () => {
    seedCredits(500);
    const { signature } = buildSignedTransfer(500);
    const result = sendCredits(alicePubKey, bobPubKey, 500, signature, HEIGHT);

    expect(result.sent).toBe(500);
    expect(result.change).toBe(0);
    expect(result.boxesConsumed).toBe(1);
    expect(getCreditBoxes(alicePubKey)).toHaveLength(0);
    expect(getCreditBoxes(bobPubKey)[0]!.value).toBe(500);
  });

  it('skips locked boxes', () => {
    seedCredits(200, 200);
    seedCredits(300);

    const { signature } = buildSignedTransfer(100);
    const result = sendCredits(alicePubKey, bobPubKey, 100, signature, HEIGHT);

    expect(result.boxesConsumed).toBe(1);
    expect(result.change).toBe(200);

    const aliceBoxes = getCreditBoxes(alicePubKey);
    const lockedBox = aliceBoxes.find(b => b.lockedUntilBlock === 200);
    expect(lockedBox).toBeDefined();
    expect(lockedBox!.value).toBe(200);
  });

  it('rejects insufficient balance', () => {
    seedCredits(50);
    const badSig = new Uint8Array(64);
    expect(() => sendCredits(alicePubKey, bobPubKey, 100, badSig, HEIGHT))
      .toThrow('Insufficient total value');
  });

  it('rejects bad signature', () => {
    seedCredits(500);
    const badSig = new Uint8Array(64);
    expect(() => sendCredits(alicePubKey, bobPubKey, 100, badSig, HEIGHT))
      .toThrow('invalid signature');
  });

  it('rejects zero or negative amount', () => {
    expect(() => sendCredits(alicePubKey, bobPubKey, 0, new Uint8Array(64), HEIGHT))
      .toThrow('amount must be positive');
    expect(() => sendCredits(alicePubKey, bobPubKey, -5, new Uint8Array(64), HEIGHT))
      .toThrow('amount must be positive');
  });

  it('transfer from multi-box wallet selects correctly', () => {
    seedCredits(100);
    seedCredits(50);
    seedCredits(20);
    seedCredits(10);

    const { signature } = buildSignedTransfer(155);
    const result = sendCredits(alicePubKey, bobPubKey, 155, signature, HEIGHT);

    expect(result.sent).toBe(155);
    expect(result.change).toBe(15);
    expect(result.boxesConsumed).toBe(3);
  });
});
