import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  createHash,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  computeBoxId,
  getUserId,
  MAX_PENDING_INVITES,
  INVITE_PROBATION_BLOCKS,
} from '@dagsocial/types';
import type { KarmaBox, BondBox } from '@dagsocial/types';
import Database from 'better-sqlite3';

import {
  initDb,
  closeDb,
  getDb,
  getBox,
  getKarmaBox,
  insertBox,
  insertIdentity,
} from '../../src/store/index.js';
import { createInvite, claimInvite, cancelInvite } from '../../src/services/invites.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract raw 32-byte Ed25519 public key from SPKI DER KeyObject. */
function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

/** Create and insert a karma box, returning it with its computed id. */
function createKarmaBox(
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
  insertBox(full);
  return full;
}

/** Sign the create-invite message. */
function signCreateInvite(
  inviterId: string,
  karmaAmount: number,
  bondAmount: number,
  privKey: KeyObject,
): Uint8Array {
  const message = `create-invite:${inviterId}:${karmaAmount}:${bondAmount}`;
  const hash = createHash('blake2b512').update(message).digest().subarray(0, 32);
  return new Uint8Array(cryptoSign(null, hash, privKey));
}

/** Sign the cancel-invite message. */
function signCancelInvite(inviteBoxId: string, privKey: KeyObject): Uint8Array {
  const message = `cancel-invite:${inviteBoxId}`;
  const hash = createHash('blake2b512').update(message).digest().subarray(0, 32);
  return new Uint8Array(cryptoSign(null, hash, privKey));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('invites service', () => {
  let db: Database.Database;
  let inviterPubKey: Uint8Array;
  let inviterPrivKey: KeyObject;
  let inviterId: string;
  let inviteePubKey: Uint8Array;
  let inviteePrivKey: KeyObject;
  let inviteeId: string;

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();

    // Generate inviter keypair
    const inviterKeys = generateKeyPairSync('ed25519');
    inviterPubKey = rawPublicKey(inviterKeys.publicKey);
    inviterPrivKey = inviterKeys.privateKey;
    inviterId = getUserId(inviterPubKey);
    insertIdentity(inviterId, inviterPubKey);

    // Generate invitee keypair
    const inviteeKeys = generateKeyPairSync('ed25519');
    inviteePubKey = rawPublicKey(inviteeKeys.publicKey);
    inviteePrivKey = inviteeKeys.privateKey;
    inviteeId = getUserId(inviteePubKey);
    insertIdentity(inviteeId, inviteePubKey);
  });

  afterEach(() => {
    closeDb();
  });

  // -----------------------------------------------------------------------
  // 1. Full create->claim cycle produces invitee karma box
  // -----------------------------------------------------------------------
  it('Full create->claim cycle produces invitee karma box', () => {
    createKarmaBox(inviterPubKey, 100, 1);

    const sig = signCreateInvite(inviterId, 15, 10, inviterPrivKey);
    const result = createInvite(inviterId, 15, 10, inviterPubKey, sig, 1);

    expect(result.inviteBox.id).toBeDefined();
    expect(result.bondBox.id).toBeDefined();
    expect(result.secret).toHaveLength(32);
    expect(result.secretHash).toHaveLength(32);

    // Inviter's karma decreased
    const inviterKarma = getKarmaBox(inviterPubKey);
    expect(inviterKarma).not.toBeNull();
    expect(inviterKarma!.value).toBe(75); // 100 - 15 - 10

    // Claim
    const claimResult = claimInvite(result.inviteBox.id!, result.secret, inviteePubKey, 5);

    expect(claimResult.userId).toBe(inviteeId);
    expect(claimResult.karmaBoxId).toBeDefined();

    // Invitee now has karma
    const inviteeKarma = getKarmaBox(inviteePubKey);
    expect(inviteeKarma).not.toBeNull();
    expect(inviteeKarma!.value).toBe(15);

    // Invite box is spent
    const inviteSpent = db
      .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
      .get(result.inviteBox.id!) as { spent_at_block: number | null };
    expect(inviteSpent.spent_at_block).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // 2. Full create->cancel cycle returns karma to inviter
  // -----------------------------------------------------------------------
  it('Full create->cancel cycle returns karma to inviter', () => {
    createKarmaBox(inviterPubKey, 100, 1);

    const sig = signCreateInvite(inviterId, 15, 10, inviterPrivKey);
    const result = createInvite(inviterId, 15, 10, inviterPubKey, sig, 1);

    const cancelSig = signCancelInvite(result.inviteBox.id!, inviterPrivKey);
    cancelInvite(result.inviteBox.id!, inviterId, cancelSig, 5);

    // Inviter gets karma back
    const inviterKarma = getKarmaBox(inviterPubKey);
    expect(inviterKarma).not.toBeNull();
    expect(inviterKarma!.value).toBe(100);

    // Invite box is spent
    const inviteSpent = db
      .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
      .get(result.inviteBox.id!) as { spent_at_block: number | null };
    expect(inviteSpent.spent_at_block).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // 3. Create fails at MAX_PENDING_INVITES
  // -----------------------------------------------------------------------
  it('Create fails at MAX_PENDING_INVITES', () => {
    const totalNeeded = (15 + 10) * MAX_PENDING_INVITES;
    createKarmaBox(inviterPubKey, totalNeeded + 100, 1);

    for (let i = 0; i < MAX_PENDING_INVITES; i++) {
      const sig = signCreateInvite(inviterId, 15, 10, inviterPrivKey);
      createInvite(inviterId, 15, 10, inviterPubKey, sig, i + 1);
    }

    const sig = signCreateInvite(inviterId, 15, 10, inviterPrivKey);
    expect(() => createInvite(inviterId, 15, 10, inviterPubKey, sig, 99)).toThrow(
      'Invite limit reached',
    );
  });

  // -----------------------------------------------------------------------
  // 4. Create fails if insufficient karma
  // -----------------------------------------------------------------------
  it('Create fails if insufficient karma', () => {
    createKarmaBox(inviterPubKey, 10, 1);

    const sig = signCreateInvite(inviterId, 15, 10, inviterPrivKey);
    expect(() => createInvite(inviterId, 15, 10, inviterPubKey, sig, 1)).toThrow(
      'Insufficient karma',
    );
  });

  // -----------------------------------------------------------------------
  // 5. Claim fails with wrong secret
  // -----------------------------------------------------------------------
  it('Claim fails with wrong secret', () => {
    createKarmaBox(inviterPubKey, 100, 1);
    const sig = signCreateInvite(inviterId, 15, 10, inviterPrivKey);
    const result = createInvite(inviterId, 15, 10, inviterPubKey, sig, 1);

    const wrongSecret = new Uint8Array(32).fill(0xff);
    expect(() =>
      claimInvite(result.inviteBox.id!, wrongSecret, inviteePubKey, 5),
    ).toThrow('Secret hash mismatch');
  });

  // -----------------------------------------------------------------------
  // 6. Claim fails if publicKey already account
  // -----------------------------------------------------------------------
  it('Claim fails if publicKey already account', () => {
    createKarmaBox(inviterPubKey, 100, 1);
    createKarmaBox(inviteePubKey, 50, 1); // invitee already has karma

    const sig = signCreateInvite(inviterId, 15, 10, inviterPrivKey);
    const result = createInvite(inviterId, 15, 10, inviterPubKey, sig, 1);

    expect(() =>
      claimInvite(result.inviteBox.id!, result.secret, inviteePubKey, 5),
    ).toThrow('already associated with an account');
  });

  // -----------------------------------------------------------------------
  // 7. Cancel fails if already claimed
  // -----------------------------------------------------------------------
  it('Cancel fails if already claimed', () => {
    createKarmaBox(inviterPubKey, 100, 1);
    const sig = signCreateInvite(inviterId, 15, 10, inviterPrivKey);
    const result = createInvite(inviterId, 15, 10, inviterPubKey, sig, 1);

    // Claim first
    claimInvite(result.inviteBox.id!, result.secret, inviteePubKey, 5);

    // Try to cancel
    const cancelSig = signCancelInvite(result.inviteBox.id!, inviterPrivKey);
    expect(() =>
      cancelInvite(result.inviteBox.id!, inviterId, cancelSig, 10),
    ).toThrow('already claimed or spent');
  });

  // -----------------------------------------------------------------------
  // 8. Cancel fails with wrong signature
  // -----------------------------------------------------------------------
  it('Cancel fails with wrong signature', () => {
    createKarmaBox(inviterPubKey, 100, 1);
    const sig = signCreateInvite(inviterId, 15, 10, inviterPrivKey);
    const result = createInvite(inviterId, 15, 10, inviterPubKey, sig, 1);

    // Sign with invitee's key
    const wrongSig = signCancelInvite(result.inviteBox.id!, inviteePrivKey);
    expect(() =>
      cancelInvite(result.inviteBox.id!, inviterId, wrongSig, 5),
    ).toThrow('Invalid inviter signature');
  });

  // -----------------------------------------------------------------------
  // 9. Bond box updated on claim (inviteeKey, probation blocks)
  // -----------------------------------------------------------------------
  it('Bond box updated on claim (inviteeKey, probation blocks)', () => {
    createKarmaBox(inviterPubKey, 100, 1);
    const sig = signCreateInvite(inviterId, 15, 10, inviterPrivKey);
    const result = createInvite(inviterId, 15, 10, inviterPubKey, sig, 1);

    // Check bond box is unclaimed initially
    const initialBond = getBox(result.bondBox.id!) as BondBox;
    expect(initialBond.inviteePublicKey.length).toBe(0);
    expect(initialBond.probationStartBlock).toBe(0);
    expect(initialBond.probationEndBlock).toBe(0);

    // Claim
    claimInvite(result.inviteBox.id!, result.secret, inviteePubKey, 5);

    // Original bond box should be spent
    const spentRow = db
      .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
      .get(result.bondBox.id!) as { spent_at_block: number | null };
    expect(spentRow.spent_at_block).not.toBeNull();

    // Find updated (new) bond box
    const inviterBonds = db
      .prepare(
        `SELECT * FROM utxo_boxes
         WHERE box_type = 'bond'
           AND json_extract(extra_data, '$.inviterId') = ?
           AND spent_at_block IS NULL`,
      )
      .all(inviterId) as Array<{ id: string; extra_data: string }>;

    expect(inviterBonds.length).toBeGreaterThan(0);
    const extra = JSON.parse(inviterBonds[0]!.extra_data);
    expect(extra.inviteePublicKey).not.toBeNull();
    expect(extra.probationStartBlock).toBe(5);
    expect(extra.probationEndBlock).toBe(5 + INVITE_PROBATION_BLOCKS);
  });

  // -----------------------------------------------------------------------
  // 10. Secret hash computed correctly
  // -----------------------------------------------------------------------
  it('Secret hash computed correctly', () => {
    createKarmaBox(inviterPubKey, 100, 1);
    const sig = signCreateInvite(inviterId, 15, 10, inviterPrivKey);
    const result = createInvite(inviterId, 15, 10, inviterPubKey, sig, 1);

    const expectedHash = createHash('blake2b512')
      .update(Buffer.from(result.secret))
      .digest()
      .subarray(0, 32);

    expect(Buffer.from(result.secretHash).toString('hex')).toBe(
      expectedHash.toString('hex'),
    );
  });
});
