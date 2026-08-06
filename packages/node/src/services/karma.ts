import { computeBoxId } from '@dagsocial/types';
import type { KarmaBox } from '@dagsocial/types';
import { getKarmaBoxes, insertBox, consumeBox } from '../store/index.js';
import { MINT_OUTPUT_INDEX, mintTxIdFor } from '../mint-provenance.js';
import type { MintContext } from '../mint-provenance.js';

/**
 * Mint (or increase) karma for a given user.
 *
 * Consumes ALL existing unspent karma boxes and creates a single new one
 * with the combined value + amount. This ensures each identity has at most
 * one unspent karma box after any mint operation.
 *
 * Exported so both the local block creator (miner) and the server's
 * block-application path can use it.
 *
 * `ctx` says *why* — the half of the box's synthetic transaction id this
 * function cannot know. It admitted `null` through the migration window, for
 * the single site that had no reason defined yet; `settlePruneUtxo` was that
 * site, G2a gave it the two `prune-refund-*` reasons, and G2b removed the
 * escape hatch.
 *
 * Non-nullable is deliberate rather than tidy-up. `tsconfig` covers `src`, so a
 * required parameter is a **compile error at the call site** — exactly where
 * omitting provenance breaks consensus. Keeping `| null` would leave the store
 * as the only line of defence, and once G3 makes `utxo_boxes.tx_id`/
 * `output_index` NOT NULL that becomes a constraint failure at block
 * application: fail-closed, but late, and it reads as a store bug rather than
 * as a missing mint reason. Nothing can legitimately pass `null` again either:
 * the contract requires a new mint reason to arrive as a tag *plus* an encoding
 * *plus* an argument that `(height, reason, subject)` cannot repeat, so "no
 * reason" is not a state a correct producer can be in.
 */
export function mintKarma(
  userId: Uint8Array,
  amount: bigint,
  blockHeight: number,
  ctx: MintContext,
): string {
  if (amount <= 0n) return '';

  const existingBoxes = getKarmaBoxes(userId);
  const existingTotal = existingBoxes.reduce((sum, b) => sum + b.value, 0n);
  const newValue = existingTotal + amount;

  // Consume all existing boxes
  for (const box of existingBoxes) {
    if (box.id) consumeBox(box.id, blockHeight);
  }

  const proofSource = existingBoxes.length > 0
    ? (existingBoxes[0]!.proofSource ?? `mint-${blockHeight}`)
    : `mint-${blockHeight}`;

  const newBox: KarmaBox = {
    boxType: 'karma',
    value: newValue,
    createdAtBlock: blockHeight,
    owner: userId,
    guard: 'owner_signature',
    proofSource,
    lastTouchBlock: blockHeight,
  };
  // Provenance is appended **after** every candidate field, matching
  // `rowToBox`'s `withProvenance`. `serializeBox` spreads box keys in insertion
  // order under `variableMapSize: false`, so a producer that interleaved these
  // would serialize to different bytes than the same box read back from SQLite
  // — a restart-triggered stateRoot fork, from nothing but key order.
  newBox.txId = mintTxIdFor(ctx, blockHeight);
  newBox.index = MINT_OUTPUT_INDEX;
  // After the attach, not before: phase G redefines `computeBoxId` to hash
  // `txId`/`index`. Inert until then — the legacy derivation strips them via
  // `canonicalBoxBytes`, which is what keeps every existing box id unmoved.
  const boxId = computeBoxId(newBox);
  newBox.id = boxId;

  insertBox(newBox);
  return boxId;
}
