import { uid } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { initDb, closeDb } from '../../src/store/db.js';
import { createChallenge, getActiveChallenge } from '../../src/store/challenges.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import { generateChallenge } from '../../src/services/pow.js';
import {
  CHALLENGE_WINDOW_BLOCKS,
  POST_POW_TARGET_BITS,
  generateKeyPair,
} from '@dagsocial/types';
import { createRouter } from '../../src/routes/challenges.js';
import { unlinkSync } from 'fs';

function hex(u: Uint8Array): string { return Buffer.from(u).toString('hex'); }
const TEST_DB = '/tmp/dagsocial-test-routes-challenges.sqlite';

async function request(
  path: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    const router = createRouter({
      generateChallenge,
      createChallenge,
      getActiveChallenge,
      getCurrentHeight,
      challengeWindowBlocks: CHALLENGE_WINDOW_BLOCKS,
      postPowTargetBits: POST_POW_TARGET_BITS,
    });
    app.use('/challenge', router);
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const r = http.request(
        {
          hostname: 'localhost',
          port: addr.port,
          path: '/challenge' + path,
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
      if (body !== undefined) r.write(JSON.stringify(body, (_k, v) => v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v));
      r.end();
    });
  });
}

describe('challenges routes', () => {
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

  it('POST /challenge returns challenge, targetBits, and expiresAtBlock', async () => {
    // Use a fresh identity to avoid conflicts with other tests
    const kp = generateKeyPair();
    const freshUserId = kp.publicKey;

    const res = await request('/', 'POST', { userId: Buffer.from(freshUserId).toString('hex') });
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(typeof body.challenge).toBe('string');
    expect((body.challenge as string).length).toBe(64); // 32 bytes hex
    expect(body.targetBits).toBe(POST_POW_TARGET_BITS);
    expect(typeof body.expiresAtBlock).toBe('number');
  });

  it('POST /challenge replaces existing active challenge (upsert)', async () => {
    // Use a fresh identity so the first request is guaranteed to succeed
    const kp = generateKeyPair();
    const freshUserId = kp.publicKey;

    // First request succeeds (201)
    const first = await request('/', 'POST', { userId: hex(freshUserId) });
    expect(first.status).toBe(201);
    const firstChallenge = (first.data as Record<string, unknown>).challenge;

    // Second request replaces existing challenge (201, new challenge bytes)
    const second = await request('/', 'POST', { userId: hex(freshUserId) });
    expect(second.status).toBe(201);
    const secondChallenge = (second.data as Record<string, unknown>).challenge;
    expect(secondChallenge).not.toBe(firstChallenge);
  });

  it('POST /challenge with any valid userId returns 201', async () => {
    const res = await request('/', 'POST', {
      userId: uid('any-user-id'),
    });
    expect(res.status).toBe(201);
  });

  it('POST /challenge computes expiresAtBlock correctly', async () => {
    // Use a fresh identity so no existing challenge
    const kp = generateKeyPair();
    const freshUserId = kp.publicKey;

    const res = await request('/', 'POST', { userId: Buffer.from(freshUserId).toString('hex') });
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;

    const currentHeight = getCurrentHeight();
    expect(body.expiresAtBlock).toBe(
      currentHeight + CHALLENGE_WINDOW_BLOCKS,
    );
  });
});
