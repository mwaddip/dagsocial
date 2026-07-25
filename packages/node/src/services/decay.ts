import {
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  computeBoxId,
} from '@dagsocial/types';
import type { KarmaBox, DecayJournalEntry } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * An identity is stale if it has NO unspent karma box where decayBurn !== true
 * and createdAtBlock is within the threshold window.
 */
export function isIdentityStale(
  boxes: KarmaBox[],
  currentHeight: number,
  thresholdBlocks: number,
): boolean {
  if (boxes.length === 0) return false;
  const hasRecentActivity = boxes.some(
    (b) =>
      b.decayBurn !== true &&
      b.createdAtBlock > currentHeight - thresholdBlocks,
  );
  return !hasRecentActivity;
}

/**
 * How many decay periods have elapsed since this identity's last activity?
 * Uses the oldest non-decay-burn box as the clock start. If all boxes are
 * decay-burn boxes, uses the youngest one.
 */
export function owedPeriods(
  boxes: KarmaBox[],
  currentHeight: number,
  intervalBlocks: number,
): number {
  const normalBoxes = boxes.filter((b) => b.decayBurn !== true);
  if (normalBoxes.length === 0) {
    if (boxes.length === 0) return 0;
    const youngest = boxes.reduce((a, b) =>
      b.createdAtBlock > a.createdAtBlock ? b : a,
    );
    return Math.floor(
      (currentHeight - youngest.createdAtBlock) / intervalBlocks,
    );
  }
  const oldest = normalBoxes.reduce((a, b) =>
    b.createdAtBlock < a.createdAtBlock ? b : a,
  );
  return Math.floor(
    (currentHeight - oldest.createdAtBlock) / intervalBlocks,
  );
}

// ---------------------------------------------------------------------------
// Decay execution
// ---------------------------------------------------------------------------

export interface DecayDeps {
  getKarmaBoxes: (owner: Uint8Array) => KarmaBox[];
  consumeBox: (boxId: string, consumedAtBlock: number) => void;
  insertBox: (box: KarmaBox) => void;
  /** Return all distinct owners with unspent karma boxes. */
  getKarmaOwners: () => Uint8Array[];
}

/**
 * Apply periodic karma decay to all stale identities.
 * Called during applyOrderingBlock after UTXO transactions are applied.
 * Returns journal entries for rollback.
 */
export function applyKarmaDecay(
  deps: DecayDeps,
  currentHeight: number,
): DecayJournalEntry[] {
  const journal: DecayJournalEntry[] = [];
  const owners = deps.getKarmaOwners();

  for (const owner of owners) {
    const boxes = deps.getKarmaBoxes(owner);
    if (boxes.length === 0) continue;

    if (!isIdentityStale(boxes, currentHeight, KARMA_STALE_THRESHOLD_BLOCKS)) {
      continue;
    }

    const periods = owedPeriods(boxes, currentHeight, KARMA_DECAY_INTERVAL_BLOCKS);
    if (periods <= 0) continue;

    const totalKarma = boxes.reduce((sum, b) => sum + b.value, 0);
    const maxBurn = Math.max(0, totalKarma - KARMA_MINIMUM);
    const burnAmount = Math.min(periods * KARMA_DECAY_AMOUNT, maxBurn);
    if (burnAmount <= 0) continue;

    const newValue = totalKarma - burnAmount;

    // Consume all existing karma boxes
    const consumedBoxIds: string[] = [];
    for (const box of boxes) {
      if (box.id) {
        deps.consumeBox(box.id, currentHeight);
        consumedBoxIds.push(box.id);
      }
    }

    // Create single consolidated replacement box
    const newBox: KarmaBox = {
      boxType: 'karma',
      value: newValue,
      createdAtBlock: currentHeight,
      owner,
      guard: 'owner_signature',
      proofSource: `decay-${currentHeight}`,
      lastTouchBlock: currentHeight,
      decayBurn: true,
    };
    const boxId = computeBoxId(newBox);
    newBox.id = boxId;
    deps.insertBox(newBox);

    journal.push({ owner, consumedBoxIds, newBoxId: boxId, burnAmount });
  }

  return journal;
}
