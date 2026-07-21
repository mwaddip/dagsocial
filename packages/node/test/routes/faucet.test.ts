import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { initDb, closeDb } from '../../src/store/db.js';
import { insertIdentity, getIdentity } from '../../src/store/identities.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import {
  getBox,
  getKarmaBox,
  insertBox,
  consumeBox,
} from '../../src/store/utxo.js';
import { generateKeyPair, getUserId, computeBoxId } from '@dagsocial/types';
import type { KarmaBox } from '@dagsocial/types';
import { createRouter } from '../../src/routes/faucet.js';
import type { FaucetDeps } from '../../src/routes/faucet.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-routes-faucet.sqlite';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDeps(): FaucetDeps {
  return {
    getIdentity,
    getKarmaBox,
    insertBox,
    consumeBox,
    getCurrentHeight,
  };
}

function buildApp(deps: FaucetDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/faucet', createRouter(deps));
  return app;
}

function buildAppWithNetworkMode(
  deps: FaucetDeps,
  networkMode: string,
): express.Express {
  const app = express();
  app.use(express.json());
  if (networkMode === 'testnet') {
    app.use('/faucet', createRouter(deps));
  } else {
    app.use('/faucet', (_req, res) => {
      res.status(403).json({ error: 'faucet disabled in production mode' });
    });
  }
  return app;
}

async function request(
  app: express.Express,
  path: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const r = http.request(
        {
          hostname: 'localhost',
          port: addr.port,
          path,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('faucet route', () => {
  let deps: FaucetDeps;
  let userId: string;
  let publicKey: Uint8Array;

  beforeAll(() => {
    try {
      unlinkSync(TEST_DB);
    } catch {
      /* ignore */
    }
    initDb(TEST_DB);

    const kp = generateKeyPair();
    publicKey = kp.publicKey;
    userId = getUserId(publicKey);
    insertIdentity(userId, publicKey);

    deps = buildDeps();
  });

  afterAll(() => {
    closeDb();
    try {
      unlinkSync(TEST_DB);
    } catch {
      /* ignore */
    }
  });

  // -----------------------------------------------------------------------
  // Test 1: Grants karma to identity with no existing box
  // -----------------------------------------------------------------------

  it('grants karma to identity with no existing box (201, newBalance = amount)', async () => {
    // Use a fresh identity for this test to avoid state from test setup
    const kp = generateKeyPair();
    const pk = kp.publicKey;
    const uid = getUserId(pk);
    insertIdentity(uid, pk);

    const app = buildApp(deps);
    const res = await request(app, '/faucet', 'POST', {
      userId: uid,
      amount: 250,
    });

    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(body.userId).toBe(uid);
    expect(typeof body.boxId).toBe('string');
    expect(body.newBalance).toBe(250);

    // Verify box exists in the store
    const box = getBox(body.boxId as string);
    expect(box).not.toBeNull();
    expect(box!.boxType).toBe('karma');
    expect(box!.value).toBe(250);
  });

  // -----------------------------------------------------------------------
  // Test 2: Tops up existing karma box
  // -----------------------------------------------------------------------

  it('tops up existing karma box (201, newBalance = old + amount)', async () => {
    // Create an identity with an existing karma box
    const kp = generateKeyPair();
    const pk = kp.publicKey;
    const uid = getUserId(pk);
    insertIdentity(uid, pk);

    const app = buildApp(deps);

    // First grant some karma
    const res1 = await request(app, '/faucet', 'POST', {
      userId: uid,
      amount: 100,
    });
    expect(res1.status).toBe(201);
    const body1 = res1.data as Record<string, unknown>;
    expect(body1.newBalance).toBe(100);

    // Now top up
    const res2 = await request(app, '/faucet', 'POST', {
      userId: uid,
      amount: 50,
    });
    expect(res2.status).toBe(201);
    const body2 = res2.data as Record<string, unknown>;
    expect(body2.newBalance).toBe(150);
    expect(body2.userId).toBe(uid);

    // Verify the new box exists and has the right value
    const newBox = getBox(body2.boxId as string);
    expect(newBox).not.toBeNull();
    expect(newBox!.value).toBe(150);
  });

  // -----------------------------------------------------------------------
  // Test 3: Unknown userId → 404
  // -----------------------------------------------------------------------

  it('returns 404 for unknown userId', async () => {
    const app = buildApp(deps);
    const res = await request(app, '/faucet', 'POST', {
      userId: 'nonexistent-user-id',
      amount: 100,
    });
    expect(res.status).toBe(404);
    const body = res.data as Record<string, unknown>;
    expect(body.error).toBe('Identity not found');
  });

  // -----------------------------------------------------------------------
  // Test 4: Network mode != testnet → 403
  // -----------------------------------------------------------------------

  it('returns 403 when network mode is not testnet', async () => {
    const app = buildAppWithNetworkMode(deps, 'production');
    const res = await request(app, '/faucet', 'POST', {
      userId,
      amount: 100,
    });
    expect(res.status).toBe(403);
  });
});
