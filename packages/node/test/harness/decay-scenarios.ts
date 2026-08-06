import type { DecayCfg, Scenario } from './decay-timeline.js';

/**
 * The timelines the phase-D golden fixtures were captured from.
 *
 * Split into two groups on purpose:
 *
 *  - **`EQUIVALENT_SCENARIOS`** — the equivalence gate. Every one of these must
 *    reproduce its frozen capture byte-for-byte after the record swap. They
 *    cover the ledger shape production is actually in: forced karma
 *    consolidation (Spec G D9) leaves at most one karma box per owner, which is
 *    what makes "oldest non-decay box" and "last activity" the same number.
 *
 *  - **`DIVERGENT_SCENARIOS`** — a shape where the two clocks legitimately
 *    disagree, captured so the disagreement is on the record rather than
 *    missing. See `decay-divergence.test.ts`.
 *
 * All heights and amounts are chosen so every arithmetic step is checkable by
 * hand; nothing here samples a clock or a random source.
 */

/**
 * Compressed config — the one `decay-full-pipeline.test.ts` runs the real nodes
 * under. Small enough that every burn is verifiable by inspection.
 */
export const FAST: DecayCfg = {
  staleThresholdBlocks: 10,
  decayIntervalBlocks: 3,
  decayAmount: 5n,
  karmaMinimum: 10n,
};

/**
 * The production constants **as they stood when the golden fixture was
 * captured** (pre-P2A, 2-minute-block basis), frozen as literals on purpose.
 *
 * The fixture exists to prove the box-age → identity-record swap
 * behaviour-identical, so the constants' *live* values are irrelevant to the
 * property under test — "production scale" means production at capture time.
 * Reading the live constants here pinned the golden's outputs while letting
 * its inputs float, which is how the P2-A unit correction (20160→40320,
 * 720→1440) broke the capture without any behaviour changing. All four fields
 * are frozen, not just the two P2-A moved: all four are inputs of the frozen
 * outputs, and two of them staying equal to the live constants would be luck,
 * not construction.
 */
export const PROD: DecayCfg = {
  staleThresholdBlocks: 20160,
  decayIntervalBlocks: 720,
  decayAmount: 5n,
  karmaMinimum: 10n,
};

