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
import type { KarmaBox } from '@dagsocial/types';
import type { IdentityRecord } from '../../src/store/identity-records.js';

/**
 * Spec G phase D — the decay clock reads the committed identity record.
 *
 * The predicates took `KarmaBox[]` and read `createdAtBlock`; they now take an
 * `IdentityRecord`. The scenarios below are the same ones, restated on the
 * clock: a box at height H that counted as activity is `lastActivityBlock: H`,
 * and a decay-burn box at height H is `lastDecayBlock: H`. End-to-end
 * equivalence is checked against frozen pre-swap captures in
 * `decay-golden.test.ts`; these are the unit-level statements of the two rules.
 */

const OWNER = new Uint8Array(32).fill(0xaa);

const TEST_CFG = {
  staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
  decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
  decayAmount: KARMA_DECAY_AMOUNT,
  karmaMinimum: KARMA_MINIMUM,
};

function clock(lastActivityBlock: number, lastDecayBlock = 0): IdentityRecord {
  return { lastActivityBlock, lastDecayBlock };
}

function makeKarmaBox(overrides: Partial<KarmaBox> = {}): KarmaBox {
  return {
    boxType: 'karma',
    value: 100n,
    owner: OWNER,
    guard: 'owner_signature',
    proofSource: 'test',
    id: 'box-' + Math.random().toString(36).slice(2, 8),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isIdentityStale
// ---------------------------------------------------------------------------

describe('isIdentityStale', () => {
  it('returns false for an identity with no record below the threshold height', () => {
    expect(isIdentityStale(null, 1000, KARMA_STALE_THRESHOLD_BLOCKS)).toBe(false);
  });

  it('returns false when activity is within the threshold', () => {
    // current = 100000, age = 1000 — well inside the threshold
    expect(isIdentityStale(clock(99000), 100000, KARMA_STALE_THRESHOLD_BLOCKS)).toBe(false);
  });

  it('returns true when activity is older than the threshold', () => {
    // current = 100000, age = 99000 — beyond the threshold
    expect(isIdentityStale(clock(1000), 100000, KARMA_STALE_THRESHOLD_BLOCKS)).toBe(true);
  });

  it('a recent decay does not count as activity', () => {
    // The decay-burn box the old code excluded is `lastDecayBlock` here: recent,
    // and still not activity. Otherwise one decay would make the identity look
    // fresh and no second cycle could ever fire.
    expect(
      isIdentityStale(clock(1000, 99999), 100000, KARMA_STALE_THRESHOLD_BLOCKS),
    ).toBe(true);
  });

  it('recent activity wins over an old decay', () => {
    expect(
      isIdentityStale(clock(99999, 1000), 100000, KARMA_STALE_THRESHOLD_BLOCKS),
    ).toBe(false);
  });

  it('is stale at exactly the threshold, not one block later', () => {
    // `>=`, not `>`. The predecessor's test was `createdAtBlock > height −
    // threshold`, so an activity height exactly `threshold` blocks back is
    // already stale. The contract's prose said `>` and was off by one.
    expect(isIdentityStale(clock(100), 100 + KARMA_STALE_THRESHOLD_BLOCKS,
      KARMA_STALE_THRESHOLD_BLOCKS)).toBe(true);
    expect(isIdentityStale(clock(100), 99 + KARMA_STALE_THRESHOLD_BLOCKS,
      KARMA_STALE_THRESHOLD_BLOCKS)).toBe(false);
  });

  it('never stale at or below the threshold height', () => {
    // The chain has not existed long enough. Load-bearing for a clock of 0,
    // where the subtraction alone would report stale at exactly `threshold`.
    expect(isIdentityStale(clock(0), KARMA_STALE_THRESHOLD_BLOCKS,
      KARMA_STALE_THRESHOLD_BLOCKS)).toBe(false);
    expect(isIdentityStale(clock(0), KARMA_STALE_THRESHOLD_BLOCKS + 1,
      KARMA_STALE_THRESHOLD_BLOCKS)).toBe(true);
  });

  it('a missing record reads as never-active', () => {
    expect(isIdentityStale(null, 100000, KARMA_STALE_THRESHOLD_BLOCKS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// owedPeriods
// ---------------------------------------------------------------------------

describe('owedPeriods', () => {
  it('returns 0 when the clock is at the current height', () => {
    expect(owedPeriods(clock(1000), 1000, KARMA_DECAY_INTERVAL_BLOCKS)).toBe(0);
  });

  it('counts periods since activity', () => {
    // Three whole intervals since the activity height.
    expect(
      owedPeriods(clock(1000), 1000 + 3 * KARMA_DECAY_INTERVAL_BLOCKS, KARMA_DECAY_INTERVAL_BLOCKS),
    ).toBe(3);
  });

  it('uses the decay height when it is later than the activity height', () => {
    // The `max(...)` fallback: after a decay the only karma box is the
    // decay-burn box, whose height is exactly `lastDecayBlock`.
    // One interval past the decay — not three past the activity.
    const activityAt = 1000;
    const decayAt = activityAt + 2 * KARMA_DECAY_INTERVAL_BLOCKS;
    expect(
      owedPeriods(
        clock(activityAt, decayAt),
        decayAt + KARMA_DECAY_INTERVAL_BLOCKS,
        KARMA_DECAY_INTERVAL_BLOCKS,
      ),
    ).toBe(1);
  });

  it('uses the activity height when it is later than the decay height', () => {
    // The decay sits more than one whole interval before the activity, so
    // reading the decay height instead would change the answer.
    const decayAt = 100;
    const activityAt = decayAt + KARMA_DECAY_INTERVAL_BLOCKS;
    const height = activityAt + 3 * KARMA_DECAY_INTERVAL_BLOCKS;
    expect(owedPeriods(clock(activityAt, decayAt), height, KARMA_DECAY_INTERVAL_BLOCKS)).toBe(3);
    expect(owedPeriods(clock(height - 1, decayAt), height, KARMA_DECAY_INTERVAL_BLOCKS)).toBe(0);
  });

  it('activity and decay at the same height count once', () => {
    // The intra-block adjacency: decay fires, then a vouch settlement mints for
    // the same owner in the same block.
    expect(
      owedPeriods(clock(2000, 2000), 2000 + KARMA_DECAY_INTERVAL_BLOCKS, KARMA_DECAY_INTERVAL_BLOCKS),
    ).toBe(1);
  });

  it('a missing record counts from height 0', () => {
    expect(owedPeriods(null, 2 * KARMA_DECAY_INTERVAL_BLOCKS, KARMA_DECAY_INTERVAL_BLOCKS)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// applyKarmaDecay
// ---------------------------------------------------------------------------

describe('applyKarmaDecay', () => {
  function makeDeps(
    boxesMap: Map<string, KarmaBox[]>,
    recordMap = new Map<string, IdentityRecord>(),
  ) {
    const consumed: { boxId: string; atHeight: number }[] = [];
    const inserted: KarmaBox[] = [];
    const key = (o: Uint8Array) => Buffer.from(o).toString('hex');
    return {
      deps: {
        getKarmaBoxes: (owner: Uint8Array) => boxesMap.get(key(owner)) ?? [],
        consumeBox: (boxId: string, atHeight: number) => {
          consumed.push({ boxId, atHeight });
        },
        insertBox: (box: KarmaBox) => {
          inserted.push(box);
        },
        getKarmaOwners: () =>
          Array.from(boxesMap.keys()).map((k) => new Uint8Array(Buffer.from(k, 'hex'))),
        getIdentityRecord: (id: Uint8Array) => recordMap.get(key(id)) ?? null,
        putIdentityRecord: (id: Uint8Array, r: IdentityRecord) => {
          recordMap.set(key(id), r);
        },
      },
      consumed,
      inserted,
      recordMap,
    };
  }

  const ownerKey = Buffer.from(OWNER).toString('hex');

  function oneOwner(boxes: KarmaBox[], record?: IdentityRecord) {
    const boxesMap = new Map<string, KarmaBox[]>([[ownerKey, boxes]]);
    const recordMap = new Map<string, IdentityRecord>();
    if (record) recordMap.set(ownerKey, record);
    return makeDeps(boxesMap, recordMap);
  }

  // The stale-family heights, derived from the constants so the tests survive
  // the next constant change. Activity at ACTIVITY_AT, decay evaluated at
  // STALE_AT: past the staleness threshold, with enough whole intervals owed
  // (CAP_INTERVALS × KARMA_DECAY_AMOUNT > 100n − KARMA_MINIMUM) that the
  // value-over-minimum cap, not the per-period rate, sets every asserted burn.
  const ACTIVITY_AT = 1000;
  const CAP_INTERVALS = Number((100n - KARMA_MINIMUM) / KARMA_DECAY_AMOUNT) + 1;
  const STALE_AT =
    ACTIVITY_AT + KARMA_STALE_THRESHOLD_BLOCKS + CAP_INTERVALS * KARMA_DECAY_INTERVAL_BLOCKS;

  it('does nothing for a non-stale identity', () => {
    const { deps, consumed, inserted } = oneOwner(
      [makeKarmaBox({ value: 100n })],
      clock(99999),
    );

    const journal = applyKarmaDecay(deps, 100000, TEST_CFG);

    expect(journal).toHaveLength(0);
    expect(consumed).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  it('burns karma for a stale identity', () => {
    // Stale by construction of STALE_AT, and owed more than the box holds over
    // the floor — so the burn is the value-over-minimum cap.
    const { deps } = oneOwner(
      [makeKarmaBox({ id: 'old-box-1', value: 100n })],
      clock(ACTIVITY_AT),
    );

    const journal = applyKarmaDecay(deps, STALE_AT, TEST_CFG);

    expect(journal).toHaveLength(1);
    const entry = journal[0]!;
    expect(entry.burnAmount).toBe(100n - KARMA_MINIMUM);
    expect(entry.consumedBoxIds).toEqual(['old-box-1']);
    expect(entry.newBoxId).toBeTruthy();
  });

  it('caps burn at the KARMA_MINIMUM floor', () => {
    // Owed far more than the box holds over the floor; only the excess burns.
    const { deps } = oneOwner(
      [makeKarmaBox({ id: 'old-box-1', value: 12n })],
      clock(ACTIVITY_AT),
    );

    const journal = applyKarmaDecay(deps, STALE_AT, TEST_CFG);

    expect(journal).toHaveLength(1);
    expect(journal[0]!.burnAmount).toBe(12n - KARMA_MINIMUM);
  });

  it('does nothing when already at or below the minimum', () => {
    const { deps, consumed, inserted } = oneOwner(
      [makeKarmaBox({ id: 'old-box-1', value: 8n })],
      clock(ACTIVITY_AT),
    );

    const journal = applyKarmaDecay(deps, STALE_AT, TEST_CFG);

    expect(journal).toHaveLength(0);
    expect(consumed).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  it('leaves the clock untouched when nothing burns', () => {
    // A stale identity sitting at the floor keeps the intervals it is owed —
    // writing `lastDecayBlock` on a zero burn would silently forgive them.
    const { deps, recordMap } = oneOwner(
      [makeKarmaBox({ id: 'old-box-1', value: 8n })],
      clock(ACTIVITY_AT),
    );

    applyKarmaDecay(deps, STALE_AT, TEST_CFG);

    expect(recordMap.get(ownerKey)).toEqual(clock(ACTIVITY_AT));
  });

  it('consolidates multiple boxes into one', () => {
    const { deps, consumed } = oneOwner(
      [
        makeKarmaBox({ id: 'box-a', value: 50n }),
        makeKarmaBox({ id: 'box-b', value: 60n }),
      ],
      clock(ACTIVITY_AT),
    );

    const journal = applyKarmaDecay(deps, STALE_AT, TEST_CFG);

    expect(journal).toHaveLength(1);
    expect(consumed.length).toBe(2);
    expect(consumed.map((c) => c.boxId).sort()).toEqual(['box-a', 'box-b']);
  });

  it('the new box has decayBurn: true', () => {
    const { deps, inserted } = oneOwner(
      [makeKarmaBox({ id: 'old-box', value: 100n })],
      clock(ACTIVITY_AT),
    );

    applyKarmaDecay(deps, STALE_AT, TEST_CFG);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.decayBurn).toBe(true);
  });

  it('advances lastDecayBlock and preserves lastActivityBlock', () => {
    const { deps, recordMap } = oneOwner(
      [makeKarmaBox({ id: 'old-box', value: 100n })],
      clock(ACTIVITY_AT),
    );

    applyKarmaDecay(deps, STALE_AT, TEST_CFG);

    expect(recordMap.get(ownerKey)).toEqual(clock(ACTIVITY_AT, STALE_AT));
  });

  it('a second cycle charges from the first decay, not from the activity', () => {
    // Without `max(...)` this would re-bill every interval since ACTIVITY_AT
    // and burn down to the floor instead of one period's worth.
    const firstDecayAt = ACTIVITY_AT + KARMA_STALE_THRESHOLD_BLOCKS;
    const { deps } = oneOwner(
      [makeKarmaBox({ id: 'decay-box', value: 100n, decayBurn: true })],
      clock(ACTIVITY_AT, firstDecayAt),
    );

    const journal = applyKarmaDecay(deps, firstDecayAt + KARMA_DECAY_INTERVAL_BLOCKS, TEST_CFG);

    expect(journal).toHaveLength(1);
    // One whole interval past the first decay -> exactly one period's burn.
    expect(journal[0]!.burnAmount).toBe(KARMA_DECAY_AMOUNT);
  });

  it('creates a record for an owner that had none', () => {
    const { deps, recordMap } = oneOwner([makeKarmaBox({ id: 'old-box', value: 100n })]);

    const journal = applyKarmaDecay(deps, STALE_AT, TEST_CFG);

    expect(journal).toHaveLength(1);
    expect(recordMap.get(ownerKey)).toEqual(clock(0, STALE_AT));
  });

  it('skips an owner with no karma boxes without touching its clock', () => {
    const { deps, recordMap } = oneOwner([], clock(ACTIVITY_AT));

    expect(applyKarmaDecay(deps, STALE_AT, TEST_CFG)).toHaveLength(0);
    expect(recordMap.get(ownerKey)).toEqual(clock(ACTIVITY_AT));
  });
});
