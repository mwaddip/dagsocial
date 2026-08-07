// ---------------------------------------------------------------------------
// P2-B phase 1 — bond transition tightening (audit F-consensus-1).
//
// Every rejection test here was first written in its ACCEPTANCE form and run
// against HEAD, where all five passed — the transactions below are not
// hypothetical shapes, they are attacks the engine used to accept. Each keeps
// its own reachability note.
//
// Each attack is paired with a non-vacuity control: the same transaction
// differing only in the field the new rule pins. The control is the acceptance
// half — it proves the rejection isolates that one rule rather than tripping
// over conservation, a guard, or a malformed fixture.
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
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
  INVITE_KARMA_THRESHOLD,
  INVITE_PROBATION_BLOCKS,
} from '@dagsocial/types';
import type {
  AnyBox,
  KarmaBox,
  InviteBox,
  BondBox,
  UtxoTransaction,
} from '@dagsocial/types';
import Database from 'better-sqlite3';

import { seedAsOneTx, fixtureProvenance, rawPublicKey } from '../helpers.js';
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
} from '../../src/store/index.js';
import { validateTx } from '../../src/services/utxo-engine.js';
import { computeTxId } from '@dagsocial/types';

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

describe('P2-B bond tightening (audit F-consensus-1)', () => {
  let db: Database.Database;
  let inviter: TestKeys;
  let invitee: TestKeys;
  let secret: Uint8Array;
  let secretHash: Uint8Array;

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
      // Present from the before-leg on so both halves run the same fixture
      // code; HEAD ignores it, the tightened engine requires it.
      getKarmaValue: (owner: Uint8Array): bigint =>
        getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
    };
  }

  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();
    inviter = makeKeys();
    invitee = makeKeys();
    secret = new Uint8Array(Buffer.from('c'.repeat(64), 'hex'));
    secretHash = new Uint8Array(
      createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32),
    );
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
   * Seed a committed bond standalone. Faithful to post-commit state: a real
   * committed bond's provenance points at the commit tx, so the invite it
   * shipped with is NOT resolvable through (txId, inviteOutputIndex) anyway
   * (the F-consensus-5 residual) — nothing in the attacks below consults it.
   */
  function seedCommittedBond(probationStartBlock: number, probationEndBlock: number): BondBox {
    const candidate = {
      boxType: 'bond' as const,
      value: INVITE_BOND_KARMA,
      inviterId: inviter.pub,
      inviteOutputIndex: 0,
      inviteePublicKey: invitee.pub,
      probationStartBlock,
      probationEndBlock,
      guard: 'bond_dual' as const,
    };
    Object.assign(candidate, fixtureProvenance(candidate, 1));
    const box = { ...candidate, id: computeBoxId(candidate) } as BondBox;
    storeInsertBox(box);
    return box;
  }

  /**
   * Seed an invite + uncommitted bond as outputs 0 and 1 of one synthetic
   * transaction — the bond commit guard resolves the invite from
   * (bond.txId, bond.inviteOutputIndex).
   */
  function seedInviteAndUncommittedBond(): { invite: InviteBox; bond: BondBox } {
    const inviteCandidate = {
      boxType: 'invite' as const,
      value: INVITE_KARMA_AMOUNT,
      secretHash,
      inviterId: inviter.pub,
      guard: 'hash_preimage_with_bond' as const,
    };
    const bondCandidate = {
      boxType: 'bond' as const,
      value: INVITE_BOND_KARMA,
      inviterId: inviter.pub,
      inviteOutputIndex: 0,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual' as const,
    };
    const [invite, bond] = seedAsOneTx([inviteCandidate, bondCandidate]);
    storeInsertBox(invite!);
    storeInsertBox(bond!);
    return { invite: invite as InviteBox, bond: bond as BondBox };
  }

  /** Same pairing, but the bond is already committed to the invitee. */
  function seedInviteAndCommittedBond(
    probationStartBlock: number,
    probationEndBlock: number,
  ): { invite: InviteBox; bond: BondBox } {
    const inviteCandidate = {
      boxType: 'invite' as const,
      value: INVITE_KARMA_AMOUNT,
      secretHash,
      inviterId: inviter.pub,
      guard: 'hash_preimage_with_bond' as const,
    };
    const bondCandidate = {
      boxType: 'bond' as const,
      value: INVITE_BOND_KARMA,
      inviterId: inviter.pub,
      inviteOutputIndex: 0,
      inviteePublicKey: invitee.pub,
      probationStartBlock,
      probationEndBlock,
      guard: 'bond_dual' as const,
    };
    const [invite, bond] = seedAsOneTx([inviteCandidate, bondCandidate]);
    storeInsertBox(invite!);
    storeInsertBox(bond!);
    return { invite: invite as InviteBox, bond: bond as BondBox };
  }

  // -------------------------------------------------------------------------
  // 1. settlement-theft — the committed invitee signs bond → own KarmaBox and
  //    takes the deposit. Height 2000 is past probationEndBlock, so the bond is
  //    unlocked and the ONLY thing standing between this tx and acceptance is
  //    the owner pin.
  // -------------------------------------------------------------------------

  /** Build an unlocked settlement of `bond` paying `beneficiary`, invitee-signed. */
  function buildSettlementTx(bond: BondBox, beneficiary: Uint8Array): UtxoTransaction {
    const karmaOut: KarmaBox = {
      boxType: 'karma',
      value: INVITE_BOND_KARMA,
      owner: beneficiary,
      guard: 'owner_signature',
      proofSource: 'bond-settle',
    };
    const tx: UtxoTransaction = {
      inputs: [bond.id!],
      outputs: [karmaOut],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, invitee);
    return tx;
  }

  it('settlement-theft: rejects an invitee-owned karma output on a bond settlement', () => {
    // Accepted on HEAD — this exact tx returned { valid: true }.
    const bond = seedCommittedBond(5, 1005);
    const result = validateTx(deps, buildSettlementTx(bond, invitee.pub), 2000);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('must be owned by the inviter');
  });

  it('settlement non-vacuity: the same settlement to the inviter is accepted', () => {
    // Identical but for the karma output's owner, so the rejection above is the
    // owner pin and nothing else — signature, conservation and unlock all pass
    // here on a tx the invitee signed.
    const bond = seedCommittedBond(5, 1005);
    const result = validateTx(deps, buildSettlementTx(bond, inviter.pub), 2000);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 1b. The unlock predicate: probation expired OR the invitee's summed
  //     unspent karma ≥ INVITE_KARMA_THRESHOLD, read at spend time.
  // -------------------------------------------------------------------------
  it('unlock-condition: rejects settlement during probation with the invitee below threshold', () => {
    const bond = seedCommittedBond(5, 1005);
    // 19 < INVITE_KARMA_THRESHOLD (20), height 100 is inside probation.
    seedKarma(invitee.pub, INVITE_KARMA_THRESHOLD - 1n, 7);
    const result = validateTx(deps, buildSettlementTx(bond, inviter.pub), 100);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('locked');
  });

  it('unlock-condition: accepts settlement during probation once the invitee meets the threshold', () => {
    const bond = seedCommittedBond(5, 1005);
    seedKarma(invitee.pub, INVITE_KARMA_THRESHOLD, 7);
    const result = validateTx(deps, buildSettlementTx(bond, inviter.pub), 100);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('unlock-condition: karma is summed across boxes, not read one box at a time', () => {
    // Two boxes of 10 meet the threshold of 20; either alone does not. Multiple
    // unspent karma boxes per owner is reachable (faucet grant + mint, or a
    // split), so a single-box read would make the threshold depend on how the
    // invitee's karma happens to be partitioned.
    const bond = seedCommittedBond(5, 1005);
    seedKarma(invitee.pub, INVITE_KARMA_THRESHOLD / 2n, 7);
    seedKarma(invitee.pub, INVITE_KARMA_THRESHOLD / 2n, 8);
    const result = validateTx(deps, buildSettlementTx(bond, inviter.pub), 100);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('rejects a settlement consuming more than one bond', () => {
    // Not in the audit finding, found while implementing it. `inputs[0]` is the
    // only bond whose inviter and probation a settlement can check, so a second
    // bond in the same transaction would ride along unchecked — and one invitee
    // committed on two different inviters' bonds satisfies both `bond_dual`
    // guards with a single signature. Without an input-count bound, bond B's
    // value settles to bond A's inviter.
    const bondA = seedCommittedBond(5, 1005);
    const otherInviter = makeKeys();
    const candidate = {
      boxType: 'bond' as const,
      value: INVITE_BOND_KARMA,
      inviterId: otherInviter.pub,
      inviteOutputIndex: 0,
      inviteePublicKey: invitee.pub,
      probationStartBlock: 5,
      probationEndBlock: 1005,
      guard: 'bond_dual' as const,
    };
    Object.assign(candidate, fixtureProvenance(candidate, 2));
    const bondB = { ...candidate, id: computeBoxId(candidate) } as BondBox;
    storeInsertBox(bondB);

    const karmaOut: KarmaBox = {
      boxType: 'karma',
      value: INVITE_BOND_KARMA * 2n,
      owner: inviter.pub,
      guard: 'owner_signature',
      proofSource: 'bond-settle',
    };
    const tx: UtxoTransaction = {
      inputs: [bondA.id!, bondB.id!],
      outputs: [karmaOut],
      signatures: {},
      protocolVersion: 1,
    };
    // One signature. It is the committed invitee's on both bonds, so every
    // guard passes — the input-count bound is the only thing rejecting this.
    addSignature(tx, invitee);

    const result = validateTx(deps, tx, 2000);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('exactly one BondBox');
  });

  it('rejects a standalone spend of an uncommitted bond', () => {
    // The uncommitted bond's only exits are the commit and cancel shapes: a
    // standalone spend would strand the paired invite, which can never be
    // claimed without a bond input.
    const { bond } = seedInviteAndUncommittedBond();
    const karmaOut: KarmaBox = {
      boxType: 'karma',
      value: INVITE_BOND_KARMA,
      owner: inviter.pub,
      guard: 'owner_signature',
      proofSource: 'bond-settle',
    };
    const tx: UtxoTransaction = {
      inputs: [bond.id!],
      outputs: [karmaOut],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, inviter);

    const result = validateTx(deps, tx, 2000);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('no standalone spend');
  });

  // -------------------------------------------------------------------------
  // 2. cancel-absorb — an invitee who already holds karma satisfies every
  //    guard on the 3-input cancel shape with only their own signature plus
  //    the invite preimage; the cancel arm pins output karma to the *karma
  //    input's* owner, never to the inviter.
  // -------------------------------------------------------------------------
  it('cancel-absorb: rejects a cancel whose karma owner is not the inviter', () => {
    // Accepted on HEAD — this exact tx returned { valid: true }. The cancel arm
    // pinned the output only to the *karma input's* owner, which the invitee's
    // own box satisfies trivially.
    const inviteeKarma = seedKarma(invitee.pub, 100n);
    const { invite, bond } = seedInviteAndCommittedBond(5, 1005);

    const karmaOut: KarmaBox = {
      boxType: 'karma',
      value: 100n + INVITE_KARMA_AMOUNT + INVITE_BOND_KARMA,
      owner: invitee.pub,
      guard: 'owner_signature',
      proofSource: 'invite-cancel',
    };
    const tx: UtxoTransaction = {
      inputs: [inviteeKarma.id!, invite.id!, bond.id!],
      outputs: [karmaOut],
      signatures: {},
      preimages: { [invite.id!]: secret },
      protocolVersion: 1,
    };
    addSignature(tx, invitee);

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('inviterId');
  });

  it('cancel non-vacuity: the same cancel by the inviter is accepted', () => {
    // Same three input types, same shape; only the karma input and the
    // beneficiary change hands. So the rejection above is the inviterId pin —
    // the preimage, the guards and conservation are all satisfied either way.
    const inviterKarma = seedKarma(inviter.pub, 100n);
    const { invite, bond } = seedInviteAndCommittedBond(5, 1005);

    const karmaOut: KarmaBox = {
      boxType: 'karma',
      value: 100n + INVITE_KARMA_AMOUNT + INVITE_BOND_KARMA,
      owner: inviter.pub,
      guard: 'owner_signature',
      proofSource: 'invite-cancel',
    };
    const tx: UtxoTransaction = {
      inputs: [inviterKarma.id!, invite.id!, bond.id!],
      outputs: [karmaOut],
      signatures: {},
      preimages: { [invite.id!]: secret },
      protocolVersion: 1,
    };
    addSignature(tx, inviter);

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 3. bond-burn — outputs: [] on a bond input is legal for anyone whose
  //    signature satisfies bond_dual; the committed invitee torches the
  //    inviter's stake.
  // -------------------------------------------------------------------------
  it('bond-burn: rejects a zero-output bond spend', () => {
    // Accepted on HEAD — this exact tx returned { valid: true }, letting the
    // committed invitee torch the inviter's stake out of spite.
    //
    // Two independent layers reject it now: conservation (the zero-output
    // exemption is vouch-only) and the transition arm ("no burn shape").
    // Conservation is step 4 and transitions are step 6, so it is the
    // arithmetic message that surfaces here — the transition arm is the
    // belt-and-braces layer, unreachable through validateTx by construction.
    const bond = seedCommittedBond(5, 1005);

    const tx: UtxoTransaction = {
      inputs: [bond.id!],
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, invitee);

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Value non-conservation');
  });

  it('bond-burn: the inviter cannot burn their own bond either', () => {
    // Not an authorisation rule — there is no burn shape for anyone. Without
    // this, "no burn" could be read as "no burn by the invitee" and satisfied
    // by a signature check.
    const bond = seedCommittedBond(5, 1005);

    const tx: UtxoTransaction = {
      inputs: [bond.id!],
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, inviter);

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Value non-conservation');
  });

  it('bond-burn non-vacuity: the unvouch zero-output spend keeps its exemption', () => {
    // The vouch escrow round-trip is the one legal zero-output spend, so the
    // burn rejection above is bond-specific rather than a blanket ban that
    // would have taken unvouch down with it.
    const candidate = {
      boxType: 'vouch' as const,
      value: 1n,
      voucherId: inviter.pub,
      targetId: invitee.pub,
      guard: 'owner_signature' as const,
    };
    Object.assign(candidate, fixtureProvenance(candidate, 1));
    const vouchBox = { ...candidate, id: computeBoxId(candidate) } as AnyBox;
    storeInsertBox(vouchBox);

    const tx: UtxoTransaction = {
      inputs: [vouchBox.id!],
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, inviter);

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 4. grief-commit — the commit arm checks only end > start, so the
  //    committing invitee locks the bond effectively forever.
  // -------------------------------------------------------------------------

  /** Build a commit of `bond` with the given probation window, invitee-signed. */
  function buildCommitTx(
    bond: BondBox,
    probationStartBlock: number,
    probationEndBlock: number,
  ): UtxoTransaction {
    const bondOut: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      inviterId: inviter.pub,
      inviteOutputIndex: 0,
      inviteePublicKey: invitee.pub,
      probationStartBlock,
      probationEndBlock,
      guard: 'bond_dual',
    };
    const tx: UtxoTransaction = {
      inputs: [bond.id!],
      outputs: [bondOut],
      signatures: {},
      preimages: { [bond.id!]: secret },
      protocolVersion: 1,
    };
    addSignature(tx, invitee);
    return tx;
  }

  it('grief-commit: rejects a probation window longer than INVITE_PROBATION_BLOCKS', () => {
    // Accepted on HEAD — this exact tx returned { valid: true }, locking the
    // inviter's bond for 10**9 blocks at the committing invitee's discretion.
    const { bond } = seedInviteAndUncommittedBond();
    const result = validateTx(deps, buildCommitTx(bond, 5, 5 + 10 ** 9), 10);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid bond commit');
  });

  // -------------------------------------------------------------------------
  // 4b. grief-commit, future-dated variant — window length is exactly
  //     INVITE_PROBATION_BLOCKS, so only the start bound catches it.
  // -------------------------------------------------------------------------
  it('grief-commit (future-dated): rejects a probation start above the settle height', () => {
    // Accepted on HEAD — this exact tx returned { valid: true }. The pinned
    // length alone does not stop it: the window is exactly the right size, just
    // 10**6 blocks away.
    const { bond } = seedInviteAndUncommittedBond();
    const start = 10 + 10 ** 6;
    const result = validateTx(
      deps,
      buildCommitTx(bond, start, start + INVITE_PROBATION_BLOCKS),
      10,
    );

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid bond commit');
  });

  it('commit non-vacuity: a window of exactly INVITE_PROBATION_BLOCKS at the settle height is accepted', () => {
    const { bond } = seedInviteAndUncommittedBond();
    const result = validateTx(
      deps,
      buildCommitTx(bond, 10, 10 + INVITE_PROBATION_BLOCKS),
      10,
    );

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('commit: a past-dated probation start stays legal', () => {
    // Deliberately permitted. Past-dating only *shortens* the effective
    // probation, which favours the inviter's unlock and evades nothing while
    // forfeiture does not exist — and a strict `== settle height` would break on
    // the delay between building a commit and its being mined.
    const { bond } = seedInviteAndUncommittedBond();
    const result = validateTx(
      deps,
      buildCommitTx(bond, 4, 4 + INVITE_PROBATION_BLOCKS),
      10,
    );

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('grief-commit: rejects a window shorter than INVITE_PROBATION_BLOCKS', () => {
    // The length is pinned to equality, not to a lower bound — a one-block
    // probation would let the invitee unlock the bond immediately.
    const { bond } = seedInviteAndUncommittedBond();
    const result = validateTx(deps, buildCommitTx(bond, 5, 6), 10);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid bond commit');
  });
});
