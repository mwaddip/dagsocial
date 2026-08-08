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
import { generateKeyPairSync, sign as cryptoSign, createHash, type KeyObject } from 'crypto';
import {
  computeBoxId,
  computeTxId,
  POST_LOCK_THREAD_COST,
  VOUCH_KARMA_AMOUNT,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
  INVITE_PROBATION_BLOCKS,
} from '@dagsocial/types';
import type { AnyBox, KarmaBox, CreditBox, UtxoTransaction } from '@dagsocial/types';
import Database from 'better-sqlite3';
import { fixtureProvenance, seedAsOneTx, makeTestIdentity } from '../helpers.js';
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

  // -------------------------------------------------------------------------
  // Field-type pin: the class-4 committed-byte-lie mutants, fed to the same
  // discriminator. Each was ACCEPTED on the pre-pin tree (the before-leg
  // probes): the store then either round-tripped different bytes than the id
  // committed to (4a), silently changed the value's encoding (4b), or kept a
  // wrong-typed field forever behind a clean id (4c).
  // -------------------------------------------------------------------------

  it('class-4a mutant, now closed: hex-string post_lock owner is rejected, nothing applied', () => {
    const karma = seedKarma(100n);
    const lyingLock = {
      boxType: 'post_lock',
      value: POST_LOCK_THREAD_COST,
      originalValue: POST_LOCK_THREAD_COST,
      owner: Buffer.from(ownerPubKey).toString('hex'), // 64-char string, not bytes
      targetPostId: 'a'.repeat(64),
      guard: 'block_apply',
    };
    const r = validateTx(
      deps,
      signedTx([karma.id!], [karmaChange(100n - POST_LOCK_THREAD_COST), lyingLock]),
      10,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/\(post_lock\): field 'owner' must be a 32-byte Uint8Array/);
    // On the pre-pin tree this box was stored and its row reconstructed to
    // DIFFERENT bytes (Array.from over the string, chars coerced to numbers) —
    // computeBoxId(rowToBox(row)) !== row.id, permanently. Now: no row at all.
    expect(deps.getBox(karma.id!)).not.toBeNull();
    const locks = db
      .prepare("SELECT COUNT(*) AS n FROM utxo_boxes WHERE box_type = 'post_lock'")
      .get() as { n: number | bigint };
    expect(Number(locks.n)).toBe(0);
  });

  it('class-4b mutant, now closed: -0 in a number field is rejected (cbor float at insert, JSON 0 on read)', () => {
    const credit = seedCredit(40n);
    const out = {
      boxType: 'credit',
      value: 40n,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 1,
      lockedUntilBlock: -0,
    };
    const r = validateTx(deps, signedTx([credit.id!], [out]), 10);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/field 'lockedUntilBlock'.*got -0/);
  });

  it('class-4c mutant, now closed: bond commit with string probation fields is rejected; the honest commit round-trips id-clean', () => {
    const inviter = makeTestIdentity();
    const invitee = makeTestIdentity();
    const secret = new Uint8Array(32).fill(7);
    const secretHash = new Uint8Array(
      createHash('blake2b512').update(secret).digest().subarray(0, 32),
    );
    const invite = {
      boxType: 'invite' as const,
      value: 25n,
      secretHash,
      inviterId: inviter.userId,
      guard: 'hash_preimage_with_bond' as const,
    };
    const bond = {
      boxType: 'bond' as const,
      value: 25n,
      inviterId: inviter.userId,
      inviteOutputIndex: 0,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual' as const,
    };
    const [seededInvite, seededBond] = seedAsOneTx([invite, bond]);
    storeInsertBox(seededInvite!);
    storeInsertBox(seededBond!);

    const commitOut = (probationStartBlock: unknown, probationEndBlock: unknown) => ({
      boxType: 'bond',
      value: 25n,
      inviterId: inviter.userId,
      inviteOutputIndex: 0,
      inviteePublicKey: invitee.userId,
      probationStartBlock,
      probationEndBlock,
      guard: 'bond_dual',
    });
    const commitTx = (out: unknown): UtxoTransaction => {
      const tx: UtxoTransaction = {
        inputs: [seededBond!.id!],
        outputs: [out] as unknown as UtxoTransaction['outputs'],
        signatures: {},
        preimages: { [seededBond!.id!]: secret },
        protocolVersion: 1,
      };
      const hash = Buffer.from(computeTxId(tx), 'hex');
      tx.signatures[Buffer.from(invitee.userId).toString('hex')] = new Uint8Array(
        cryptoSign(null, hash, invitee.privateKey),
      );
      return tx;
    };

    // The before-leg P4 shape: strings pass the arm's arithmetic by coercion
    // ("1025" - "25" === INVITE_PROBATION_BLOCKS) and committed a wrong-typed
    // bond whose id round-tripped CLEAN — an undetectable lie. Now the schema
    // rejects it before the arm can coerce.
    const lying = validateTx(
      deps,
      commitTx(commitOut('25', String(25 + INVITE_PROBATION_BLOCKS))),
      100,
    );
    expect(lying.valid).toBe(false);
    expect(lying.error).toMatch(/field 'probationStartBlock' must be a non-negative safe integer/);
    // The stored bond is still uncommitted.
    const row = db
      .prepare('SELECT extra_data FROM utxo_boxes WHERE id = ?')
      .get(seededBond!.id!) as { extra_data: string };
    expect(JSON.parse(row.extra_data).inviteePublicKey).toBeNull();

    // The honest commit — same shape, typed numbers — validates, applies,
    // and its output satisfies the discriminator.
    const honestOut = commitOut(25, 25 + INVITE_PROBATION_BLOCKS);
    const honest = validateTx(deps, commitTx(honestOut), 100);
    expect(honest.valid, honest.error).toBe(true);
    applyTx(deps, commitTx(honestOut), honest.computedOutputs!, 100);
    for (const o of honest.computedOutputs!) expectIdClean(o.id!);
  });
});
