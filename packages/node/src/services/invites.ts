import {
  computeBoxId,
  computeTxId,
  MAX_PENDING_INVITES,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
  decodeTx,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type { InviteBox, BondBox, KarmaBox, UtxoTransaction } from '@dagsocial/types';
import {
  getPendingInviteCount,
  insertUtxoTx,
  getPendingEntries,
} from '../store/index.js';
import { validateTx } from './utxo-engine.js';
import type { UtxoEngineDeps } from './utxo-engine.js';

// ---------------------------------------------------------------------------
// MemPool helpers
// ---------------------------------------------------------------------------

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
 * Create an invite. The client builds a signed UtxoTransaction that consumes
 * a KarmaBox and produces karma + invite + bond outputs.
 *
 * Fixed amounts: INVITE_KARMA_AMOUNT = 25, INVITE_BOND_KARMA = 25.
 *
 * The service validates the transaction and inserts it into the mempool.
 * The invite is **pending** until the next ordering block is confirmed.
 */
export function createInvite(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): {
  status: 'pending';
  txId: string;
  expiresAtHeight: number;
  inviteBox: InviteBox;
  bondBox: BondBox;
  tx: UtxoTransaction;
} {
  // ---- 1. Extract inviter from the consumed KarmaBox input ----
  const karmaInput = tx.inputs
    .map((id) => deps.getBox(id))
    .find((box): box is KarmaBox => box?.boxType === 'karma');
  if (!karmaInput) {
    throw new Error('No karma box input found in transaction');
  }
  const inviterId = karmaInput.owner;

  // ---- 2. Verify invite count limit (UTXO + mempool) ----
  const utxoCount = getPendingInviteCount(inviterId);
  const mempoolCount = countPendingInvitesInMempool(inviterId);
  const totalPending = utxoCount + mempoolCount;
  if (totalPending >= MAX_PENDING_INVITES) {
    throw new Error(
      `Invite limit reached: ${totalPending} pending invites (max ${MAX_PENDING_INVITES})`,
    );
  }

  // ---- 3. Verify outputs: exactly 1 karma + 1 invite + 1 bond ----
  const karmaOutputs = tx.outputs.filter((o) => o.boxType === 'karma');
  const inviteOutputs = tx.outputs.filter((o) => o.boxType === 'invite');
  const bondOutputs = tx.outputs.filter((o) => o.boxType === 'bond');

  if (tx.outputs.length !== 3 || karmaOutputs.length !== 1 || inviteOutputs.length !== 1 || bondOutputs.length !== 1) {
    throw new Error(
      'Invite creation requires exactly 3 outputs: 1 karma + 1 invite + 1 bond',
    );
  }

  // ---- 4. Verify fixed amounts ----
  const inviteOut = inviteOutputs[0] as InviteBox;
  const bondOut = bondOutputs[0] as BondBox;

  if (inviteOut.value !== INVITE_KARMA_AMOUNT) {
    throw new Error(
      `InviteBox value must be ${INVITE_KARMA_AMOUNT}, got ${inviteOut.value}`,
    );
  }
  if (bondOut.value !== INVITE_BOND_KARMA) {
    throw new Error(
      `BondBox value must be ${INVITE_BOND_KARMA}, got ${bondOut.value}`,
    );
  }

  // ---- 5. Validate transaction (guards, transitions, decay) ----
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new Error(`Invalid invite create transaction: ${result.error}`);
  }

  // ---- 6. Insert into mempool ----
  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  insertUtxoTx(tx, null, expiresAtHeight);

  // ---- 7. Return result ----
  const txId = computeTxId(tx);

  return {
    status: 'pending',
    txId,
    expiresAtHeight,
    inviteBox: { ...inviteOut, id: inviteOut.id ?? computeBoxId(inviteOut) },
    bondBox: { ...bondOut, id: bondOut.id ?? computeBoxId(bondOut) },
    tx,
  };
}

/**
 * Commit to an invite by spending the BondBox to lock in the invitee's identity.
 *
 * The invitee builds a tx spending only the BondBox. The bond_dual guard's
 * commit path verifies that the preimage matches the InviteBox's secretHash
 * **and** that the tx carries a valid Ed25519 signature from the committed
 * invitee — the output BondBox's inviteePublicKey (audit H-2), so a commit
 * cannot bind a key the committer does not control. The transition records
 * the invitee's public key and starts probation timers.
 *
 * Known-open: the invite is a bearer instrument — `secretHash` names no
 * invitee — so an observer who learns the secret can still commit under their
 * own key. Binding the invitee at invite creation is deferred to the
 * karma-econ emission-model track.
 *
 * The commit is **pending** until the next ordering block is confirmed.
 * Once committed, the invitee must reveal (claimInvite) to get their karma.
 */
