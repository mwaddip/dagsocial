import {
  computeTxId,
  VOUCH_MIN_BALANCE,
  VOUCH_COOLDOWN_BLOCKS,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type { VouchBox, UtxoTransaction } from '@dagsocial/types';
import {
  hasActiveVouch,
  hasActiveVouchCooldown,
  insertUtxoTx,
  getKarmaBox,
} from '../store/index.js';
import { isValidVouchTarget } from '@dagsocial/validation';
import { validateTx } from './utxo-engine.js';
import type { UtxoEngineDeps } from './utxo-engine.js';

export function castVouch(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): { status: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction } {
  const vouchOutput = tx.outputs.find((o): o is VouchBox => o.boxType === 'vouch');
  if (!vouchOutput) {
    throw new Error('Transaction must contain a VouchBox output');
  }
  const { voucherId, targetId } = vouchOutput;

  if (!isValidVouchTarget(targetId)) {
    throw new Error('Invalid vouch target: must be a 32-byte public key');
  }

  if (Buffer.from(voucherId).equals(Buffer.from(targetId))) {
    throw new Error('Cannot vouch for yourself');
  }

  const karmaBox = deps.getKarmaBox?.(voucherId) ?? getKarmaBox(voucherId);
  if (!karmaBox || karmaBox.value < VOUCH_MIN_BALANCE) {
    throw new Error(
      `Insufficient karma: need at least ${VOUCH_MIN_BALANCE} to vouch`,
    );
  }

  if (hasActiveVouch(voucherId, targetId)) {
    throw new Error('Already vouching for this identity');
  }
  if (hasActiveVouchCooldown(voucherId, targetId)) {
    throw new Error('Vouch cooldown active — cannot re-vouch yet');
  }

  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new Error(`Invalid vouch transaction: ${result.error}`);
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
    throw new Error('Transaction does not consume a VouchBox');
  }

  const signerHex = Object.keys(tx.signatures)[0];
  if (!signerHex || Buffer.from(voucherId).toString('hex') !== signerHex) {
    throw new Error('VouchBox does not belong to signer');
  }

  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new Error(`Invalid unvouch transaction: ${result.error}`);
  }

  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  insertUtxoTx(tx, null, expiresAtHeight);

  const txId = computeTxId(tx);
  const karmaReturnsAtBlock = currentBlockHeight + VOUCH_COOLDOWN_BLOCKS;
  return { status: 'pending', txId, expiresAtHeight, karmaReturnsAtBlock, tx };
}
