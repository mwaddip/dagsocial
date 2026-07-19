export const config = {
  pow: {
    slotTargetBits: parseInt(process.env['POW_SLOT_TARGET_BITS'] ?? '20', 10),
    submitTargetBits: parseInt(process.env['POW_SUBMIT_TARGET_BITS'] ?? '8', 10),
    slotWindowBlocks: parseInt(process.env['POW_SLOT_WINDOW_BLOCKS'] ?? '100', 10),
  },
  block: {
    intervalMs: parseInt(process.env['BLOCK_INTERVAL_MS'] ?? '30000', 10),
    intervalPosts: parseInt(process.env['BLOCK_INTERVAL_POSTS'] ?? '1', 10),
    maxPostsPerBlock: parseInt(process.env['MAX_POSTS_PER_BLOCK'] ?? '100', 10),
  },
  db: {
    path: process.env['DB_PATH'] ?? 'dagsocial.db',
  },
  server: {
    port: parseInt(process.env['PORT'] ?? '3000', 10),
  },
} as const;
