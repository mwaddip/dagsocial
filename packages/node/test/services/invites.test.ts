import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  createHash,
  type KeyObject,
} from 'crypto';
import {
  computeBoxId,
  decodeTx,
  MAX_PENDING_INVITES,
  INVITE_PROBATION_BLOCKS,
  PROTOCOL_VERSION,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
} from '@dagsocial/types';
import type { KarmaBox, InviteBox, BondBox, UtxoTransaction, AnyBox } from '@dagsocial/types';
import Database from 'better-sqlite3';

import {
  initDb,
  closeDb,
  getDb,
  getKarmaBox,
  insertBox as storeInsertBox,
  insertIdentity,
  getIdentity as storeGetIdentity,
  getBox as storeGetBox,
  consumeBox as storeConsumeBox,
  getPendingEntries,
} from '../../src/store/index.js';
import { createInvite, claimInvite, cancelInvite } from '../../src/services/invites.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';
import { rawPublicKey, signTransaction } from '../helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  storeInsertBox(full);
  return full;
}

/** Create and insert an invite box into UTXO. */
function insertInviteBox(
  value: number,
  createdAtBlock: number,
  secretHash: Uint8Array,
  inviterId: Uint8Array,
): InviteBox {
  const box: Omit<InviteBox, 'id'> & { id?: string } = {
    boxType: 'invite',
    value,
    createdAtBlock,
    secretHash,
    inviterId,
    guard: 'hash_preimage',
  };
  const id = computeBoxId(box);
  const full: InviteBox = { ...box, id, boxType: 'invite', guard: 'hash_preimage' };
  storeInsertBox(full);
  return full;
}

