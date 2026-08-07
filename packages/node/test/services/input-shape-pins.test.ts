// ---------------------------------------------------------------------------
// P2-B phase 4 — input-shape pins: karma ownership and the single unvouch.
//
// Both defects share the session's recurring shape: a rule reasons about
// `inputs[0]` (or assumes one input of a kind) without pinning that the input
// set has that shape. Both were first written in their ACCEPTANCE form and
// run against untouched HEAD, where they passed — these are transactions the
// engine used to accept, not hypothetical shapes:
//
//   - K1: every karma OUTPUT was pinned to `inputs[0].owner` ("Karma cannot
//     be transferred"), but the input set was never checked for a shared
//     owner — validateTx step 3 only requires a common boxType. So
//     [karmaA(10), karmaB(10)] → karmaA(20) validated with both co-signing,
//     and B's karma became A's. Consensual, but karma is non-transferable by
//     rule — a consensual transfer is still a transfer, and it prices
//     off-chain. The audit's most severe class, and unlike the unlike-path
//     instance it does NOT close when P2-D lands.
//   - K2: block application detects an unvouch by walking the inputs for a
//     VouchBox, writes ONE escrow row, and breaks — while the transition arm
//     asked only for zero outputs and conservation exempts zero-output vouch
//     spends wholesale. A two-VouchBox unvouch consumed both stakes and
//     escrowed one. The money leg lives in unvouch-value-flow.test.ts.
//
// Each rejection is paired with a non-vacuity control: the same transaction
// differing only in the pinned property, proving the rejection isolates that
// one rule rather than tripping over conservation, a guard, or a malformed
// fixture.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'crypto';
import { computeBoxId, computeTxId, VOUCH_KARMA_AMOUNT } from '@dagsocial/types';
import type { AnyBox, KarmaBox, VouchBox, UtxoTransaction } from '@dagsocial/types';
import Database from 'better-sqlite3';

import { fixtureProvenance, rawPublicKey } from '../helpers.js';
import {
  initDb,
  closeDb,
  getDb,
  getBox as storeGetBox,
  getBoxByProvenance as storeGetBoxByProvenance,
  getKarmaBox,
  getKarmaBoxes,
  insertBox as storeInsertBox,
  consumeBox as storeConsumeBox,
  hasActiveVouchCooldown as storeHasActiveVouchCooldown,
} from '../../src/store/index.js';
import { validateTx } from '../../src/services/utxo-engine.js';

interface TestKeys {
  pub: Uint8Array;
  priv: KeyObject;
}

function makeKeys(): TestKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: rawPublicKey(publicKey), priv: privateKey };
}

/** Sign the tx hash for `keys` and store under the hex pubkey. */
function addSignature(tx: UtxoTransaction, keys: TestKeys): void {
  const hash = Buffer.from(computeTxId(tx), 'hex');
  tx.signatures[Buffer.from(keys.pub).toString('hex')] = new Uint8Array(
    cryptoSign(null, hash, keys.priv),
  );
}

