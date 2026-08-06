import {
  computeTxId,
  MAX_PENDING_INVITES,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type { InviteBox, BondBox, KarmaBox, UtxoTransaction } from '@dagsocial/types';
import {
  getPendingInviteCount,
  insertUtxoTx,
  countPendingInvites,
} from '../store/index.js';
import { materializeOutput, validateTx } from './utxo-engine.js';
import type { UtxoEngineDeps } from './utxo-engine.js';
import { ClientError } from './client-error.js';

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
    throw new ClientError('No karma box input found in transaction');
  }
  const inviterId = karmaInput.owner;

  // ---- 2. Verify invite count limit (UTXO + mempool) ----
  // The mempool count is SQL over the gate-metadata columns, so an inviter
  // cannot hide pending invites past a scan bound any more (audit M-8).
  const utxoCount = getPendingInviteCount(inviterId);
  const mempoolCount = countPendingInvites(Buffer.from(inviterId).toString('hex'));
  const totalPending = utxoCount + mempoolCount;
  if (totalPending >= MAX_PENDING_INVITES) {
    throw new ClientError(
      `Invite limit reached: ${totalPending} pending invites (max ${MAX_PENDING_INVITES})`,
    );
  }

  // ---- 3. Verify outputs: exactly 1 karma + 1 invite + 1 bond ----
  const karmaOutputs = tx.outputs.filter((o) => o.boxType === 'karma');
  const inviteOutputs = tx.outputs.filter((o) => o.boxType === 'invite');
  const bondOutputs = tx.outputs.filter((o) => o.boxType === 'bond');

  if (tx.outputs.length !== 3 || karmaOutputs.length !== 1 || inviteOutputs.length !== 1 || bondOutputs.length !== 1) {
    throw new ClientError(
      'Invite creation requires exactly 3 outputs: 1 karma + 1 invite + 1 bond',
    );
  }

  // ---- 4. Verify fixed amounts ----
  const inviteOut = inviteOutputs[0] as InviteBox;
  const bondOut = bondOutputs[0] as BondBox;

  if (inviteOut.value !== INVITE_KARMA_AMOUNT) {
    throw new ClientError(
      `InviteBox value must be ${INVITE_KARMA_AMOUNT}, got ${inviteOut.value}`,
    );
  }
  if (bondOut.value !== INVITE_BOND_KARMA) {
    throw new ClientError(
      `BondBox value must be ${INVITE_BOND_KARMA}, got ${bondOut.value}`,
    );
  }

  // ---- 4b. The bond must point at THIS transaction's InviteBox ----
  //
  // Checked at **create**, not only when the bond is dereferenced at commit
  // (user decision, 2026-08-06). The old `inviteBoxId: BoxId` was validated
  // nowhere here: a bond could name any box in the world, and a wrong value
  // surfaced one transaction later as "InviteBox not found for bond commit" —
  // a dangling reference rather than a rejected transaction.
  //
  // Pairing by output index makes the *scope* structural — a bond can only
  // address an output of its own transaction — and this check makes the
  // *target* structural too. Together, a bond paired with anything other than
  // the invite it shipped with is inexpressible rather than caught late, which
  // is the whole reason the index form was chosen over re-encoding the id.
  if (tx.outputs[bondOut.inviteOutputIndex] !== inviteOut) {
    throw new ClientError(
      `BondBox.inviteOutputIndex must address the InviteBox output of the same ` +
      `transaction: got ${bondOut.inviteOutputIndex}, InviteBox is at ` +
      `${tx.outputs.indexOf(inviteOut)}`,
    );
  }

  // ---- 5. Validate transaction (guards, transitions, decay) ----
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid invite create transaction: ${result.error}`);
  }

  // ---- 6. Insert into mempool ----
  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  insertUtxoTx(tx, null, expiresAtHeight);

  // ---- 7. Return result ----
  //
  // `txId` is computed FIRST, before any provenance is attached: it hashes the
  // output *candidates*, so attaching first would feed provenance into the very
  // id it is derived from. `computeTxId` routes outputs through
  // `canonicalBoxBytes` and so does not observe provenance — which makes
  // getting this backwards silent rather than an error.
  const txId = computeTxId(tx);

  // These two ids are still returned, and they must still equal what block
  // application will store — so they are materialized exactly the way that path
  // materializes them, and `tx` here is client-supplied decoded CBOR, so the
  // strip-before-append in `materializeOutput` is load-bearing.
  //
  // What changed (user decision, 2026-08-06): the client no longer has to
  // *predict* `inviteBox.id` in order to build the bond. It says which output
  // index the invite is at, and the node resolves the pair from
  // `(txId, inviteOutputIndex)` at commit. These are now informational —
  // an id the client can display or track, not one it has to get right for the
  // flow to work. That is strictly stronger than the "exact prediction" Spec G
  // aimed at: prediction became unnecessary rather than merely reliable.
  return {
    status: 'pending',
    txId,
    expiresAtHeight,
    inviteBox: materializeOutput(inviteOut, txId, tx.outputs.indexOf(inviteOut)) as InviteBox,
    bondBox: materializeOutput(bondOut, txId, tx.outputs.indexOf(bondOut)) as BondBox,
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
    throw new ClientError('Commit transaction must have exactly one input (BondBox)');
  }
  const bondBoxId = tx.inputs[0]!;
  const bondBoxInput = deps.getBox(bondBoxId);
  if (!bondBoxInput || bondBoxInput.boxType !== 'bond') {
    throw new ClientError(`Bond box not found: ${bondBoxId}`);
  }
  const bondIn = bondBoxInput as BondBox;

  // ---- 2. Verify BondBox is unclaimed ----
  if (bondIn.inviteePublicKey.length > 0) {
    throw new ClientError('BondBox already committed', 409);
  }

  // ---- 3. Verify exactly 1 BondBox output ----
  const bondOutputs = tx.outputs.filter((o) => o.boxType === 'bond');
  if (tx.outputs.length !== 1 || bondOutputs.length !== 1) {
    throw new ClientError('Commit transaction must produce exactly 1 BondBox output');
  }
  const bondOut = bondOutputs[0] as BondBox;

  // ---- 4. Verify output BondBox has valid commitment shape ----
  if (bondOut.inviteePublicKey.length !== 32) {
    throw new ClientError('Commit output BondBox must have 32-byte inviteePublicKey');
  }

  // ---- 5. Validate transaction (guards, transitions) ----
  // The bond_dual commit guard verifies a real Ed25519 signature from the
  // committed invitee — the output BondBox's inviteePublicKey (audit H-2).
  // That check is consensus-enforced, so the service layer does not repeat it;
  // an "a signature entry exists" test here would only re-add the weak gate.
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid commit transaction: ${result.error}`);
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
    throw new ClientError('Transaction does not consume an InviteBox');
  }
  if (!bondBoxId) {
    throw new ClientError('Transaction does not consume a BondBox');
  }

  // ---- 2. Verify invite box exists, is unspent, is type invite ----
  const inviteBox = deps.getBox(inviteBoxId);
  if (!inviteBox || inviteBox.boxType !== 'invite') {
    throw new ClientError(`Invite box not found: ${inviteBoxId}`);
  }

  // ---- 2.5. Verify bond box is committed ----
  const bondBoxForClaim = deps.getBox(bondBoxId);
  if (!bondBoxForClaim || bondBoxForClaim.boxType !== 'bond') {
    throw new ClientError(`Bond box not found: ${bondBoxId}`);
  }
  const bondForClaim = bondBoxForClaim as BondBox;
  if (bondForClaim.inviteePublicKey.length !== 32) {
    throw new ClientError('BondBox must be committed before reveal');
  }

  // ---- 3. Verify invitee public key is not already an account ----
  const karmaOutput = tx.outputs.find((o): o is KarmaBox => o.boxType === 'karma');
  if (!karmaOutput) {
    throw new ClientError('Transaction must produce a KarmaBox for the invitee');
  }
  const inviteePubKey = karmaOutput.owner;

  const existingKarma = deps.getKarmaBox(inviteePubKey);
  if (existingKarma) {
    throw new ClientError('Public key already associated with an account');
  }

  // ---- 3.5. Verify karma output owner matches committed bond invitee ----
  if (!Buffer.from(bondForClaim.inviteePublicKey).equals(karmaOutput.owner)) {
    throw new ClientError('Karma output owner must match committed invitee public key');
  }

  // ---- 4. Validate transaction (guards, transitions, decay) ----
  // This verifies the hash_preimage_with_bond via checkGuards, the bond reveal
  // transition, and value conservation.
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid invite claim transaction: ${result.error}`);
  }

  // ---- 5. Insert into mempool ----
  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  insertUtxoTx(tx, null, expiresAtHeight);

  // ---- 6. Return result ----
  // txId first, then provenance — see createInvite.
  const txId = computeTxId(tx);
  const karmaBoxId = materializeOutput(
    karmaOutput,
    txId,
    tx.outputs.indexOf(karmaOutput),
  ).id!;

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
    throw new ClientError('Transaction does not consume an InviteBox');
  }

  // ---- 2. Verify invite box exists, is unspent, is type invite ----
  const inviteBox = deps.getBox(inviteBoxId);
  if (!inviteBox || inviteBox.boxType !== 'invite') {
    throw new ClientError(`Invite box not found: ${inviteBoxId}`);
  }

  // ---- 3. Verify inviter matches the invite box's inviterId ----
  const inv = inviteBox as InviteBox;
  const karmaInput = tx.inputs
    .map((id) => deps.getBox(id))
    .find((box): box is KarmaBox => box?.boxType === 'karma');
  if (!karmaInput) {
    throw new ClientError('Transaction does not consume a KarmaBox');
  }
  if (!Buffer.from(karmaInput.owner).equals(Buffer.from(inv.inviterId))) {
    throw new ClientError(
      'Inviter mismatch: karma box owner does not match invite box inviterId',
      403,
    );
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
    throw new ClientError('Transaction does not consume a BondBox');
  }
  const bondBox = deps.getBox(bondBoxId);
  if (!bondBox || bondBox.boxType !== 'bond') {
    throw new ClientError(`Bond box not found: ${bondBoxId}`);
  }
  // Cancel works on both unclaimed and committed BondBoxes.
  // The inviter reclaim path on bond_dual allows the inviter to reclaim
  // regardless of commit state.

  // ---- 4. Validate transaction (guards, transitions, decay) ----
  // This checks owner_signature on the karma box, bond_dual (inviter reclaim path)
  // on the bond box, and the cancel transition.
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid invite cancel transaction: ${result.error}`);
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
