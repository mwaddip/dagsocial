import { computeBoxId } from '@dagsocial/types';
import type { KarmaBox } from '@dagsocial/types';
import { MINT_OUTPUT_INDEX, decayContext, mintTxIdFor } from '../mint-provenance.js';
// Type-only: the decay service reaches the record through injected deps, never
// through the store module directly.
import type { IdentityRecord } from '../store/identity-records.js';

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
 * The clock of an identity that has no record at all.
 *
 * Every karma producer now writes one — the journaled paths through
 * `insertBox`'s choke point, and genesis explicitly (`ensureSystemKarmaBox`) —
 * so an owner holding karma with no record should be unreachable. It is still a
 * total function's job to say what happens if one appears, and "never observed
 * active" is the honest reading: maximally stale, decaying from height 0.
 *
 * The alternative — skipping record-less owners — is the more dangerous
 * failure: it exempts an identity from decay permanently, and does so silently.
 * Over-charging by a fraction of an interval is recoverable; a karma balance
 * that can never decay is an economic hole.
 */
const NEVER_ACTIVE: IdentityRecord = { lastActivityBlock: 0, lastDecayBlock: 0 };

/**
 * Is this identity stale — no normal activity within the threshold window?
 *
 *     stale = (height − lastActivityBlock) >= staleThresholdBlocks
 *
 * **`>=`, not `>`.** Spec G D10 makes this a representation swap that must be
 * behaviour-identical, and the predicate being replaced was "no unspent
 * non-decay karma box with `createdAtBlock > height − threshold`" — i.e. stale
 * iff `A <= height − threshold` iff `height − A >= threshold`. The contract's
 * prose stated `>`, which is off by one and would delay every identity's first
 * decay by exactly one block. The code is the authority on what the ledger did;
 * the contract has been corrected.
 *
 * The `currentHeight <= thresholdBlocks` guard is **not** subsumed by the new
 * formula. It was: with `A >= 1` the subtraction cannot reach the threshold
 * below it. But `lastActivityBlock` can be 0 for a never-active identity, and
 * `0 − 0 >= threshold` is true at exactly `height === threshold`, where the old
 * code returned false. The guard is what keeps that case identical.
 */
export function isIdentityStale(
  record: IdentityRecord | null,
  currentHeight: number,
  thresholdBlocks: number,
): boolean {
  if (currentHeight <= thresholdBlocks) return false;
  const clock = record ?? NEVER_ACTIVE;
  return currentHeight - clock.lastActivityBlock >= thresholdBlocks;
}

/**
 * How many decay periods have elapsed since this identity's clock last moved?
 *
 *     owedPeriods = floor( (height − max(lastActivityBlock, lastDecayBlock)) / interval )
 *
 * The `max` is not decoration. After a decay fires, the owner's only karma box
 * is the decay-burn box, and its height is exactly `lastDecayBlock`; charging
 * from `lastActivityBlock` alone would re-bill every interval since the
 * original activity on every subsequent cycle. This is the same fallback the
 * box-reading version expressed as "use the youngest box when all boxes are
 * decay-burn".
 *
 * No clamp at zero, matching the predecessor: `applyKarmaDecay` skips anything
 * `<= 0`, and swallowing a negative here would hide a clock that had somehow
 * run ahead of the chain.
 */
export function owedPeriods(
  record: IdentityRecord | null,
  currentHeight: number,
  intervalBlocks: number,
): number {
  const clock = record ?? NEVER_ACTIVE;
  const clockStart = Math.max(clock.lastActivityBlock, clock.lastDecayBlock);
  return Math.floor((currentHeight - clockStart) / intervalBlocks);
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
  /** The identity's decay clock, or null if it has never held karma. */
  getIdentityRecord: (identityId: Uint8Array) => IdentityRecord | null;
  /** Write the clock back. Journals at the store choke point. */
  putIdentityRecord: (identityId: Uint8Array, record: IdentityRecord) => void;
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

    // The clock is read once, before anything mutates: both predicates must see
    // the same pre-decay state, and the write-back below needs the prior
    // `lastActivityBlock` to carry it through untouched.
    const record = deps.getIdentityRecord(owner);

    if (!isIdentityStale(record, currentHeight, cfg.staleThresholdBlocks)) {
      continue;
    }

    const periods = owedPeriods(record, currentHeight, cfg.decayIntervalBlocks);
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

    // Advance the decay half of the clock. Written after the box insert so the
    // journal's reverse replay undoes the record before deleting the box that
    // caused it, and only on a firing — `periods > 0` and `burnAmount > 0` both
    // gate this, so a stale identity sitting at the karma floor keeps its clock
    // where it was rather than silently forfeiting the intervals it is owed.
    //
    // `lastActivityBlock` is carried through unchanged: the decay-burn box the
    // line above inserted is deliberately *not* activity, and resetting the
    // activity half here would make an identity look freshly active every time
    // it was charged.
    deps.putIdentityRecord(owner, {
      lastActivityBlock: record?.lastActivityBlock ?? 0,
      lastDecayBlock: currentHeight,
    });

    journal.push({ owner, consumedBoxIds, newBoxId: boxId, burnAmount });
  }

  return journal;
}
