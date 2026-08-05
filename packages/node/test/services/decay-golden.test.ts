import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../harness/decay-timeline.js';
import { EQUIVALENT_SCENARIOS } from '../harness/decay-scenarios.js';
import type { ScenarioCapture } from '../harness/decay-timeline.js';

/**
 * Spec G phase D — the decay equivalence gate.
 *
 * Spec G D10: moving the decay clock from box `createdAtBlock` onto the
 * committed `IdentityRecord` is a **representation swap and must be
 * behaviour-identical**. The same owners decay, at the same heights, by the
 * same amounts. Any difference is a bug in this phase, not a design
 * improvement, however sensible it looks.
 *
 * These fixtures were captured from the **pre-swap** implementation, before any
 * phase-D source edit. That ordering is the whole point: captured afterwards
 * they would encode the new behaviour as correct and check nothing at all.
 *
 * The timelines run against production code — the real store, the real block
 * journal, the real `mintKarma`, the real `applyKarmaDecay`. See
 * `test/harness/decay-timeline.ts` for why a fake store would have made this
 * vacuous.
 *
 * **Do not regenerate this fixture.** The capture path below refuses to
 * overwrite an existing file for exactly that reason; making it write again
 * takes a deliberate `rm`, which is a thing a reviewer can see in a diff.
 */

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/decay-golden.json', import.meta.url));

interface GoldenFixture {
  capturedBefore: string;
  equivalent: Record<string, ScenarioCapture>;
}

async function captureAll(): Promise<Record<string, ScenarioCapture>> {
  const out: Record<string, ScenarioCapture> = {};
  for (const scenario of EQUIVALENT_SCENARIOS) {
    out[scenario.name] = await runScenario(scenario);
  }
  return out;
}

describe('decay golden-output equivalence (Spec G phase D)', () => {
  // First in the file so a capture run writes before the assertions read.
  it('captures the fixture when it is absent (opt-in, never overwrites)', async () => {
    if (process.env['DECAY_GOLDEN_CAPTURE'] !== '1') return;
    if (existsSync(FIXTURE_PATH)) {
      throw new Error(
        `${FIXTURE_PATH} already exists — refusing to overwrite a captured golden.`,
      );
    }
    const fixture: GoldenFixture = {
      capturedBefore:
        'Spec G phase D — captured from the pre-swap implementation, before D2/D3 edited any source file',
      equivalent: await captureAll(),
    };
    writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  });

  it('the fixture exists and predates every phase-D source edit', () => {
    // Capture path: only ever runs against a missing file, and only when asked.
    // A golden fixture regenerated after the change under test is worse than no
    // fixture, because it looks like evidence.
    if (!existsSync(FIXTURE_PATH)) {
      if (process.env['DECAY_GOLDEN_CAPTURE'] !== '1') {
        throw new Error(
          `Missing ${FIXTURE_PATH}. It is captured once, from the pre-swap ` +
          `implementation. Re-running the capture after the swap would freeze ` +
          `the new behaviour as correct.`,
        );
      }
      // Written by the capture run; the assertion below is what the file is for.
      throw new Error('capture must run in the dedicated capture test');
    }
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as GoldenFixture;
    expect(fixture.capturedBefore).toBe(
      'Spec G phase D — captured from the pre-swap implementation, before D2/D3 edited any source file',
    );
    expect(Object.keys(fixture.equivalent).sort()).toEqual(
      EQUIVALENT_SCENARIOS.map((s) => s.name).sort(),
    );
  });

  for (const scenario of EQUIVALENT_SCENARIOS) {
    it(`reproduces the frozen capture: ${scenario.name}`, async () => {
      const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as GoldenFixture;
      const expected = fixture.equivalent[scenario.name];
      expect(expected, `no frozen capture for ${scenario.name}`).toBeDefined();

      const actual = await runScenario(scenario);
      expect(actual).toEqual(expected);
    });
  }

  it('a perturbed burn amount does not compare equal', async () => {
    // The failure mode this whole file exists to avoid is a golden harness that
    // passes against wrong numbers. A comparison that had gone vacuous — an
    // empty event list, a `toEqual` against `undefined`, a capture that stopped
    // recording burns — would pass every assertion above. This one would not.
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as GoldenFixture;
    const name = 'decay-twice-then-thrice';
    const frozen = fixture.equivalent[name]!;
    expect(frozen.decayEvents.length).toBeGreaterThan(0);

    const perturbed: ScenarioCapture = {
      ...frozen,
      decayEvents: frozen.decayEvents.map((e, i) =>
        i === 0 ? { ...e, burnAmount: (BigInt(e.burnAmount) + 1n).toString() } : e,
      ),
    };

    const actual = await runScenario(EQUIVALENT_SCENARIOS.find((s) => s.name === name)!);
    expect(actual).toEqual(frozen);
    expect(actual).not.toEqual(perturbed);
  });
});
