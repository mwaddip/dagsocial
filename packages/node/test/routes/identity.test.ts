import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { initDb, closeDb } from '../../src/store/db.js';
import { insertIdentity, getIdentity } from '../../src/store/identities.js';
import { createRouter } from '../../src/routes/identity.js';
import { generateKeyPair } from '@dagsocial/types';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-routes-identity.sqlite';

async function request(
  path: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    const router = createRouter({ insertIdentity, getIdentity, bootstrapKarma: () => {} });
    app.use('/identity', router);
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const r = http.request(
        {
          hostname: 'localhost',
          port: addr.port,
          path: '/identity' + path,
          method,
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode ?? 0, data: JSON.parse(d) });
            } catch {
              resolve({ status: res.statusCode ?? 0, data: d });
            }
          });
        },
      );
      if (body !== undefined) r.write(JSON.stringify(body));
      r.end();
    });
  });
}

describe('identity routes', () => {
  beforeAll(() => {
    try {
      unlinkSync(TEST_DB);
    } catch {
      /* ignore */
    }
    initDb(TEST_DB);
  });

  afterAll(() => {
    closeDb();
    try {
      unlinkSync(TEST_DB);
    } catch {
      /* ignore */
    }
  });

  it('POST /identity creates identity and returns 201 with userId, publicKey, secretKey', async () => {
    const res = await request('/', 'POST', {});
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(typeof body.userId).toBe('string');
    expect(typeof body.publicKey).toBe('string');
    expect(typeof body.secretKey).toBe('string');
    expect((body.publicKey as string).length).toBe(64); // 32 bytes hex
  });

  it('POST /identity/import with valid key returns 201', async () => {
    // Generate a fresh key pair (not yet in the DB)
    const kp = generateKeyPair();
    const publicKey = Buffer.from(kp.publicKey).toString('hex');

    const res = await request('/import', 'POST', { publicKey });
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(typeof body.userId).toBe('string');
    expect(body.publicKey).toBe(publicKey);
  });

  it('POST /identity/import with invalid hex returns 400', async () => {
    const res = await request('/import', 'POST', { publicKey: 'not-hex!!' });
    expect(res.status).toBe(400);
  });

  it('POST /identity/import of existing identity returns 200', async () => {
    // Generate a fresh key pair and import it once
    const kp = generateKeyPair();
    const publicKey = Buffer.from(kp.publicKey).toString('hex');

    // First import (201)
    const first = await request('/import', 'POST', { publicKey });
    expect(first.status).toBe(201);

    // Second import of same key (200 - already exists)
    const second = await request('/import', 'POST', { publicKey });
    expect(second.status).toBe(200);
  });

  it('GET /identity/:userId returns identity data', async () => {
    const created = await request('/', 'POST', {});
    const { userId } = created.data as { userId: string };

    const res = await request(`/${userId}`, 'GET');
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.userId).toBe(userId);
    expect(typeof body.publicKey).toBe('string');
    expect(typeof body.createdAt).toBe('number');
  });

  it('GET /identity/:userId returns 404 for unknown', async () => {
    const res = await request('/nonexistent-id', 'GET');
    expect(res.status).toBe(404);
  });
});
