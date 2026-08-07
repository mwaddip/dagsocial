// ---------------------------------------------------------------------------
// P2-B phase 2 — vouch integrity + the born-committed bond (audit
// F-consensus-3, B6, and two holes found deriving the phase: the unpinned
// voucherId and the invite-create arm).
//
// Every attack below was first written in its ACCEPTANCE form and run against
// HEAD, where all of them passed — these are transactions the engine used to
// accept, not hypothetical shapes. Each keeps its own reachability note.
//
// Each attack is paired with a non-vacuity control: the same transaction
// differing only in the field the new rule pins, proving the rejection
// isolates that one rule rather than tripping over conservation, a guard, or
// a malformed fixture.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  createHash,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  computeBoxId,
  computeTxId,
  VOUCH_KARMA_AMOUNT,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
} from '@dagsocial/types';
import type {
  AnyBox,
  KarmaBox,
  InviteBox,
  BondBox,
  VouchBox,
  UtxoTransaction,
} from '@dagsocial/types';
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
  insertVouchCooldown,
  hasActiveVouchCooldown as storeHasActiveVouchCooldown,
} from '../../src/store/index.js';
import { validateTx } from '../../src/services/utxo-engine.js';
import { castVouch } from '../../src/services/vouch.js';
import { createInvite } from '../../src/services/invites.js';

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

