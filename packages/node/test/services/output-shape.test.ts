/**
 * Output shape — the closed per-boxType schema (guard-shape pin,
 * NODE_INTERFACE → "Output shape").
 *
 * Two layers:
 *  - direct `checkOutputShape` calls for the schema mechanics (stray key,
 *    missing key, present-with-undefined, unknown boxType, the provenance-trio
 *    skip) — the unknown-boxType arm is reachable ONLY directly, because every
 *    transition arm already rejects unknown output types on its own;
 *  - full `validateTx` runs against a real store for the consensus surface:
 *    every boxType's honest shape still validates through a legal transition
 *    (including the two declared optionals present and absent), and each of
 *    the six boxTypes rejects a wrong-but-known-elsewhere guard.
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
import type {
  AnyBox,
  AnyBoxCandidate,
  KarmaBox,
  CreditBox,
  UtxoTransaction,
} from '@dagsocial/types';
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
import { validateTx, checkOutputShape } from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';

function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

/** Honest candidate per boxType, parameterized on an owner key. */
function honestCandidate(
  boxType: string,
  owner: Uint8Array,
): Record<string, unknown> {
  switch (boxType) {
    case 'karma':
      return {
        boxType: 'karma',
        value: 10n,
        owner,
        guard: 'owner_signature',
        proofSource: 'test',
      };
    case 'credit':
      return {
        boxType: 'credit',
        value: 10n,
        owner,
        guard: 'owner_signature',
        proofSource: 7,
      };
    case 'invite':
      return {
        boxType: 'invite',
        value: 10n,
        secretHash: new Uint8Array(32).fill(0xaa),
        inviterId: owner,
        guard: 'hash_preimage_with_bond',
      };
    case 'bond':
      return {
        boxType: 'bond',
        value: 10n,
        inviterId: owner,
        inviteOutputIndex: 1,
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'bond_dual',
      };
    case 'post_lock':
      return {
        boxType: 'post_lock',
        value: 10n,
        originalValue: 10n,
        owner,
        targetPostId: 'a'.repeat(64),
        guard: 'block_apply',
      };
    case 'vouch':
      return {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        voucherId: owner,
        targetId: new Uint8Array(32).fill(0xcc),
        guard: 'owner_signature',
      };
    default:
      throw new Error(`no honest candidate for ${boxType}`);
  }
}

const BOX_TYPES = ['karma', 'credit', 'invite', 'bond', 'post_lock', 'vouch'] as const;

/** A guard string that is canonical for a DIFFERENT boxType. */
const WRONG_GUARD: Record<(typeof BOX_TYPES)[number], string> = {
  karma: 'block_apply',
  credit: 'block_apply',
  invite: 'owner_signature',
  bond: 'owner_signature',
  post_lock: 'owner_signature',
  vouch: 'bond_dual',
};

function shapeOf(outputs: unknown[]) {
  return checkOutputShape(outputs as AnyBoxCandidate[]);
}

// ---------------------------------------------------------------------------
// Direct checkOutputShape tests (no store)
// ---------------------------------------------------------------------------

