import {
  POST_POW_TARGET_BITS,
  CHALLENGE_WINDOW_BLOCKS,
  EPOCH_BLOCKS,
} from '@dagsocial/types';

export interface Config {
  port: number;
  dbPath: string;
  postPowTargetBits: number;
  challengeWindowBlocks: number;
  orderingBlockIntervalMs: number;
  orderingBlockMinSubBlocks: number;
  maxSubBlocksPerBlock: number;
  epochBlocks: number;
}

export function loadConfig(): Readonly<Config> {
  const cfg: Config = {
    port: parseInt(process.env['PORT'] ?? '3000', 10),
    dbPath: process.env['DB_PATH'] ?? 'dagsocial.db',
    postPowTargetBits: parseInt(
      process.env['POST_POW_TARGET_BITS'] ?? String(POST_POW_TARGET_BITS),
      10,
    ),
    challengeWindowBlocks: parseInt(
      process.env['CHALLENGE_WINDOW_BLOCKS'] ?? String(CHALLENGE_WINDOW_BLOCKS),
      10,
    ),
    orderingBlockIntervalMs: parseInt(
      process.env['ORDERING_BLOCK_INTERVAL_MS'] ?? '60000',
      10,
    ),
    orderingBlockMinSubBlocks: parseInt(
      process.env['ORDERING_BLOCK_MIN_SUB_BLOCKS'] ?? '1',
      10,
    ),
    maxSubBlocksPerBlock: parseInt(
      process.env['MAX_SUB_BLOCKS_PER_BLOCK'] ?? '1000',
      10,
    ),
    epochBlocks: parseInt(
      process.env['EPOCH_BLOCKS'] ?? String(EPOCH_BLOCKS),
      10,
    ),
  };

  return Object.freeze(cfg);
}