export function commitInvite(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): {
  status: 'pending';
  txId: string;
  expiresAtHeight: number;
  bondBoxId: string;
  tx: UtxoTransaction;
} {
  // ---- 1. Extract BondBox from inputs ----
  if (tx.inputs.length !== 1) {
    throw new Error('Commit transaction must have exactly one input (BondBox)');
  }
  const bondBoxId = tx.inputs[0]!;
  const bondBoxInput = deps.getBox(bondBoxId);
  if (!bondBoxInput || bondBoxInput.boxType !== 'bond') {
    throw new Error(`Bond box not found: ${bondBoxId}`);
  }
  const bondIn = bondBoxInput as BondBox;

  // ---- 2. Verify BondBox is unclaimed ----
  if (bondIn.inviteePublicKey.length > 0) {
    throw new Error('BondBox already committed');
  }

  // ---- 3. Verify exactly 1 BondBox output ----
  const bondOutputs = tx.outputs.filter((o) => o.boxType === 'bond');
  if (tx.outputs.length !== 1 || bondOutputs.length !== 1) {
    throw new Error('Commit transaction must produce exactly 1 BondBox output');
  }
  const bondOut = bondOutputs[0] as BondBox;

  // ---- 4. Verify output BondBox has valid commitment shape ----
  if (bondOut.inviteePublicKey.length !== 32) {
    throw new Error('Commit output BondBox must have 32-byte inviteePublicKey');
  }

  // ---- 5. Validate transaction (guards, transitions) ----
  // The bond_dual commit guard verifies a real Ed25519 signature from the
  // committed invitee — the output BondBox's inviteePublicKey (audit H-2).
  // That check is consensus-enforced, so the service layer does not repeat it;
  // an "a signature entry exists" test here would only re-add the weak gate.
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new Error(`Invalid commit transaction: ${result.error}`);
  }

  // ---- 6. Insert into mempool ----
  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  insertUtxoTx(tx, null, expiresAtHeight);

  // ---- 7. Return result ----
  const txId = computeTxId(tx);

  return {
    status: 'pending',
    txId,
    expiresAtHeight,
    bondBoxId,
    tx,
  };
}

/**
 * Claim an invite using a signed UtxoTransaction that includes the preimage
 * secret in `tx.preimages`.
 *
 * The client builds a tx consuming the InviteBox and BondBox, producing a
 * new KarmaBox for the invitee and an updated (claimed) BondBox.
 *
 * validateTx verifies the hash_preimage_with_bond guard via the preimages map.
 * The claim is **pending** until the next ordering block is confirmed.
 */
export function claimInvite(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): {
  status: 'pending';
  txId: string;
  expiresAtHeight: number;
  userId: Uint8Array;
  karmaBoxId: string;
  tx: UtxoTransaction;
} {
  // ---- 1. Extract invite box ID and bond box ID from tx.inputs ----
  let inviteBoxId: string | undefined;
  let bondBoxId: string | undefined;

  for (const inputId of tx.inputs) {
    const box = deps.getBox(inputId);
    if (box?.boxType === 'invite') inviteBoxId = inputId;
    if (box?.boxType === 'bond') bondBoxId = inputId;
  }

  if (!inviteBoxId) {
    throw new Error('Transaction does not consume an InviteBox');
  }
  if (!bondBoxId) {
    throw new Error('Transaction does not consume a BondBox');
  }

  // ---- 2. Verify invite box exists, is unspent, is type invite ----
  const inviteBox = deps.getBox(inviteBoxId);
  if (!inviteBox || inviteBox.boxType !== 'invite') {
    throw new Error(`Invite box not found: ${inviteBoxId}`);
  }

  // ---- 2.5. Verify bond box is committed ----
  const bondBoxForClaim = deps.getBox(bondBoxId);
  if (!bondBoxForClaim || bondBoxForClaim.boxType !== 'bond') {
    throw new Error(`Bond box not found: ${bondBoxId}`);
  }
  const bondForClaim = bondBoxForClaim as BondBox;
  if (bondForClaim.inviteePublicKey.length !== 32) {
    throw new Error('BondBox must be committed before reveal');
  }

  // ---- 3. Verify invitee public key is not already an account ----
  const karmaOutput = tx.outputs.find((o): o is KarmaBox => o.boxType === 'karma');
  if (!karmaOutput) {
    throw new Error('Transaction must produce a KarmaBox for the invitee');
  }
  const inviteePubKey = karmaOutput.owner;

  const existingKarma = deps.getKarmaBox(inviteePubKey);
  if (existingKarma) {
    throw new Error('Public key already associated with an account');
  }

  // ---- 3.5. Verify karma output owner matches committed bond invitee ----
  if (!Buffer.from(bondForClaim.inviteePublicKey).equals(karmaOutput.owner)) {
    throw new Error('Karma output owner must match committed invitee public key');
  }

  // ---- 4. Validate transaction (guards, transitions, decay) ----
  // This verifies the hash_preimage_with_bond via checkGuards, the bond reveal
  // transition, and value conservation.
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new Error(`Invalid invite claim transaction: ${result.error}`);
  }

  // ---- 5. Insert into mempool ----
  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  insertUtxoTx(tx, null, expiresAtHeight);

  // ---- 6. Return result ----
  const txId = computeTxId(tx);
  const karmaBoxId = karmaOutput.id ?? computeBoxId(karmaOutput);

  return {
    status: 'pending',
    txId,
    expiresAtHeight,
    userId: inviteePubKey,
    karmaBoxId,
    tx,
  };
}