describe('checkOutputShape (direct)', () => {
  const owner = new Uint8Array(32).fill(1);

  it('accepts every boxType honest shape', () => {
    for (const t of BOX_TYPES) {
      const r = shapeOf([honestCandidate(t, owner)]);
      expect(r.valid, `${t}: ${r.error}`).toBe(true);
    }
  });

  it('accepts the declared optionals present (karma.decayBurn, credit.lockedUntilBlock)', () => {
    expect(shapeOf([{ ...honestCandidate('karma', owner), decayBurn: true }]).valid).toBe(true);
    expect(
      shapeOf([{ ...honestCandidate('credit', owner), lockedUntilBlock: 500 }]).valid,
    ).toBe(true);
  });

  it('tolerates client-supplied id/txId/index (candidate form — structurally stripped from all committed bytes)', () => {
    const r = shapeOf([
      { ...honestCandidate('karma', owner), id: 'ff'.repeat(32), txId: 'aa'.repeat(32), index: 3 },
    ]);
    expect(r.valid, r.error).toBe(true);
  });

  it('rejects an unknown boxType with a clean UtxoResult error', () => {
    const r = shapeOf([{ boxType: 'wat', value: 10n, guard: 'owner_signature' }]);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/unknown boxType/);
  });

  it('rejects a stray key on every boxType', () => {
    for (const t of BOX_TYPES) {
      const r = shapeOf([{ ...honestCandidate(t, owner), note: 'x' }]);
      expect(r.valid, t).toBe(false);
      expect(r.error, t).toMatch(/unexpected key 'note'/);
    }
  });

  it('rejects a missing required key on every boxType (last non-guard key dropped)', () => {
    const dropped: Record<string, string> = {
      karma: 'proofSource',
      credit: 'proofSource',
      invite: 'secretHash',
      bond: 'probationEndBlock',
      post_lock: 'targetPostId',
      vouch: 'targetId',
    };
    for (const t of BOX_TYPES) {
      const c = honestCandidate(t, owner);
      delete c[dropped[t]!];
      const r = shapeOf([c]);
      expect(r.valid, t).toBe(false);
      expect(r.error, t).toMatch(new RegExp(`missing required key '${dropped[t]}'`));
    }
  });

  it('rejects an optional key present with value undefined (it enters the id preimage but not the store round-trip)', () => {
    const r = shapeOf([{ ...honestCandidate('karma', owner), decayBurn: undefined }]);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/present with value undefined/);
  });

  it('rejects a required key present with value undefined', () => {
    const r = shapeOf([{ ...honestCandidate('post_lock', owner), targetPostId: undefined }]);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/present with value undefined/);
  });

  it('rejects the wrong-but-known-elsewhere guard on every boxType', () => {
    for (const t of BOX_TYPES) {
      const r = shapeOf([{ ...honestCandidate(t, owner), guard: WRONG_GUARD[t] }]);
      expect(r.valid, t).toBe(false);
      expect(r.error, t).toMatch(/guard must be/);
    }
  });

  it('rejects the retired-reserved guard strings on the types that once wore them', () => {
    // 'hash_preimage' / 'inviter_signature' are unreachable by contract;
    // 'epoch_tally' is reserved-retired (P2-D). All are lies about the bytes.
    expect(shapeOf([{ ...honestCandidate('invite', owner), guard: 'hash_preimage' }]).valid).toBe(false);
    expect(shapeOf([{ ...honestCandidate('bond', owner), guard: 'inviter_signature' }]).valid).toBe(false);
    expect(shapeOf([{ ...honestCandidate('post_lock', owner), guard: 'epoch_tally' }]).valid).toBe(false);
  });

  it('names the offending output index in the error', () => {
    const r = shapeOf([
      honestCandidate('karma', owner),
      { ...honestCandidate('post_lock', owner), guard: 'owner_signature' },
    ]);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/index 1 \(post_lock\)/);
  });
});

// ---------------------------------------------------------------------------
// validateTx integration — real store, signed txs, legal transitions
// ---------------------------------------------------------------------------

