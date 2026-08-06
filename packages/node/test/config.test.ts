import { describe, it, expect, beforeEach } from 'vitest';
import {
  NETWORK_PROFILES,
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  MAGIC_DEVNET,
} from '@dagsocial/types';

const TEST_KEYS = [
  'PORT',
  'DB_PATH',
  'CHALLENGE_WINDOW_BLOCKS',
  'ORDERING_BLOCK_INTERVAL_MS',
  'ORDERING_BLOCK_MIN_SUB_BLOCKS',
  'MAX_SUB_BLOCKS_PER_BLOCK',
  'MAX_MEMPOOL_ENTRIES',
  'EPOCH_BLOCKS',
  'NETWORK_TYPE',
  'MINING_SECRET',
  'MINING_MODE',
  'NODE_ROLE',
  // Dead since P2-A phase 2b — consensus values are selected by NETWORK_TYPE,
  // never set individually. Section 7 sets these to prove they are ignored.
  'POST_POW_TARGET_BITS',
  'ORDERING_BLOCK_POW_TARGET_BITS',
  'KARMA_DECAY_INTERVAL_BLOCKS',
  'KARMA_STALE_THRESHOLD_BLOCKS',
  'KARMA_DECAY_AMOUNT',
  'KARMA_MINIMUM',
  'CREDIT_TREASURY_PCT',
  'CREDIT_INITIAL_REWARD',
  'TREASURY_PUBKEY',
  'AVL_KEY_LENGTH',
];

function clearTestEnv() {
  for (const key of TEST_KEYS) {
    delete process.env[key];
  }
}

