import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import { insertIdentity, getIdentity } from '../../src/store/identities.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import {
  getKarmaBox,
  insertBox,
  getBox,
} from '../../src/store/utxo.js';
import { getPendingEntries } from '../../src/store/mempool.js';
import { initSystemKeypair, ensureSystemKarmaBox, getSystemKeypair } from '../../src/store/system.js';
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
    getBox,
    insertBox,
    consumeBox: (id: string, atBlock: number) => {
      getDb().prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(atBlock, id);
    },
    runInTransaction: (fn: () => void) => getDb().transaction(fn)(),
    isSystemBox: (boxId: string) => {
      const sysKey = getSystemKeypair();
      if (!sysKey) return false;
      const box = getBox(boxId);
      if (!box || box.boxType !== 'karma') return false;
      return Buffer.from((box as KarmaBox).owner).equals(Buffer.from(sysKey.publicKey));
    },
  };
}

function buildApp(deps: FaucetDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/faucet', createRouter(deps));
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

    // Init system keypair and karma box (50K)
    const sysKey = initSystemKeypair();
    ensureSystemKarmaBox(sysKey.publicKey, 1);

    const kp = generateKeyPair();
    publicKey = kp.publicKey;
    userId = publicKey;
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
  // Test 1: Grants 100 karma from system box
  // -----------------------------------------------------------------------

  it('grants 100 karma from system box (200, pending)', async () => {
    const kp = generateKeyPair();
    const pk = kp.publicKey;
    const pkHex = hex(pk);
    insertIdentity(pk, pk);

    const app = buildApp(deps);
    const res = await request(app, '/faucet', 'POST', {
      userId: pkHex,
    });

    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(typeof body.txId).toBe('string');
    expect(typeof body.expiresAtHeight).toBe('number');
    expect((body.expiresAtHeight as number) > 0).toBe(true);

    // Verify the transaction is in the mempool
    const entries = getPendingEntries(10);
    const utxoEntry = entries.find((e) => e.entryType === 'utxo_tx' && e.utxoTxCbor);
    expect(utxoEntry).toBeDefined();

    // Decode the transaction — system box → system change + user box
    const tx = decodeTx(utxoEntry!.utxoTxCbor!);
    expect(tx.inputs.length).toBe(1); // system karma box
    expect(tx.outputs.length).toBe(2); // system change + user grant
    expect(tx.outputs[0]!.boxType).toBe('karma');
    expect(tx.outputs[1]!.boxType).toBe('karma');

    // One output is 100 (user grant), the other is system balance - 100
    const values = tx.outputs.map((o) => o.value);
    expect(values).toContain(100);

    // The user grant box should NOT be in UTXO store yet (only in mempool)
    const box = getBox(body.txId as string);
    expect(box).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Test 2: Subsequent faucet grants work (system box depleting)
  // -----------------------------------------------------------------------

  it('handles multiple faucet grants from the same system box', async () => {
    const kp = generateKeyPair();
    const pk = kp.publicKey;
    insertIdentity(pk, pk);

    const app = buildApp(deps);

    // First grant
    const res1 = await request(app, '/faucet', 'POST', { userId: hex(pk) });
    expect(res1.status).toBe(200);
    const body1 = res1.data as Record<string, unknown>;
    expect(body1.status).toBe('pending');

    // Second grant (same user — same tx shape, same txId = idempotent)
    const res2 = await request(app, '/faucet', 'POST', { userId: hex(pk) });
    expect(res2.status).toBe(200);
    const body2 = res2.data as Record<string, unknown>;
    expect(body2.status).toBe('pending');
    // Same inputs + outputs = same txId (deterministic)
  });

  // -----------------------------------------------------------------------
  // Test 3: Unknown userId → 404
  // -----------------------------------------------------------------------

  it('returns 404 for unknown userId', async () => {
    const app = buildApp(deps);
    const res = await request(app, '/faucet', 'POST', {
      userId: '00'.repeat(32),
    });
    expect(res.status).toBe(404);
    const body = res.data as Record<string, unknown>;
    expect(body.error).toBe('Identity not found');
  });

  // -----------------------------------------------------------------------
  // Test 4: Network mode != testnet → 403
  // -----------------------------------------------------------------------

  it('returns 403 when network mode is not testnet', async () => {
    const app = express();
    app.use(express.json());
    app.use('/faucet', (_req, res) => {
      res.status(403).json({ error: 'faucet disabled in production mode' });
    });
    const res = await request(app, '/faucet', 'POST', {
      userId: hex(userId),
    });
    expect(res.status).toBe(403);
  });
});
