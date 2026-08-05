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
 * function cannot know. It is required rather than optional so a new call site
 * cannot silently produce a provenance-less box; `null` is the one explicit way
 * to say "no reason is defined for this site yet" and currently has exactly one
 * caller (`settlePruneUtxo` — see the note there).
 */
export function mintKarma(
  userId: Uint8Array,
  amount: bigint,
  blockHeight: number,
  ctx: MintContext | null,
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
  if (ctx) {
    newBox.txId = mintTxIdFor(ctx, blockHeight);
    newBox.index = MINT_OUTPUT_INDEX;
  }
  // After the attach, not before: phase G redefines `computeBoxId` to hash
  // `txId`/`index`. Inert until then — the legacy derivation strips them via
  // `canonicalBoxBytes`, which is what keeps every existing box id unmoved.
  const boxId = computeBoxId(newBox);
  newBox.id = boxId;

  insertBox(newBox);
  return boxId;
}
