/**
 * The id-integrity discriminator for the guard-shape pin: an output accepted
 * by `validateTx` always satisfies `computeBoxId(rowToBox(row)) === row.id`
 * after apply.
 *
 * This is the invariant the check exists for (ARCHITECTURE → "Canonical bytes
 * are the record"). Before the pin, a lying `guard` or a stray key was
 * accepted, hashed verbatim into the box id and the AVL leaf, and then
 * silently dropped by the store round-trip (`insertBox` types the columns,
 * `rowToBox` fabricates the canonical guard) — so the committed bytes and
 * every later reconstruction of the box permanently disagreed. The before-leg
 * of the unit reproduced exactly that on the pre-edit tree; these tests hold
 * the door shut.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'crypto';
import {
  computeBoxId,
  computeTxId,
  POST_LOCK_THREAD_COST,
  VOUCH_KARMA_AMOUNT,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
} from '@dagsocial/types';
import type { AnyBox, KarmaBox, CreditBox, UtxoTransaction } from '@dagsocial/types';
import Database from 'better-sqlite3';
import { fixtureProvenance } from '../helpers.js';
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
import { validateTx, applyTx } from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';

function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

describe('guard-shape pin: id integrity of accepted outputs', () => {
  let db: Database.Database;
  let ownerPubKey: Uint8Array;
  let ownerPrivKey: KeyObject;
  let deps: UtxoEngineDeps;

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    ownerPubKey = rawPublicKey(publicKey);
    ownerPrivKey = privateKey;
    deps = {
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
      getKarmaValue: (owner: Uint8Array) =>
        getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
      hasActiveVouchCooldown: storeHasActiveVouchCooldown,
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
    };
  });

  afterEach(() => closeDb());

  function seedKarma(value: bigint): KarmaBox {
    const box: Omit<KarmaBox, 'id'> & { id?: string } = {
      boxType: 'karma',
      value,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
    };
    Object.assign(box, fixtureProvenance(box, 1));
    const full = { ...box, id: computeBoxId(box) } as KarmaBox;
    storeInsertBox(full);
    return full;
  }

  function seedCredit(value: bigint): CreditBox {
    const box: Omit<CreditBox, 'id'> & { id?: string } = {
      boxType: 'credit',
      value,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 1,
    };
    Object.assign(box, fixtureProvenance(box, 1));
    const full = { ...box, id: computeBoxId(box) } as CreditBox;
    storeInsertBox(full);
    return full;
  }

  function signedTx(inputs: string[], outputs: unknown[]): UtxoTransaction {
    const tx: UtxoTransaction = {
      inputs,
      outputs: outputs as UtxoTransaction['outputs'],
      signatures: {},
      protocolVersion: 1,
    };
    const hash = Buffer.from(computeTxId(tx), 'hex');
    tx.signatures[Buffer.from(ownerPubKey).toString('hex')] = new Uint8Array(
      cryptoSign(null, hash, ownerPrivKey),
    );
    return tx;
  }

  /**
   * The discriminator: what the store hands back (rowToBox) re-derives the
   * row's own id. Reads through the raw row so a spent box would count too.
   */
  function expectIdClean(boxId: string): void {
    const fromStore = storeGetBox(boxId);
    expect(fromStore, `box ${boxId} not found in store`).not.toBeNull();
    const { id: _id, ...rest } = fromStore!;
    expect(computeBoxId(rest)).toBe(boxId);
  }

  function karmaChange(value: bigint): Record<string, unknown> {
    return {
      boxType: 'karma',
      value,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
    };
  }

  it('before-leg probe 1, now closed: lying post_lock guard is rejected, nothing applied', () => {
    const karma = seedKarma(100n);
    const lyingLock = {
      boxType: 'post_lock',
      value: POST_LOCK_THREAD_COST,
      originalValue: POST_LOCK_THREAD_COST,
      owner: ownerPubKey,
      targetPostId: 'a'.repeat(64),
      guard: 'owner_signature',
    };
    const r = validateTx(
      deps,
      signedTx([karma.id!], [karmaChange(100n - POST_LOCK_THREAD_COST), lyingLock]),
      10,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/guard must be 'block_apply'/);
    // The input is untouched and no post_lock row exists.
    expect(deps.getBox(karma.id!)).not.toBeNull();
    const locks = db
      .prepare("SELECT COUNT(*) AS n FROM utxo_boxes WHERE box_type = 'post_lock'")
      .get() as { n: number | bigint };
    expect(Number(locks.n)).toBe(0);
  });

  it('before-leg probe 2, now closed: stray key is rejected, nothing applied', () => {
    const karma = seedKarma(100n);
    const strayLock = {
      boxType: 'post_lock',
      value: POST_LOCK_THREAD_COST,
      originalValue: POST_LOCK_THREAD_COST,
      owner: ownerPubKey,
      targetPostId: 'a'.repeat(64),
      guard: 'block_apply',
      note: 'x',
    };
    const r = validateTx(
      deps,
      signedTx([karma.id!], [karmaChange(100n - POST_LOCK_THREAD_COST), strayLock]),
      10,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/unexpected key 'note'/);
    expect(deps.getBox(karma.id!)).not.toBeNull();
  });

  it('honest karma → karma + post_lock applies and round-trips id-clean', () => {
    const karma = seedKarma(100n);
    const lock = {
      boxType: 'post_lock',
      value: POST_LOCK_THREAD_COST,
      originalValue: POST_LOCK_THREAD_COST,
      owner: ownerPubKey,
      targetPostId: 'a'.repeat(64),
      guard: 'block_apply',
    };
    const tx = signedTx([karma.id!], [karmaChange(100n - POST_LOCK_THREAD_COST), lock]);
    const r = validateTx(deps, tx, 10);
    expect(r.valid, r.error).toBe(true);
    applyTx(deps, tx, r.computedOutputs!, 10);
    for (const out of r.computedOutputs!) expectIdClean(out.id!);
  });

  it('honest karma → karma + invite + bond applies and round-trips id-clean', () => {
    const karma = seedKarma(100n);
    const invite = {
      boxType: 'invite',
      value: INVITE_KARMA_AMOUNT,
      secretHash: new Uint8Array(32).fill(0xaa),
      inviterId: ownerPubKey,
      guard: 'hash_preimage_with_bond',
    };
    const bond = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      inviterId: ownerPubKey,
      inviteOutputIndex: 1,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual',
    };
    const tx = signedTx(
      [karma.id!],
      [karmaChange(100n - INVITE_KARMA_AMOUNT - INVITE_BOND_KARMA), invite, bond],
    );
    const r = validateTx(deps, tx, 10);
    expect(r.valid, r.error).toBe(true);
    applyTx(deps, tx, r.computedOutputs!, 10);
    for (const out of r.computedOutputs!) expectIdClean(out.id!);
  });

  it('honest credit → credit (lockedUntilBlock present) applies and round-trips id-clean', () => {
    const credit = seedCredit(40n);
    const out = {
      boxType: 'credit',
      value: 40n,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 1,
      lockedUntilBlock: 500,
    };
    const tx = signedTx([credit.id!], [out]);
    const r = validateTx(deps, tx, 10);
    expect(r.valid, r.error).toBe(true);
    applyTx(deps, tx, r.computedOutputs!, 10);
    for (const o of r.computedOutputs!) expectIdClean(o.id!);
  });

  it('honest karma → karma + vouch (and karma with decayBurn) applies and round-trips id-clean', () => {
    const karma = seedKarma(100n);
    const vouch = {
      boxType: 'vouch',
      value: VOUCH_KARMA_AMOUNT,
      voucherId: ownerPubKey,
      targetId: new Uint8Array(32).fill(0xcc),
      guard: 'owner_signature',
    };
    const change = { ...karmaChange(100n - VOUCH_KARMA_AMOUNT), decayBurn: true };
    const tx = signedTx([karma.id!], [change, vouch]);
    const r = validateTx(deps, tx, 10);
    expect(r.valid, r.error).toBe(true);
    applyTx(deps, tx, r.computedOutputs!, 10);
    for (const o of r.computedOutputs!) expectIdClean(o.id!);
  });
});
