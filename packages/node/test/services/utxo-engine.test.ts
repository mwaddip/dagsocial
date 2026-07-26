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
} from '@dagsocial/types';
import type { AnyBox, KarmaBox, LikeBox, InviteBox, BondBox, UtxoTransaction } from '@dagsocial/types';
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
    value: number,
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
  it('valid karma to karma (balance change, same owner)', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 60,
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
    expect((outputBox as KarmaBox).value).toBe(60);
  });

  // -------------------------------------------------------------------------
  // 2. Valid karma→karma+invite+bond (invite creation)
  // -------------------------------------------------------------------------
  it('valid karma to karma+invite+bond (invite creation)', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 70,
      createdAtBlock: 10,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 10,
    };

    const secretHash = new Uint8Array(32).fill(0xaa);
    const inviteBox: InviteBox = {
      boxType: 'invite',
      value: 15,
      createdAtBlock: 10,
      secretHash,
      inviterId: ownerUserId,
      guard: 'hash_preimage_with_bond',
    };
    const inviteId = computeBoxId(inviteBox);

    const bondBox: BondBox = {
      boxType: 'bond',
      value: 15,
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
    const karma = createAndInsertKarma(ownerPubKey, 100, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 98,
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
    const karma = createAndInsertKarma(ownerPubKey, 100, 1);

    // Consume the box first (mark as spent)
    storeConsumeBox(karma.id!, 5);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 100,
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
  // 5. Karma value non-conservation allowed (periodic decay handles it)
  // -------------------------------------------------------------------------
  it('allows karma value non-conservation (decay is periodic)', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100, 1);

    // Output claims 120 from 100 input — conservation check is skipped for
    // karma since periodic decay now handles value enforcement.
    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 120,
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
  });

  // -------------------------------------------------------------------------
  // 6. Rejects illegal transition (owner change on karma)
  // -------------------------------------------------------------------------
  it('rejects illegal transition (owner change on karma)', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100, 1);

    // Different owner
    const { publicKey: otherPub } = generateKeyPairSync('ed25519');
    const otherPubRaw = rawPublicKey(otherPub);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 100,
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
    const karma = createAndInsertKarma(ownerPubKey, 100, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 100,
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
    const karma = createAndInsertKarma(ownerPubKey, 100, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 80,
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
    const karma = createAndInsertKarma(ownerPubKey, 100, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 80,
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
    const karma = createAndInsertKarma(ownerPubKey, 100, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 60,
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
        value: 25,
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
        value: 25,
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
        value: 25,
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
        value: 25,
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
        value: 25,
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
        value: 25,
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
        value: 25,
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
        value: 25,
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
        value: 25,
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
        value: 25,
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
        value: 25,
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
        value: 25,
        createdAtBlock: 10,
        owner: inviteePubKey,
        guard: 'owner_signature',
        proofSource: 'claim',
        lastTouchBlock: 10,
      };
      const bondOut: BondBox = {
        boxType: 'bond',
        value: 25,
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
        value: 50,
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
        value: 25,
        createdAtBlock: 10,
        owner: inviteePubKey,
        guard: 'owner_signature',
        proofSource: 'claim',
        lastTouchBlock: 10,
      };
      const bondOut: BondBox = {
        boxType: 'bond',
        value: 25,
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
});