describe('P2-B phase 2 — vouch integrity + born-committed bond', () => {
  let db: Database.Database;
  let voucher: TestKeys;
  let target: TestKeys;

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
      // Present from the before-leg on so both halves run the same fixture
      // code: HEAD ignores it, the tightened engine requires it. Backed by the
      // store's real predicate — the one implementation every path shares.
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
    voucher = makeKeys();
    target = makeKeys();
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

  /**
   * A vouch cast K(v) → K(v − stake) + Vouch(stake), signed by `signer`.
   * `voucherIdInBox` defaults to the signer but is a free field — the runtime
   * shape is attacker-supplied CBOR, not bound by the VouchBox type.
   */
  function buildVouchCast(
    karmaBox: KarmaBox,
    signer: TestKeys,
    opts: {
      stake?: bigint;
      voucherIdInBox?: Uint8Array;
      targetId?: Uint8Array;
    } = {},
  ): UtxoTransaction {
    const stake = opts.stake ?? VOUCH_KARMA_AMOUNT;
    const vouchOut = {
      boxType: 'vouch' as const,
      value: stake,
      voucherId: opts.voucherIdInBox ?? signer.pub,
      targetId: opts.targetId ?? target.pub,
      guard: 'owner_signature' as const,
    } as unknown as VouchBox;
    const karmaOut: KarmaBox = {
      boxType: 'karma',
      value: karmaBox.value - stake,
      owner: karmaBox.owner,
      guard: 'owner_signature',
      proofSource: 'vouch_op',
    };
    const tx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [karmaOut, vouchOut],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, signer);
    return tx;
  }

  // -------------------------------------------------------------------------
  // V1 — the stake is unpinned in both directions (audit F-consensus-3).
  // `checkOutputValues` permits 0n and conservation is the only other bound,
  // while the unvouch escrow writes the CONSTANT: a 0-value vouch matures
  // into 1 karma minted from nothing, a 100-value vouch destroys 99.
  // -------------------------------------------------------------------------

  it('V1: rejects a 0-value vouch cast', () => {
    // Accepted on HEAD — this exact tx returned { valid: true }, and its
    // unvouch matured into 1 karma minted from nothing (the escrow wrote the
    // constant). Measured end-to-end in vouch-value-flow.test.ts.
    const karma = seedKarma(voucher.pub, 100n);
    const tx = buildVouchCast(karma, voucher, { stake: 0n });

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('must stake exactly');
  });

  it('V1: rejects a 100-value vouch cast', () => {
    // Accepted on HEAD. The unvouch escrow wrote the constant 1, so the other
    // 99 karma were destroyed — the pin closes both directions at once.
    const karma = seedKarma(voucher.pub, 200n);
    const tx = buildVouchCast(karma, voucher, { stake: 100n });

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('must stake exactly');
  });

  it('V1 non-vacuity: the same cast staking exactly VOUCH_KARMA_AMOUNT is accepted', () => {
    const karma = seedKarma(voucher.pub, 100n);
    const tx = buildVouchCast(karma, voucher, { stake: VOUCH_KARMA_AMOUNT });

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // V2 — voucherId is unpinned at cast. `checkGuards` resolves a box's signer
  // as `owner ?? voucherId`, so a VouchBox carrying a foreign voucherId is
  // guarded by the foreign key: A stakes their karma, B unvouches it, and the
  // escrow matures to B — a karma transfer with no invite.
  // -------------------------------------------------------------------------

  it('V2: rejects a cast whose voucherId is not the karma input owner', () => {
    // Accepted on HEAD — and the consequence ran to completion there: the
    // foreign key's unvouch was guard-valid (`checkGuards` resolves a
    // VouchBox's signer as `owner ?? voucherId`), so the escrow re-minted A's
    // stake to B. The block-level half lives in vouch-value-flow.test.ts.
    const foreign = makeKeys();
    const karma = seedKarma(voucher.pub, 100n);
    const tx = buildVouchCast(karma, voucher, { voucherIdInBox: foreign.pub });

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("voucherId must be the karma input's owner");
  });

  it('V2 front door: castVouch rejects a signer that is not the voucherId', () => {
    // Accepted on HEAD: castVouch never compared the signer to voucherId, so
    // the theft was reachable through the service layer, not only through a
    // block. The consensus pin closes both doors at once.
    const foreign = makeKeys();
    seedKarma(foreign.pub, 20n, 1); // castVouch reads the voucherId's balance
    const karma = seedKarma(voucher.pub, 100n);
    const tx = buildVouchCast(karma, voucher, { voucherIdInBox: foreign.pub });

    expect(() => castVouch(deps, tx, 10)).toThrow(
      /voucherId must be the karma input's owner/,
    );
  });

  it('V2 non-vacuity: the same cast with voucherId == karma input owner is accepted', () => {
    const karma = seedKarma(voucher.pub, 100n);
    const tx = buildVouchCast(karma, voucher, { voucherIdInBox: voucher.pub });

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // V3 — no apply-time cooldown gate (B6, decided 2026-08-04, never built).
  // `hasActiveVouchCooldown` was mempool-only, so a block-embedded cast for a
  // pair with a live cooldown row reaches `insertVouchCooldown`'s INSERT OR
  // REPLACE on the next unvouch and destroys the first escrow's pending
  // re-mint on the forward path.
  // -------------------------------------------------------------------------

  it('V3: rejects a cast while an active cooldown exists for the pair', () => {
    // Accepted on HEAD — the predicate was mempool-only, so a block-embedded
    // cast reached the escrow overwrite.
    const karma = seedKarma(voucher.pub, 100n);
    insertVouchCooldown(voucher.pub, target.pub, 999, VOUCH_KARMA_AMOUNT);

    const tx = buildVouchCast(karma, voucher, {});
    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('active cooldown');
  });

  it('V3 non-vacuity: a cooldown for a different pair does not block the cast', () => {
    const otherTarget = makeKeys();
    const karma = seedKarma(voucher.pub, 100n);
    insertVouchCooldown(voucher.pub, otherTarget.pub, 999, VOUCH_KARMA_AMOUNT);

    const tx = buildVouchCast(karma, voucher, {});
    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // V4 — a BondBox can be born already-committed, so the bond is free. The
  // karma arm of `checkTransitions` checks output counts only, and
  // `createInvite` checks values and index pairing but never the commitment
  // fields. A bond born committed with a zeroed window satisfies settlement
  // immediately (expiry leg vacuously true at any height ≥ 1) while the
  // InviteBox stays live and claimable — the network's only sybil cost, free.
  // -------------------------------------------------------------------------

  /** K(100) → K(50) + Invite(25) + Bond(25), the bond's commitment fields free. */
  function buildInviteCreate(
    inviter: TestKeys,
    karmaBox: KarmaBox,
    bondFields: {
      inviteePublicKey: Uint8Array;
      probationStartBlock: number;
      probationEndBlock: number;
    },
  ): UtxoTransaction {
    const secret = new Uint8Array(Buffer.from('d'.repeat(64), 'hex'));
    const secretHash = new Uint8Array(
      createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32),
    );
    const karmaOut: KarmaBox = {
      boxType: 'karma',
      value: karmaBox.value - INVITE_KARMA_AMOUNT - INVITE_BOND_KARMA,
      owner: inviter.pub,
      guard: 'owner_signature',
      proofSource: 'invite_op',
    };
    const inviteOut = {
      boxType: 'invite' as const,
      value: INVITE_KARMA_AMOUNT,
      secretHash,
      inviterId: inviter.pub,
      guard: 'hash_preimage_with_bond' as const,
    } as InviteBox;
    const bondOut = {
      boxType: 'bond' as const,
      value: INVITE_BOND_KARMA,
      inviterId: inviter.pub,
      inviteOutputIndex: 1,
      ...bondFields,
      guard: 'bond_dual' as const,
    } as BondBox;
    const tx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [karmaOut, inviteOut, bondOut],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, inviter);
    return tx;
  }

  it('V4: rejects an invite create whose bond is born committed', () => {
    // Accepted on HEAD — and so was the second leg: the same bond settled
    // straight back to the inviter at height 1 (committed ✓, owner ✓, expiry
    // leg vacuously true over a zeroed window) while the InviteBox stayed
    // live and claimable. Both legs green meant the bond — the network's only
    // sybil cost — cost nothing.
    const inviter = makeKeys();
    const karma = seedKarma(inviter.pub, 100n);
    const createTx = buildInviteCreate(inviter, karma, {
      inviteePublicKey: inviter.pub,
      probationStartBlock: 0,
      probationEndBlock: 0,
    });

    const result = validateTx(deps, createTx, 1);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('must emit an uncommitted bond');
  });

  it('V4: rejects a bond born with a non-zero probationStartBlock', () => {
    // The window fields are pinned independently of the key: pre-filled
    // probation state is exactly what would let a later commit-shaped step
    // inherit a window it never passed through the commit pin.
    const inviter = makeKeys();
    const karma = seedKarma(inviter.pub, 100n);
    const createTx = buildInviteCreate(inviter, karma, {
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 5,
      probationEndBlock: 0,
    });

    const result = validateTx(deps, createTx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('must emit an uncommitted bond');
  });

  it('V4: rejects a bond born with a non-zero probationEndBlock', () => {
    const inviter = makeKeys();
    const karma = seedKarma(inviter.pub, 100n);
    const createTx = buildInviteCreate(inviter, karma, {
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 1005,
    });

    const result = validateTx(deps, createTx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('must emit an uncommitted bond');
  });

  it('V4 service path: createInvite rejects a born-committed bond', () => {
    // Accepted on HEAD: createInvite checked values and index pairing but
    // never the commitment fields, and the demo UI drives this path.
    const inviter = makeKeys();
    const karma = seedKarma(inviter.pub, 100n);
    const createTx = buildInviteCreate(inviter, karma, {
      inviteePublicKey: inviter.pub,
      probationStartBlock: 0,
      probationEndBlock: 0,
    });

    expect(() => createInvite(deps, createTx, 1)).toThrow(
      /must emit an uncommitted bond/,
    );
  });

  it('V4 non-vacuity: the same create with an uncommitted zeroed bond is accepted', () => {
    const inviter = makeKeys();
    const karma = seedKarma(inviter.pub, 100n);
    const createTx = buildInviteCreate(inviter, karma, {
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
    });

    const result = validateTx(deps, createTx, 1);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
