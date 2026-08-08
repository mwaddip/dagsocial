import { defineConfig, configDefaults, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      globals: true,
      // Rebuilds dist/ before the run when the e2e suite is included — e2e
      // spawns dist/index.js as a child process, which the vitest alias does
      // not reach. Gated off while `test/e2e/**` sits in the exclude list
      // below; see test/global-setup.ts.
      globalSetup: ['./test/global-setup.ts'],
      // PARKED 2026-08-06 — see test/e2e/README.md. The e2e suite drives
      // likes-as-boxes and epoch tallying, both of which Phase 2 unit P2-D
      // deletes, and it compresses consensus timescales through env overrides
      // that P2-A removes. It is rewritten against the post-P2-D protocol on
      // the network-profile mechanism, not repaired in place.
      exclude: [...configDefaults.exclude, 'test/e2e/**'],
      // Block-application suites mine real PoW solutions (the powTargetBits
      // schedule is enforced at apply, so fixtures cannot fake it) and are
      // compute-bound by design. Under a full-repo parallel run the 5s
      // default flakes on whichever heavy test lands on a contended core —
      // observed on journal-roundtrip and like-settlement — so the ceiling
      // reflects the workload instead of per-test annotations chasing it.
      testTimeout: 60_000,
      env: {
        POW_SLOT_TARGET_BITS: '4',
      },
    },
  }),
);
