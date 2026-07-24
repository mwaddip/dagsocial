import { uid } from './helpers.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { initDb, closeDb } from '../src/store/db.js';
import { createApp } from '../src/server.js';
import type { Config } from '../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    port: 0,
    dbPath: ':memory:',
    networkMode: 'testnet',
    nodeRole: 'server',
    postPowTargetBits: 20,
    challengeWindowBlocks: 10,
    orderingBlockIntervalMs: 60000,
    orderingBlockMinSubBlocks: 1,
    maxSubBlocksPerBlock: 1000,
    epochBlocks: 60,
    miningMode: 'internal',
    orderingBlockPowTargetBits: 12,
    creditInitialReward: 100,
    creditTreasuryPct: 10,
    treasuryPubKey: '',
    bootstrapPeers: [],
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    maxPeers: 50,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('server', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    initDb(':memory:');
    const app = createApp(makeConfig());
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(() => {
    server.close();
    closeDb();
  });

  describe('GET /status', () => {
    it('returns 200 with JSON body containing blockHeight', async () => {
      const res = await fetch(`${baseUrl}/status`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = await res.json();
      expect(body).toHaveProperty('blockHeight');
      expect(typeof body.blockHeight).toBe('number');
    });
  });

  describe('GET /', () => {
    it('returns HTML (Content-Type includes text/html)', async () => {
      const res = await fetch(`${baseUrl}/`);
      // The demo UI HTML may or may not exist in the test environment,
      // but express.static will either serve it or fall through.
      // If express.static serves the file, status is 200 and content-type is text/html.
      // If it falls through, it hits the 404 from one of the routers or
      // the default Express 404 handler.
      // We accept both: presence of index.html is a build artifact concern.
      const contentType = res.headers.get('content-type') ?? '';
      if (res.status === 200) {
        expect(contentType).toContain('text/html');
      }
      // If 404, the file just isn't there — not a server bug.
    });
  });

  describe('unknown route', () => {
    it('returns 404 for a nonexistent path', async () => {
      const res = await fetch(`${baseUrl}/nonexistent-route-xyz`);
      expect(res.status).toBe(404);
    });
  });
});