/**
 * Cancel an unclaimed invite. The client builds a signed UtxoTransaction that
 * consumes the KarmaBox, InviteBox, and BondBox, returning all value to a new
 * KarmaBox for the inviter.
 *
 * validateTx checks the bond_dual guard (inviter_signature path) on the bond box
 * and the owner_signature on the karma box.
 * The cancellation is **pending** until the next ordering block is confirmed.
 */
export function cancelInvite(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): {
  status: 'pending';
  txId: string;
  expiresAtHeight: number;
  tx: UtxoTransaction;
} {
  // ---- 1. Extract invite box ID from tx.inputs ----
  let inviteBoxId: string | undefined;

  for (const inputId of tx.inputs) {
    const box = deps.getBox(inputId);
    if (box?.boxType === 'invite') {
      inviteBoxId = inputId;
      break;
    }
  }

  if (!inviteBoxId) {
    throw new Error('Transaction does not consume an InviteBox');
  }

  // ---- 2. Verify invite box exists, is unspent, is type invite ----
  const inviteBox = deps.getBox(inviteBoxId);
  if (!inviteBox || inviteBox.boxType !== 'invite') {
    throw new Error(`Invite box not found: ${inviteBoxId}`);
  }

  // ---- 3. Verify inviter matches the invite box's inviterId ----
  const inv = inviteBox as InviteBox;
  const karmaInput = tx.inputs
    .map((id) => deps.getBox(id))
    .find((box): box is KarmaBox => box?.boxType === 'karma');
  if (!karmaInput) {
    throw new Error('Transaction does not consume a KarmaBox');
  }
  if (!Buffer.from(karmaInput.owner).equals(Buffer.from(inv.inviterId))) {
    throw new Error('Inviter mismatch: karma box owner does not match invite box inviterId');
  }

  // ---- 3.5. Verify bond box exists ----
  let bondBoxId: string | undefined;
  for (const inputId of tx.inputs) {
    const box = deps.getBox(inputId);
    if (box?.boxType === 'bond') {
      bondBoxId = inputId;
      break;
    }
  }
  if (!bondBoxId) {
    throw new Error('Transaction does not consume a BondBox');
  }
  const bondBox = deps.getBox(bondBoxId);
  if (!bondBox || bondBox.boxType !== 'bond') {
    throw new Error(`Bond box not found: ${bondBoxId}`);
  }
  // Cancel works on both unclaimed and committed BondBoxes.
  // The inviter reclaim path on bond_dual allows the inviter to reclaim
  // regardless of commit state.

  // ---- 4. Validate transaction (guards, transitions, decay) ----
  // This checks owner_signature on the karma box, bond_dual (inviter reclaim path)
  // on the bond box, and the cancel transition.
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new Error(`Invalid invite cancel transaction: ${result.error}`);
  }

  // ---- 5. Insert into mempool ----
  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  insertUtxoTx(tx, null, expiresAtHeight);

  // ---- 6. Return result ----
  const txId = computeTxId(tx);

  return {
    status: 'pending',
    txId,
    expiresAtHeight,
    tx,
  };
}
