import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Rebuilds dist/ before any test file runs — the e2e suites spawn
    // dist/index.js and would otherwise test a stale binary.
    globalSetup: ['./test/global-setup.ts'],
    env: {
      POW_SLOT_TARGET_BITS: '4',
    },
  },
});
