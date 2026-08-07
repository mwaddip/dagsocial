import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      globals: true,
      passWithNoTests: true,
      testTimeout: 15000, // libp2p tests may need more time
    },
  }),
);
