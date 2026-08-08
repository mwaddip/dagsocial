import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRouter, type MiningDeps } from '../../src/routes/mining.js';
import { initDb, closeDb } from '../../src/store/db.js';
import { createApp } from '../../src/server.js';
import type { Config } from '../../src/config.js';
import type { OrderingBlock } from '@dagsocial/types';
import { profileFor } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET = 'sekret';
const MINER_HEX = 'a1'.repeat(32); // 64 hex chars — valid payout override

function makeTemplate(): OrderingBlock {
  return {
    header: {
      protocolVersion: 1,
      height: 7,
      prevBlockHash: '11'.repeat(32),
      subBlockRoot: '22'.repeat(32),
      utxoTxRoot: '33'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId: new Uint8Array(32).fill(0x44),
      powNonce: 0,
      powTargetBits: 12,
      createdAt: 1_700_000_000_000,
    },
    subBlockTree: { subBlockRefs: [], subBlockEntries: [], pruneEntries: [] },
    utxoTxTree: {
      utxoTxIds: [],
      utxoTxs: [],
      likeBoxIds: [],
      coinbaseOutputs: [
        {
          owner: new Uint8Array(32).fill(0x55),
          value: 90,
          lockedUntilBlock: 727,
          isTreasury: false,
        },
      ],
    },
    validatorSignature: new Uint8Array(64),
  };
}

function makeDeps(overrides: Partial<MiningDeps> = {}): MiningDeps {
  return {
    getCurrentTemplate: () => makeTemplate(),
    submitMinedBlock: () => 'deadbeef',
    setMinerPubkey: () => {},
    miningSecret: SECRET,
    ...overrides,
  };
}

function makeApp(deps: MiningDeps): express.Express {
  return express().use(express.json()).use(createRouter(deps));
}

// ---------------------------------------------------------------------------
// Auth (audit M-7) — every 401 case has a control differing only in the
// Authorization header.
// ---------------------------------------------------------------------------

