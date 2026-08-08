import {
  seedAsOneTx,
  fixtureProvenance,
  uid } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  createHash,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  computeCandidateBoxId,
  computeBoxId,
  computeTxId,
  LIKE_KARMA_COST,
  POST_LOCK_THREAD_COST,
  VOUCH_KARMA_AMOUNT,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
} from '@dagsocial/types';
import type {
  AnyBox,
  KarmaBox,
  InviteBox,
  BondBox,
  PostLockBox,
  VouchBox,
  UtxoTransaction,
} from '@dagsocial/types';
import Database from 'better-sqlite3';

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
import type { UtxoEngineDeps, UtxoResult } from '../../src/services/utxo-engine.js';

/**
 * Local convenience wrapper that replaces the removed validateAndApplyTx.
 */
function validateAndApplyTx(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): UtxoResult {
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) return result;
  applyTx(deps, tx, result.computedOutputs!, currentBlockHeight);
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract raw 32-byte Ed25519 public key from SPKI DER KeyObject. */
function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

/** Sign a 32-byte hash with Ed25519 private key. */
function signHash(hash: Uint8Array, privKey: KeyObject): Uint8Array {
  const sig = cryptoSign(null, Buffer.from(hash), privKey);
  return new Uint8Array(sig);
}

/** Compute txHash exactly as the engine does (via computeTxId). */
function computeTxHash(tx: UtxoTransaction): Uint8Array {
  return Buffer.from(computeTxId(tx), 'hex');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('validateAndApplyTx', () => {
  let db: Database.Database;
  let ownerPubKey: Uint8Array;
  let ownerPrivKey: KeyObject;
  let ownerUserId: string;

  /**
   * Create deps that wrap the real store functions.
   * `getBox` is overridden to return null for spent boxes.
   */
  function makeDeps(): UtxoEngineDeps {
    return {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        // Must also be unspent
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
  }

  let deps: UtxoEngineDeps;

  beforeEach(() => {
    // Create a fresh in-memory database and initialise schema
    initDb(':memory:');
    db = getDb();

    // Generate owner keypair (reused across tests)
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    ownerPubKey = rawPublicKey(publicKey);
    ownerPrivKey = privateKey;
    ownerUserId = ownerPubKey;


    deps = makeDeps();
  });

  afterEach(() => {
    closeDb();
  });

  /** Create a KarmaBox (without id), compute its id, and insert it. */
  function createAndInsertKarma(
    owner: Uint8Array,
    value: bigint,
    seed: number,
    proofSource = 'test',
  ): KarmaBox {
    const box: Omit<KarmaBox, 'id'> & { id?: string } = {
      boxType: 'karma',
      value,
      owner,
      guard: 'owner_signature',
      proofSource,
    };
    Object.assign(box, fixtureProvenance(box, seed));
    const id = computeBoxId(box);
    const full: KarmaBox = { ...box, id, boxType: 'karma', guard: 'owner_signature' };
    storeInsertBox(full);
    return full;
  }

  /** Build a transaction with a valid signature for the given private key. */
  function buildSignedTx(
    inputs: string[],
    rawOutputs: AnyBox[],
    privKey: KeyObject,
    pubKey: Uint8Array,
    protocolVersion = 1,
    likeTarget?: string,
  ): UtxoTransaction {
    const hexKey = Buffer.from(pubKey).toString('hex');
    const tx: UtxoTransaction = {
      inputs,
      outputs: rawOutputs,
      signatures: {},
      protocolVersion,
      ...(likeTarget !== undefined ? { likeTarget } : {}),
    };
    const hash = computeTxHash(tx);
    tx.signatures[hexKey] = signHash(hash, privKey);
    return tx;
  }

  // -------------------------------------------------------------------------
  // 1. Valid karma→karma (balance change, same owner)
  // -------------------------------------------------------------------------
  it('valid karma to karma (re-anchor, same owner, value conserved)', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 100n,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
    };

    const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();

    // Input box should now be spent
    expect(deps.getBox(karma.id!)).toBeNull();

    // Output box should exist and have an id assigned.
    //
    // Derived from the transaction's own id and the output's position, not from
    // the bare candidate: `computeBoxId` binds provenance as of phase G3b, so
    // re-deriving from a candidate with none yields a stable but meaningless id
    // — the test would look green while asserting nothing (report §F3).
    const outputBox = deps.getBox(computeCandidateBoxId(newKarma, result.txId!, 0));
    expect(outputBox).not.toBeNull();
    expect(outputBox!.boxType).toBe('karma');
    expect((outputBox as KarmaBox).value).toBe(100n);
  });

  // -------------------------------------------------------------------------
  // 2. Valid karma→karma+invite+bond (invite creation)
  // -------------------------------------------------------------------------
  it('valid karma to karma+invite+bond (invite creation)', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 70n,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
    };

    const secretHash = new Uint8Array(32).fill(0xaa);
    const inviteBox: InviteBox = {
      boxType: 'invite',
      value: 15n,
      secretHash,
      inviterId: ownerUserId,
      guard: 'hash_preimage_with_bond',
    };
    Object.assign(inviteBox, fixtureProvenance(inviteBox, 1));
    const inviteId = computeBoxId(inviteBox);

    const bondBox: BondBox = {
      boxType: 'bond',
      value: 15n,
      inviterId: ownerUserId,
      inviteOutputIndex: 0,
      // Length 0 is the uncommitted state. This fixture used 32 zero bytes,
      // which is the *committed* shape — accepted only while invite creation
      // never looked at the commitment fields (P2-B phase 2 pins them).
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual',
    };

    const tx = buildSignedTx(
      [karma.id!],
      [newKarma, inviteBox, bondBox],
      ownerPrivKey,
      ownerPubKey,
    );
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();

    // All outputs should exist
    expect(deps.getBox(computeCandidateBoxId(newKarma, result.txId!, 0))).not.toBeNull();
    expect(deps.getBox(computeCandidateBoxId(inviteBox, result.txId!, 1))).not.toBeNull();
    expect(deps.getBox(computeCandidateBoxId(bondBox, result.txId!, 2))).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 3. Valid like burn (P2-D): karma → karma at −LIKE_KARMA_COST, likeTarget
  // -------------------------------------------------------------------------
  it('valid like burn: karma → karma at −LIKE_KARMA_COST with likeTarget', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 100n - LIKE_KARMA_COST,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
    };

    const tx = buildSignedTx(
      [karma.id!],
      [newKarma],
      ownerPrivKey,
      ownerPubKey,
      1,
      'aa'.repeat(32),
    );
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
    // The input is spent, the change box exists, and no other box was minted —
    // the burned karma is simply gone from the UTXO set.
    expect(deps.getBox(karma.id!)).toBeNull();
    const changeBox = deps.getBox(computeCandidateBoxId(newKarma, result.txId!, 0));
    expect(changeBox).not.toBeNull();
    expect((changeBox as KarmaBox).value).toBe(100n - LIKE_KARMA_COST);
  });

  // -------------------------------------------------------------------------
  // 4. Rejects spent input
  // -------------------------------------------------------------------------
  it('rejects spent input', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    // Consume the box first (mark as spent)
    storeConsumeBox(karma.id!, 5);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 100n,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
    };

    const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('not found or already spent');
  });

  // -------------------------------------------------------------------------
  // 5. Karma value non-conservation rejected (audit C-1)
  // -------------------------------------------------------------------------
  it('rejects karma value non-conservation (audit C-1)', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    // Output claims 120 from a 100 input — 20 karma minted from nothing.
    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 120n,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
    };

    const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Value non-conservation');

    // Nothing applied — the input box is still unspent.
    expect(deps.getBox(karma.id!)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 6. Rejects illegal transition (owner change on karma)
  // -------------------------------------------------------------------------
  it('rejects illegal transition (owner change on karma)', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    // Different owner
    const { publicKey: otherPub } = generateKeyPairSync('ed25519');
    const otherPubRaw = rawPublicKey(otherPub);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 100n,
      owner: otherPubRaw,
      guard: 'owner_signature',
      proofSource: 'test',
    };

    const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('cannot be transferred');
  });

  // -------------------------------------------------------------------------
  // 7. Rejects missing signature for owner_signature guard
  // -------------------------------------------------------------------------
  it('rejects missing signature for owner_signature guard', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 100n,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
    };

    // Build tx WITHOUT the owner's signature
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [newKarma],
      signatures: {}, // empty — no signature
      protocolVersion: 1,
    };
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Missing or invalid owner signature');
  });

  // -------------------------------------------------------------------------
  // 8. Transaction atomic: partial failure rolls back all changes
  // -------------------------------------------------------------------------
  it('transaction atomic: partial failure rolls back all changes', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 100n,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
    };

    const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);

    // Create failing deps: insertBox always throws
    const failingDeps: UtxoEngineDeps = {
      ...deps,
      insertBox: (_box: AnyBox) => {
        throw new Error('Simulated insert failure');
      },
    };

    let threw = false;
    try {
      validateAndApplyTx(failingDeps, tx, 10);
    } catch {
      threw = true;
    }

    // Should have thrown (insertBox failure inside transaction propagates)
    expect(threw).toBe(true);

    // The consumed box should still be unspent (transaction rolled back)
    expect(deps.getBox(karma.id!)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 9. computeBoxId called for each output, IDs assigned
  // -------------------------------------------------------------------------
  it('computeBoxId called for each output, IDs assigned', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    // A karma split — two same-owner outputs, so the per-output id derivation
    // is exercised at more than one index.
    const splitA: KarmaBox = {
      boxType: 'karma',
      value: 60n,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
    };
    const splitB: KarmaBox = {
      boxType: 'karma',
      value: 40n,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test-b',
    };

    const tx = buildSignedTx(
      [karma.id!],
      [splitA, splitB],
      ownerPrivKey,
      ownerPubKey,
    );
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(true);

    // All output boxes should exist with their computed IDs, derived from the
    // transaction's own id and each output's position.
    const expectedIds = [splitA, splitB].map((c, i) =>
      computeCandidateBoxId(c, result.txId!, i),
    );
    for (const expectedId of expectedIds) {
      const box = storeGetBox(expectedId);
      expect(box).not.toBeNull();
      expect(box!.id).toBe(expectedId);
    }
  });

  // -------------------------------------------------------------------------
  // 10. validateTx checks guards and transitions but does not mutate state
  // -------------------------------------------------------------------------
  it('validateTx checks guards and transitions but does not mutate state', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 100n,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
    };

    const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
    const result = validateTx(deps, tx, 10);

    expect(result.valid).toBe(true);
    expect(result.computedOutputs).toBeDefined();
    expect(result.computedOutputs!.length).toBe(1);
    expect(result.computedOutputs![0]!.id).toBe(
      computeCandidateBoxId(newKarma, result.txId!, 0),
    );
    expect(result.txId).toBeDefined();

    // Box should still exist and be unspent (getBox returns null for spent boxes)
    const box = deps.getBox(karma.id!);
    expect(box).not.toBeNull();

    // No new boxes created — only the original karma box exists
    const bobBox = deps.getKarmaBox(ownerPubKey);
    expect(bobBox).not.toBeNull(); // the original box is still there, unchanged
  });

  // ---------------------------------------------------------------------------
  // 11. hash_preimage_with_bond guard
  // ---------------------------------------------------------------------------
  describe('hash_preimage_with_bond guard', () => {
    let inviterPubKey: Uint8Array;
    let inviterPrivKey: KeyObject;
    let inviteePubKey: Uint8Array;
    let inviteePrivKey: KeyObject;
    let inviteBoxId: string;
    let bondBoxId: string;
    let secret: Uint8Array;
    let secretHash: Uint8Array;

    beforeEach(() => {
      const inviterKeys = generateKeyPairSync('ed25519');
      inviterPubKey = rawPublicKey(inviterKeys.publicKey);
      inviterPrivKey = inviterKeys.privateKey;

      const inviteeKeys = generateKeyPairSync('ed25519');
      inviteePubKey = rawPublicKey(inviteeKeys.publicKey);
      inviteePrivKey = inviteeKeys.privateKey;

      secret = new Uint8Array(Buffer.from('a'.repeat(64), 'hex'));
      secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

      // Create an invite box
      const inviteBox: InviteBox = {
        boxType: 'invite',
        value: 25n,
        secretHash,
        inviterId: inviterPubKey,
        guard: 'hash_preimage_with_bond',
      };
      // Create an unclaimed bond box paired with the invite.
      //
      // Seeded as outputs 0 and 1 of ONE synthetic transaction, because the bond
      // now finds its invite at `(bond.txId, bond.inviteOutputIndex)`. Two
      // independently-seeded boxes would leave the bond pointing at an index of
      // a transaction with no invite at it — the mispairing the index form
      // exists to make inexpressible, so the fixture must not fake it.
      const bondCandidate = {
        boxType: 'bond' as const,
        value: 25n,
        inviterId: inviterPubKey,
        inviteOutputIndex: 0,
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'bond_dual' as const,
      };
      const [seededInvite, seededBond] = seedAsOneTx([inviteBox, bondCandidate]);
      inviteBoxId = seededInvite!.id!;
      bondBoxId = seededBond!.id!;
      storeInsertBox(seededInvite!);
      storeInsertBox(seededBond!);
    });

    it('rejects tx with no BondBox input', () => {
      const newKarmaBox: KarmaBox = {
        boxType: 'karma',
        value: 25n,
        owner: new Uint8Array(32),
        guard: 'owner_signature',
        proofSource: 'claim',
      };

      const tx: UtxoTransaction = {
        inputs: [inviteBoxId],
        outputs: [newKarmaBox],
        signatures: {},
        protocolVersion: 1,
      };

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('requires a BondBox');
    });

    it('rejects tx with missing preimage', () => {
      const bondOut: BondBox = {
        boxType: 'bond',
        value: 25n,
        inviterId: inviterPubKey,
        inviteOutputIndex: 0,
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'bond_dual',
      };
      const karmaOut: KarmaBox = {
        boxType: 'karma',
        value: 25n,
        owner: new Uint8Array(32),
        guard: 'owner_signature',
        proofSource: 'claim',
      };

      const tx: UtxoTransaction = {
        inputs: [inviteBoxId, bondBoxId],
        outputs: [karmaOut, bondOut],
        signatures: {},
        protocolVersion: 1,
      };

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Missing preimage');
    });

    it('rejects tx with wrong preimage', () => {
      const wrongSecret = new Uint8Array(32);
      const bondOut: BondBox = {
        boxType: 'bond',
        value: 25n,
        inviterId: inviterPubKey,
        inviteOutputIndex: 0,
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'bond_dual',
      };
      const karmaOut: KarmaBox = {
        boxType: 'karma',
        value: 25n,
        owner: new Uint8Array(32),
        guard: 'owner_signature',
        proofSource: 'claim',
      };

      const tx: UtxoTransaction = {
        inputs: [inviteBoxId, bondBoxId],
        outputs: [karmaOut, bondOut],
        signatures: {},
        preimages: { [inviteBoxId]: wrongSecret },
        protocolVersion: 1,
      };

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('preimage mismatch');
    });

    it('accepts tx with valid preimage and committed bond', () => {
      // Simulate committed BondBox
      db.prepare(
        'UPDATE utxo_boxes SET extra_data = ? WHERE id = ?',
      ).run(
        JSON.stringify({
          inviterId: Buffer.from(inviterPubKey).toString('hex'),
          inviteOutputIndex: 0,
          inviteePublicKey: Array.from(inviteePubKey),
          probationStartBlock: 3,
          probationEndBlock: 1003,
        }),
        bondBoxId,
      );

      const bondOut: BondBox = {
        boxType: 'bond',
        value: 25n,
        inviterId: inviterPubKey,
        inviteOutputIndex: 0,
        inviteePublicKey: inviteePubKey,
        probationStartBlock: 3,
        probationEndBlock: 1003,
        guard: 'bond_dual',
      };
      const karmaOut: KarmaBox = {
        boxType: 'karma',
        value: 25n,
        owner: inviteePubKey,
        guard: 'owner_signature',
        proofSource: 'claim',
      };

      const tx: UtxoTransaction = {
        inputs: [inviteBoxId, bondBoxId],
        outputs: [karmaOut, bondOut],
        signatures: {},
        preimages: { [inviteBoxId]: secret },
        protocolVersion: 1,
      };
      const hash = computeTxHash(tx);
      const hexKey = Buffer.from(inviteePubKey).toString('hex');
      tx.signatures[hexKey] = signHash(hash, inviteePrivKey);

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 12. invite+bond reveal (claim) transition
  // ---------------------------------------------------------------------------
  describe('invite+bond reveal transition', () => {
    let inviterPubKey: Uint8Array;
    let inviterPrivKey: KeyObject;
    let inviteePubKey: Uint8Array;
    let inviteePrivKey: KeyObject;
    let secret: Uint8Array;
    let secretHash: Uint8Array;
    let inviteBoxId: string;
    let bondBoxId: string;

    beforeEach(() => {
      const inviterKeys = generateKeyPairSync('ed25519');
      inviterPubKey = rawPublicKey(inviterKeys.publicKey);
      inviterPrivKey = inviterKeys.privateKey;

      const inviteeKeys = generateKeyPairSync('ed25519');
      inviteePubKey = rawPublicKey(inviteeKeys.publicKey);
      inviteePrivKey = inviteeKeys.privateKey;

      secret = new Uint8Array(Buffer.from('a'.repeat(64), 'hex'));
      secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

      // Create invite box
      const inviteBox: InviteBox = {
        boxType: 'invite',
        value: 25n,
        secretHash,
        inviterId: inviterPubKey,
        guard: 'hash_preimage_with_bond',
      };
      // Invite and bond seeded as outputs 0 and 1 of ONE synthetic transaction —
      // the bond resolves its invite from `(txId, inviteOutputIndex)`.
      const bondCandidate = {
        boxType: 'bond' as const,
        value: 25n,
        inviterId: inviterPubKey,
        inviteOutputIndex: 0,
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'bond_dual' as const,
      };
      const [seededInvite, seededBond] = seedAsOneTx([inviteBox, bondCandidate]);
      inviteBoxId = seededInvite!.id!;
      bondBoxId = seededBond!.id!;
      storeInsertBox(seededInvite!);
      storeInsertBox(seededBond!);
    });

    /** Build a signed reveal tx with preimages and invitee signature. */
    function buildRevealTx(
      karmaOut: KarmaBox,
      bondOut: BondBox,
    ): UtxoTransaction {
      const tx: UtxoTransaction = {
        inputs: [inviteBoxId, bondBoxId],
        outputs: [karmaOut, bondOut],
        signatures: {},
        preimages: { [inviteBoxId]: secret },
        protocolVersion: 1,
      };
      const hash = computeTxHash(tx);
      const hexKey = Buffer.from(inviteePubKey).toString('hex');
      tx.signatures[hexKey] = signHash(hash, inviteePrivKey);
      return tx;
    }

    it('accepts valid invite+bond reveal', () => {
      // Simulate committed BondBox
      db.prepare(
        'UPDATE utxo_boxes SET extra_data = ? WHERE id = ?',
      ).run(
        JSON.stringify({
          inviterId: Buffer.from(inviterPubKey).toString('hex'),
          inviteOutputIndex: 0,
          inviteePublicKey: Array.from(inviteePubKey),
          probationStartBlock: 3,
          probationEndBlock: 1003,
        }),
        bondBoxId,
      );

      const karmaOut: KarmaBox = {
        boxType: 'karma',
        value: 25n,
        owner: inviteePubKey,
        guard: 'owner_signature',
        proofSource: 'claim',
      };
      const bondOut: BondBox = {
        boxType: 'bond',
        value: 25n,
        inviterId: inviterPubKey,
        inviteOutputIndex: 0,
        inviteePublicKey: inviteePubKey,
        probationStartBlock: 3,
        probationEndBlock: 1003,
        guard: 'bond_dual',
      };

      const tx = buildRevealTx(karmaOut, bondOut);
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(true);
    });

    it('rejects reveal with no bond output', () => {
      // karma output value matches total input value (50) to pass value conservation,
      // then the transition check catches the missing bond output
      const karmaOut: KarmaBox = {
        boxType: 'karma',
        value: 50n,
        owner: inviteePubKey,
        guard: 'owner_signature',
        proofSource: 'claim',
      };

      const tx: UtxoTransaction = {
        inputs: [inviteBoxId, bondBoxId],
        outputs: [karmaOut],
        signatures: {},
        preimages: { [inviteBoxId]: secret },
        protocolVersion: 1,
      };
      const hash = computeTxHash(tx);
      const hexKey = Buffer.from(inviterPubKey).toString('hex');
      tx.signatures[hexKey] = signHash(hash, inviterPrivKey);

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid invite reveal');
    });

    it('rejects reveal with uncommitted bond output (empty inviteePubKey)', () => {
      const karmaOut: KarmaBox = {
        boxType: 'karma',
        value: 25n,
        owner: inviteePubKey,
        guard: 'owner_signature',
        proofSource: 'claim',
      };
      const bondOut: BondBox = {
        boxType: 'bond',
        value: 25n,
        inviterId: inviterPubKey,
        inviteOutputIndex: 0,
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'bond_dual',
      };

      const tx: UtxoTransaction = {
        inputs: [inviteBoxId, bondBoxId],
        outputs: [karmaOut, bondOut],
        signatures: {},
        preimages: { [inviteBoxId]: secret },
        protocolVersion: 1,
      };
      const hash = computeTxHash(tx);
      const hexKey = Buffer.from(inviterPubKey).toString('hex');
      tx.signatures[hexKey] = signHash(hash, inviterPrivKey);

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid invite reveal');
    });
  });

  // ---------------------------------------------------------------------------
  // 13. Value conservation (audit C-1, L-11)
  //
  // sum(inputs) == sum(outputs) for every box type. The sole exception is a
  // BondBox burn (zero outputs). Karma/credits are minted or burned only in
  // block-application paths, never inside a user transaction.
  // ---------------------------------------------------------------------------
  describe('value conservation (audit C-1, L-11)', () => {
    it('rejects self-signed K(v) -> K(v) + K(2) (mints karma from nothing)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      // The C-1 exploit: the change box keeps the full balance while a second
      // box conjures 2 more karma.
      const newKarma: KarmaBox = {
        boxType: 'karma',
        value: 100n,
        owner: ownerPubKey,
        guard: 'owner_signature',
        proofSource: 'test',
      };
      const conjured: KarmaBox = {
        boxType: 'karma',
        value: 2n,
        owner: ownerPubKey,
        guard: 'owner_signature',
        proofSource: 'test',
      };

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma, conjured],
        ownerPrivKey,
        ownerPubKey,
      );
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Value non-conservation');
      expect(result.error).toContain('inputs=100');
      expect(result.error).toContain('outputs=102');

      // Nothing applied.
      expect(deps.getBox(karma.id!)).not.toBeNull();
      expect(deps.getKarmaBox(ownerPubKey)!.value).toBe(100n);
    });

    it('accepts the correct like burn K(v) -> K(v-1) with likeTarget (P2-D)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      const newKarma: KarmaBox = {
        boxType: 'karma',
        value: 100n - LIKE_KARMA_COST,
        owner: ownerPubKey,
        guard: 'owner_signature',
        proofSource: 'test',
      };

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma],
        ownerPrivKey,
        ownerPubKey,
        1,
        'dd'.repeat(32),
      );
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(deps.getKarmaBox(ownerPubKey)!.value).toBe(100n - LIKE_KARMA_COST);
    });

    // -----------------------------------------------------------------------
    // L-11 — box `value` must be a non-negative integer
    // -----------------------------------------------------------------------
    for (const [label, badValue] of [
      ['negative', -1],
      ['NaN', Number.NaN],
      ['fractional', 1.5],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['beyond MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 2],
    ] as const) {
      it(`rejects a ${label} box value (${String(badValue)})`, () => {
        const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

        const newKarma = {
          boxType: 'karma',
          value: badValue,
          owner: ownerPubKey,
          guard: 'owner_signature',
          proofSource: 'test',
        } as unknown as KarmaBox;

        const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
        const result = validateAndApplyTx(deps, tx, 10);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid box value');
        expect(deps.getBox(karma.id!)).not.toBeNull();
      });
    }

    it('rejects a negative value that balances the sum (K(10) -> K(15) + K(-5))', () => {
      const karma = createAndInsertKarma(ownerPubKey, 10n, 1);

      // 15 + (-5) == 10, so a sum-only check would pass this — yet it hands
      // the owner a 15-karma box out of a 10-karma input.
      const newKarma: KarmaBox = {
        boxType: 'karma',
        value: 15n,
        owner: ownerPubKey,
        guard: 'owner_signature',
        proofSource: 'test',
      };
      const negative = {
        boxType: 'karma',
        value: -5,
        owner: ownerPubKey,
        guard: 'owner_signature',
        proofSource: 'test',
      } as unknown as KarmaBox;

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma, negative],
        ownerPrivKey,
        ownerPubKey,
      );
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid box value');
      expect(deps.getKarmaBox(ownerPubKey)!.value).toBe(10n);
    });

    // -----------------------------------------------------------------------
    // Legitimate tx shapes must keep passing
    // -----------------------------------------------------------------------
    it('accepts a conserving post-lock tx K(v) -> K(v-5) + PostLock(5)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      const newKarma: KarmaBox = {
        boxType: 'karma',
        value: 100n - POST_LOCK_THREAD_COST,
        owner: ownerPubKey,
        guard: 'owner_signature',
        proofSource: 'test',
      };
      const postLock: PostLockBox = {
        boxType: 'post_lock',
        value: POST_LOCK_THREAD_COST,
        originalValue: POST_LOCK_THREAD_COST,
        owner: ownerPubKey,
        targetPostId: 'ab'.repeat(32),
        guard: 'block_apply',
      };

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma, postLock],
        ownerPrivKey,
        ownerPubKey,
      );
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('accepts a conserving vouch tx K(v) -> K(v-1) + Vouch(1)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const targetPubRaw = rawPublicKey(targetPub);

      const newKarma: KarmaBox = {
        boxType: 'karma',
        value: 100n - VOUCH_KARMA_AMOUNT,
        owner: ownerPubKey,
        guard: 'owner_signature',
        proofSource: 'test',
      };
      const vouchBox: VouchBox = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        voucherId: ownerPubKey,
        targetId: targetPubRaw,
        guard: 'owner_signature',
      };

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma, vouchBox],
        ownerPrivKey,
        ownerPubKey,
      );
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('accepts a conserving invite-create tx K(v) -> K(v-50) + Invite(25) + Bond(25)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      const newKarma: KarmaBox = {
        boxType: 'karma',
        value: 100n - INVITE_KARMA_AMOUNT - INVITE_BOND_KARMA,
        owner: ownerPubKey,
        guard: 'owner_signature',
        proofSource: 'test',
      };
      const inviteBox: InviteBox = {
        boxType: 'invite',
        value: INVITE_KARMA_AMOUNT,
        secretHash: new Uint8Array(32).fill(0xbb),
        inviterId: ownerUserId,
        guard: 'hash_preimage_with_bond',
      };
      const bondBox: BondBox = {
        boxType: 'bond',
        value: INVITE_BOND_KARMA,
        inviterId: ownerUserId,
        inviteOutputIndex: 0,
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'bond_dual',
      };

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma, inviteBox, bondBox],
        ownerPrivKey,
        ownerPubKey,
      );
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('rejects invite-create that does not debit the change box (audit C-1)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      // invites.ts checks only that invite/bond equal 25 each — never that the
      // change box was debited. Conservation is what catches this.
      const newKarma: KarmaBox = {
        boxType: 'karma',
        value: 100n,
        owner: ownerPubKey,
        guard: 'owner_signature',
        proofSource: 'test',
      };
      const inviteBox: InviteBox = {
        boxType: 'invite',
        value: INVITE_KARMA_AMOUNT,
        secretHash: new Uint8Array(32).fill(0xcc),
        inviterId: ownerUserId,
        guard: 'hash_preimage_with_bond',
      };
      const bondBox: BondBox = {
        boxType: 'bond',
        value: INVITE_BOND_KARMA,
        inviterId: ownerUserId,
        inviteOutputIndex: 0,
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'bond_dual',
      };

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma, inviteBox, bondBox],
        ownerPrivKey,
        ownerPubKey,
      );
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Value non-conservation');
    });

    it('rejects a BondBox burn (zero outputs) — the exemption was removed in P2-B', () => {
      // This test asserted acceptance until P2-B phase 1. Bond forfeiture is
      // not implemented and no legal transition destroys a bond, so the
      // exemption bought nothing but a burn shape the *committed invitee* could
      // reach — their signature satisfies `bond_dual`, so they could torch the
      // inviter's stake. See test/services/bond-tightening.test.ts for the
      // attack form and its non-vacuity controls.
      const bondBox: BondBox = {
        boxType: 'bond',
        value: INVITE_BOND_KARMA,
        inviterId: ownerPubKey,
        inviteOutputIndex: 0,
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'bond_dual',
      };
      Object.assign(bondBox, fixtureProvenance(bondBox, 1));
      const bondBoxId = computeBoxId(bondBox);
      storeInsertBox({ ...bondBox, id: bondBoxId });

      const tx = buildSignedTx([bondBoxId], [], ownerPrivKey, ownerPubKey);
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Value non-conservation');
      // Nothing applied — the bond is still unspent.
      expect(deps.getBox(bondBoxId)).not.toBeNull();
    });

    it('accepts a VouchBox burn (unvouch) — karma escrows into the cooldown', () => {
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const vouchBox: VouchBox = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        voucherId: ownerPubKey,
        targetId: rawPublicKey(targetPub),
        guard: 'owner_signature',
      };
      Object.assign(vouchBox, fixtureProvenance(vouchBox, 1));
      const vouchBoxId = computeBoxId(vouchBox);
      storeInsertBox({ ...vouchBox, id: vouchBoxId });

      const tx = buildSignedTx([vouchBoxId], [], ownerPrivKey, ownerPubKey);
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(deps.getBox(vouchBoxId)).toBeNull();
    });

    it('does not extend the zero-output exception to karma or like inputs', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      // A karma spend with no outputs is not a legal burn — only bond and
      // vouch may destroy value this way.
      const tx = buildSignedTx([karma.id!], [], ownerPrivKey, ownerPubKey);
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Value non-conservation');
      expect(deps.getBox(karma.id!)).not.toBeNull();
    });

    it('accepts a conserving credit transfer C(v) -> C(a) + C(v-a)', () => {
      const { publicKey: recipientPub } = generateKeyPairSync('ed25519');
      const recipientRaw = rawPublicKey(recipientPub);

      const creditBox = {
        boxType: 'credit' as const,
        value: 100n,
        owner: ownerPubKey,
        guard: 'owner_signature' as const,
        proofSource: 'test',
      };
      Object.assign(creditBox, fixtureProvenance(creditBox, 1));
      const creditBoxId = computeBoxId(creditBox);
      storeInsertBox({ ...creditBox, id: creditBoxId } as AnyBox);

      const tx = buildSignedTx(
        [creditBoxId],
        [
          { ...creditBox, value: 30n, owner: recipientRaw },
          { ...creditBox, value: 70n },
        ] as AnyBox[],
        ownerPrivKey,
        ownerPubKey,
      );
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 14. Cancel-shape Invite+Bond sweep (audit H-2)
  //
  // The old `bond_dual` commit path accepted any non-empty `signatures` map
  // once the preimage matched. That let anyone who learned the invite secret
  // `s` spend their OWN KarmaBox alongside the InviteBox and the still-
  // uncommitted BondBox in the 3-input "cancel shape" — a mixed-type
  // combination `validateTx` step 3 explicitly permits — and sweep both boxes
  // into their own karma with NO inviter signature. Nothing else stopped it:
  // the total conserves, the InviteBox's `hash_preimage_with_bond` guard skips
  // the signature check while the bond is uncommitted, and the cancel
  // transition only requires `karmaOut.owner == karmaIn.owner`, which the
  // attacker's own box satisfies.
  //
  // The sweep produces no BondBox output, so the hardened guard now rejects it.
  // This attack never goes through `commitInvite`, so it belongs here at the
  // consensus layer rather than in invites.test.ts.
  // ---------------------------------------------------------------------------
  describe('cancel-shape Invite+Bond sweep (audit H-2)', () => {
    const KARMA_IN = 100n;
    const SWEPT_TOTAL = KARMA_IN + INVITE_KARMA_AMOUNT + INVITE_BOND_KARMA;

    let inviterPubKey: Uint8Array;
    let inviterPrivKey: KeyObject;
    let attackerPubKey: Uint8Array;
    let attackerPrivKey: KeyObject;
    let secret: Uint8Array;
    let inviteBoxId: string;
    let bondBoxId: string;

    beforeEach(() => {
      const inviterKeys = generateKeyPairSync('ed25519');
      inviterPubKey = rawPublicKey(inviterKeys.publicKey);
      inviterPrivKey = inviterKeys.privateKey;

      const attackerKeys = generateKeyPairSync('ed25519');
      attackerPubKey = rawPublicKey(attackerKeys.publicKey);
      attackerPrivKey = attackerKeys.privateKey;

      secret = new Uint8Array(Buffer.from('b'.repeat(64), 'hex'));
      const secretHash = createHash('blake2b512')
        .update(Buffer.from(secret))
        .digest()
        .subarray(0, 32);

      const inviteBox: InviteBox = {
        boxType: 'invite',
        value: INVITE_KARMA_AMOUNT,
        secretHash,
        inviterId: inviterPubKey,
        guard: 'hash_preimage_with_bond',
      };
      // Uncommitted bond — the state the sweep depends on. Seeded with the
      // invite as outputs 0 and 1 of ONE synthetic transaction, so the bond's
      // `inviteOutputIndex` resolves to the invite it shipped with.
      const bondCandidate = {
        boxType: 'bond' as const,
        value: INVITE_BOND_KARMA,
        inviterId: inviterPubKey,
        inviteOutputIndex: 0,
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'bond_dual' as const,
      };
      const [seededInvite, seededBond] = seedAsOneTx([inviteBox, bondCandidate], 1, 42);
      inviteBoxId = seededInvite!.id!;
      bondBoxId = seededBond!.id!;
      storeInsertBox(seededInvite!);
      storeInsertBox(seededBond!);
    });

    /**
     * The 3-input cancel shape: karma + invite + bond → a single KarmaBox
     * holding the full sum, owned by `beneficiary`. Both preimage slots carry
     * `s`, so the InviteBox guard and the bond commit path each see a matching
     * secret. Returned unsigned — every test adds the signatures it is about.
     */
    function buildSweepTx(beneficiary: Uint8Array, karmaInId: string): UtxoTransaction {
      const karmaOut: KarmaBox = {
        boxType: 'karma',
        value: SWEPT_TOTAL,
        owner: beneficiary,
        guard: 'owner_signature',
        proofSource: `invite-cancel:${inviteBoxId}`,
      };
      return {
        inputs: [karmaInId, inviteBoxId, bondBoxId],
        outputs: [{ ...karmaOut, id: computeBoxId(karmaOut) }],
        signatures: {},
        preimages: { [inviteBoxId]: secret, [bondBoxId]: secret },
        protocolVersion: 1,
      };
    }

    /** Sign the tx hash for `pubKey`. Signatures are not part of the hash. */
    function addSignature(
      tx: UtxoTransaction,
      pubKey: Uint8Array,
      privKey: KeyObject,
    ): void {
      tx.signatures[Buffer.from(pubKey).toString('hex')] = signHash(
        computeTxHash(tx),
        privKey,
      );
    }

    it('rejects a preimage-only sweep of Invite+Bond into the attacker karma', () => {
      const attackerKarma = createAndInsertKarma(attackerPubKey, KARMA_IN, 1, 'attacker');
      const tx = buildSweepTx(attackerPubKey, attackerKarma.id!);
      // The attacker signs only for their own KarmaBox input. The inviter
      // authorised nothing — knowing `s` is the attacker's entire claim.
      addSignature(tx, attackerPubKey, attackerPrivKey);

      const result = validateTx(deps, tx, 10);

      expect(result.valid).toBe(false);
      // Rejected AT the bond-commit guard — not earlier for conservation, a
      // mixed-input-type violation, or a bad preimage. The control test below
      // proves every other check passes on this exact transaction.
      expect(result.error).toContain('committed BondBox output');
    });

    it('non-vacuity control: the inviter-signed sweep reaches the transition layer, where P2-B stops it', () => {
      const attackerKarma = createAndInsertKarma(attackerPubKey, KARMA_IN, 1, 'attacker');
      const tx = buildSweepTx(attackerPubKey, attackerKarma.id!);
      addSignature(tx, attackerPubKey, attackerPrivKey);
      // One added signature is the only difference from the rejected tx above.
      // With it, `bond_dual` Path 1 (inviter reclaim) matches and every guard is
      // satisfied — which is what makes this a control: the tx above fails for
      // exactly one reason, missing bond authorisation.
      addSignature(tx, inviterPubKey, inviterPrivKey);

      const result = validateTx(deps, tx, 10);

      // Until P2-B phase 1 this was accepted, and that acceptance was the
      // control's assertion: the inviter may direct the value anywhere. That is
      // no longer true — the bond's value only ever returns to the inviter
      // (audit F-consensus-1), so an attacker-owned cancel output is illegal
      // whoever signs it. The control's *meaning* survives the inversion:
      // failing at the transition layer proves conservation and every guard
      // passed on this exact transaction.
      expect(result.valid).toBe(false);
      expect(result.error).toContain('inviterId');
    });

    it('still accepts a legitimate inviter cancel (uncommitted bond)', () => {
      const inviterKarma = createAndInsertKarma(inviterPubKey, KARMA_IN, 1, 'inviter');
      const tx = buildSweepTx(inviterPubKey, inviterKarma.id!);
      addSignature(tx, inviterPubKey, inviterPrivKey);

      const result = validateTx(deps, tx, 10);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 15. P2-D like biconditional: `likeTarget` present ⟺ deficit exactly
  // LIKE_KARMA_COST — the only legal karma deficit in any user transaction —
  // and the like shape is exactly one karma output, same owner as all inputs.
  // ---------------------------------------------------------------------------
  describe('P2-D like biconditional and shape', () => {
    const TARGET = 'ab'.repeat(32);

    function karmaOut(value: bigint, owner: Uint8Array): KarmaBox {
      return {
        boxType: 'karma',
        value,
        owner,
        guard: 'owner_signature',
        proofSource: 'like-quadrant',
      } as KarmaBox;
    }

    // --- the four quadrants -------------------------------------------------

    it('quadrant 1 — deficit of LIKE_KARMA_COST with likeTarget: valid', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!], [karmaOut(99n, ownerPubKey)], ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.error).toBeUndefined();
      expect(result.valid).toBe(true);
    });

    it('quadrant 2 — deficit without likeTarget: invalid (the before-leg invariant)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!], [karmaOut(100n - LIKE_KARMA_COST, ownerPubKey)], ownerPrivKey, ownerPubKey,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Value non-conservation');
    });

    it('quadrant 3 — likeTarget on a conserving tx (zero deficit): invalid', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!], [karmaOut(100n, ownerPubKey)], ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Like non-conservation');
    });

    it('quadrant 4a — likeTarget with a deficit of 2: invalid', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!], [karmaOut(98n, ownerPubKey)], ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Like non-conservation');
    });

    it('quadrant 4b — likeTarget with a surplus: invalid', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!], [karmaOut(101n, ownerPubKey)], ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Like non-conservation');
    });

    // --- input rules --------------------------------------------------------

    it('multi-input like: two karma boxes, one owner, one −1 output: valid', () => {
      const karmaA = createAndInsertKarma(ownerPubKey, 60n, 1, 'box-a');
      const karmaB = createAndInsertKarma(ownerPubKey, 40n, 2, 'box-b');
      const tx = buildSignedTx(
        [karmaA.id!, karmaB.id!],
        [karmaOut(100n - LIKE_KARMA_COST, ownerPubKey)],
        ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.error).toBeUndefined();
      expect(result.valid).toBe(true);
    });

    it('foreign-owner karma input mixed into a like: invalid (same-owner rule)', () => {
      const { publicKey: otherPub, privateKey: otherPriv } = generateKeyPairSync('ed25519');
      const otherRaw = rawPublicKey(otherPub);
      const karmaA = createAndInsertKarma(ownerPubKey, 60n, 1, 'own');
      const karmaB = createAndInsertKarma(otherRaw, 40n, 2, 'foreign');

      const tx = buildSignedTx(
        [karmaA.id!, karmaB.id!],
        [karmaOut(100n - LIKE_KARMA_COST, ownerPubKey)],
        ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      // Both owners co-sign — consensual, and still illegal.
      tx.signatures[Buffer.from(otherRaw).toString('hex')] =
        signHash(computeTxHash(tx), otherPriv);

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Karma cannot be transferred');
    });

    it('likeTarget on a non-karma (credit) spend: invalid', () => {
      const creditBox = {
        boxType: 'credit' as const,
        value: 100n,
        owner: ownerPubKey,
        guard: 'owner_signature' as const,
        proofSource: 1,
      };
      Object.assign(creditBox, fixtureProvenance(creditBox, 1));
      const creditId = computeBoxId(creditBox as never);
      storeInsertBox({ ...creditBox, id: creditId } as AnyBox);

      const tx = buildSignedTx(
        [creditId],
        [{ ...creditBox, value: 99n } as AnyBox],
        ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('likeTarget is only legal on an all-karma burn transaction');
    });

    it('likeTarget on a zero-output unvouch: invalid (no shelter under the vouch exemption)', () => {
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const vouchBox: VouchBox = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        voucherId: ownerPubKey,
        targetId: rawPublicKey(targetPub),
        guard: 'owner_signature',
      };
      Object.assign(vouchBox, fixtureProvenance(vouchBox, 1));
      const vouchBoxId = computeBoxId(vouchBox);
      storeInsertBox({ ...vouchBox, id: vouchBoxId });

      const tx = buildSignedTx([vouchBoxId], [], ownerPrivKey, ownerPubKey, 1, TARGET);
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('likeTarget is only legal on an all-karma burn transaction');
    });

    // --- output-shape violations -------------------------------------------

    it('like with two karma outputs: invalid', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!],
        [karmaOut(60n, ownerPubKey), karmaOut(39n, ownerPubKey)],
        ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exactly one karma output');
    });

    it('like with karma + another box type: invalid', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const postLock: PostLockBox = {
        boxType: 'post_lock',
        value: 5n,
        originalValue: 5n,
        owner: ownerPubKey,
        targetPostId: TARGET,
        guard: 'block_apply',
      } as PostLockBox;
      const tx = buildSignedTx(
        [karma.id!],
        [karmaOut(94n, ownerPubKey), postLock],
        ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exactly one karma output');
    });

    // --- the retired arms stay dead ----------------------------------------

    it("a retired 'like'-typed output is an illegal karma transition (the old cast shape stays dead)", () => {
      // T2b deleted the box type; JS clients are untyped, so the old cast
      // shape can still arrive as JSON. The karma transition arm rejects any
      // non-karma output, retired types included.
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const relic = {
        boxType: 'like',
        value: 2n,
        likerId: ownerUserId,
        targetPostId: TARGET,
        guard: 'epoch_tally',
      } as never;
      const tx = buildSignedTx(
        [karma.id!],
        [karmaOut(98n, ownerPubKey), relic],
        ownerPrivKey, ownerPubKey,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Illegal karma transition');
    });

    it('spending a block_apply-guarded PostLockBox is rejected at the guard (T2a)', () => {
      const postLock: PostLockBox = {
        boxType: 'post_lock',
        value: POST_LOCK_THREAD_COST,
        originalValue: POST_LOCK_THREAD_COST,
        owner: ownerPubKey,
        targetPostId: TARGET,
        guard: 'block_apply',
      };
      Object.assign(postLock, fixtureProvenance(postLock, 1));
      const postLockId = computeBoxId(postLock);
      storeInsertBox({ ...postLock, id: postLockId } as AnyBox);

      // The owner's own signature does not open a settlement-guarded box.
      // Conservation holds (5 in, 5 out), and the transition table would also
      // reject a post_lock input — so what this pins is the guard arm
      // specifically: the error must name the actual guard.
      const tx = buildSignedTx(
        [postLockId],
        [karmaOut(POST_LOCK_THREAD_COST, ownerPubKey)],
        ownerPrivKey, ownerPubKey,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('block_apply guard');
      expect(result.error).toContain('can only be consumed by block application');
    });
  });
});
