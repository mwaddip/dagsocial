import { computeBoxId, MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';
import type { CreditBox, UtxoTransaction } from '@dagsocial/types';
import {
  getCreditBoxes,
  insertBox,
  consumeBox,
  insertUtxoTx,
} from '../store/index.js';

import { ClientError } from './client-error.js';
import { validateTx } from './utxo-engine.js';
import type { UtxoEngineDeps } from './utxo-engine.js';
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

  // The conditional field is spread rather than assigned afterwards: spreading
  // `{}` adds no key at all, so this cannot produce the explicit `undefined`
  // that contract 1a rules out. Key *order* no longer matters as of phase G3b —
  // both encoders sort — but present-vs-absent still does.
  const newBox: CreditBox = {
    boxType: 'credit',
    value: newValue,
    owner,
    guard: 'owner_signature',
    proofSource: blockHeight,
    ...(mergedLockedUntilBlock !== undefined ? { lockedUntilBlock: mergedLockedUntilBlock } : {}),
    txId: mintTxIdFor(ctx, blockHeight),
    index: MINT_OUTPUT_INDEX,
  };
  newBox.id = computeBoxId(newBox);

  insertBox(newBox);
  return newBox.id!;
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

export interface CreditTransferResult {
  status: 'pending';
  txId: string;
  expiresAtHeight: number;
  /** The pooled transaction, for the route's broadcast. */
  tx: UtxoTransaction;
}

/**
 * Pool a client-built, client-signed credit transfer.
 *
 * Receives a pre-built, signed UtxoTransaction from the client and does what
 * every other tx route does: `validateTx`, then `insertUtxoTx`. Credits move
 * at block application on every node, not when the HTTP call returns —
 * signature verification stays inside `validateTx`'s guard check.
 *
 * This replaced a builder that selected boxes server-side and applied the
 * result with `consumeBox`/`insertBox` directly — no block, no open journal.
 * That bypassed consensus entirely (audit F-consensus-7): the transfer
 * entered no block, produced no journal entries, never reached the AVL feed,
 * and the divergence detonated at the next restart-rebuild as a permanent
 * `stateRoot` fork. It also mirrored the client's transaction construction
 * byte-for-byte, which nothing tested; taking the client's own transaction
 * deletes the second implementation instead of documenting it.
 */
export function sendCredits(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): CreditTransferResult {
  // Shape gate for this route: every output is a CreditBox. Per-type value
  // conservation then pins the inputs to credit boxes too. This routes other
  // tx kinds to their own endpoints — it is not a consensus rule; those live
  // in `validateTx` below.
  if (tx.outputs.length === 0 || tx.outputs.some((o) => o.boxType !== 'credit')) {
    throw new ClientError('credit transfer outputs must all be CreditBoxes');
  }

  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid credit transfer: ${result.error}`);
  }

  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  insertUtxoTx(tx, null, expiresAtHeight);

  return {
    status: 'pending',
    txId: result.txId!,
    expiresAtHeight,
    tx,
  };
}