describe('validateTx output shape (integration)', () => {
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

  function karmaChange(value: bigint): Record<string, unknown> {
    return {
      boxType: 'karma',
      value,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
    };
  }

  // ---- accept controls: one legal transition per output boxType ----

  it('accepts karma → karma (honest, decayBurn absent)', () => {
    const karma = seedKarma(100n);
    const r = validateTx(deps, signedTx([karma.id!], [karmaChange(100n)]), 10);
    expect(r.valid, r.error).toBe(true);
  });

  it('accepts karma → karma with decayBurn present', () => {
    const karma = seedKarma(100n);
    const r = validateTx(
      deps,
      signedTx([karma.id!], [{ ...karmaChange(100n), decayBurn: true }]),
      10,
    );
    expect(r.valid, r.error).toBe(true);
  });

  it('accepts credit → credit (honest, lockedUntilBlock absent and present)', () => {
    const c1 = seedCredit(40n);
    const r1 = validateTx(
      deps,
      signedTx(
        [c1.id!],
        [{ boxType: 'credit', value: 40n, owner: ownerPubKey, guard: 'owner_signature', proofSource: 1 }],
      ),
      10,
    );
    expect(r1.valid, r1.error).toBe(true);

    const r2 = validateTx(
      deps,
      signedTx(
        [c1.id!],
        [
          {
            boxType: 'credit',
            value: 40n,
            owner: ownerPubKey,
            guard: 'owner_signature',
            proofSource: 1,
            lockedUntilBlock: 500,
          },
        ],
      ),
      10,
    );
    expect(r2.valid, r2.error).toBe(true);
  });

  it('accepts karma → karma + post_lock (honest)', () => {
    const karma = seedKarma(100n);
    const lock = {
      boxType: 'post_lock',
      value: POST_LOCK_THREAD_COST,
      originalValue: POST_LOCK_THREAD_COST,
      owner: ownerPubKey,
      targetPostId: 'a'.repeat(64),
      guard: 'block_apply',
    };
    const r = validateTx(
      deps,
      signedTx([karma.id!], [karmaChange(100n - POST_LOCK_THREAD_COST), lock]),
      10,
    );
    expect(r.valid, r.error).toBe(true);
  });

  it('accepts karma → karma + vouch (honest)', () => {
    const karma = seedKarma(100n);
    const vouch = {
      boxType: 'vouch',
      value: VOUCH_KARMA_AMOUNT,
      voucherId: ownerPubKey,
      targetId: new Uint8Array(32).fill(0xcc),
      guard: 'owner_signature',
    };
    const r = validateTx(
      deps,
      signedTx([karma.id!], [karmaChange(100n - VOUCH_KARMA_AMOUNT), vouch]),
      10,
    );
    expect(r.valid, r.error).toBe(true);
  });

  it('accepts karma → karma + invite + bond (honest, uncommitted bond)', () => {
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
    const change = karmaChange(100n - INVITE_KARMA_AMOUNT - INVITE_BOND_KARMA);
    const r = validateTx(deps, signedTx([karma.id!], [change, invite, bond]), 10);
    expect(r.valid, r.error).toBe(true);
  });

  // ---- guard rejects: same legal transitions, one guard flipped ----

  it('rejects karma output with guard block_apply', () => {
    const karma = seedKarma(100n);
    const r = validateTx(
      deps,
      signedTx([karma.id!], [{ ...karmaChange(100n), guard: 'block_apply' }]),
      10,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/\(karma\): guard must be 'owner_signature'/);
  });

  it('rejects credit output with guard block_apply', () => {
    const c = seedCredit(40n);
    const r = validateTx(
      deps,
      signedTx(
        [c.id!],
        [
          {
            boxType: 'credit',
            value: 40n,
            owner: ownerPubKey,
            guard: 'block_apply',
            proofSource: 1,
          },
        ],
      ),
      10,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/\(credit\): guard must be 'owner_signature'/);
  });

  it('rejects post_lock output with guard owner_signature (the before-leg probe)', () => {
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
    expect(r.error).toMatch(/\(post_lock\): guard must be 'block_apply'/);
  });

  it('rejects vouch output with guard bond_dual', () => {
    const karma = seedKarma(100n);
    const vouch = {
      boxType: 'vouch',
      value: VOUCH_KARMA_AMOUNT,
      voucherId: ownerPubKey,
      targetId: new Uint8Array(32).fill(0xcc),
      guard: 'bond_dual',
    };
    const r = validateTx(
      deps,
      signedTx([karma.id!], [karmaChange(100n - VOUCH_KARMA_AMOUNT), vouch]),
      10,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/\(vouch\): guard must be 'owner_signature'/);
  });

  it('rejects invite output with guard owner_signature and bond output with guard owner_signature', () => {
    const karma = seedKarma(100n);
    const invite = (guard: string) => ({
      boxType: 'invite',
      value: INVITE_KARMA_AMOUNT,
      secretHash: new Uint8Array(32).fill(0xaa),
      inviterId: ownerPubKey,
      guard,
    });
    const bond = (guard: string) => ({
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      inviterId: ownerPubKey,
      inviteOutputIndex: 1,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard,
    });
    const change = karmaChange(100n - INVITE_KARMA_AMOUNT - INVITE_BOND_KARMA);

    const r1 = validateTx(
      deps,
      signedTx([karma.id!], [change, invite('owner_signature'), bond('bond_dual')]),
      10,
    );
    expect(r1.valid).toBe(false);
    expect(r1.error).toMatch(/\(invite\): guard must be 'hash_preimage_with_bond'/);

    const r2 = validateTx(
      deps,
      signedTx([karma.id!], [change, invite('hash_preimage_with_bond'), bond('owner_signature')]),
      10,
    );
    expect(r2.valid).toBe(false);
    expect(r2.error).toMatch(/\(bond\): guard must be 'bond_dual'/);
  });

  // ---- key-set rejects through the full pipeline ----

  it('rejects a stray key through validateTx (honest guard + note)', () => {
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
  });

  it('rejects a missing required key through validateTx (post_lock without targetPostId)', () => {
    const karma = seedKarma(100n);
    const lock = {
      boxType: 'post_lock',
      value: POST_LOCK_THREAD_COST,
      originalValue: POST_LOCK_THREAD_COST,
      owner: ownerPubKey,
      guard: 'block_apply',
    };
    const r = validateTx(
      deps,
      signedTx([karma.id!], [karmaChange(100n - POST_LOCK_THREAD_COST), lock]),
      10,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/missing required key 'targetPostId'/);
  });

  it('rejects an optional key present with undefined through validateTx (CBOR can encode it, the store cannot round-trip it)', () => {
    const karma = seedKarma(100n);
    const r = validateTx(
      deps,
      signedTx([karma.id!], [{ ...karmaChange(100n), decayBurn: undefined }]),
      10,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/present with value undefined/);
  });

  // ---- unknown boxType: the step-4 schema rejects it first ----
  // Inverted by the field-type pin: the shape check now runs at step 4, ahead
  // of the transition arms, so ITS unknown-boxType arm is the primary gate
  // and the karma arm's totality count is the defense-in-depth layer behind
  // it. The tightened assertion doubles as the placement pin — moving the
  // check back behind the arms resurfaces the arm's wording and fails here.
  it('rejects an unknown output boxType at the shape gate (the transition arm backstops it)', () => {
    const karma = seedKarma(100n);
    const alien = { boxType: 'wat', value: 10n, guard: 'owner_signature' };
    const r = validateTx(deps, signedTx([karma.id!], [{ ...karmaChange(90n) }, alien]), 10);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/unknown boxType wat/);
  });
});