/** Create and insert a bond box into UTXO. */
function insertBondBox(
  value: number,
  createdAtBlock: number,
  inviterId: Uint8Array,
): BondBox {
  const box: Omit<BondBox, 'id'> & { id?: string } = {
    boxType: 'bond',
    value,
    createdAtBlock,
    inviterId,
    inviteePublicKey: new Uint8Array(0),
    probationStartBlock: 0,
    probationEndBlock: 0,
    guard: 'inviter_signature',
  };
  const id = computeBoxId(box);
  const full: BondBox = { ...box, id, boxType: 'bond', guard: 'inviter_signature' };
  storeInsertBox(full);
  return full;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('invites service', () => {
  let db: Database.Database;
  let inviterPubKey: Uint8Array;
  let inviterPrivKey: KeyObject;
  let inviterPubKeyHex: string;
  let inviterId: Uint8Array;
  let inviteePubKey: Uint8Array;
  let inviteePubKeyHex: string;
  let inviteePrivKey: KeyObject;

  function makeDeps(): UtxoEngineDeps {
    return {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db
          .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
          .get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
      insertBox: (box: AnyBox) => storeInsertBox(box),
      consumeBox: (id: string, atBlock: number) => storeConsumeBox(id, atBlock),
      getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
      getIdentity: (userId: Uint8Array) => storeGetIdentity(userId),
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
    };
  }

  let deps: UtxoEngineDeps;

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();

    // Generate inviter keypair
    const inviterKeys = generateKeyPairSync('ed25519');
    inviterPubKey = rawPublicKey(inviterKeys.publicKey);
    inviterPrivKey = inviterKeys.privateKey;
    inviterPubKeyHex = Buffer.from(inviterPubKey).toString('hex');
    inviterId = inviterPubKey;
    insertIdentity(inviterId, inviterPubKey);

    // Generate invitee keypair
    const inviteeKeys = generateKeyPairSync('ed25519');
    inviteePubKey = rawPublicKey(inviteeKeys.publicKey);
    inviteePrivKey = inviteeKeys.privateKey;
    inviteePubKeyHex = Buffer.from(inviteePubKey).toString('hex');
    insertIdentity(inviteePubKey, inviteePubKey);

    deps = makeDeps();
  });

  afterEach(() => {
    closeDb();
  });

  // -----------------------------------------------------------------------
  // 1. createInvite returns pending and inserts into mempool
  // -----------------------------------------------------------------------
  it('createInvite returns pending and inserts into mempool', () => {
    const karma = createKarmaBox(inviterPubKey, 100, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 50,
      createdAtBlock: 1,
      owner: inviterPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 1,
    };
    const newKarmaId = computeBoxId(newKarma);

    const secret = new Uint8Array(32).fill(0x01);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    const inviteBox: InviteBox = {
      boxType: 'invite',
      value: INVITE_KARMA_AMOUNT,
      createdAtBlock: 1,
      secretHash,
      inviterId,
      guard: 'hash_preimage',
    };
    const inviteBoxId = computeBoxId(inviteBox);

    const bondBox: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 1,
      inviterId,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'inviter_signature',
    };
    const bondBoxId = computeBoxId(bondBox);

    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { ...newKarma, id: newKarmaId },
        { ...inviteBox, id: inviteBoxId },
        { ...bondBox, id: bondBoxId },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);

    const result = createInvite(deps, tx, 1);

    expect(result.status).toBe('pending');
    expect(result.txId).toBeDefined();
    expect(typeof result.txId).toBe('string');
    expect(result.expiresAtHeight).toBe(1 + 720);
    expect(result.inviteBox.id).toBeDefined();
    expect(result.bondBox.id).toBeDefined();

    // Karma is unchanged (pending in mempool)
    const inviterKarma = getKarmaBox(inviterPubKey);
    expect(inviterKarma).not.toBeNull();
    expect(inviterKarma!.value).toBe(100); // unchanged — pending

    // Verify mempool has the entry
    const entries = getPendingEntries(100);
    const matching = entries.filter((e) => {
      if (e.entryType !== 'utxo_tx' || !e.utxoTxCbor) return false;
      const storedTx = decodeTx(e.utxoTxCbor);
      return storedTx.outputs.some((o) => o.boxType === 'invite');
    });
    expect(matching.length).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 2. claimInvite returns pending and inserts into mempool
  // -----------------------------------------------------------------------
  it('claimInvite returns pending and inserts into mempool', () => {
    const karma = createKarmaBox(inviterPubKey, 100, 1);

    const secret = new Uint8Array(32).fill(0x42);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    // Manually insert invite and bond boxes into UTXO (simulating confirmed create)
    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId);

    // Build claim tx
    const karmaOut: KarmaBox = {
      boxType: 'karma',
      value: INVITE_KARMA_AMOUNT,
      createdAtBlock: 5,
      owner: inviteePubKey,
      guard: 'owner_signature',
      proofSource: `invite-claim:${inviteBox.id}`,
      lastTouchBlock: 5,
    };
    const karmaOutId = computeBoxId(karmaOut);

    const bondOut: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 1,
      inviterId,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 5,
      probationEndBlock: 5 + INVITE_PROBATION_BLOCKS,
      guard: 'inviter_signature',
    };
    const bondOutId = computeBoxId(bondOut);

    const tx: UtxoTransaction = {
      inputs: [inviteBox.id!, bondBox.id!],
      outputs: [
        { ...karmaOut, id: karmaOutId },
        { ...bondOut, id: bondOutId },
      ],
      signatures: {},
      preimages: { [inviteBox.id!]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };

    // Inviter must sign the claim tx (for bond's inviter_signature guard)
    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);

    const claimResult = claimInvite(deps, tx, 5);

    expect(claimResult.status).toBe('pending');
    expect(claimResult.txId).toBeDefined();
    expect(typeof claimResult.txId).toBe('string');
    expect(claimResult.expiresAtHeight).toBe(5 + 720);
    expect(Buffer.from(claimResult.userId).toString('hex')).toBe(inviteePubKeyHex);
    expect(claimResult.karmaBoxId).toBeDefined();

    // Karma unchanged (pending)
    const inviteeKarma = getKarmaBox(inviteePubKey);
    expect(inviteeKarma).toBeNull(); // not yet created — pending

    // Verify mempool has the claim entry
    const entries = getPendingEntries(100);
    const matching = entries.filter((e) => {
      if (e.entryType !== 'utxo_tx' || !e.utxoTxCbor) return false;
      const storedTx = decodeTx(e.utxoTxCbor);
      return storedTx.outputs.some(
        (o) =>
          o.boxType === 'karma' &&
          (o as KarmaBox).proofSource.startsWith('invite-claim'),
      );
    });
    expect(matching.length).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 3. cancelInvite returns pending and inserts into mempool
  // -----------------------------------------------------------------------
  it('cancelInvite returns pending and inserts into mempool', () => {
    const karmaIn = createKarmaBox(inviterPubKey, 100, 1);

    const secret = new Uint8Array(32).fill(0xaa);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    // Manually insert invite and bond boxes into UTXO
    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId);

    // Build cancel tx: karma + invite + bond -> karma (all value returned)
    const totalValue = 100 + INVITE_KARMA_AMOUNT + INVITE_BOND_KARMA;
    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: totalValue,
      createdAtBlock: 5,
      owner: inviterPubKey,
      guard: 'owner_signature',
      proofSource: `invite-cancel:${inviteBox.id}`,
      lastTouchBlock: 5,
    };
    const newKarmaId = computeBoxId(newKarma);

    const tx: UtxoTransaction = {
      inputs: [karmaIn.id!, inviteBox.id!, bondBox.id!],
      outputs: [
        { ...newKarma, id: newKarmaId },
      ],
      signatures: {},
      preimages: { [inviteBox.id!]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };

    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);

    const result = cancelInvite(deps, tx, 5);

    expect(result.status).toBe('pending');
    expect(result.txId).toBeDefined();
    expect(typeof result.txId).toBe('string');
    expect(result.expiresAtHeight).toBe(5 + 720);

    // Karma unchanged (pending)
    const inviterKarma = getKarmaBox(inviterPubKey);
    expect(inviterKarma).not.toBeNull();
    // The createKarmaBox only created one box, but the cancel tx is pending
    // so the original karma should still be there
    expect(inviterKarma!.id).toBe(karmaIn.id);

    // Verify mempool has the cancel entry
    const entries = getPendingEntries(100);
    const matching = entries.filter((e) => {
      if (e.entryType !== 'utxo_tx' || !e.utxoTxCbor) return false;
      const storedTx = decodeTx(e.utxoTxCbor);
      return storedTx.outputs.some(
        (o) =>
          o.boxType === 'karma' &&
          (o as KarmaBox).proofSource.startsWith('invite-cancel'),
      );
    });
    expect(matching.length).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 4. Create fails at MAX_PENDING_INVITES (UTXO + mempool)
  // -----------------------------------------------------------------------
  it('Create fails at MAX_PENDING_INVITES', () => {
    const totalNeeded = (INVITE_KARMA_AMOUNT + INVITE_BOND_KARMA) * MAX_PENDING_INVITES;
    createKarmaBox(inviterPubKey, totalNeeded + 100, 1);

    for (let i = 0; i < MAX_PENDING_INVITES; i++) {
      // Build a fresh tx for each invite
      const karma = createKarmaBox(inviterPubKey, 100, i + 1);

      const newKarma: KarmaBox = {
        boxType: 'karma',
        value: 50,
        createdAtBlock: i + 1,
        owner: inviterPubKey,
        guard: 'owner_signature',
        proofSource: `test-${i}`,
        lastTouchBlock: i + 1,
      };
      const secret = new Uint8Array(32).fill(i + 1);
      const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);
      const inviteBox: InviteBox = {
        boxType: 'invite',
        value: INVITE_KARMA_AMOUNT,
        createdAtBlock: i + 1,
        secretHash,
        inviterId,
        guard: 'hash_preimage',
      };
      const bondBox: BondBox = {
        boxType: 'bond',
        value: INVITE_BOND_KARMA,
        createdAtBlock: i + 1,
        inviterId,
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'inviter_signature',
      };

      const tx: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [
          { ...newKarma, id: computeBoxId(newKarma) },
          { ...inviteBox, id: computeBoxId(inviteBox) },
          { ...bondBox, id: computeBoxId(bondBox) },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      signTransaction(tx, inviterPrivKey, inviterPubKeyHex);

      createInvite(deps, tx, i + 1);
    }

    // One more should fail
    const karma = createKarmaBox(inviterPubKey, 100, 99, 'overflow-test');
    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 50,
      createdAtBlock: 99,
      owner: inviterPubKey,
      guard: 'owner_signature',
      proofSource: 'overflow-test',
      lastTouchBlock: 99,
    };
    const secret = new Uint8Array(32).fill(0xff);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);
    const inviteBox: InviteBox = {
      boxType: 'invite',
      value: INVITE_KARMA_AMOUNT,
      createdAtBlock: 99,
      secretHash,
      inviterId,
      guard: 'hash_preimage',
    };
    const bondBox: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 99,
      inviterId,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'inviter_signature',
    };

    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { ...newKarma, id: computeBoxId(newKarma) },
        { ...inviteBox, id: computeBoxId(inviteBox) },
        { ...bondBox, id: computeBoxId(bondBox) },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);

    expect(() => createInvite(deps, tx, 99)).toThrow('Invite limit reached');
  });

  // -----------------------------------------------------------------------
  // 5. Create accepts karma below invite cost (decay is periodic)
  // -----------------------------------------------------------------------
  it('Create accepts karma below invite cost (decay is periodic)', () => {
    const karma = createKarmaBox(inviterPubKey, 10, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 0,
      createdAtBlock: 1,
      owner: inviterPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 1,
    };
    const secret = new Uint8Array(32).fill(0x01);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);
    const inviteBox: InviteBox = {
      boxType: 'invite',
      value: INVITE_KARMA_AMOUNT,
      createdAtBlock: 1,
      secretHash,
      inviterId,
      guard: 'hash_preimage',
    };
    const bondBox: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 1,
      inviterId,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'inviter_signature',
    };

    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { ...newKarma, id: computeBoxId(newKarma) },
        { ...inviteBox, id: computeBoxId(inviteBox) },
        { ...bondBox, id: computeBoxId(bondBox) },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);

    // Karma value non-conservation is no longer enforced at tx time —
    // periodic decay handles value enforcement globally.
    const result = createInvite(deps, tx, 1);
    expect(result.status).toBe('pending');
  });

  // -----------------------------------------------------------------------
  // 6. Claim fails with wrong secret
  // -----------------------------------------------------------------------
  it('Claim fails with wrong secret', () => {
    const secret = new Uint8Array(32).fill(0x42);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);
    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId);

    const wrongSecret = new Uint8Array(32).fill(0xff);
    const karmaOut: KarmaBox = {
      boxType: 'karma',
      value: INVITE_KARMA_AMOUNT,
      createdAtBlock: 5,
      owner: inviteePubKey,
      guard: 'owner_signature',
      proofSource: `invite-claim:${inviteBox.id}`,
      lastTouchBlock: 5,
    };
    const bondOut: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 1,
      inviterId,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 5,
      probationEndBlock: 5 + INVITE_PROBATION_BLOCKS,
      guard: 'inviter_signature',
    };

    const tx: UtxoTransaction = {
      inputs: [inviteBox.id!, bondBox.id!],
      outputs: [
        { ...karmaOut, id: computeBoxId(karmaOut) },
        { ...bondOut, id: computeBoxId(bondOut) },
      ],
      signatures: {},
      preimages: { [inviteBox.id!]: wrongSecret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);

    expect(() => claimInvite(deps, tx, 5)).toThrow(
      'Invalid invite claim transaction',
    );
  });

  // -----------------------------------------------------------------------
  // 7. Claim fails if publicKey already account
  // -----------------------------------------------------------------------
  it('Claim fails if publicKey already account', () => {
    createKarmaBox(inviteePubKey, 50, 1); // invitee already has karma

    const secret = new Uint8Array(32).fill(0x42);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);
    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId);

    const karmaOut: KarmaBox = {
      boxType: 'karma',
      value: INVITE_KARMA_AMOUNT,
      createdAtBlock: 5,
      owner: inviteePubKey,
      guard: 'owner_signature',
      proofSource: `invite-claim:${inviteBox.id}`,
      lastTouchBlock: 5,
    };
    const bondOut: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 1,
      inviterId,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 5,
      probationEndBlock: 5 + INVITE_PROBATION_BLOCKS,
      guard: 'inviter_signature',
    };

    const tx: UtxoTransaction = {
      inputs: [inviteBox.id!, bondBox.id!],
      outputs: [
        { ...karmaOut, id: computeBoxId(karmaOut) },
        { ...bondOut, id: computeBoxId(bondOut) },
      ],
      signatures: {},
      preimages: { [inviteBox.id!]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);

    expect(() => claimInvite(deps, tx, 5)).toThrow(
      'already associated with an account',
    );
  });

  // -----------------------------------------------------------------------
  // 8. Cancel fails if already claimed (confirmed — spent in UTXO)
  // -----------------------------------------------------------------------
  it('Cancel fails if already claimed', () => {
    const karmaIn = createKarmaBox(inviterPubKey, 100, 1);

    const secret = new Uint8Array(32).fill(0xaa);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);
    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId);

    // Simulate confirmed claim by marking invite box as spent
    db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(3, inviteBox.id);

    // Build a cancel tx
    const totalValue = 100 + INVITE_KARMA_AMOUNT + INVITE_BOND_KARMA;
    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: totalValue,
      createdAtBlock: 10,
      owner: inviterPubKey,
      guard: 'owner_signature',
      proofSource: `invite-cancel:${inviteBox.id}`,
      lastTouchBlock: 10,
    };

    const tx: UtxoTransaction = {
      inputs: [karmaIn.id!, inviteBox.id!, bondBox.id!],
      outputs: [{ ...newKarma, id: computeBoxId(newKarma) }],
      signatures: {},
      preimages: { [inviteBox.id!]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);

    expect(() => cancelInvite(deps, tx, 10)).toThrow('Transaction does not consume an InviteBox');
  });

  // -----------------------------------------------------------------------
  // 9. Cancel fails with wrong signature
  // -----------------------------------------------------------------------
  it('Cancel fails with wrong signature', () => {
    const karmaIn = createKarmaBox(inviterPubKey, 100, 1);

    const secret = new Uint8Array(32).fill(0xaa);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);
    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId);

    const totalValue = 100 + INVITE_KARMA_AMOUNT + INVITE_BOND_KARMA;
    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: totalValue,
      createdAtBlock: 5,
      owner: inviterPubKey,
      guard: 'owner_signature',
      proofSource: `invite-cancel:${inviteBox.id}`,
      lastTouchBlock: 5,
    };

    const tx: UtxoTransaction = {
      inputs: [karmaIn.id!, inviteBox.id!, bondBox.id!],
      outputs: [{ ...newKarma, id: computeBoxId(newKarma) }],
      signatures: {},
      preimages: { [inviteBox.id!]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };

    // Sign with invitee's key instead of inviter's (wrong signature)
    signTransaction(tx, inviteePrivKey, inviteePubKeyHex);

    expect(() => cancelInvite(deps, tx, 5)).toThrow(
      'Invalid invite cancel transaction',
    );
  });
});
