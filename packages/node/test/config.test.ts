import { describe, it, expect, beforeEach } from 'vitest';

const TEST_KEYS = [
  'PORT',
  'DB_PATH',
  'POST_POW_TARGET_BITS',
  'CHALLENGE_WINDOW_BLOCKS',
  'ORDERING_BLOCK_INTERVAL_MS',
  'ORDERING_BLOCK_MIN_SUB_BLOCKS',
  'MAX_SUB_BLOCKS_PER_BLOCK',
  'MAX_MEMPOOL_ENTRIES',
  'EPOCH_BLOCKS',
  'NETWORK_MODE',
  'MINING_SECRET',
  'MINING_MODE',
  'NODE_ROLE',
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
      expect(cfg.networkMode).toBe('testnet');
      expect(cfg.miningSecret).toBe('');
    });
  });

  describe('2. env overrides', () => {
    it('reads overrides from env vars', async () => {
      process.env['PORT'] = '8080';
      process.env['DB_PATH'] = '/tmp/test.db';
      process.env['POST_POW_TARGET_BITS'] = '24';
      process.env['CHALLENGE_WINDOW_BLOCKS'] = '5';
      process.env['ORDERING_BLOCK_INTERVAL_MS'] = '30000';
      process.env['ORDERING_BLOCK_MIN_SUB_BLOCKS'] = '3';
      process.env['MAX_SUB_BLOCKS_PER_BLOCK'] = '500';
      process.env['EPOCH_BLOCKS'] = '120';
      process.env['MAX_MEMPOOL_ENTRIES'] = '25';
      process.env['NETWORK_MODE'] = 'mainnet';
      process.env['MINING_SECRET'] = 'sekret';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.port).toBe(8080);
      expect(cfg.dbPath).toBe('/tmp/test.db');
      expect(cfg.postPowTargetBits).toBe(24);
      expect(cfg.challengeWindowBlocks).toBe(5);
      expect(cfg.orderingBlockIntervalMs).toBe(30000);
      expect(cfg.orderingBlockMinSubBlocks).toBe(3);
      expect(cfg.maxSubBlocksPerBlock).toBe(500);
      expect(cfg.epochBlocks).toBe(120);
      expect(cfg.maxMempoolEntries).toBe(25);
      expect(cfg.networkMode).toBe('mainnet');
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
});
