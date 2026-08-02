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
  getBox as storeGetBox,
  consumeBox as storeConsumeBox,
  getPendingEntries,
} from '../../src/store/index.js';
import { createInvite, claimInvite, cancelInvite, commitInvite } from '../../src/services/invites.js';
import { validateTx } from '../../src/services/utxo-engine.js';
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
    guard: 'hash_preimage_with_bond',
  };
  const id = computeBoxId(box);
  const full: InviteBox = { ...box, id, boxType: 'invite', guard: 'hash_preimage_with_bond' };
  storeInsertBox(full);
  return full;
}

/** Create and insert a bond box into UTXO. */
function insertBondBox(
  value: number,
  createdAtBlock: number,
  inviterId: Uint8Array,
  inviteBoxId: string,
): BondBox {
  const box: Omit<BondBox, 'id'> & { id?: string } = {
    boxType: 'bond',
    value,
    createdAtBlock,
    inviterId,
    inviteBoxId,
    inviteePublicKey: new Uint8Array(0),
    probationStartBlock: 0,
    probationEndBlock: 0,
    guard: 'bond_dual',
  };
  const id = computeBoxId(box);
  const full: BondBox = { ...box, id, boxType: 'bond', guard: 'bond_dual' };
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

    // Generate invitee keypair
    const inviteeKeys = generateKeyPairSync('ed25519');
    inviteePubKey = rawPublicKey(inviteeKeys.publicKey);
    inviteePrivKey = inviteeKeys.privateKey;
    inviteePubKeyHex = Buffer.from(inviteePubKey).toString('hex');

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
      guard: 'hash_preimage_with_bond',
    };
    const inviteBoxId = computeBoxId(inviteBox);

    const bondBox: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 1,
      inviterId,
      inviteBoxId: inviteBoxId,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual',
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
  it('commit + reveal full lifecycle', () => {
    const karma = createKarmaBox(inviterPubKey, 100, 1);

    const secret = new Uint8Array(32).fill(0x42);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    // Manually insert invite and bond boxes into UTXO (simulating confirmed create)
    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId, inviteBox.id!);

    // ---- Step 1: Commit ----
    const bondOutCommitted: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 3,
      inviterId,
      inviteBoxId: inviteBox.id!,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 3,
      probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      guard: 'bond_dual',
    };
    const bondOutCommittedId = computeBoxId(bondOutCommitted);

    const commitTx: UtxoTransaction = {
      inputs: [bondBox.id!],
      outputs: [{ ...bondOutCommitted, id: bondOutCommittedId }],
      signatures: {},
      preimages: { [bondBox.id!]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(commitTx, inviteePrivKey, inviteePubKeyHex);

    const commitResult = commitInvite(deps, commitTx, 3);
    expect(commitResult.status).toBe('pending');
    expect(commitResult.bondBoxId).toBe(bondBox.id);

    // Simulate commit confirmed by updating BondBox extra_data
    const db = getDb();
    db.prepare(
      'UPDATE utxo_boxes SET extra_data = ? WHERE id = ?',
    ).run(
      JSON.stringify({
        inviterId: Buffer.from(inviterId).toString('hex'),
        inviteBoxId: inviteBox.id,
        inviteePublicKey: Array.from(inviteePubKey),
        probationStartBlock: 3,
        probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      }),
      bondBox.id,
    );

    // ---- Step 2: Reveal (claim) ----
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

    // BondOut preserves commitment fields
    const bondOutReveal: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 3,
      inviterId,
      inviteBoxId: inviteBox.id!,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 3,
      probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      guard: 'bond_dual',
    };
    const bondOutRevealId = computeBoxId(bondOutReveal);

    const revealTx: UtxoTransaction = {
      inputs: [inviteBox.id!, bondBox.id!],
      outputs: [
        { ...karmaOut, id: karmaOutId },
        { ...bondOutReveal, id: bondOutRevealId },
      ],
      signatures: {},
      preimages: { [inviteBox.id!]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(revealTx, inviteePrivKey, inviteePubKeyHex);

    const claimResult = claimInvite(deps, revealTx, 5);

    expect(claimResult.status).toBe('pending');
    expect(claimResult.txId).toBeDefined();
    expect(claimResult.userId).toEqual(inviteePubKey);
    expect(claimResult.karmaBoxId).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // commitInvite returns pending and inserts into mempool
  // -----------------------------------------------------------------------
  it('commitInvite returns pending and inserts into mempool', () => {
    const secret = new Uint8Array(32).fill(0x42);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId, inviteBox.id!);

    const bondOut: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 5,
      inviterId,
      inviteBoxId: inviteBox.id!,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 5,
      probationEndBlock: 5 + INVITE_PROBATION_BLOCKS,
      guard: 'bond_dual',
    };
    const bondOutId = computeBoxId(bondOut);

    const tx: UtxoTransaction = {
      inputs: [bondBox.id!],
      outputs: [{ ...bondOut, id: bondOutId }],
      signatures: {},
      preimages: { [bondBox.id!]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviteePrivKey, inviteePubKeyHex);

    const result = commitInvite(deps, tx, 5);

    expect(result.status).toBe('pending');
    expect(result.txId).toBeDefined();
    expect(typeof result.txId).toBe('string');
    expect(result.expiresAtHeight).toBe(5 + 720);
    expect(result.bondBoxId).toBe(bondBox.id);

    // Verify mempool has the commit entry
    const entries = getPendingEntries(100);
    const matching = entries.filter((e) => {
      if (e.entryType !== 'utxo_tx' || !e.utxoTxCbor) return false;
      const storedTx = decodeTx(e.utxoTxCbor);
      return storedTx.inputs.length === 1 && storedTx.outputs.length === 1;
    });
    expect(matching.length).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Commit fails with wrong secret
  // -----------------------------------------------------------------------
  it('Commit fails with wrong secret', () => {
    const secret = new Uint8Array(32).fill(0x42);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);
    const wrongSecret = new Uint8Array(32).fill(0xff);

    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId, inviteBox.id!);

    const bondOut: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 5,
      inviterId,
      inviteBoxId: inviteBox.id!,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 5,
      probationEndBlock: 5 + INVITE_PROBATION_BLOCKS,
      guard: 'bond_dual',
    };

    const tx: UtxoTransaction = {
      inputs: [bondBox.id!],
      outputs: [{ ...bondOut, id: computeBoxId(bondOut) }],
      signatures: {},
      preimages: { [bondBox.id!]: wrongSecret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviteePrivKey, inviteePubKeyHex);

    expect(() => commitInvite(deps, tx, 5)).toThrow('Invalid commit transaction');
  });

  // -----------------------------------------------------------------------
  // Commit fails if BondBox already committed
  // -----------------------------------------------------------------------
  it('Commit fails if BondBox already committed', () => {
    const secret = new Uint8Array(32).fill(0x42);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId, inviteBox.id!);

    // Simulate confirmed commit by updating extra_data
    const db = getDb();
    db.prepare(
      'UPDATE utxo_boxes SET extra_data = ? WHERE id = ?',
    ).run(
      JSON.stringify({
        inviterId: Buffer.from(inviterId).toString('hex'),
        inviteBoxId: inviteBox.id,
        inviteePublicKey: Array.from(inviteePubKey),
        probationStartBlock: 3,
        probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      }),
      bondBox.id,
    );

    const bondOut: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 5,
      inviterId,
      inviteBoxId: inviteBox.id!,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 5,
      probationEndBlock: 5 + INVITE_PROBATION_BLOCKS,
      guard: 'bond_dual',
    };

    const tx: UtxoTransaction = {
      inputs: [bondBox.id!],
      outputs: [{ ...bondOut, id: computeBoxId(bondOut) }],
      signatures: {},
      preimages: { [bondBox.id!]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviteePrivKey, inviteePubKeyHex);

    expect(() => commitInvite(deps, tx, 5)).toThrow('already committed');
  });

  // -----------------------------------------------------------------------
  // Reveal fails if BondBox committed to different pubkey
  // -----------------------------------------------------------------------
  it('Reveal fails if BondBox committed to different pubkey', () => {
    const secret = new Uint8Array(32).fill(0x42);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId, inviteBox.id!);

    // Simulate BondBox committed to a different pubkey (attacker's)
    const attackerKeys = generateKeyPairSync('ed25519');
    const attackerPubKey = rawPublicKey(attackerKeys.publicKey);
    const db = getDb();
    db.prepare(
      'UPDATE utxo_boxes SET extra_data = ? WHERE id = ?',
    ).run(
      JSON.stringify({
        inviterId: Buffer.from(inviterId).toString('hex'),
        inviteBoxId: inviteBox.id,
        inviteePublicKey: Array.from(attackerPubKey),
        probationStartBlock: 3,
        probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      }),
      bondBox.id,
    );

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
      createdAtBlock: 3,
      inviterId,
      inviteBoxId: inviteBox.id!,
      inviteePublicKey: attackerPubKey,
      probationStartBlock: 3,
      probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      guard: 'bond_dual',
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
    // Invitee signs, but bond is committed to attacker
    signTransaction(tx, inviteePrivKey, inviteePubKeyHex);

    expect(() => claimInvite(deps, tx, 5)).toThrow('Karma output owner must match committed invitee public key');
  });

  // -----------------------------------------------------------------------
  // Cancel succeeds on committed BondBox
  // -----------------------------------------------------------------------
  it('Cancel succeeds on committed BondBox', () => {
    const karmaIn = createKarmaBox(inviterPubKey, 100, 1);

    const secret = new Uint8Array(32).fill(0xaa);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);
    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId, inviteBox.id!);

    // Simulate committed BondBox by updating extra_data
    const db = getDb();
    db.prepare(
      'UPDATE utxo_boxes SET extra_data = ? WHERE id = ?',
    ).run(
      JSON.stringify({
        inviterId: Buffer.from(inviterId).toString('hex'),
        inviteBoxId: inviteBox.id,
        inviteePublicKey: Array.from(inviteePubKey),
        probationStartBlock: 3,
        probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      }),
      bondBox.id,
    );

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

    const result = cancelInvite(deps, tx, 10);
    expect(result.status).toBe('pending');
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
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId, inviteBox.id!);

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
        guard: 'hash_preimage_with_bond',
      };
      const inviteBoxId = computeBoxId(inviteBox);
      const bondBox: BondBox = {
        boxType: 'bond',
        value: INVITE_BOND_KARMA,
        createdAtBlock: i + 1,
        inviterId,
        inviteBoxId,
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'bond_dual',
      };

      const tx: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [
          { ...newKarma, id: computeBoxId(newKarma) },
          { ...inviteBox, id: inviteBoxId },
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
      guard: 'hash_preimage_with_bond',
    };
    const inviteBoxId = computeBoxId(inviteBox);
    const bondBox: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 99,
      inviterId,
      inviteBoxId,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual',
    };

    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { ...newKarma, id: computeBoxId(newKarma) },
        { ...inviteBox, id: inviteBoxId },
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
  it('Create rejects karma below invite cost (audit C-1)', () => {
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
      guard: 'hash_preimage_with_bond',
    };
    const inviteBoxId = computeBoxId(inviteBox);
    const bondBox: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 1,
      inviterId,
      inviteBoxId,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual',
    };

    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { ...newKarma, id: computeBoxId(newKarma) },
        { ...inviteBox, id: inviteBoxId },
        { ...bondBox, id: computeBoxId(bondBox) },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);

    // K(10) -> K(0) + Invite(25) + Bond(25) would mint 40 karma from nothing.
    expect(() => createInvite(deps, tx, 1)).toThrow('Value non-conservation');
  });

  // -----------------------------------------------------------------------
  // 6. Claim fails with wrong secret
  // -----------------------------------------------------------------------
  it('Claim fails with wrong secret', () => {
    const secret = new Uint8Array(32).fill(0x42);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);
    const inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId, inviteBox.id!);

    // Simulate committed BondBox
    const db = getDb();
    db.prepare(
      'UPDATE utxo_boxes SET extra_data = ? WHERE id = ?',
    ).run(
      JSON.stringify({
        inviterId: Buffer.from(inviterId).toString('hex'),
        inviteBoxId: inviteBox.id,
        inviteePublicKey: Array.from(inviteePubKey),
        probationStartBlock: 3,
        probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      }),
      bondBox.id,
    );

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
      createdAtBlock: 3,
      inviterId,
      inviteBoxId: inviteBox.id!,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 3,
      probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      guard: 'bond_dual',
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
    signTransaction(tx, inviteePrivKey, inviteePubKeyHex);

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
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId, inviteBox.id!);

    // Simulate committed BondBox
    const db = getDb();
    db.prepare(
      'UPDATE utxo_boxes SET extra_data = ? WHERE id = ?',
    ).run(
      JSON.stringify({
        inviterId: Buffer.from(inviterId).toString('hex'),
        inviteBoxId: inviteBox.id,
        inviteePublicKey: Array.from(inviteePubKey),
        probationStartBlock: 3,
        probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      }),
      bondBox.id,
    );

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
      createdAtBlock: 3,
      inviterId,
      inviteBoxId: inviteBox.id!,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 3,
      probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      guard: 'bond_dual',
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
    signTransaction(tx, inviteePrivKey, inviteePubKeyHex);

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
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId, inviteBox.id!);

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
    const bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId, inviteBox.id!);

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

  // -----------------------------------------------------------------------
  // 10. Bond-commit signature guard (audit H-2)
  //
  // The bond_dual commit path (`checkGuards` Path 3 in utxo-engine) used to
  // accept any non-empty `signatures` map once the preimage matched, and
  // `commitInvite` only checked that an entry for the invitee key existed. So
  // consensus accepted a commit whose signature did not verify at all, and a
  // commit could bind a key the committer did not control. The guard now
  // requires a VALID Ed25519 signature from the committed invitee — the
  // OUTPUT BondBox's `inviteePublicKey`.
  //
  // Deliberately NOT covered here: the bearer front-run. `InviteBox.secretHash
  // = H(s)` names no invitee, so an observer who learns `s` can still commit
  // under their *own* key and sign it — that passes, by design. Closing it
  // requires binding the invitee at invite creation, deferred to the
  // karma-econ emission-model track.
  // -----------------------------------------------------------------------
  describe('bond-commit signature guard (H-2)', () => {
    const secret = new Uint8Array(32).fill(0x42);
    let inviteBox: InviteBox;
    let bondBox: BondBox;

    beforeEach(() => {
      const secretHash = createHash('blake2b512')
        .update(Buffer.from(secret))
        .digest()
        .subarray(0, 32);
      inviteBox = insertInviteBox(INVITE_KARMA_AMOUNT, 1, secretHash, inviterId);
      bondBox = insertBondBox(INVITE_BOND_KARMA, 1, inviterId, inviteBox.id!);
    });

    /** Unsigned, otherwise well-formed commit: uncommitted bond → bond bound to `committedKey`. */
    function buildCommitTx(committedKey: Uint8Array): UtxoTransaction {
      const bondOut: BondBox = {
        boxType: 'bond',
        value: INVITE_BOND_KARMA,
        createdAtBlock: 5,
        inviterId,
        inviteBoxId: inviteBox.id!,
        inviteePublicKey: committedKey,
        probationStartBlock: 5,
        probationEndBlock: 5 + INVITE_PROBATION_BLOCKS,
        guard: 'bond_dual',
      };
      return {
        inputs: [bondBox.id!],
        outputs: [{ ...bondOut, id: computeBoxId(bondOut) }],
        signatures: {},
        preimages: { [bondBox.id!]: secret },
        protocolVersion: PROTOCOL_VERSION,
      };
    }

    it('accepts a commit signed by the committed invitee', () => {
      const tx = buildCommitTx(inviteePubKey);
      signTransaction(tx, inviteePrivKey, inviteePubKeyHex);

      expect(validateTx(deps, tx, 5).valid).toBe(true);

      const result = commitInvite(deps, tx, 5);
      expect(result.status).toBe('pending');
      expect(result.bondBoxId).toBe(bondBox.id);
    });

    it('rejects a commit with no signature at all', () => {
      const tx = buildCommitTx(inviteePubKey);
      expect(Object.keys(tx.signatures)).toHaveLength(0);

      const result = validateTx(deps, tx, 5);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Bond commit must be signed by the committed invitee');
      expect(() => commitInvite(deps, tx, 5)).toThrow(
        'Bond commit must be signed by the committed invitee',
      );
    });

    it('rejects a commit whose signature under the committed key does not verify', () => {
      const tx = buildCommitTx(inviteePubKey);
      // A 64-byte signature slot with garbage contents: the old guard only
      // checked that the map was non-empty, so this used to be accepted.
      tx.signatures[inviteePubKeyHex] = new Uint8Array(64).fill(0x7f);

      const result = validateTx(deps, tx, 5);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Bond commit must be signed by the committed invitee');
      expect(() => commitInvite(deps, tx, 5)).toThrow(
        'Bond commit must be signed by the committed invitee',
      );
    });

    it('rejects a commit validly signed by a key other than the committed invitee', () => {
      // Output binds invitee A; a third party B (not the inviter, so the
      // inviter-reclaim path cannot absorb it) produces a real signature.
      const otherKeys = generateKeyPairSync('ed25519');
      const otherPubKey = rawPublicKey(otherKeys.publicKey);
      const otherPubKeyHex = Buffer.from(otherPubKey).toString('hex');

      const tx = buildCommitTx(inviteePubKey);
      signTransaction(tx, otherKeys.privateKey, otherPubKeyHex);

      expect(tx.signatures[otherPubKeyHex]).toBeDefined();
      expect(tx.signatures[inviteePubKeyHex]).toBeUndefined();

      const result = validateTx(deps, tx, 5);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Bond commit must be signed by the committed invitee');
      expect(() => commitInvite(deps, tx, 5)).toThrow(
        'Bond commit must be signed by the committed invitee',
      );
    });
  });
});
