import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    passWithNoTests: true,
    testTimeout: 15000, // libp2p tests may need more time
  },
});