export const EQUIVALENT_SCENARIOS: Scenario[] = [
  {
    // Nothing fires below the threshold. Pins the guard against
    // `currentHeight − threshold` going negative, which would make every box
    // look recent.
    name: 'no-decay-below-threshold',
    cfg: FAST,
    owners: ['alice'],
    steps: [
      { at: 1, op: 'mint', owner: 'alice', amount: 100n },
      { at: 1, op: 'decay' },
      { at: 5, op: 'decay' },
      { at: 10, op: 'decay' },
    ],
  },
  {
    // The staleness boundary, at exactly `height − lastActivity === threshold`.
    // The single height where a `>` and a `>=` comparison disagree, so this is
    // what pins which one the ledger uses.
    name: 'staleness-boundary-exactly-at-threshold',
    cfg: FAST,
    owners: ['alice'],
    steps: [
      { at: 1, op: 'mint', owner: 'alice', amount: 100n },
      { at: 11, op: 'decay' },
      { at: 12, op: 'decay' },
    ],
  },
  {
    // An activity height of 0 at exactly the threshold height. Unreachable for
    // a box today (every producer clamps to ≥ 1), but it is the value a
    // never-active identity's clock reads, so the guard has to hold there.
    name: 'zero-activity-height-at-threshold',
    cfg: FAST,
    owners: ['alice'],
    steps: [
      { at: 0, op: 'seed', owner: 'alice', amount: 100n, tag: 'origin' },
      { at: 10, op: 'decay' },
      { at: 11, op: 'decay' },
    ],
  },
  {
    // Decay twice, then a third time. The **only** path that exercises the
    // `max(lastActivityBlock, lastDecayBlock)` fallback: after the first firing
    // the owner's one karma box is the decay-burn box, whose height is exactly
    // `lastDecayBlock`, and reading `lastActivityBlock` alone would charge from
    // the original activity and over-burn.
    name: 'decay-twice-then-thrice',
    cfg: FAST,
    owners: ['alice'],
    steps: [
      { at: 1, op: 'mint', owner: 'alice', amount: 100n },
      { at: 20, op: 'decay' },
      { at: 26, op: 'decay' },
      { at: 32, op: 'decay' },
    ],
  },
  {
    // Activity after a decay resets the clock, and the next decay charges from
    // the activity rather than from the older decay.
    name: 'activity-resets-clock-after-decay',
    cfg: FAST,
    owners: ['alice'],
    steps: [
      { at: 1, op: 'mint', owner: 'alice', amount: 100n },
      { at: 20, op: 'decay' },
      { at: 22, op: 'mint', owner: 'alice', amount: 10n },
      { at: 30, op: 'decay' },
      { at: 40, op: 'decay' },
    ],
  },
  {
    // The intra-block adjacency phase C's report §6.6 established is reachable:
    // block application runs `applyKarmaDecay` before `processVouchCooldowns`,
    // so a vouch settlement can mint karma for an owner decay just fired for,
    // **at the same height**. Under the swap that mint writes
    // `lastActivityBlock` to the same height decay wrote `lastDecayBlock`; under
    // the old code it created a non-decay karma box at that height. Both must
    // reset staleness identically.
    name: 'decay-then-mint-same-block',
    cfg: FAST,
    owners: ['alice'],
    steps: [
      { at: 1, op: 'mint', owner: 'alice', amount: 100n },
      { at: 20, op: 'decay' },
      { at: 20, op: 'mint', owner: 'alice', amount: 10n },
      { at: 25, op: 'decay' },
      { at: 35, op: 'decay' },
    ],
  },
  {
    // The burn is capped so the balance never crosses the minimum, and a
    // subsequent firing at the floor produces no event at all.
    name: 'burn-capped-at-minimum-floor',
    cfg: FAST,
    owners: ['alice'],
    steps: [
      { at: 1, op: 'mint', owner: 'alice', amount: 12n },
      { at: 20, op: 'decay' },
      { at: 40, op: 'decay' },
    ],
  },
  {
    // Already below the floor: stale, owed periods, and still no burn.
    name: 'below-minimum-never-burns',
    cfg: FAST,
    owners: ['alice'],
    steps: [
      { at: 1, op: 'mint', owner: 'alice', amount: 8n },
      { at: 20, op: 'decay' },
      { at: 40, op: 'decay' },
    ],
  },
  {
    // Two owners on independent clocks, interleaved in one timeline: one goes
    // stale while the other is still active, then both decay from different
    // origins in the same block.
    name: 'two-owners-independent-clocks',
    cfg: FAST,
    owners: ['alice', 'bob'],
    steps: [
      { at: 1, op: 'mint', owner: 'alice', amount: 100n },
      { at: 1, op: 'mint', owner: 'bob', amount: 100n },
      { at: 15, op: 'mint', owner: 'bob', amount: 5n },
      { at: 20, op: 'decay' },
      { at: 30, op: 'decay' },
    ],
  },
  {
    // One timeline at capture-time production constants (see PROD), so the
    // fixtures are not entirely a compressed-config artifact.
    name: 'production-constants',
    cfg: PROD,
    owners: ['alice'],
    steps: [
      { at: 1, op: 'mint', owner: 'alice', amount: 1000n },
      { at: 20161, op: 'decay' },
      { at: 20881, op: 'decay' },
      { at: 22321, op: 'decay' },
    ],
  },
];

export const DIVERGENT_SCENARIOS: Scenario[] = [
  {
    // Two non-decay karma boxes at different heights for one owner.
    //
    // Reachable: `claimInvite` mints a KarmaBox to the invitee (its inputs are
    // the InviteBox and the BondBox, not the invitee's karma), and `faucetGrant`
    // mints a second one to the same identity (its input is the *system* karma
    // box). Neither spends what the recipient already holds, so both survive.
    //
    // The old clock reads the **oldest** non-decay box; the record reads the
    // **newest** activity. Spec G §7 names this as the blocker this unit
    // removes, so the difference is intended — but it is a behavioural
    // difference, so it is captured rather than assumed away.
    name: 'two-non-decay-boxes-at-different-heights',
    cfg: FAST,
    owners: ['alice'],
    steps: [
      { at: 1, op: 'seed', owner: 'alice', amount: 50n, tag: 'invite-claim' },
      { at: 10, op: 'seed', owner: 'alice', amount: 50n, tag: 'faucet' },
      { at: 30, op: 'decay' },
    ],
  },
];
