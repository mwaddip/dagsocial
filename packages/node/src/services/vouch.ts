import {
  computeTxId,
  VOUCH_MIN_BALANCE,
  VOUCH_COOLDOWN_BLOCKS,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type { VouchBox, UtxoTransaction } from '@dagsocial/types';
import {
  hasAnyActiveVouch,
  hasActiveVouchCooldown,
  hasPendingVouch,
  insertUtxoTx,
  getKarmaBox,
} from '../store/index.js';
import { isValidVouchTarget } from '@dagsocial/validation';
import { validateTx } from './utxo-engine.js';
import type { UtxoEngineDeps } from './utxo-engine.js';
import { ClientError } from './client-error.js';

export function castVouch(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): { status: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction } {
  const vouchOutput = tx.outputs.find((o): o is VouchBox => o.boxType === 'vouch');
  if (!vouchOutput) {
    throw new ClientError('Transaction must contain a VouchBox output');
  }
  const { voucherId, targetId } = vouchOutput;

  if (!isValidVouchTarget(targetId)) {
    throw new ClientError('Invalid vouch target: must be a 32-byte public key');
  }

  if (Buffer.from(voucherId).equals(Buffer.from(targetId))) {
    throw new ClientError('Cannot vouch for yourself');
  }

  const karmaBox = deps.getKarmaBox?.(voucherId) ?? getKarmaBox(voucherId);
  if (!karmaBox || karmaBox.value < VOUCH_MIN_BALANCE) {
    throw new ClientError(
      `Insufficient karma: need at least ${VOUCH_MIN_BALANCE} to vouch`,
    );
  }

  // One vouch at a time, across all targets (ARCHITECTURE invariant, audit
  // L-4). The pair-scoped check let a voucher hold many concurrent VouchBoxes
  // by simply picking different targets. The mempool arm closes the same hole
  // for a vouch that is submitted but not yet confirmed.
  if (hasAnyActiveVouch(voucherId)) {
    throw new ClientError('Already vouching for an identity — unvouch first');
  }
  if (hasPendingVouch(Buffer.from(voucherId).toString('hex'))) {
    throw new ClientError('Vouch already pending — wait for it to confirm');
  }
  if (hasActiveVouchCooldown(voucherId, targetId)) {
    throw new ClientError('Vouch cooldown active — cannot re-vouch yet');
  }

  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid vouch transaction: ${result.error}`);
  }

  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  insertUtxoTx(tx, null, expiresAtHeight);

  const txId = computeTxId(tx);
  return { status: 'pending', txId, expiresAtHeight, tx };
}

export function initiateUnvouch(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): {
  status: 'pending';
  txId: string;
  expiresAtHeight: number;
  karmaReturnsAtBlock: number;
  tx: UtxoTransaction;
} {
  let voucherId: Uint8Array | undefined;
  let targetId: Uint8Array | undefined;

  for (const inputId of tx.inputs) {
    const box = deps.getBox(inputId);
    if (box && box.boxType === 'vouch') {
      const vouchBox = box as VouchBox;
      voucherId = vouchBox.voucherId;
      targetId = vouchBox.targetId;
      break;
    }
  }

  if (!voucherId || !targetId) {
    throw new ClientError('Transaction does not consume a VouchBox');
  }

  const signerHex = Object.keys(tx.signatures)[0];
  if (!signerHex || Buffer.from(voucherId).toString('hex') !== signerHex) {
    throw new ClientError('VouchBox does not belong to signer');
  }

  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid unvouch transaction: ${result.error}`);
  }

  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  insertUtxoTx(tx, null, expiresAtHeight);

  const txId = computeTxId(tx);
  const karmaReturnsAtBlock = currentBlockHeight + VOUCH_COOLDOWN_BLOCKS;
  return { status: 'pending', txId, expiresAtHeight, karmaReturnsAtBlock, tx };
}
