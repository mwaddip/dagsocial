import {
  computeBoxId,
  computeTxId,
  selectBoxes,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { AnyBox, CreditBox, UtxoTransaction } from '@dagsocial/types';
import { verify as cryptoVerify } from 'crypto';
import {
  getCreditBoxes,
  getUnlockedCreditBoxes,
  insertBox,
  consumeBox,
} from '../store/index.js';

import { ed25519PublicKeyToKeyObject } from '@dagsocial/validation';
import { ClientError } from './client-error.js';
import { materializeOutput } from './utxo-engine.js';
import { MINT_OUTPUT_INDEX, mintTxIdFor } from '../mint-provenance.js';
import type { MintContext } from '../mint-provenance.js';

// ---------------------------------------------------------------------------
// Mint (coinbase emission)
// ---------------------------------------------------------------------------

/**
 * Mint (or increase) credits for a given owner.
 *
 * Consumes ALL existing unspent credit boxes and creates a single new one
 * with the combined value + amount. Same pattern as mintKarma.
 *
 * `ctx` precedes `lockedUntilBlock` because it is required and that one is
 * optional — and because it belongs with the other identity inputs. It stopped
 * admitting `null` at phase G2b, for the reason spelled out on `mintKarma`: a
 * required parameter fails at compile time in `src`, where omitting provenance
 * breaks consensus, rather than leaving the store to catch it later.
 */
export function mintCredits(
  owner: Uint8Array,
  amount: bigint,
  blockHeight: number,
  ctx: MintContext,
  lockedUntilBlock?: number,
): string {
  if (amount <= 0n) return '';

  const existingBoxes = getCreditBoxes(owner);
  const existingTotal = existingBoxes.reduce((sum, b) => sum + b.value, 0n);
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
  // Appended after every candidate field — including the conditional
  // `lockedUntilBlock` — so this matches `rowToBox`'s key order. See mintKarma.
  newBox.txId = mintTxIdFor(ctx, blockHeight);
  newBox.index = MINT_OUTPUT_INDEX;
  newBox.id = computeBoxId(newBox);

  insertBox(newBox);
  return newBox.id!;
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

export interface CreditTransferResult {
  txId: string;
  sent: bigint;
  change: bigint;
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
  amount: bigint,
  signature: Uint8Array,
  currentHeight: number,
  expectedHeight?: number,
): CreditTransferResult {
  if (amount <= 0n) {
    throw new ClientError('amount must be positive');
  }

  // 1. Select unlocked boxes
  const unlocked = getUnlockedCreditBoxes(from, currentHeight);
  const selected = selectBoxes(unlocked, amount);
  const totalSelected = selected.reduce((sum, b) => sum + b.value, 0n);
  const change = totalSelected - amount;

  // 2. Build outputs — use expectedHeight for createdAtBlock so the txId
  //    matches what the client signed. Falls back to currentHeight if
  //    expectedHeight is not provided (backward compat for non-UI callers).
  const buildHeight = expectedHeight ?? currentHeight;
  const outputs: CreditBox[] = [];

  const recipientBox: CreditBox = {
    boxType: 'credit',
    value: amount,
    createdAtBlock: buildHeight,
    owner: to,
    guard: 'owner_signature',
    proofSource: -1, // transfer (not coinbase)
  };
  outputs.push(recipientBox);

  if (change > 0n) {
    const changeBox: CreditBox = {
      boxType: 'credit',
      value: change,
      createdAtBlock: buildHeight,
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
    throw new ClientError('invalid signature', 401);
  }

  // 5. Apply to UTXO set
  //
  // Provenance is attached only now — after `computeTxId` above, which hashes
  // the output *candidates*. Attaching first would feed provenance into the
  // very transaction id it derives from, and because `computeTxId` routes
  // outputs through `canonicalBoxBytes` it would not observe the difference:
  // the mistake is silent, not an error.
  for (const box of selected) {
    consumeBox(box.id!, currentHeight);
  }
  tx.outputs
    .map((box, index) => materializeOutput(box as AnyBox, txId, index))
    .forEach(insertBox);

  return {
    txId,
    sent: amount,
    change,
    boxesConsumed: selected.length,
  };
}
