import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
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

/**
 * Sum the karma every pending faucet grant in the mempool would pay to `owner`.
 * The faucet only enqueues transactions, so this is the balance the identity is
 * on track to receive once the block lands.
 */
function pendingFaucetKarmaFor(owner: Uint8Array): number {
  let total = 0;
  for (const entry of getPendingEntries(1000)) {
    if (entry.entryType !== 'utxo_tx' || !entry.utxoTxCbor) continue;
    const tx = decodeTx(entry.utxoTxCbor);
    for (const out of tx.outputs) {
      if (out.boxType !== 'karma') continue;
      if (Buffer.from((out as KarmaBox).owner).equals(Buffer.from(owner))) {
        total += out.value;
      }
    }
  }
  return total;
}

function buildDeps(): FaucetDeps {
  return {
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
  // Test 2: One grant per identity, ever — a repeat request is rejected
  // -----------------------------------------------------------------------

  it('rejects a repeat grant for the same userId with 409', async () => {
    const pk = generateKeyPair().publicKey;
    const app = buildApp(deps);

    const res1 = await request(app, '/faucet', 'POST', { userId: hex(pk) });
    expect(res1.status).toBe(200);
    expect((res1.data as Record<string, unknown>).status).toBe('pending');

    const res2 = await request(app, '/faucet', 'POST', { userId: hex(pk) });
    expect(res2.status).toBe(409);
    expect(String((res2.data as Record<string, unknown>).reason)).toContain('already funded');
  });

  // -----------------------------------------------------------------------
  // Test 2b: Balance never exceeds one grant, however many calls are made
  // -----------------------------------------------------------------------

  it('never grants more than one faucet allocation to an identity', async () => {
    const pk = generateKeyPair().publicKey;
    const app = buildApp(deps);

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app, '/faucet', 'POST', { userId: hex(pk) });
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);
    expect(pendingFaucetKarmaFor(pk)).toBe(100);
  });

  // -----------------------------------------------------------------------
  // Test 2c: Two calls within one block cannot both succeed
  // -----------------------------------------------------------------------

  it('lets only one of two same-block calls succeed', async () => {
    const pk = generateKeyPair().publicKey;
    const app = buildApp(deps);

    // getCurrentHeight is unchanged between these calls — no block is produced,
    // so both land in the same block window and only the settled/pending check
    // can separate them.
    const heightBefore = getCurrentHeight();
    const [res1, res2] = await Promise.all([
      request(app, '/faucet', 'POST', { userId: hex(pk) }),
      request(app, '/faucet', 'POST', { userId: hex(pk) }),
    ]);
    expect(getCurrentHeight()).toBe(heightBefore);

    const codes = [res1.status, res2.status].sort();
    expect(codes).toEqual([200, 409]);
    expect(pendingFaucetKarmaFor(pk)).toBe(100);
  });

  // -----------------------------------------------------------------------
  // Test 2d: A settled faucet-origin box blocks a further grant, spent or not
  // -----------------------------------------------------------------------

  it('rejects an identity that already holds a settled faucet-origin box', async () => {
    const pk = generateKeyPair().publicKey;
    const box: KarmaBox = {
      boxType: 'karma',
      value: 100,
      createdAtBlock: 1,
      owner: pk,
      guard: 'owner_signature',
      proofSource: 'faucet',
      lastTouchBlock: 1,
    };
    insertBox({ ...box, id: computeBoxId(box) });

    const app = buildApp(deps);
    const res = await request(app, '/faucet', 'POST', { userId: hex(pk) });
    expect(res.status).toBe(409);
  });

  it('rejects an identity whose faucet grant has already been spent', async () => {
    const pk = generateKeyPair().publicKey;
    const box: KarmaBox = {
      boxType: 'karma',
      value: 100,
      createdAtBlock: 1,
      owner: pk,
      guard: 'owner_signature',
      proofSource: 'faucet',
      lastTouchBlock: 2,
    };
    const boxId = computeBoxId(box);
    insertBox({ ...box, id: boxId });
    getDb().prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(5, boxId);

    const app = buildApp(deps);
    const res = await request(app, '/faucet', 'POST', { userId: hex(pk) });
    expect(res.status).toBe(409);
  });

  // -----------------------------------------------------------------------
  // Test 3: Unknown userId → succeeds (no registration needed)
  // -----------------------------------------------------------------------

  it('grants karma to any valid userId', async () => {
    const app = buildApp({ ...deps, runInTransaction: (fn: () => void) => fn() });
    const res = await request(app, '/faucet', 'POST', {
      userId: '00'.repeat(32),
    });
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
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
