import {
  CHALLENGE_WINDOW_BLOCKS,
  CREDIT_TREASURY_PCT,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  AVL_KEY_LENGTH,
  profileFor,
} from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';

export interface Config {
  port: number;
  adminPort: number;
  adminBindAddress: string;
  dbPath: string;
  /**
   * The network this node is on. Class `network-identity` — the only environment
   * variable that may change a consensus parameter, and it changes every one of
   * them together by selecting `profile` (ARCHITECTURE §Network Identity).
   */
  networkType: NetworkType;
  /**
   * The parameter table `networkType` selects, resolved once at load and frozen.
   * The consensus fields below are copied from it so consumers keep one flat
   * config surface; `index.ts` reads `magic` off it for the wire layer.
   */
  profile: NetworkProfile;
  nodeRole: 'server' | 'miner';
  /** Base path where the demo UI is served (e.g., "/testnet/" or "/"). */
  publicUrl: string;
  postPowTargetBits: number;
  challengeWindowBlocks: number;
  orderingBlockIntervalMs: number;
  orderingBlockMinSubBlocks: number;
  maxSubBlocksPerBlock: number;
  /** Hard mempool bound — inserts are rejected at the cap, never evicted (audit M-8). */
  maxMempoolEntries: number;
  // Mining
  miningMode: 'internal' | 'external';
  miningSecret: string;          // bearer token for mining API, required non-empty in external mode
  orderingBlockPowTargetBits: number;
  creditTreasuryPct: number;
  treasuryPubKey: string;  // hex-encoded 32-byte key, empty = no treasury
  // Karma decay
  karmaStaleThresholdBlocks: number;
  karmaDecayIntervalBlocks: number;
  karmaDecayAmount: bigint;
  karmaMinimum: bigint;
  // AVL state root
  verifyStateRoot: boolean;
  maxProofHistory: number;
  avlKeyLength: number;
  // Net settings
  bootstrapPeers: string[];
  listenAddrs: string;
  maxPeers: number;
}

export function loadConfig(): Readonly<Config> {
  // Resolve the network profile first. `profileFor` throws on an unknown value:
  // a misconfigured node must fail at startup, loudly — it must never default
  // onto a network it was not pointed at.
  const profile = profileFor((process.env['NETWORK_TYPE'] ?? 'testnet') as NetworkType);

  const cfg: Config = {
    port: parseInt(process.env['PORT'] ?? '3000', 10),
    adminPort: parseInt(process.env['ADMIN_PORT'] ?? '3001', 10),
    adminBindAddress: process.env['ADMIN_BIND_ADDRESS'] ?? '127.0.0.1',
    dbPath: process.env['DB_PATH'] ?? 'dagsocial.db',
    networkType: profile.networkType,
    profile,
    nodeRole: parseNodeRole(process.env['NODE_ROLE'] ?? 'server'),
    publicUrl: process.env['PUBLIC_URL'] ?? '/',
    // The challenge endpoint advertises this and the verifier enforces it — both
    // read this one field, so a node can no longer claim a difficulty it does
    // not check (audit A6).
    postPowTargetBits: profile.postPowTargetBits,
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
    maxMempoolEntries: parseInt(
      process.env['MAX_MEMPOOL_ENTRIES'] ?? '10000',
      10,
    ),
    // Mining
    miningMode: parseMiningMode(process.env['MINING_MODE'] ?? 'internal'),
    miningSecret: process.env['MINING_SECRET'] ?? '',
    orderingBlockPowTargetBits: profile.orderingBlockPowTargetBits,
    creditTreasuryPct: CREDIT_TREASURY_PCT,
    treasuryPubKey: profile.treasuryPubKey,
    // Karma decay — per-network timescale from the profile, universal economics
    // from the constants (ARCHITECTURE §Network Identity: "compress time, never
    // economics"). None of these is readable from the environment.
    karmaStaleThresholdBlocks: profile.karmaStaleThresholdBlocks,
    karmaDecayIntervalBlocks: profile.karmaDecayIntervalBlocks,
    karmaDecayAmount: KARMA_DECAY_AMOUNT,
    karmaMinimum: KARMA_MINIMUM,
    // AVL state root. On by default since Spec B P3: producer and verifier now
    // agree by construction — the header carries the POST-block digest (H-6),
    // both feeds are canonically ordered (M-12), and the mutation set is
    // journal-derived (P1) — so a mismatch is genuine state divergence and
    // must reject the block. `VERIFY_STATE_ROOT=false` disables it.
    verifyStateRoot: process.env['VERIFY_STATE_ROOT'] !== 'false',
    maxProofHistory: parseInt(
      process.env['MAX_PROOF_HISTORY'] ?? '1440',
      10,
    ),
    avlKeyLength: AVL_KEY_LENGTH,
    // Net settings
    bootstrapPeers: parseBootstrapPeers(process.env['BOOTSTRAP_PEERS'] ?? ''),
    listenAddrs: process.env['LISTEN_ADDRS'] ?? '/ip4/0.0.0.0/tcp/0',
    maxPeers: parseInt(process.env['MAX_PEERS'] ?? '50', 10),
  };

  assertMiningAuthConfigured(cfg);

  return Object.freeze(cfg);
}

/**
 * Allow-list of faucet-bearing networks (NODE_INTERFACE §Faucet). Fail-closed:
 * a network added later mints nothing until someone names it here. All three
 * faucet gates — the system-box provisioning (index.ts), the /faucet mount
 * (server.ts) and the /credits/faucet handler guard (routes/utxo.ts) — call
 * this one predicate so they cannot drift.
 */
export function isFaucetNetwork(networkType: NetworkType): boolean {
  return networkType === 'testnet' || networkType === 'devnet';
}

/**
 * External mining serves the coinbase payout override (`?miner=`) over HTTP, so
 * the bearer secret is load-bearing — there is no unauthenticated mode. A miner
 * configured for external mining without a secret fails at startup rather than
 * opening the endpoints (MINING_INTERFACE invariant 8, audit M-7).
 */
function assertMiningAuthConfigured(cfg: Config): void {
  if (cfg.nodeRole !== 'miner' || cfg.miningMode !== 'external') return;
  if (cfg.miningSecret.trim().length === 0) {
    throw new Error(
      'MINING_SECRET must be set and non-empty when NODE_ROLE=miner and ' +
        'MINING_MODE=external — the mining API has no unauthenticated mode',
    );
  }
}

function parseMiningMode(raw: string): 'internal' | 'external' {
  if (raw === 'internal' || raw === 'external') return raw;
  throw new Error(`Invalid MINING_MODE "${raw}" — must be "internal" or "external"`);
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
