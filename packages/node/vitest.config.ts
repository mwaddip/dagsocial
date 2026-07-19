import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    env: {
      POW_SLOT_TARGET_BITS: '4',
    },
  },
});
