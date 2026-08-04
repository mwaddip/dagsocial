import { uid } from '../helpers.js';
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
  LIKE_COST,
  POST_LOCK_THREAD_COST,
  VOUCH_KARMA_AMOUNT,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
} from '@dagsocial/types';
import type {
  AnyBox,
  KarmaBox,
  LikeBox,
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
  getKarmaBox,
  insertBox as storeInsertBox,
  consumeBox as storeConsumeBox,
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
      insertBox: (box: AnyBox) => storeInsertBox(box),
      consumeBox: (id: string, atBlock: number) => storeConsumeBox(id, atBlock),
      getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
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
    createdAtBlock: number,
    proofSource = 'test',
  ): KarmaBox {
    const box: Omit<KarmaBox, 'id'> & { id?: string } = {
      boxType: 'karma',
      value,
      createdAtBlock,
      owner,
      guard: 'owner_signature',
      proofSource,
      lastTouchBlock: createdAtBlock,
    };
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
  ): UtxoTransaction {
    const hexKey = Buffer.from(pubKey).toString('hex');
    const tx: UtxoTransaction = {
      inputs,
      outputs: rawOutputs,
      signatures: {},
      protocolVersion,
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
      createdAtBlock: 10,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 10,
    };

    const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();

    // Input box should now be spent
    expect(deps.getBox(karma.id!)).toBeNull();

    // Output box should exist and have an id assigned
    const outputBox = deps.getBox(computeBoxId(newKarma));
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
      createdAtBlock: 10,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 10,
    };

    const secretHash = new Uint8Array(32).fill(0xaa);
    const inviteBox: InviteBox = {
      boxType: 'invite',
      value: 15n,
      createdAtBlock: 10,
      secretHash,
      inviterId: ownerUserId,
      guard: 'hash_preimage_with_bond',
    };
    const inviteId = computeBoxId(inviteBox);

    const bondBox: BondBox = {
      boxType: 'bond',
      value: 15n,
      createdAtBlock: 10,
      inviterId: ownerUserId,
      inviteBoxId: inviteId,
      inviteePublicKey: new Uint8Array(32),
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
    expect(deps.getBox(computeBoxId(newKarma))).not.toBeNull();
    expect(deps.getBox(computeBoxId(inviteBox))).not.toBeNull();
    expect(deps.getBox(computeBoxId(bondBox))).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 3. Valid karma→karma+like (like cast)
  // -------------------------------------------------------------------------
  it('valid karma to karma+like (like cast)', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 98n,
      createdAtBlock: 10,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 10,
    };

    const likeBox: LikeBox = {
      boxType: 'like',
      value: LIKE_COST,
      createdAtBlock: 10,
      likerId: ownerUserId,
      targetPostId: 'aa'.repeat(32),
      guard: 'epoch_tally',
    };

    const tx = buildSignedTx(
      [karma.id!],
      [newKarma, likeBox],
      ownerPrivKey,
      ownerPubKey,
    );
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
    expect(deps.getBox(computeBoxId(likeBox))).not.toBeNull();
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
      createdAtBlock: 10,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 10,
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
      createdAtBlock: 10,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 10,
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
      createdAtBlock: 10,
      owner: otherPubRaw,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 10,
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
      createdAtBlock: 10,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 10,
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
      createdAtBlock: 10,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 10,
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

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 100n - LIKE_COST,
      createdAtBlock: 10,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 10,
    };
    const likeBox: LikeBox = {
      boxType: 'like',
      value: LIKE_COST,
      createdAtBlock: 10,
      likerId: ownerUserId,
      targetPostId: 'bb'.repeat(32),
      guard: 'epoch_tally',
    };

    const expectedIds = [computeBoxId(newKarma), computeBoxId(likeBox)];

    const tx = buildSignedTx(
      [karma.id!],
      [newKarma, likeBox],
      ownerPrivKey,
      ownerPubKey,
    );
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(true);

    // All output boxes should exist with their computed IDs
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
      createdAtBlock: 10,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 10,
    };

    const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
    const result = validateTx(deps, tx, 10);

    expect(result.valid).toBe(true);
    expect(result.computedOutputs).toBeDefined();
    expect(result.computedOutputs!.length).toBe(1);
    expect(result.computedOutputs![0]!.id).toBe(computeBoxId(newKarma));
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
        createdAtBlock: 1,
        secretHash,
        inviterId: inviterPubKey,
        guard: 'hash_preimage_with_bond',
      };
      inviteBoxId = computeBoxId(inviteBox);
      storeInsertBox({ ...inviteBox, id: inviteBoxId });

      // Create an unclaimed bond box paired with the invite
      const bondBox: BondBox = {
        boxType: 'bond',
        value: 25n,
        createdAtBlock: 1,
        inviterId: inviterPubKey,
        inviteBoxId: inviteBoxId,
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'bond_dual',
      };
      bondBoxId = computeBoxId(bondBox);
      storeInsertBox({ ...bondBox, id: bondBoxId });
    });

    it('rejects tx with no BondBox input', () => {
      const newKarmaBox: KarmaBox = {
        boxType: 'karma',
        value: 25n,
        createdAtBlock: 10,
        owner: new Uint8Array(32),
        guard: 'owner_signature',
        proofSource: 'claim',
        lastTouchBlock: 10,
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
        createdAtBlock: 1,
        inviterId: inviterPubKey,
        inviteBoxId,
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'bond_dual',
      };
      const karmaOut: KarmaBox = {
        boxType: 'karma',
        value: 25n,
        createdAtBlock: 10,
        owner: new Uint8Array(32),
        guard: 'owner_signature',
        proofSource: 'claim',
        lastTouchBlock: 10,
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
        createdAtBlock: 1,
        inviterId: inviterPubKey,
        inviteBoxId,
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'bond_dual',
      };
      const karmaOut: KarmaBox = {
        boxType: 'karma',
        value: 25n,
        createdAtBlock: 10,
        owner: new Uint8Array(32),
        guard: 'owner_signature',
        proofSource: 'claim',
        lastTouchBlock: 10,
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
          inviteBoxId,
          inviteePublicKey: Array.from(inviteePubKey),
          probationStartBlock: 3,
          probationEndBlock: 1003,
        }),
        bondBoxId,
      );

      const bondOut: BondBox = {
        boxType: 'bond',
        value: 25n,
        createdAtBlock: 1,
        inviterId: inviterPubKey,
        inviteBoxId,
        inviteePublicKey: inviteePubKey,
        probationStartBlock: 3,
        probationEndBlock: 1003,
        guard: 'bond_dual',
      };
      const karmaOut: KarmaBox = {
        boxType: 'karma',
        value: 25n,
        createdAtBlock: 10,
        owner: inviteePubKey,
        guard: 'owner_signature',
        proofSource: 'claim',
        lastTouchBlock: 10,
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
        createdAtBlock: 1,
        secretHash,
        inviterId: inviterPubKey,
        guard: 'hash_preimage_with_bond',
      };
      inviteBoxId = computeBoxId(inviteBox);
      storeInsertBox({ ...inviteBox, id: inviteBoxId });

      // Create unclaimed bond box paired with invite
      const bondBox: BondBox = {
        boxType: 'bond',
        value: 25n,
        createdAtBlock: 1,
        inviterId: inviterPubKey,
        inviteBoxId: inviteBoxId,
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'bond_dual',
      };
      bondBoxId = computeBoxId(bondBox);
      storeInsertBox({ ...bondBox, id: bondBoxId });
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
          inviteBoxId,
          inviteePublicKey: Array.from(inviteePubKey),
          probationStartBlock: 3,
          probationEndBlock: 1003,
        }),
        bondBoxId,
      );

      const karmaOut: KarmaBox = {
        boxType: 'karma',
        value: 25n,
        createdAtBlock: 10,
        owner: inviteePubKey,
        guard: 'owner_signature',
        proofSource: 'claim',
        lastTouchBlock: 10,
      };
      const bondOut: BondBox = {
        boxType: 'bond',
        value: 25n,
        createdAtBlock: 1,
        inviterId: inviterPubKey,
        inviteBoxId,
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
        createdAtBlock: 10,
        owner: inviteePubKey,
        guard: 'owner_signature',
        proofSource: 'claim',
        lastTouchBlock: 10,
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
        createdAtBlock: 10,
        owner: inviteePubKey,
        guard: 'owner_signature',
        proofSource: 'claim',
        lastTouchBlock: 10,
      };
      const bondOut: BondBox = {
        boxType: 'bond',
        value: 25n,
        createdAtBlock: 1,
        inviterId: inviterPubKey,
        inviteBoxId,
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
    it('rejects self-signed K(v) -> K(v) + Like(2) (mints karma from nothing)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      // The C-1 exploit: the change box keeps the full balance while a
      // LikeBox conjures 2 more karma.
      const newKarma: KarmaBox = {
        boxType: 'karma',
        value: 100n,
        createdAtBlock: 10,
        owner: ownerPubKey,
        guard: 'owner_signature',
        proofSource: 'test',
        lastTouchBlock: 10,
      };
      const likeBox: LikeBox = {
        boxType: 'like',
        value: LIKE_COST,
        createdAtBlock: 10,
        likerId: ownerUserId,
        targetPostId: 'cc'.repeat(32),
        guard: 'epoch_tally',
      };

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma, likeBox],
        ownerPrivKey,
        ownerPubKey,
      );
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Value non-conservation');
      expect(result.error).toContain('inputs=100');
      expect(result.error).toContain(`outputs=${100n + LIKE_COST}`);

      // Nothing applied.
      expect(deps.getBox(karma.id!)).not.toBeNull();
      expect(deps.getKarmaBox(ownerPubKey)!.value).toBe(100n);
    });

    it('accepts the correct K(v) -> K(v-2) + Like(2)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      const newKarma: KarmaBox = {
        boxType: 'karma',
        value: 100n - LIKE_COST,
        createdAtBlock: 10,
        owner: ownerPubKey,
        guard: 'owner_signature',
        proofSource: 'test',
        lastTouchBlock: 10,
      };
      const likeBox: LikeBox = {
        boxType: 'like',
        value: LIKE_COST,
        createdAtBlock: 10,
        likerId: ownerUserId,
        targetPostId: 'dd'.repeat(32),
        guard: 'epoch_tally',
      };

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma, likeBox],
        ownerPrivKey,
        ownerPubKey,
      );
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(deps.getKarmaBox(ownerPubKey)!.value).toBe(100n - LIKE_COST);
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
          createdAtBlock: 10,
          owner: ownerPubKey,
          guard: 'owner_signature',
          proofSource: 'test',
          lastTouchBlock: 10,
        } as unknown as KarmaBox;

        const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
        const result = validateAndApplyTx(deps, tx, 10);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid box value');
        expect(deps.getBox(karma.id!)).not.toBeNull();
      });
    }

    it('rejects a negative value that balances the sum (K(10) -> K(15) + Like(-5))', () => {
      const karma = createAndInsertKarma(ownerPubKey, 10n, 1);

      // 15 + (-5) == 10, so a sum-only check would pass this — yet it hands
      // the owner a 15-karma box out of a 10-karma input.
      const newKarma: KarmaBox = {
        boxType: 'karma',
        value: 15n,
        createdAtBlock: 10,
        owner: ownerPubKey,
        guard: 'owner_signature',
        proofSource: 'test',
        lastTouchBlock: 10,
      };
      const likeBox = {
        boxType: 'like',
        value: -5,
        createdAtBlock: 10,
        likerId: ownerUserId,
        targetPostId: 'ee'.repeat(32),
        guard: 'epoch_tally',
      } as unknown as LikeBox;

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma, likeBox],
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
        createdAtBlock: 10,
        owner: ownerPubKey,
        guard: 'owner_signature',
        proofSource: 'test',
        lastTouchBlock: 10,
      };
      const postLock: PostLockBox = {
        boxType: 'post_lock',
        value: POST_LOCK_THREAD_COST,
        originalValue: POST_LOCK_THREAD_COST,
        createdAtBlock: 10,
        owner: ownerPubKey,
        targetPostId: 'ab'.repeat(32),
        guard: 'epoch_tally',
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
        createdAtBlock: 10,
        owner: ownerPubKey,
        guard: 'owner_signature',
        proofSource: 'test',
        lastTouchBlock: 10,
      };
      const vouchBox: VouchBox = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 10,
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
        createdAtBlock: 10,
        owner: ownerPubKey,
        guard: 'owner_signature',
        proofSource: 'test',
        lastTouchBlock: 10,
      };
      const inviteBox: InviteBox = {
        boxType: 'invite',
        value: INVITE_KARMA_AMOUNT,
        createdAtBlock: 10,
        secretHash: new Uint8Array(32).fill(0xbb),
        inviterId: ownerUserId,
        guard: 'hash_preimage_with_bond',
      };
      const bondBox: BondBox = {
        boxType: 'bond',
        value: INVITE_BOND_KARMA,
        createdAtBlock: 10,
        inviterId: ownerUserId,
        inviteBoxId: computeBoxId(inviteBox),
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
        createdAtBlock: 10,
        owner: ownerPubKey,
        guard: 'owner_signature',
        proofSource: 'test',
        lastTouchBlock: 10,
      };
      const inviteBox: InviteBox = {
        boxType: 'invite',
        value: INVITE_KARMA_AMOUNT,
        createdAtBlock: 10,
        secretHash: new Uint8Array(32).fill(0xcc),
        inviterId: ownerUserId,
        guard: 'hash_preimage_with_bond',
      };
      const bondBox: BondBox = {
        boxType: 'bond',
        value: INVITE_BOND_KARMA,
        createdAtBlock: 10,
        inviterId: ownerUserId,
        inviteBoxId: computeBoxId(inviteBox),
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

    it('accepts a BondBox burn (zero outputs) — the sole exception', () => {
      const bondBox: BondBox = {
        boxType: 'bond',
        value: INVITE_BOND_KARMA,
        createdAtBlock: 1,
        inviterId: ownerPubKey,
        inviteBoxId: 'ff'.repeat(32),
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'bond_dual',
      };
      const bondBoxId = computeBoxId(bondBox);
      storeInsertBox({ ...bondBox, id: bondBoxId });

      const tx = buildSignedTx([bondBoxId], [], ownerPrivKey, ownerPubKey);
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(deps.getBox(bondBoxId)).toBeNull();
    });

    it('accepts a VouchBox burn (unvouch) — karma escrows into the cooldown', () => {
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const vouchBox: VouchBox = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 1,
        voucherId: ownerPubKey,
        targetId: rawPublicKey(targetPub),
        guard: 'owner_signature',
      };
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
        createdAtBlock: 1,
        owner: ownerPubKey,
        guard: 'owner_signature' as const,
        proofSource: 'test',
      };
      const creditBoxId = computeBoxId(creditBox);
      storeInsertBox({ ...creditBox, id: creditBoxId } as AnyBox);

      const tx = buildSignedTx(
        [creditBoxId],
        [
          { ...creditBox, value: 30n, owner: recipientRaw, createdAtBlock: 10 },
          { ...creditBox, value: 70n, createdAtBlock: 10 },
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
        createdAtBlock: 1,
        secretHash,
        inviterId: inviterPubKey,
        guard: 'hash_preimage_with_bond',
      };
      inviteBoxId = computeBoxId(inviteBox);
      storeInsertBox({ ...inviteBox, id: inviteBoxId });

      // Uncommitted bond — the state the sweep depends on.
      const bondBox: BondBox = {
        boxType: 'bond',
        value: INVITE_BOND_KARMA,
        createdAtBlock: 1,
        inviterId: inviterPubKey,
        inviteBoxId,
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'bond_dual',
      };
      bondBoxId = computeBoxId(bondBox);
      storeInsertBox({ ...bondBox, id: bondBoxId });
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
        createdAtBlock: 10,
        owner: beneficiary,
        guard: 'owner_signature',
        proofSource: `invite-cancel:${inviteBoxId}`,
        lastTouchBlock: 10,
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

    it('non-vacuity control: the same sweep is accepted once the inviter signs it', () => {
      const attackerKarma = createAndInsertKarma(attackerPubKey, KARMA_IN, 1, 'attacker');
      const tx = buildSweepTx(attackerPubKey, attackerKarma.id!);
      addSignature(tx, attackerPubKey, attackerPrivKey);
      // One added signature is the only difference from the rejected tx above.
      // With it, `bond_dual` Path 1 (inviter reclaim) matches and the spend is
      // authorised — the inviter is free to direct the value anywhere. So the
      // sweep fails for exactly one reason: missing bond authorisation.
      addSignature(tx, inviterPubKey, inviterPrivKey);

      const result = validateTx(deps, tx, 10);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
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
});
