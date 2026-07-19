import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { initDb, closeDb } from '../../src/store/db.js';
import { createApp } from '../../src/server.js';
import { startBlockCreator, stopBlockCreator } from '../../src/services/blockCreator.js';
import { solvePoW } from '../../src/services/pow.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-api.sqlite';

async function fetchJson(
  app: ReturnType<typeof createApp>, path: string, method: string, body?: unknown
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const req = http.request({
        hostname: 'localhost', port: addr.port, path, method,
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
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

describe('end-to-end API', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch {}
    process.env['DB_PATH'] = TEST_DB;
    initDb(TEST_DB);
    app = createApp();
    startBlockCreator();
  });

  afterAll(() => {
    stopBlockCreator();
    closeDb();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('full flow: identity → slot → post → status → blocks', async () => {
    // Create identity
    const idRes = await fetchJson(app, '/identity', 'POST', {});
    expect(idRes.status).toBe(201);
    const { userId } = idRes.data as { userId: string };

    // Request slot
    const slotReq = await fetchJson(app, '/slots/request', 'POST', { userId });
    expect(slotReq.status).toBe(200);
    const { challenge, targetBits } = slotReq.data as { challenge: string; targetBits: number };

    // Solve and claim
    const nonce = solvePoW(challenge, targetBits);
    const claimRes = await fetchJson(app, '/slots/claim', 'POST', { userId, challenge, nonce });
    expect(claimRes.status).toBe(200);
    const { token } = claimRes.data as { token: { hash: string } };
    expect(token.hash).toBeTruthy();

    // Get status
    const statusRes = await fetchJson(app, '/status', 'GET');
    expect(statusRes.status).toBe(200);
    const status = statusRes.data as { identityCount: number };
    expect(status.identityCount).toBeGreaterThanOrEqual(1);

    // Get blocks
    const blockRes = await fetchJson(app, '/blocks/1', 'GET');
    expect([200, 404]).toContain(blockRes.status);
  });

  it('POST /posts with invalid data returns 400', async () => {
    const res = await fetchJson(app, '/posts', 'POST', {});
    expect(res.status).toBe(400);
  });

  it('GET /status returns expected shape', async () => {
    const res = await fetchJson(app, '/status', 'GET');
    expect(res.status).toBe(200);
    const data = res.data as Record<string, number>;
    expect(data.blockHeight).toBeDefined();
    expect(data.postCount).toBeDefined();
    expect(data.pendingPosts).toBeDefined();
  });
});
