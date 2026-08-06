import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../harness/decay-timeline.js';
import { DIVERGENT_SCENARIOS } from '../harness/decay-scenarios.js';
import type { ScenarioCapture } from '../harness/decay-timeline.js';

/**
 * Spec G phase D — the one ledger shape where the two clocks disagree.
 *
 * The equivalence gate (`decay-golden.test.ts`) covers the shape production is
 * normally in: forced karma consolidation (Spec G D9) leaves at most one karma
 * box per owner, so "oldest non-decay box" and "last activity" are the same
 * height. When an owner holds **two** non-decay karma boxes at different
 * heights, they are not:
 *
 *   - the pre-swap `owedPeriods` charges from the **oldest** non-decay box;
 *   - the identity record carries the **newest** activity.
 *
 * That shape is reachable — `claimInvite` mints a KarmaBox to the invitee
 * (inputs: the InviteBox and BondBox, not the invitee's karma) and `faucetGrant`
 * mints another to the same identity (input: the *system* karma box). Neither
 * spends what the recipient already holds.
 *
 * **This is an accepted, deliberate deviation from Spec G D10 — not an
 * incidental one.** Spec G §3.4 asserted `owedPeriods` equivalence on the
 * premise that "forced consolidation means normally one karma box (oldest ==
 * newest == last touch)". That premise is false: `applyTx` does not
 * consolidate, so any transaction that mints karma to an owner **without
 * spending that owner's existing karma** — the faucet grant (its only input is
 * the *system* karma box) and the invite claim (its inputs are the InviteBox and
 * BondBox) — leaves two non-decay karma boxes standing.
 *
 * Decay is now measured from the most recent activity rather than from the
 * oldest surviving box. That change was reviewed and accepted deliberately, and
 * §3.4's false premise is being corrected in the spec and the contract. This
 * file is the pinned record of the difference, kept out of the golden set so
 * that neither can be mistaken for the other.
 *
 * The frozen `preSwap` capture stays in the fixture as the record of what the
 * ledger used to do. This file's expectation is the one thing in phase D that
 * moved on purpose; the equivalence gate's fixtures did not move at all.
 */

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/decay-divergence.json', import.meta.url));

interface DivergenceFixture {
  capturedBefore: string;
  /** What the pre-swap, box-height clock produced. Frozen; never regenerated. */
  preSwap: Record<string, ScenarioCapture>;
}

describe('decay clock divergence on unconsolidated karma (Spec G phase D)', () => {
  it('captures the pre-swap outputs when absent (opt-in, never overwrites)', async () => {
    if (process.env['DECAY_GOLDEN_CAPTURE'] !== '1') return;
    if (existsSync(FIXTURE_PATH)) {
      throw new Error(`${FIXTURE_PATH} already exists — refusing to overwrite.`);
    }
    const preSwap: Record<string, ScenarioCapture> = {};
    for (const scenario of DIVERGENT_SCENARIOS) {
      preSwap[scenario.name] = await runScenario(scenario);
    }
    writeFileSync(
      FIXTURE_PATH,
      `${JSON.stringify(
        {
          capturedBefore:
            'Spec G phase D — captured from the pre-swap implementation, before D2/D3 edited any source file',
          preSwap,
        } satisfies DivergenceFixture,
        null,
        2,
      )}\n`,
    );
  });

  it('the record charges from the newest activity, where boxes charged from the oldest', async () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as DivergenceFixture;
    const name = 'two-non-decay-boxes-at-different-heights';
    const preSwap = fixture.preSwap[name];
    expect(preSwap, `no pre-swap capture for ${name}`).toBeDefined();

    // Timeline: karma at height 1, more karma at height 10, decay at height 30.
    // Config: threshold 10, interval 3, burn 5, floor 10.
    //
    //   pre-swap  oldest non-decay box = 1  → floor((30 − 1) / 3) = 9 → burn 45
    //   post-swap lastActivityBlock    = 10 → floor((30 − 10) / 3) = 6 → burn 30
    //
    // Staleness agrees (both read the newest activity); only the amount moves.
    expect(preSwap!.decayEvents).toEqual([
      { height: 30, owner: 'alice', burnAmount: '45', consumedCount: 2, balanceAfter: '55' },
    ]);

    const actual = await runScenario(DIVERGENT_SCENARIOS[0]!);
    expect(actual.decayEvents).toEqual([
      { height: 30, owner: 'alice', burnAmount: '30', consumedCount: 2, balanceAfter: '70' },
    ]);
    expect(actual.finalBalances).toEqual({ alice: '70' });

    // The deviation is the point of this file: if these ever compare equal
    // again, either the swap was reverted or the scenario stopped reaching the
    // unconsolidated shape, and both are things a reviewer must see.
    expect(actual).not.toEqual(preSwap);
  });

  it('the two clocks still agree on WHEN the identity goes stale', async () => {
    // Only `owedPeriods` diverges. `isIdentityStale` reads the newest activity
    // either way — the old predicate asked "is ANY non-decay box recent", which
    // is the newest one. Pinned separately so a future change that also moved
    // staleness could not hide inside the accepted amount difference.
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as DivergenceFixture;
    const preSwap = fixture.preSwap['two-non-decay-boxes-at-different-heights']!;
    const actual = await runScenario(DIVERGENT_SCENARIOS[0]!);

    expect(actual.decayEvents.map((e) => e.height)).toEqual(
      preSwap.decayEvents.map((e) => e.height),
    );
  });
});
