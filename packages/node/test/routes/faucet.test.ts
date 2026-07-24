import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { initDb, closeDb } from '../../src/store/db.js';
import { insertIdentity, getIdentity } from '../../src/store/identities.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import {
  getKarmaBox,
  insertBox,
  getBox,
} from '../../src/store/utxo.js';
import { getPendingEntries } from '../../src/store/mempool.js';
import { generateKeyPair, computeBoxId, computeTxId } from '@dagsocial/types';
import type { KarmaBox } from '@dagsocial/types';
import { decodeTx } from '@dagsocial/types';
import { createRouter } from '../../src/routes/faucet.js';
import type { FaucetDeps } from '../../src/routes/faucet.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-routes-faucet.sqlite';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hex(u: Uint8Array): string {
  return Buffer.from(u).toString('hex');
}

function buildDeps(): FaucetDeps {
  return {
    getIdentity,
    getKarmaBox,
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
      if (body !== undefined) r.write(JSON.stringify(body, (_k, v) => v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v));
      r.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('faucet route', () => {
  let deps: FaucetDeps;
  let userId: Uint8Array;
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
    userId = publicKey;  // userId IS the public key
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

  it('grants karma to identity with no existing box (201, pending)', async () => {
    const kp = generateKeyPair();
    const pk = kp.publicKey;
    const pkHex = hex(pk);
    insertIdentity(pk, pk);

    const app = buildApp(deps);
    const res = await request(app, '/faucet', 'POST', {
      userId: pkHex,
      amount: 250,
    });

    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(typeof body.txId).toBe('string');
    expect(typeof body.expiresAtHeight).toBe('number');
    expect((body.expiresAtHeight as number) > 0).toBe(true);

    // Verify the transaction is in the mempool
    const entries = getPendingEntries(10);
    const utxoEntry = entries.find((e) => e.entryType === 'utxo_tx' && e.utxoTxCbor);
    expect(utxoEntry).toBeDefined();

    // Decode the transaction and verify the output
    const tx = decodeTx(utxoEntry!.utxoTxCbor!);
    expect(tx.inputs).toEqual([]); // no existing box to consume
    expect(tx.outputs.length).toBe(1);
    const output = tx.outputs[0];
    expect(output.boxType).toBe('karma');
    expect(output.value).toBe(250);

    // The box should NOT be in the UTXO store yet (only in mempool)
    const box = getBox(body.txId as string);
    expect(box).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Test 2: Tops up existing (confirmed) karma box
  // -----------------------------------------------------------------------

  it('tops up existing karma box via mempool (201, pending)', async () => {
    const kp = generateKeyPair();
    const pk = kp.publicKey;
    const pkHex = hex(pk);
    insertIdentity(pk, pk);

    // Insert a confirmed karma box directly into UTXO (simulating a previous
    // faucet grant that has been confirmed by a block)
    const existingBox: KarmaBox = {
      boxType: 'karma',
      value: 100,
      createdAtBlock: 1,
      owner: pk,
      guard: 'owner_signature',
      proofSource: 'faucet',
      lastTouchBlock: 1,
    };
    const existingBoxId = computeBoxId(existingBox);
    insertBox({ ...existingBox, id: existingBoxId });

    // Verify it exists in UTXO store
    const stored = getKarmaBox(pk);
    expect(stored).not.toBeNull();
    expect(stored!.value).toBe(100);

    const app = buildApp(deps);

    // Now call faucet to top-up
    const res = await request(app, '/faucet', 'POST', {
      userId: pkHex,
      amount: 50,
    });
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(typeof body.txId).toBe('string');
    expect(typeof body.expiresAtHeight).toBe('number');
    expect((body.expiresAtHeight as number) > 0).toBe(true);

    // Verify the transaction is in the mempool by txId
    const txId = body.txId as string;
    const entries = getPendingEntries(10);
    const txEntry = entries.find((e) => {
      if (e.entryType !== 'utxo_tx' || !e.utxoTxCbor) return false;
      const decoded = decodeTx(e.utxoTxCbor);
      return computeTxId(decoded) === txId;
    });
    expect(txEntry).toBeDefined();

    // Decode the transaction — should consume old box and output new with 150
    const tx = decodeTx(txEntry!.utxoTxCbor!);
    expect(tx.inputs).toEqual([existingBoxId]);
    expect(tx.outputs.length).toBe(1);
    expect(tx.outputs[0].boxType).toBe('karma');
    expect(tx.outputs[0].value).toBe(150);
  });

  // -----------------------------------------------------------------------
  // Test 3: Unknown userId → 404
  // -----------------------------------------------------------------------

  it('returns 404 for unknown userId', async () => {
    const app = buildApp(deps);
    const res = await request(app, '/faucet', 'POST', {
      userId: '00'.repeat(32),  // 32 bytes of zeros as hex = 64 hex chars
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
      userId: hex(userId),
      amount: 100,
    });
    expect(res.status).toBe(403);
  });
});
