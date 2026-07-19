import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { initDb, closeDb } from '../../src/store/db.js';
import { slotsRouter } from '../../src/routes/slots.js';
import { solvePoW } from '../../src/services/pow.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-slots-int.sqlite';

async function fetchJson(path: string, method: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/slots', slotsRouter);
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const r = http.request({
        hostname: 'localhost', port: addr.port, path: '/slots' + path, method,
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          server.close();
          try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(d) }); }
          catch { resolve({ status: res.statusCode ?? 0, data: d }); }
        });
      });
      if (body) r.write(JSON.stringify(body));
      r.end();
    });
  });
}

describe('slot routes', () => {
  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch {}
    initDb(TEST_DB);
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('full slot flow: request -> solve -> claim -> token', async () => {
    const userId = 'test-user-slots';
    const reqRes = await fetchJson('/request', 'POST', { userId });
    expect(reqRes.status).toBe(200);
    const { challenge, targetBits } = reqRes.data as { challenge: string; targetBits: number };
    const nonce = solvePoW(challenge, targetBits);
    const claimRes = await fetchJson('/claim', 'POST', { userId, challenge, nonce });
    expect(claimRes.status).toBe(200);
    expect(((claimRes.data as { token: Record<string, unknown> }).token).userId).toBe(userId);
  });

  it('invalid nonce returns 400', async () => {
    const userId = 'bad-nonce';
    const reqRes = await fetchJson('/request', 'POST', { userId });
    const { challenge } = reqRes.data as { challenge: string };
    const bad = await fetchJson('/claim', 'POST', { userId, challenge, nonce: 0 });
    expect(bad.status).toBe(400);
  });
});