describe('mining routes — auth', () => {
  describe('1. missing Authorization header', () => {
    it('rejects GET /template with 401', async () => {
      const res = await request(makeApp(makeDeps())).get('/template');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('control: same request with the correct bearer returns 200', async () => {
      const res = await request(makeApp(makeDeps()))
        .get('/template')
        .set('Authorization', `Bearer ${SECRET}`);
      expect(res.status).toBe(200);
      expect(res.body.header.height).toBe(7);
      expect(res.body.powPreimage).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects POST /submit with 401', async () => {
      const res = await request(makeApp(makeDeps()))
        .post('/submit')
        .send({ powNonce: 42, height: 7 });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('control: same request with the correct bearer returns 201', async () => {
      const res = await request(makeApp(makeDeps()))
        .post('/submit')
        .set('Authorization', `Bearer ${SECRET}`)
        .send({ powNonce: 42, height: 7 });
      expect(res.status).toBe(201);
      expect(res.body.blockHash).toBe('deadbeef');
    });

    it('rejects a non-bearer scheme with 401', async () => {
      const res = await request(makeApp(makeDeps()))
        .get('/template')
        .set('Authorization', SECRET);
      expect(res.status).toBe(401);
    });
  });

  describe('2. wrong secret', () => {
    it('rejects a wrong secret of the same length with 401', async () => {
      expect('WRONG!'.length).toBe(SECRET.length); // same length, different bytes
      const res = await request(makeApp(makeDeps()))
        .get('/template')
        .set('Authorization', 'Bearer WRONG!');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('rejects a shorter secret with 401 (timingSafeEqual length trap)', async () => {
      const res = await request(makeApp(makeDeps()))
        .get('/template')
        .set('Authorization', 'Bearer s');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('rejects a longer secret with 401 (timingSafeEqual length trap)', async () => {
      const res = await request(makeApp(makeDeps()))
        .get('/template')
        .set('Authorization', `Bearer ${SECRET}${SECRET}`);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('rejects an empty bearer value with 401', async () => {
      const res = await request(makeApp(makeDeps()))
        .get('/template')
        .set('Authorization', 'Bearer ');
      expect(res.status).toBe(401);
    });
  });

  describe('3. coinbase payout override is behind auth', () => {
    it('does not reach setMinerPubkey without auth', async () => {
      const setMinerPubkey = vi.fn();
      const res = await request(makeApp(makeDeps({ setMinerPubkey })))
        .get('/template')
        .query({ miner: MINER_HEX });

      expect(res.status).toBe(401);
      expect(setMinerPubkey).not.toHaveBeenCalled();
    });

    it('control: same request with the correct bearer sets the payout key', async () => {
      const setMinerPubkey = vi.fn();
      const res = await request(makeApp(makeDeps({ setMinerPubkey })))
        .get('/template')
        .query({ miner: MINER_HEX })
        .set('Authorization', `Bearer ${SECRET}`);

      expect(res.status).toBe(200);
      expect(setMinerPubkey).toHaveBeenCalledTimes(1);
      const arg = setMinerPubkey.mock.calls[0]![0] as Uint8Array;
      expect(Buffer.from(arg).toString('hex')).toBe(MINER_HEX);
    });

    it('rejects invalid miner hex with 400 once authenticated', async () => {
      const setMinerPubkey = vi.fn();
      const res = await request(makeApp(makeDeps({ setMinerPubkey })))
        .get('/template')
        .query({ miner: 'nothex' })
        .set('Authorization', `Bearer ${SECRET}`);

      expect(res.status).toBe(400);
      expect(setMinerPubkey).not.toHaveBeenCalled();
    });
  });

  describe('4. router construction', () => {
    it('refuses to build a router without a secret', () => {
      expect(() => createRouter(makeDeps({ miningSecret: '' }))).toThrow(/secret/i);
    });

    it('control: builds with a secret', () => {
      expect(() => createRouter(makeDeps())).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Mount policy (audit M-7) — internal miners expose no mining surface at all.
// An unmounted path 404s; a mounted one 401s. That is the discriminator.
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    port: 0,
    dbPath: ':memory:',
    networkType: 'testnet',
    profile: profileFor('testnet'),
    nodeRole: 'miner',
    publicUrl: '/',
    postPowTargetBits: 20,
    challengeWindowBlocks: 10,
    orderingBlockIntervalMs: 60000,
    orderingBlockMinSubBlocks: 1,
    maxSubBlocksPerBlock: 1000,
    miningMode: 'internal',
    miningSecret: '',
    orderingBlockPowTargetBits: 12,
    creditTreasuryPct: 10,
    treasuryPubKey: '',
    bootstrapPeers: [],
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    maxPeers: 50,
    ...overrides,
  } as Config;
}

describe('mining routes — mount policy', () => {
  beforeAll(() => {
    initDb(':memory:');
  });

  afterAll(() => {
    closeDb();
  });

  describe('5. internal-mode miner', () => {
    it('does not serve /mining/template (404, not 401)', async () => {
      const app = createApp(makeConfig({ miningMode: 'internal' }));
      const res = await request(app).get('/mining/template');
      expect(res.status).toBe(404);
    });

    it('does not serve it even with a bearer header (the path is absent)', async () => {
      const app = createApp(makeConfig({ miningMode: 'internal', miningSecret: SECRET }));
      const res = await request(app)
        .get('/mining/template')
        .set('Authorization', `Bearer ${SECRET}`);
      expect(res.status).toBe(404);
    });
  });

  describe('5b. external-mode miner with a secret', () => {
    it('control: serves /mining/template — 401 unauthenticated (mounted)', async () => {
      const app = createApp(makeConfig({ miningMode: 'external', miningSecret: SECRET }));
      const res = await request(app).get('/mining/template');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('passes auth with the correct bearer (404 = no template yet, not 401)', async () => {
      const app = createApp(makeConfig({ miningMode: 'external', miningSecret: SECRET }));
      const res = await request(app)
        .get('/mining/template')
        .set('Authorization', `Bearer ${SECRET}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No block template available');
    });
  });

  describe('5c. server role', () => {
    it('never serves /mining even in external mode', async () => {
      const app = createApp(
        makeConfig({ nodeRole: 'server', miningMode: 'external', miningSecret: SECRET }),
      );
      const res = await request(app).get('/mining/template');
      expect(res.status).toBe(404);
    });
  });
});
