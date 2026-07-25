import {
  computeBoxId,
  computeTxId,
  selectBoxes,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { CreditBox, UtxoTransaction } from '@dagsocial/types';
import { verify as cryptoVerify } from 'crypto';
import {
  getCreditBoxes,
  getUnlockedCreditBoxes,
  insertBox,
  consumeBox,
} from '../store/index.js';

import { ed25519PublicKeyToKeyObject } from '@dagsocial/validation';

// ---------------------------------------------------------------------------
// Mint (coinbase emission)
// ---------------------------------------------------------------------------

/**
 * Mint (or increase) credits for a given owner.
 *
 * Consumes ALL existing unspent credit boxes and creates a single new one
 * with the combined value + amount. Same pattern as mintKarma.
 */
export function mintCredits(
  owner: Uint8Array,
  amount: number,
  blockHeight: number,
  lockedUntilBlock?: number,
): string {
  if (amount <= 0) return '';

  const existingBoxes = getCreditBoxes(owner);
  const existingTotal = existingBoxes.reduce((sum, b) => sum + b.value, 0);
  const newValue = existingTotal + amount;

  for (const box of existingBoxes) {
    if (box.id) consumeBox(box.id, blockHeight);
  }

  let mergedLockedUntilBlock = lockedUntilBlock;
  for (const box of existingBoxes) {
    if (box.lockedUntilBlock !== undefined) {
      mergedLockedUntilBlock = Math.max(
        mergedLockedUntilBlock ?? 0,
        box.lockedUntilBlock,
      );
    }
  }

  const newBox: CreditBox = {
    boxType: 'credit',
    value: newValue,
    createdAtBlock: blockHeight,
    owner,
    guard: 'owner_signature',
    proofSource: blockHeight,
  };
  if (mergedLockedUntilBlock !== undefined) {
    newBox.lockedUntilBlock = mergedLockedUntilBlock;
  }
  newBox.id = computeBoxId(newBox);

  insertBox(newBox);
  return newBox.id!;
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

export interface CreditTransferResult {
  txId: string;
  sent: number;
  change: number;
  boxesConsumed: number;
}

/**
 * Transfer credits from one identity to another. Bitcoin-style UTXO selection:
 * largest-first from unlocked boxes, remainder back as change.
 *
 * Verifies the provided Ed25519 signature over the transaction ID against the
 * sender's public key. Throws on insufficient balance or bad signature.
 */
export function sendCredits(
  from: Uint8Array,
  to: Uint8Array,
  amount: number,
  signature: Uint8Array,
  currentHeight: number,
): CreditTransferResult {
  if (amount <= 0) {
    throw new Error('amount must be positive');
  }

  // 1. Select unlocked boxes
  const unlocked = getUnlockedCreditBoxes(from, currentHeight);
  const selected = selectBoxes(unlocked, amount);
  const totalSelected = selected.reduce((sum, b) => sum + b.value, 0);
  const change = totalSelected - amount;

  // 2. Build outputs
  const outputs: CreditBox[] = [];

  const recipientBox: CreditBox = {
    boxType: 'credit',
    value: amount,
    createdAtBlock: currentHeight,
    owner: to,
    guard: 'owner_signature',
    proofSource: -1, // transfer (not coinbase)
  };
  outputs.push(recipientBox);

  if (change > 0) {
    const changeBox: CreditBox = {
      boxType: 'credit',
      value: change,
      createdAtBlock: currentHeight,
      owner: from,
      guard: 'owner_signature',
      proofSource: -1,
    };
    outputs.push(changeBox);
  }

  // 3. Build transaction
  const tx: UtxoTransaction = {
    inputs: selected.map((b) => b.id!),
    outputs: outputs.map((b) => ({ ...b, id: computeBoxId(b) })),
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };

  const txId = computeTxId(tx);

  // 4. Verify signature
  const keyObj = ed25519PublicKeyToKeyObject(from);
  const txIdBytes = Buffer.from(txId, 'hex');
  const ok = cryptoVerify(null, txIdBytes, keyObj, Buffer.from(signature));
  if (!ok) {
    throw new Error('invalid signature');
  }

  // 5. Apply to UTXO set
  for (const box of selected) {
    consumeBox(box.id!, currentHeight);
  }
  for (const output of tx.outputs) {
    insertBox(output);
  }

  return {
    txId,
    sent: amount,
    change,
    boxesConsumed: selected.length,
  };
}
