import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRouter, type MiningDeps } from '../../src/routes/mining.js';
import type { OrderingBlock } from '@dagsocial/types';

function makeDeps(overrides: Partial<MiningDeps> = {}): MiningDeps {
  return {
    getCurrentTemplate: () => null,
    submitMinedBlock: () => null,
    setMinerPubkey: () => {},
    miningSecret: '',
    ...overrides,
  };
}

function makeApp(deps: MiningDeps): express.Express {
  return express().use(express.json()).use(createRouter(deps));
}

describe('mining routes', () => {
  describe('auth', () => {
    it('returns 200 from /template when no secret is configured', async () => {
      const app = express().use(createRouter(makeDeps()));
      const res = await request(app).get('/template');
      expect(res.status).toBe(404); // no template, not 401
    });

    it('returns 401 from /template when secret is set and no header sent', async () => {
      const app = express().use(createRouter(makeDeps({ miningSecret: 'sekret' })));
      const res = await request(app).get('/template');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('returns 401 from /template when wrong secret is sent', async () => {
      const app = express().use(createRouter(makeDeps({ miningSecret: 'sekret' })));
      const res = await request(app)
        .get('/template')
        .set('Authorization', 'Bearer wrong');
      expect(res.status).toBe(401);
    });

    it('returns 404 from /template when correct secret is sent', async () => {
      const app = express().use(
        createRouter(makeDeps({ miningSecret: 'sekret', getCurrentTemplate: () => null })),
      );
      const res = await request(app)
        .get('/template')
        .set('Authorization', 'Bearer sekret');
      expect(res.status).toBe(404); // auth passed, no template
    });

    it('returns 401 from /submit when secret is set and no header sent', async () => {
      const app = express().use(createRouter(makeDeps({ miningSecret: 'sekret' })));
      const res = await request(app)
        .post('/submit')
        .send({ powNonce: 42, height: 1 });
      expect(res.status).toBe(401);
    });

    it('returns 201 from /submit when correct secret is sent and PoW is valid', async () => {
      const app = makeApp(
        makeDeps({
          miningSecret: 'sekret',
          submitMinedBlock: () => 'deadbeef',
        }),
      );
      const res = await request(app)
        .post('/submit')
        .set('Authorization', 'Bearer sekret')
        .send({ powNonce: 42, height: 1 });
      expect(res.status).toBe(201);
    });
  });
});
