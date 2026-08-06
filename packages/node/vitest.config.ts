import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Rebuilds dist/ before any test file runs — the e2e suites spawn
    // dist/index.js and would otherwise test a stale binary.
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
});