describe('config', () => {
  beforeEach(() => {
    vi.resetModules();
    clearTestEnv();
  });

  describe('1. defaults', () => {
    it('returns defaults when no env vars are set', async () => {
      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.port).toBe(3000);
      expect(cfg.dbPath).toBe('dagsocial.db');
      expect(cfg.postPowTargetBits).toBe(20);
      expect(cfg.challengeWindowBlocks).toBe(10);
      expect(cfg.orderingBlockIntervalMs).toBe(60000);
      expect(cfg.orderingBlockMinSubBlocks).toBe(1);
      expect(cfg.maxSubBlocksPerBlock).toBe(1000);
      expect(cfg.epochBlocks).toBe(60);
      expect(cfg.maxMempoolEntries).toBe(10000);
      expect(cfg.networkType).toBe('testnet');
      // toEqual, not toBe: vi.resetModules() gives the dynamically imported
      // config a fresh @dagsocial/types instance, so table identity does not
      // hold across the boundary — structural equality is the assertion.
      expect(cfg.profile).toEqual(NETWORK_PROFILES.testnet);
      expect(cfg.miningSecret).toBe('');
    });
  });

  describe('2. env overrides (operational and local vars only)', () => {
    it('reads overrides from env vars', async () => {
      process.env['PORT'] = '8080';
      process.env['DB_PATH'] = '/tmp/test.db';
      process.env['CHALLENGE_WINDOW_BLOCKS'] = '5';
      process.env['ORDERING_BLOCK_INTERVAL_MS'] = '30000';
      process.env['ORDERING_BLOCK_MIN_SUB_BLOCKS'] = '3';
      process.env['MAX_SUB_BLOCKS_PER_BLOCK'] = '500';
      process.env['EPOCH_BLOCKS'] = '120';
      process.env['MAX_MEMPOOL_ENTRIES'] = '25';
      process.env['NETWORK_TYPE'] = 'mainnet';
      process.env['MINING_SECRET'] = 'sekret';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.port).toBe(8080);
      expect(cfg.dbPath).toBe('/tmp/test.db');
      expect(cfg.challengeWindowBlocks).toBe(5);
      expect(cfg.orderingBlockIntervalMs).toBe(30000);
      expect(cfg.orderingBlockMinSubBlocks).toBe(3);
      expect(cfg.maxSubBlocksPerBlock).toBe(500);
      expect(cfg.epochBlocks).toBe(120);
      expect(cfg.maxMempoolEntries).toBe(25);
      expect(cfg.networkType).toBe('mainnet');
      expect(cfg.miningSecret).toBe('sekret');
    });
  });

  describe('3. numeric parsing', () => {
    it('parses numeric strings correctly', async () => {
      process.env['PORT'] = '3001';
      process.env['ORDERING_BLOCK_INTERVAL_MS'] = '120000';
      process.env['MAX_SUB_BLOCKS_PER_BLOCK'] = '2000';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(typeof cfg.port).toBe('number');
      expect(cfg.port).toBe(3001);
      expect(cfg.orderingBlockIntervalMs).toBe(120000);
      expect(cfg.maxSubBlocksPerBlock).toBe(2000);
    });
  });

  describe('4. port is integer', () => {
    it('port is an integer', async () => {
      process.env['PORT'] = '3000';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(Number.isInteger(cfg.port)).toBe(true);
    });
  });

  // Each throwing case below has a control differing only in the guarded field.
  describe('5. mining auth fail-fast (audit M-7)', () => {
    it('throws when an external-mode miner has no MINING_SECRET', async () => {
      // Import under a safe env so module-level `config` builds, then flip.
      const { loadConfig } = await import('../src/config.js');

      process.env['NODE_ROLE'] = 'miner';
      process.env['MINING_MODE'] = 'external';
      delete process.env['MINING_SECRET'];

      expect(() => loadConfig()).toThrow(/MINING_SECRET/);
    });

    it('throws when MINING_SECRET is whitespace only', async () => {
      const { loadConfig } = await import('../src/config.js');

      process.env['NODE_ROLE'] = 'miner';
      process.env['MINING_MODE'] = 'external';
      process.env['MINING_SECRET'] = '   ';

      expect(() => loadConfig()).toThrow(/MINING_SECRET/);
    });

    it('fails at startup: importing config with that env rejects', async () => {
      process.env['NODE_ROLE'] = 'miner';
      process.env['MINING_MODE'] = 'external';
      delete process.env['MINING_SECRET'];

      await expect(import('../src/config.js')).rejects.toThrow(/MINING_SECRET/);
    });

    it('control: same env with a secret loads', async () => {
      process.env['NODE_ROLE'] = 'miner';
      process.env['MINING_MODE'] = 'external';
      process.env['MINING_SECRET'] = 'sekret';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.miningMode).toBe('external');
      expect(cfg.miningSecret).toBe('sekret');
    });

    it('control: internal-mode miner loads without a secret', async () => {
      process.env['NODE_ROLE'] = 'miner';
      process.env['MINING_MODE'] = 'internal';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.miningMode).toBe('internal');
      expect(cfg.miningSecret).toBe('');
    });

    it('control: server role in external mode loads without a secret', async () => {
      process.env['NODE_ROLE'] = 'server';
      process.env['MINING_MODE'] = 'external';

      const { loadConfig } = await import('../src/config.js');

      expect(() => loadConfig()).not.toThrow();
    });
  });

  // NETWORK_TYPE selects the whole consensus parameter table at once
  // (ARCHITECTURE §Network Identity). Two operators who agree on it cannot
  // differ on anything it selects; one who sets an unknown value gets a dead
  // node, not a default network.
  describe('6. network profile selection (P2-A)', () => {
    it('resolves the testnet profile by default', async () => {
      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.networkType).toBe('testnet');
      expect(cfg.profile).toEqual(NETWORK_PROFILES.testnet);
      expect(cfg.profile.magic).toBe(MAGIC_TESTNET);
    });

    it('NETWORK_TYPE=devnet resolves the devnet profile and copies its values', async () => {
      process.env['NETWORK_TYPE'] = 'devnet';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.networkType).toBe('devnet');
      expect(cfg.profile).toEqual(NETWORK_PROFILES.devnet);
      expect(cfg.profile.magic).toBe(MAGIC_DEVNET);
      // The flat consensus fields are copies OF the profile, not parallel
      // reads: each must equal the devnet table entry, not testnet's.
      expect(cfg.postPowTargetBits).toBe(4);
      expect(cfg.orderingBlockPowTargetBits).toBe(4);
      expect(cfg.karmaDecayIntervalBlocks).toBe(3);
      expect(cfg.karmaStaleThresholdBlocks).toBe(500);
    });

    it('NETWORK_TYPE=mainnet resolves the mainnet profile', async () => {
      process.env['NETWORK_TYPE'] = 'mainnet';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.networkType).toBe('mainnet');
      expect(cfg.profile).toEqual(NETWORK_PROFILES.mainnet);
      expect(cfg.profile.magic).toBe(MAGIC_MAINNET);
    });

    it('throws for an unrecognised NETWORK_TYPE — never falls back', async () => {
      // Import under a safe env so module-level `config` builds, then flip.
      const { loadConfig } = await import('../src/config.js');

      process.env['NETWORK_TYPE'] = 'regtest';

      expect(() => loadConfig()).toThrow(/Unknown network type/);
    });

    it('fails at startup: importing config with a bad NETWORK_TYPE rejects', async () => {
      process.env['NETWORK_TYPE'] = 'regtest';

      await expect(import('../src/config.js')).rejects.toThrow(/Unknown network type/);
    });

    it('control: importing config with a known NETWORK_TYPE resolves', async () => {
      process.env['NETWORK_TYPE'] = 'devnet';

      const { config } = await import('../src/config.js');

      expect(config.networkType).toBe('devnet');
    });
  });

  // The nine variables below were readable per-process until P2-A phase 2b
  // (NODE_INTERFACE §Configuration, the `⚠ VIOLATED` rows, plus the
  // `advertised` POST_POW_TARGET_BITS). Setting them must change nothing:
  // values come from the profile or the universal constants only. Expected
  // values are baked literals, phase-2a style — a silent constant change
  // fails here too.
  describe('7. consensus env reads are dead (P2-A)', () => {
    it('ignores every formerly-readable consensus variable', async () => {
      process.env['NETWORK_TYPE'] = 'testnet';
      process.env['POST_POW_TARGET_BITS'] = '1';
      process.env['ORDERING_BLOCK_POW_TARGET_BITS'] = '1';
      process.env['KARMA_DECAY_INTERVAL_BLOCKS'] = '1';
      process.env['KARMA_STALE_THRESHOLD_BLOCKS'] = '1';
      process.env['KARMA_DECAY_AMOUNT'] = '999';
      process.env['KARMA_MINIMUM'] = '999';
      process.env['CREDIT_TREASURY_PCT'] = '99';
      process.env['CREDIT_INITIAL_REWARD'] = '1';
      process.env['TREASURY_PUBKEY'] = 'ff'.repeat(32);
      process.env['AVL_KEY_LENGTH'] = '16';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.postPowTargetBits).toBe(20);
      expect(cfg.orderingBlockPowTargetBits).toBe(12);
      expect(cfg.karmaDecayIntervalBlocks).toBe(1440);
      expect(cfg.karmaStaleThresholdBlocks).toBe(40320);
      expect(cfg.karmaDecayAmount).toBe(5n);
      expect(cfg.karmaMinimum).toBe(10n);
      expect(cfg.creditTreasuryPct).toBe(10);
      expect(cfg.creditInitialReward).toBe(10_000_000_000n);
      expect(cfg.treasuryPubKey).toBe('');
      expect(cfg.avlKeyLength).toBe(32);
    });
  });
});