describe('P2-B phase 4 — input-shape pins', () => {
  let db: Database.Database;

  function makeDeps() {
    return {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db
          .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
          .get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
      getBoxByProvenance: storeGetBoxByProvenance,
      insertBox: (box: AnyBox) => storeInsertBox(box),
      consumeBox: (id: string, atBlock: number) => storeConsumeBox(id, atBlock),
      getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
      getKarmaValue: (owner: Uint8Array): bigint =>
        getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
      hasActiveVouchCooldown: storeHasActiveVouchCooldown,
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
    };
  }

  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();
    deps = makeDeps();
  });

  afterEach(() => {
    closeDb();
  });

  /** Seed a karma box for `owner` with independent fixture provenance. */
  function seedKarma(owner: Uint8Array, value: bigint, nonce = 0): KarmaBox {
    const candidate = {
      boxType: 'karma' as const,
      value,
      owner,
      guard: 'owner_signature' as const,
      proofSource: 'test',
    };
    Object.assign(candidate, fixtureProvenance(candidate, 1, nonce));
    const box = { ...candidate, id: computeBoxId(candidate) } as KarmaBox;
    storeInsertBox(box);
    return box;
  }

  /** Seed a VouchBox holding `value`, staked by `voucherId` on `targetId`. */
  function seedVouch(
    voucherId: Uint8Array,
    targetId: Uint8Array,
    value: bigint = VOUCH_KARMA_AMOUNT,
    nonce = 0,
  ): VouchBox {
    const candidate = {
      boxType: 'vouch' as const,
      value,
      voucherId,
      targetId,
      guard: 'owner_signature' as const,
    };
    Object.assign(candidate, fixtureProvenance(candidate, 1, nonce));
    const box = { ...candidate, id: computeBoxId(candidate) } as unknown as VouchBox;
    storeInsertBox(box);
    return box;
  }

  /** A consolidation: the given karma boxes spent to one box owned by `owner`. */
  function buildConsolidation(
    boxes: KarmaBox[],
    owner: Uint8Array,
    signers: TestKeys[],
  ): UtxoTransaction {
    const total = boxes.reduce((sum, b) => sum + b.value, 0n);
    const tx: UtxoTransaction = {
      inputs: boxes.map((b) => b.id!),
      outputs: [
        {
          boxType: 'karma',
          value: total,
          owner,
          guard: 'owner_signature',
          proofSource: 'test',
        } as KarmaBox,
      ],
      signatures: {},
      protocolVersion: 1,
    };
    for (const s of signers) addSignature(tx, s);
    return tx;
  }

  // -------------------------------------------------------------------------
  // K1 — karma inputs may have different owners, so karma is transferable.
  // -------------------------------------------------------------------------

  it('K1: rejects a cross-owner karma consolidation', () => {
    // Accepted on HEAD — [karmaA(10), karmaB(10)] → karmaA(20) returned
    // { valid: true }: same boxType, conservation holds, every output matches
    // inputs[0].owner, and checkGuards gets the owner signature it wants from
    // each of A and B. B's karma became A's — priced off-chain, consensual,
    // and still a transfer of the non-transferable asset.
    const a = makeKeys();
    const b = makeKeys();
    const boxA = seedKarma(a.pub, 10n);
    const boxB = seedKarma(b.pub, 10n);

    const tx = buildConsolidation([boxA, boxB], a.pub, [a, b]);

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('karma inputs have different owners');
  });

  it('K1 non-vacuity: self-consolidation of two own-owner boxes is accepted', () => {
    // The legitimate multi-input case: several of one owner's boxes into one.
    const a = makeKeys();
    const boxA1 = seedKarma(a.pub, 10n, 0);
    const boxA2 = seedKarma(a.pub, 10n, 1);

    const tx = buildConsolidation([boxA1, boxA2], a.pub, [a]);

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // K2 — a multi-VouchBox unvouch destroys all but one stake.
  // -------------------------------------------------------------------------

  it('K2: rejects a two-VouchBox unvouch', () => {
    // Accepted on HEAD — two VouchBoxes in, zero outputs, one voucher
    // signature: the transition arm asked only for zero outputs, and
    // conservation exempts zero-output vouch spends wholesale. Block
    // application then consumed both boxes and escrowed one — the money is
    // measured in unvouch-value-flow.test.ts.
    const voucher = makeKeys();
    const target1 = makeKeys();
    const target2 = makeKeys();
    const v1 = seedVouch(voucher.pub, target1.pub);
    const v2 = seedVouch(voucher.pub, target2.pub);

    const tx: UtxoTransaction = {
      inputs: [v1.id!, v2.id!],
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, voucher);

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('exactly one VouchBox');
  });

  it('K2 non-vacuity: a single-VouchBox unvouch is accepted', () => {
    const voucher = makeKeys();
    const target = makeKeys();
    const v = seedVouch(voucher.pub, target.pub);

    const tx: UtxoTransaction = {
      inputs: [v.id!],
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, voucher);

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
