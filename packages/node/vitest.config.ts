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
      env: {
        POW_SLOT_TARGET_BITS: '4',
      },
    },
  }),
);
