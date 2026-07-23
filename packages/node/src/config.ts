import {
  POST_POW_TARGET_BITS,
  CHALLENGE_WINDOW_BLOCKS,
  EPOCH_BLOCKS,
} from '@dagsocial/types';

export interface Config {
  port: number;
  dbPath: string;
  networkMode: string;
  nodeRole: 'server' | 'miner';
  postPowTargetBits: number;
  challengeWindowBlocks: number;
  orderingBlockIntervalMs: number;
  orderingBlockMinSubBlocks: number;
  maxSubBlocksPerBlock: number;
  epochBlocks: number;
  // Net settings
  bootstrapPeers: string[];
  listenAddrs: string;
  maxPeers: number;
}

export function loadConfig(): Readonly<Config> {
  const cfg: Config = {
    port: parseInt(process.env['PORT'] ?? '3000', 10),
    dbPath: process.env['DB_PATH'] ?? 'dagsocial.db',
    networkMode: process.env['NETWORK_MODE'] ?? 'testnet',
    nodeRole: parseNodeRole(process.env['NODE_ROLE'] ?? 'server'),
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
    // Net settings
    bootstrapPeers: parseBootstrapPeers(process.env['BOOTSTRAP_PEERS'] ?? ''),
    listenAddrs: process.env['LISTEN_ADDRS'] ?? '/ip4/0.0.0.0/tcp/0',
    maxPeers: parseInt(process.env['MAX_PEERS'] ?? '50', 10),
  };

  return Object.freeze(cfg);
}

function parseBootstrapPeers(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseNodeRole(raw: string): 'server' | 'miner' {
  if (raw === 'server' || raw === 'miner') return raw;
  throw new Error(`Invalid NODE_ROLE "${raw}" — must be "server" or "miner"`);
}

export const config = loadConfig();
