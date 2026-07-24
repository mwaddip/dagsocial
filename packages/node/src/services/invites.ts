import { randomBytes, createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  computeBoxId,
  computeTxId,
  MAX_PENDING_INVITES,
  INVITE_PROBATION_BLOCKS,
  PROTOCOL_VERSION,
  decodeTx,
} from '@dagsocial/types';
import type { InviteBox, BondBox, KarmaBox, UtxoTransaction } from '@dagsocial/types';
import {
  getBox,
  insertBox,
  consumeBox,
  getKarmaBox,
  getPendingInviteCount,
  getBondBoxes,
  getIdentity,
  getDb,
  insertUtxoTx,
  getPendingEntries,
} from '../store/index.js';

// ---------------------------------------------------------------------------
// Ed25519 SPKI prefix for raw 32-byte public keys
// ---------------------------------------------------------------------------

const ED25519_SPKI_PREFIX = Buffer.from(
  '302a300506032b6570032100',
  'hex',
);

function publicKeyToKeyObject(pubKey: Uint8Array): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pubKey)]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Verify an Ed25519 signature over a pre-hashed message.
 * The signer signs: blake2b512(message).subarray(0, 32)
 */
function verifySignature(
  message: Uint8Array,
  signature: Uint8Array,
  pubKey: Uint8Array,
): boolean {
  try {
    const keyObj = publicKeyToKeyObject(pubKey);
    const hash = createHash('blake2b512')
      .update(Buffer.from(message))
      .digest()
      .subarray(0, 32);
    return Boolean(cryptoVerify(null, hash, keyObj, Buffer.from(signature)));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the unclaimed bond box matching a given invite box.
 * Matches by inviter ID, unclaimed status (empty inviteePublicKey), and
 * createdAtBlock (created in the same logical operation).
 */
function findMatchingBondBox(
  inviterId: string,
  createdAtBlock: number,
): BondBox | null {
  const db = getDb();
  const bondBoxes = getBondBoxes(inviterId);
  for (const bond of bondBoxes) {
    if (!bond.id) continue;
    const row = db
      .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
      .get(bond.id) as { spent_at_block: number | null } | undefined;
    if (row && row.spent_at_block !== null) continue;

    if (bond.inviteePublicKey.length === 0 && bond.createdAtBlock === createdAtBlock) {
      return bond;
    }
  }
  return null;
}

/**
 * Count pending invite creates in the mempool for a given inviter.
 * This prevents bypassing the MAX_PENDING_INVITES limit by submitting
 * multiple unconfirmed invite-create transactions.
 */
function countPendingInvitesInMempool(inviterId: Uint8Array): number {
  const inviterIdHex = Buffer.from(inviterId).toString('hex');
  const entries = getPendingEntries(1000);
  let count = 0;
  for (const entry of entries) {
    if (entry.entryType !== 'utxo_tx' || !entry.utxoTxCbor) continue;
    const tx = decodeTx(entry.utxoTxCbor);
    for (const output of tx.outputs) {
      if (output.boxType === 'invite') {
        const inviteOut = output as InviteBox;
        if (Buffer.from(inviteOut.inviterId).toString('hex') === inviterIdHex) {
          count++;
        }
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an invite. Locks karmaAmount in an InviteBox (hash-locked) and
 * bondAmount in a BondBox (inviter-controlled).
 *
 * The signature covers a deterministic message (not the UTXO tx hash, since the
 * secret is generated internally and the caller cannot pre-sign the tx):
 *
 *   signMessage = blake2b512("create-invite:" + inviterId + ":" + karmaAmount +
 *                            ":" + bondAmount).subarray(0, 32)
 *
 * The UTXO transaction is inserted into the mempool and applied when the next
 * ordering block is confirmed — the invite is **pending** until then.
 *
 * Returns the secret for out-of-band communication to the invitee.
 */
export function createInvite(
  inviterId: string,
  karmaAmount: number,
  bondAmount: number,
  inviterPubKey: Uint8Array,
  signature: Uint8Array,
  currentBlockHeight: number,
): {
  status: 'pending';
  txId: string;
  expiresAtHeight: number;
  inviteBox: InviteBox;
  bondBox: BondBox;
  secret: Uint8Array;
  secretHash: Uint8Array;
  tx: UtxoTransaction;
} {
  // ---- 1. Verify pending invite count limit (UTXO + mempool) ----
  const utxoCount = getPendingInviteCount(inviterId);
  const mempoolCount = countPendingInvitesInMempool(inviterId);
  const totalPending = utxoCount + mempoolCount;
  if (totalPending >= MAX_PENDING_INVITES) {
    throw new Error(
      `Invite limit reached: ${totalPending} pending invites (max ${MAX_PENDING_INVITES})`,
    );
  }

  // ---- 2. Verify karma balance ----
  const karmaBox = getKarmaBox(inviterPubKey);
  if (!karmaBox) {
    throw new Error(`No karma box found for inviter ${inviterId}`);
  }

  const totalRequired = karmaAmount + bondAmount;
  if (karmaBox.value < totalRequired) {
    throw new Error(
      `Insufficient karma: need ${totalRequired}, have ${karmaBox.value}`,
    );
  }

  // ---- 3. Verify signature over deterministic message ----
  const signMessage = `create-invite:${inviterId}:${karmaAmount}:${bondAmount}`;
  if (!verifySignature(Buffer.from(signMessage), signature, inviterPubKey)) {
    throw new Error('Invalid inviter signature');
  }

  // ---- 4. Generate random secret ----
  const secret = new Uint8Array(randomBytes(32));

  // ---- 5. Compute secret hash ----
  const secretHash = createHash('blake2b512')
    .update(Buffer.from(secret))
    .digest()
    .subarray(0, 32);

  // ---- 6. Build output boxes ----
  const remainingKarma = karmaBox.value - totalRequired;

  const newKarmaBox: KarmaBox = {
    boxType: 'karma',
    value: remainingKarma,
    createdAtBlock: currentBlockHeight,
    owner: inviterPubKey,
    guard: 'owner_signature',
    proofSource: 'invite-create',
    lastTouchBlock: currentBlockHeight,
  };

  const inviteBox: InviteBox = {
    boxType: 'invite',
    value: karmaAmount,
    createdAtBlock: currentBlockHeight,
    secretHash,
    inviterId,
    guard: 'hash_preimage',
  };

  const bondBox: BondBox = {
    boxType: 'bond',
    value: bondAmount,
    createdAtBlock: currentBlockHeight,
    inviterId,
    inviteePublicKey: new Uint8Array(0),
    probationStartBlock: 0,
    probationEndBlock: 0,
    guard: 'inviter_signature',
  };

  const inviteBoxId = computeBoxId(inviteBox);
  const bondBoxId = computeBoxId(bondBox);
  const newKarmaBoxId = computeBoxId(newKarmaBox);

  // ---- 7. Build and insert UTXO transaction into mempool ----
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!],
    outputs: [
      { ...newKarmaBox, id: newKarmaBoxId },
      { ...inviteBox, id: inviteBoxId },
      { ...bondBox, id: bondBoxId },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };

  const expiresAtHeight = currentBlockHeight + 720;
  insertUtxoTx(tx, null, expiresAtHeight);

  const txId = computeTxId(tx);

  return {
    status: 'pending',
    txId,
    expiresAtHeight,
    inviteBox: { ...inviteBox, id: inviteBoxId },
    bondBox: { ...bondBox, id: bondBoxId },
    secret,
    secretHash,
    tx,
  };
}

/**
 * Claim an invite using the preimage secret.
 *
 * Consumes the InviteBox and creates a new KarmaBox for the invitee.
 * Updates the matching BondBox with the invitee's public key and probation window.
 *
 * The UTXO transaction is inserted into the mempool and applied when the next
 * ordering block is confirmed — the claim is **pending** until then.
 */
export function claimInvite(
  inviteBoxId: string,
  secret: Uint8Array,
  publicKey: Uint8Array,
  currentBlockHeight: number,
): {
  status: 'pending';
  txId: string;
  expiresAtHeight: number;
  userId: Uint8Array;
  karmaBoxId: string;
  tx: UtxoTransaction;
} {
  const db = getDb();

  // ---- 1. Get invite box, verify it exists and is unspent ----
  const box = getBox(inviteBoxId);
  if (!box || box.boxType !== 'invite') {
    throw new Error(`Invite box not found: ${inviteBoxId}`);
  }

  const inviteSpentRow = db
    .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
    .get(inviteBoxId) as { spent_at_block: number | null } | undefined;
  if (!inviteSpentRow || inviteSpentRow.spent_at_block !== null) {
    throw new Error(`Invite box already spent: ${inviteBoxId}`);
  }

  const inv = box as InviteBox;

  // ---- 2. Verify secret hash ----
  const computedHash = createHash('blake2b512')
    .update(Buffer.from(secret))
    .digest()
    .subarray(0, 32);

  if (Buffer.from(computedHash).toString('hex') !== Buffer.from(inv.secretHash).toString('hex')) {
    throw new Error('Secret hash mismatch');
  }

  // ---- 3. Verify publicKey not already an account ----
  const existingKarma = getKarmaBox(publicKey);
  if (existingKarma) {
    throw new Error('Public key already associated with an account');
  }

  // ---- 4. userId IS the public key ----
  const userId = publicKey;

  // ---- 5. Find matching bond box ----
  const bondBox = findMatchingBondBox(inv.inviterId, inv.createdAtBlock);
  if (!bondBox || !bondBox.id) {
    throw new Error(`No unclaimed bond box found for inviter ${inv.inviterId}`);
  }

  // ---- 6. Build output boxes ----
  const newKarmaBox: KarmaBox = {
    boxType: 'karma',
    value: inv.value,
    createdAtBlock: currentBlockHeight,
    owner: publicKey,
    guard: 'owner_signature',
    proofSource: `invite-claim:${inviteBoxId}`,
    lastTouchBlock: currentBlockHeight,
  };
  const karmaBoxId = computeBoxId(newKarmaBox);

  const probationEndBlock = currentBlockHeight + INVITE_PROBATION_BLOCKS;
  const updatedBondBox: BondBox = {
    boxType: 'bond',
    value: bondBox.value,
    createdAtBlock: currentBlockHeight,
    inviterId: bondBox.inviterId,
    inviteePublicKey: publicKey,
    probationStartBlock: currentBlockHeight,
    probationEndBlock,
    guard: 'inviter_signature',
  };
  const updatedBondBoxId = computeBoxId(updatedBondBox);

  // ---- 7. Build and insert UTXO transaction into mempool ----
  const tx: UtxoTransaction = {
    inputs: [inviteBoxId, bondBox.id!],
    outputs: [
      { ...newKarmaBox, id: karmaBoxId },
      { ...updatedBondBox, id: updatedBondBoxId },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };

  const expiresAtHeight = currentBlockHeight + 720;
  insertUtxoTx(tx, null, expiresAtHeight);

  const txId = computeTxId(tx);

  return { status: 'pending', txId, expiresAtHeight, userId, karmaBoxId, tx };
}

/**
 * Cancel an unclaimed invite. Consumes the InviteBox and BondBox, returning
 * both values to the inviter's karma box.
 *
 * The signature covers: blake2b512("cancel-invite:" + inviteBoxId).subarray(0, 32)
 *
 * The UTXO transaction is inserted into the mempool and applied when the next
 * ordering block is confirmed — the cancellation is **pending** until then.
 */
export function cancelInvite(
  inviteBoxId: string,
  inviterId: string,
  signature: Uint8Array,
  currentBlockHeight: number,
): {
  status: 'pending';
  txId: string;
  expiresAtHeight: number;
  tx: UtxoTransaction;
} {
  const db = getDb();

  // ---- 1. Get invite box, verify unclaimed ----
  const box = getBox(inviteBoxId);
  if (!box || box.boxType !== 'invite') {
    throw new Error(`Invite box not found: ${inviteBoxId}`);
  }

  const inviteSpentRow = db
    .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
    .get(inviteBoxId) as { spent_at_block: number | null } | undefined;
  if (!inviteSpentRow || inviteSpentRow.spent_at_block !== null) {
    throw new Error('Invite already claimed or spent');
  }

  const inv = box as InviteBox;
  if (!Buffer.from(inv.inviterId).equals(Buffer.from(inviterId))) {
    throw new Error('Inviter mismatch');
  }

  // ---- 2. Verify inviter signature ----
  const identity = getIdentity(inviterId);
  if (!identity) {
    throw new Error(`Inviter identity not found: ${inviterId}`);
  }

  const signMessage = `cancel-invite:${inviteBoxId}`;
  if (!verifySignature(Buffer.from(signMessage), signature, identity.publicKey)) {
    throw new Error('Invalid inviter signature');
  }

  // ---- 3. Find matching bond box ----
  const bondBox = findMatchingBondBox(inv.inviterId, inv.createdAtBlock);
  if (!bondBox || !bondBox.id) {
    throw new Error(`No unclaimed bond box found for inviter ${inv.inviterId}`);
  }

  // ---- 4. Get current karma box for inviter ----
  const karmaBox = getKarmaBox(identity.publicKey);
  if (!karmaBox) {
    throw new Error(`No karma box found for inviter ${inviterId}`);
  }

  // ---- 5. Build output: return both values to inviter ----
  const returnValue = inv.value + bondBox.value;
  const newKarmaValue = karmaBox.value + returnValue;

  const newKarmaBox: KarmaBox = {
    boxType: 'karma',
    value: newKarmaValue,
    createdAtBlock: currentBlockHeight,
    owner: identity.publicKey,
    guard: 'owner_signature',
    proofSource: `invite-cancel:${inviteBoxId}`,
    lastTouchBlock: currentBlockHeight,
  };
  const newKarmaBoxId = computeBoxId(newKarmaBox);

  // ---- 6. Build and insert UTXO transaction into mempool ----
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!, inviteBoxId, bondBox.id!],
    outputs: [{ ...newKarmaBox, id: newKarmaBoxId }],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };

  const expiresAtHeight = currentBlockHeight + 720;
  insertUtxoTx(tx, null, expiresAtHeight);

  const txId = computeTxId(tx);

  return { status: 'pending', txId, expiresAtHeight, tx };
}
