import { computeBoxId } from '@dagsocial/types';
import type { KarmaBox } from '@dagsocial/types';
import { getIdentity, getKarmaBox, insertBox, consumeBox } from '../store/index.js';

/**
 * Mint (or increase) karma for a given user.
 *
 * userId IS the public key — no identity lookup needed. Either creates
 * a new karma box or increases the value of their existing one. The old box
 * is consumed and a new one created (even for top-ups — this resets the decay
 * clock via createdAtBlock).
 *
 * Exported so both the local block creator (miner) and the server's
 * block-application path can use it.
 */
export function mintKarma(
  userId: Uint8Array,
  amount: number,
  blockHeight: number,
): void {
  if (amount <= 0) return;

  // userId IS the public key — look up karma box directly
  const existingBox = getKarmaBox(userId);

  let newValue: number;
  let proofSource: string;
  let oldBoxId: string | undefined;

  if (existingBox && existingBox.id) {
    newValue = existingBox.value + amount;
    proofSource = existingBox.proofSource ?? `mint-${blockHeight}`;
    oldBoxId = existingBox.id;
  } else {
    newValue = amount;
    proofSource = `mint-${blockHeight}`;
  }

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

  if (oldBoxId) {
    consumeBox(oldBoxId, blockHeight);
  }

  insertBox(newBox);
}
