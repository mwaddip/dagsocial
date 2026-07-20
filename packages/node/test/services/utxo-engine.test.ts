import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  createHash,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  computeBoxId,
  serializeTx,
  getUserId,
  KARMA_DECAY_RATE,
  KARMA_DECAY_GRACE_BLOCKS,
  KARMA_FLOOR,
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
  insertIdentity,
  getIdentity as storeGetIdentity,
} from '../../src/store/index.js';
import { validateAndApplyTx } from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';

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

/** Compute txHash exactly as the engine does. */
function computeTxHash(tx: UtxoTransaction): Uint8Array {
  return createHash('blake2b512')
    .update(Buffer.from(serializeTx(tx)))
    .digest()
    .subarray(0, 32);
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
      getIdentity: (userId: string) => storeGetIdentity(userId),
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
    ownerUserId = getUserId(ownerPubKey);

    // Register identity so getIdentity works
    insertIdentity(ownerUserId, ownerPubKey);

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
      guard: 'hash_preimage',
    };

    const bondBox: BondBox = {
      boxType: 'bond',
      value: 15,
      createdAtBlock: 10,
      inviterId: ownerUserId,
      inviteePublicKey: new Uint8Array(32),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'inviter_signature',
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
  // 5. Rejects value non-conservation
  // -------------------------------------------------------------------------
  it('rejects value non-conservation', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100, 1);

    // Output claims 120 but only 100 was consumed
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

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/value|Value|Insufficient effective karma/);
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
  // 8. Karma decay applied at consumption (create old box, consume, check)
  // -------------------------------------------------------------------------
  it('applies karma decay at consumption', () => {
    // Box created at block 1, consumed at block 1001
    // age = 1000, graceAge = 1000 - 100 = 900
    // decay = floor(100 * 0.0001 * 900) = floor(9) = 9
    // effective = max(100 - 9, 0) = 91
    const karma = createAndInsertKarma(ownerPubKey, 100, 1);

    // Request 95 karma — more than effective (91), so should fail
    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 95,
      createdAtBlock: 1001,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 1001,
    };

    const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
    const result = validateAndApplyTx(deps, tx, 1001);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Insufficient effective karma');
  });

  // -------------------------------------------------------------------------
  // 9. Karma decay with grace period (young box not decayed)
  // -------------------------------------------------------------------------
  it('karma decay with grace period (young box not decayed)', () => {
    // Box created at block 1, consumed at block 50
    // age = 49, graceAge = max(0, 49 - 100) = 0
    // decay = floor(100 * 0.0001 * 0) = 0
    // effective = 100 — no decay within grace period
    const karma = createAndInsertKarma(ownerPubKey, 100, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 100,
      createdAtBlock: 50,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 50,
    };

    const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
    const result = validateAndApplyTx(deps, tx, 50);

    // Should pass — no decay within grace period
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 10. Karma decay floor (doesn't go below 0)
  // -------------------------------------------------------------------------
  it('karma decay floor (doesn\'t go below KARMA_FLOOR)', () => {
    // Box created long ago with tiny value; massive decay should floor at 0
    const karma = createAndInsertKarma(ownerPubKey, 5, 1);

    // Need at least 1 karma output to be valid
    // effectiveKarma = max(5 - floor(5 * 0.0001 * max(0, 20000 - 100)), 0)
    //                = max(5 - floor(5 * 0.0001 * 19900), 0)
    //                = max(5 - floor(9.95), 0)
    //                = max(5 - 9, 0)
    //                = max(-4, 0)
    //                = 0
    // So any output > 0 should fail (even 1)
    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 1,
      createdAtBlock: 20001,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 20001,
    };

    const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
    const result = validateAndApplyTx(deps, tx, 20001);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Insufficient effective karma');
  });

  // -------------------------------------------------------------------------
  // 11. Transaction atomic: partial failure rolls back all changes
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
  // 12. computeBoxId called for each output, IDs assigned
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
});
