import { computeBoxId } from '@dagsocial/types';
import type { CreditBox } from '@dagsocial/types';
import { getCreditBox, insertBox, consumeBox } from '../store/index.js';

/**
 * Mint (or increase) credits for a given owner.
 *
 * Same pattern as mintKarma: either creates a new CreditBox or increases the
 * value of the existing one.  The old box is consumed and a new one created.
 * If lockedUntilBlock is set, credits cannot be spent before that block height.
 */
export function mintCredits(
  owner: Uint8Array,
  amount: number,
  blockHeight: number,
  lockedUntilBlock?: number,
): void {
  if (amount <= 0) return;

  const existingBox = getCreditBox(owner);

  let newValue: number;
  let oldBoxId: string | undefined;
  let mergedLockedUntilBlock: number | undefined;

  if (existingBox && existingBox.id) {
    newValue = existingBox.value + amount;
    oldBoxId = existingBox.id;
    // Keep the further-future lock if both old and new have one
    if (existingBox.lockedUntilBlock !== undefined || lockedUntilBlock !== undefined) {
      mergedLockedUntilBlock = Math.max(
        existingBox.lockedUntilBlock ?? 0,
        lockedUntilBlock ?? 0,
      );
    }
  } else {
    newValue = amount;
    mergedLockedUntilBlock = lockedUntilBlock;
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

  if (oldBoxId) {
    consumeBox(oldBoxId, blockHeight);
  }

  insertBox(newBox);
}
