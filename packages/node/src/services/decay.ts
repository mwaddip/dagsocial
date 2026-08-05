import { computeBoxId } from '@dagsocial/types';
import type { KarmaBox } from '@dagsocial/types';
import { MINT_OUTPUT_INDEX, decayContext, mintTxIdFor } from '../mint-provenance.js';

/**
 * Per-owner summary of one decay application. Node-local: block application
 * journals the underlying box mutations at the store choke point; this
 * return value exists for the decay service's own callers and tests.
 */
export interface DecayJournalEntry {
  owner: Uint8Array;
  consumedBoxIds: string[];
  newBoxId: string;
  burnAmount: bigint;
}

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
  // Guard: chain hasn't existed long enough for staleness to apply.
  // Without this, `currentHeight - thresholdBlocks` wraps negative and
  // every non-decay-burn box falsely appears "recent".
  if (currentHeight <= thresholdBlocks) return false;
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
  cfg: {
    staleThresholdBlocks: number;
    decayIntervalBlocks: number;
    decayAmount: bigint;
    karmaMinimum: bigint;
  },
): DecayJournalEntry[] {
  const journal: DecayJournalEntry[] = [];
  const owners = deps.getKarmaOwners();

  for (const owner of owners) {
    const boxes = deps.getKarmaBoxes(owner);
    if (boxes.length === 0) continue;

    if (!isIdentityStale(boxes, currentHeight, cfg.staleThresholdBlocks)) {
      continue;
    }

    const periods = owedPeriods(boxes, currentHeight, cfg.decayIntervalBlocks);
    if (periods <= 0) continue;

    const totalKarma = boxes.reduce((sum, b) => sum + b.value, 0n);
    const overMinimum = totalKarma - cfg.karmaMinimum;
    const maxBurn = overMinimum > 0n ? overMinimum : 0n;
    const owed = BigInt(periods) * cfg.decayAmount;
    const burnAmount = owed < maxBurn ? owed : maxBurn;
    if (burnAmount <= 0n) continue;

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
    // Appended after every candidate field, matching `rowToBox`'s
    // `withProvenance` — `decayBurn` included, since it is the last field the
    // producer sets and `rowToBox` sets it in the same position.
    //
    // `owner` alone is an injective subject here: `applyKarmaDecay` visits each
    // owner at most once per call (`getKarmaOwners` returns distinct owners) and
    // runs once per block, so `(height, 'decay', owner)` cannot repeat.
    newBox.txId = mintTxIdFor(decayContext(owner), currentHeight);
    newBox.index = MINT_OUTPUT_INDEX;
    const boxId = computeBoxId(newBox);
    newBox.id = boxId;
    deps.insertBox(newBox);

    journal.push({ owner, consumedBoxIds, newBoxId: boxId, burnAmount });
  }

  return journal;
}
