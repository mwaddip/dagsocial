import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { initDb, closeDb } from '../../src/store/db.js';
import { insertIdentity, getIdentity } from '../../src/store/identities.js';
import { createRouter } from '../../src/routes/identity.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-identity.sqlite';

async function req(path: string, method: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/identity', createRouter({ insertIdentity, getIdentity }));
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const r = http.request({
        hostname: 'localhost', port: addr.port, path: '/identity' + path, method,
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

describe('identity routes', () => {
  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch {}
    initDb(TEST_DB);
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('POST /identity creates identity', async () => {
    const res = await req('/', 'POST', {});
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(typeof body.userId).toBe('string');
    expect(body.publicKey).toBeDefined();
  });

  it('GET /identity/:userId returns identity without secret key', async () => {
    const created = await req('/', 'POST', {});
    const { userId } = created.data as { userId: string };
    const res = await req(`/${userId}`, 'GET');
    expect(res.status).toBe(200);
    expect((res.data as Record<string, unknown>).secretKey).toBeUndefined();
  });

  it('GET /identity/:userId returns 404 for unknown', async () => {
    const res = await req('/nonexistent', 'GET');
    expect(res.status).toBe(404);
  });
});
