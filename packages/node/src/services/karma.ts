import { computeBoxId } from '@dagsocial/types';
import type { KarmaBox } from '@dagsocial/types';
import { getKarmaBoxes, insertBox, consumeBox } from '../store/index.js';

/**
 * Mint (or increase) karma for a given user.
 *
 * Consumes ALL existing unspent karma boxes and creates a single new one
 * with the combined value + amount. This ensures each identity has at most
 * one unspent karma box after any mint operation.
 *
 * Exported so both the local block creator (miner) and the server's
 * block-application path can use it.
 */
export function mintKarma(
  userId: Uint8Array,
  amount: bigint,
  blockHeight: number,
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
  const boxId = computeBoxId(newBox);
  newBox.id = boxId;

  insertBox(newBox);
  return boxId;
}
