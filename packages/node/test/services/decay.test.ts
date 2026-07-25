import { describe, it, expect } from 'vitest';
import {
  isIdentityStale,
  owedPeriods,
  applyKarmaDecay,
} from '../../src/services/decay.js';
import {
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type { KarmaBox, DecayJournalEntry } from '@dagsocial/types';

const OWNER = new Uint8Array(32).fill(0xaa);

function makeKarmaBox(overrides: Partial<KarmaBox> = {}): KarmaBox {
  return {
    boxType: 'karma',
    value: 100,
    createdAtBlock: 0,
    owner: OWNER,
    guard: 'owner_signature',
    proofSource: 'test',
    lastTouchBlock: 0,
    id: 'box-' + Math.random().toString(36).slice(2, 8),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isIdentityStale
// ---------------------------------------------------------------------------

describe('isIdentityStale', () => {
  it('returns false for empty box list', () => {
    expect(isIdentityStale([], 1000, KARMA_STALE_THRESHOLD_BLOCKS)).toBe(false);
  });

  it('returns false when a normal box is within threshold', () => {
    const boxes = [makeKarmaBox({ createdAtBlock: 99000 })];
    // threshold = 20160, current = 100000, age = 1000 < threshold
    expect(isIdentityStale(boxes, 100000, KARMA_STALE_THRESHOLD_BLOCKS)).toBe(false);
  });

  it('returns true when all normal boxes are older than threshold', () => {
    const boxes = [makeKarmaBox({ createdAtBlock: 1000 })];
    // threshold = 20160, current = 100000, age = 99000 > threshold
    expect(isIdentityStale(boxes, 100000, KARMA_STALE_THRESHOLD_BLOCKS)).toBe(true);
  });

  it('returns true when only decayBurn boxes exist', () => {
    const boxes = [
      makeKarmaBox({ createdAtBlock: 99999, decayBurn: true }),
    ];
    // Even though box is recent, it's decayBurn — no real activity
    expect(isIdentityStale(boxes, 100000, KARMA_STALE_THRESHOLD_BLOCKS)).toBe(true);
  });

  it('returns false with mixed old decayBurn + recent normal box', () => {
    const boxes = [
      makeKarmaBox({ createdAtBlock: 1000, decayBurn: true }),  // old decay
      makeKarmaBox({ createdAtBlock: 99999 }),                   // recent normal
    ];
    expect(isIdentityStale(boxes, 100000, KARMA_STALE_THRESHOLD_BLOCKS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// owedPeriods
// ---------------------------------------------------------------------------

describe('owedPeriods', () => {
  it('returns 0 for empty box list', () => {
    expect(owedPeriods([], 1000, KARMA_DECAY_INTERVAL_BLOCKS)).toBe(0);
  });

  it('returns correct periods for normal boxes', () => {
    // Oldest normal box at height 1000, current 3160, interval 720
    // (3160 - 1000) / 720 = 3
    const boxes = [makeKarmaBox({ createdAtBlock: 1000 })];
    expect(owedPeriods(boxes, 3160, KARMA_DECAY_INTERVAL_BLOCKS)).toBe(3);
  });

  it('uses oldest normal box when multiple exist', () => {
    const boxes = [
      makeKarmaBox({ createdAtBlock: 2000 }),  // newer
      makeKarmaBox({ createdAtBlock: 1000 }),  // older — this one counts
    ];
    expect(owedPeriods(boxes, 3160, KARMA_DECAY_INTERVAL_BLOCKS)).toBe(3);
  });

  it('uses youngest decayBurn box when all are decayBurn', () => {
    const boxes = [
      makeKarmaBox({ createdAtBlock: 1000, decayBurn: true }),  // older decay
      makeKarmaBox({ createdAtBlock: 2000, decayBurn: true }),  // younger decay
    ];
    // Uses youngest: (3160 - 2000) / 720 = 1
    expect(owedPeriods(boxes, 3160, KARMA_DECAY_INTERVAL_BLOCKS)).toBe(1);
  });

  it('ignores decayBurn boxes when normal boxes exist', () => {
    const boxes = [
      makeKarmaBox({ createdAtBlock: 500, decayBurn: true }),   // old decay — ignored
      makeKarmaBox({ createdAtBlock: 1000 }),                    // normal — this counts
    ];
    // Oldest normal is 1000: (3160 - 1000) / 720 = 3
    expect(owedPeriods(boxes, 3160, KARMA_DECAY_INTERVAL_BLOCKS)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// applyKarmaDecay
// ---------------------------------------------------------------------------

describe('applyKarmaDecay', () => {
  function makeDeps(boxesMap: Map<string, KarmaBox[]>) {
    const consumed: { boxId: string; atHeight: number }[] = [];
    const inserted: KarmaBox[] = [];
    return {
      deps: {
        getKarmaBoxes: (owner: Uint8Array) => {
          const key = Buffer.from(owner).toString('hex');
          return boxesMap.get(key) ?? [];
        },
        consumeBox: (boxId: string, atHeight: number) => {
          consumed.push({ boxId, atHeight });
        },
        insertBox: (box: KarmaBox) => {
          inserted.push(box);
        },
        getKarmaOwners: () => {
          return Array.from(boxesMap.keys()).map(k => new Uint8Array(Buffer.from(k, 'hex')));
        },
      },
      consumed,
      inserted,
    };
  }

  it('does nothing for non-stale identity', () => {
    const ownerKey = Buffer.from(OWNER).toString('hex');
    const boxesMap = new Map<string, KarmaBox[]>();
    boxesMap.set(ownerKey, [
      makeKarmaBox({ createdAtBlock: 99999, value: 100 }),
    ]);
    const { deps, consumed, inserted } = makeDeps(boxesMap);

    const journal = applyKarmaDecay(deps, 100000);

    expect(journal).toHaveLength(0);
    expect(consumed).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  it('burns karma for stale identity', () => {
    const ownerKey = Buffer.from(OWNER).toString('hex');
    const boxesMap = new Map<string, KarmaBox[]>();
    // Box at height 1000, current 25000, threshold 20160 -> stale (age 24000 > 20160)
    // periods = floor((25000-1000)/720) = 33, burn = min(33*5=165, 100-10=90) = 90
    boxesMap.set(ownerKey, [
      makeKarmaBox({ id: 'old-box-1', createdAtBlock: 1000, value: 100 }),
    ]);
    const { deps } = makeDeps(boxesMap);

    const journal = applyKarmaDecay(deps, 25000);

    expect(journal).toHaveLength(1);
    const entry = journal[0]!;
    expect(entry.burnAmount).toBe(90);
    expect(entry.consumedBoxIds).toEqual(['old-box-1']);
    expect(entry.newBoxId).toBeTruthy();
  });

  it('caps burn at KARMA_MINIMUM floor', () => {
    const ownerKey = Buffer.from(OWNER).toString('hex');
    const boxesMap = new Map<string, KarmaBox[]>();
    // Box with 12 karma, current 25000 -> stale, 33 owed periods
    // burn = min(33*5=165, 12-10=2) = 2
    boxesMap.set(ownerKey, [
      makeKarmaBox({ id: 'old-box-1', createdAtBlock: 1000, value: 12 }),
    ]);
    const { deps } = makeDeps(boxesMap);

    const journal = applyKarmaDecay(deps, 25000);

    expect(journal).toHaveLength(1);
    expect(journal[0]!.burnAmount).toBe(2);
  });

  it('does nothing when already at or below minimum', () => {
    const ownerKey = Buffer.from(OWNER).toString('hex');
    const boxesMap = new Map<string, KarmaBox[]>();
    boxesMap.set(ownerKey, [
      makeKarmaBox({ id: 'old-box-1', createdAtBlock: 1000, value: 8 }),
    ]);
    const { deps, consumed, inserted } = makeDeps(boxesMap);

    const journal = applyKarmaDecay(deps, 25000);

    expect(journal).toHaveLength(0);
    expect(consumed).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  it('consolidates multiple boxes into one', () => {
    const ownerKey = Buffer.from(OWNER).toString('hex');
    const boxesMap = new Map<string, KarmaBox[]>();
    boxesMap.set(ownerKey, [
      makeKarmaBox({ id: 'box-a', createdAtBlock: 1000, value: 50 }),
      makeKarmaBox({ id: 'box-b', createdAtBlock: 1000, value: 60 }),
    ]);
    const { deps, consumed } = makeDeps(boxesMap);

    const journal = applyKarmaDecay(deps, 25000);

    expect(journal).toHaveLength(1);
    expect(consumed.length).toBe(2); // both old boxes consumed
    expect(consumed.map(c => c.boxId).sort()).toEqual(['box-a', 'box-b']);
  });

  it('new box has decayBurn: true', () => {
    const ownerKey = Buffer.from(OWNER).toString('hex');
    const boxesMap = new Map<string, KarmaBox[]>();
    boxesMap.set(ownerKey, [
      makeKarmaBox({ id: 'old-box', createdAtBlock: 1000, value: 100 }),
    ]);
    const { deps, inserted } = makeDeps(boxesMap);

    applyKarmaDecay(deps, 25000);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.decayBurn).toBe(true);
  });
});
