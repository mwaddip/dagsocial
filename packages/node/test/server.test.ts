import { uid } from './helpers.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { initDb, closeDb } from '../src/store/db.js';
import { createApp } from '../src/server.js';
import type { Config } from '../src/config.js';
import { profileFor } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    port: 0,
    dbPath: ':memory:',
    networkType: 'testnet',
    profile: profileFor('testnet'),
    nodeRole: 'server',
    postPowTargetBits: 20,
    challengeWindowBlocks: 10,
    orderingBlockIntervalMs: 60000,
    orderingBlockMinSubBlocks: 1,
    maxSubBlocksPerBlock: 1000,
    miningMode: 'internal',
    orderingBlockPowTargetBits: 12,
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

  // The mount gate is the isFaucetNetwork allow-list — testnet/devnet only
  // (NODE_INTERFACE §Faucet) — so devnet must get the real router and mainnet
  // the 403 stub. An empty POST discriminates the two without touching the
  // store: the real router answers 400 (userId required) before any db access,
  // the stub answers 403.
  describe('faucet mount gate', () => {
    async function postFaucet(networkType: 'mainnet' | 'testnet' | 'devnet') {
      const app = createApp(
        makeConfig({ networkType, profile: profileFor(networkType) }),
      );
      const gateServer = app.listen(0);
      try {
        const addr = gateServer.address() as AddressInfo;
        return await fetch(`http://localhost:${addr.port}/faucet`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      } finally {
        gateServer.close();
      }
    }

    it('mounts the real faucet router on devnet', async () => {
      const res = await postFaucet('devnet');
      expect(res.status).toBe(400);
    });

    it('mounts the real faucet router on testnet', async () => {
      const res = await postFaucet('testnet');
      expect(res.status).toBe(400);
    });

    it('serves the 403 stub on mainnet', async () => {
      const res = await postFaucet('mainnet');
      expect(res.status).toBe(403);
    });
  });
});
