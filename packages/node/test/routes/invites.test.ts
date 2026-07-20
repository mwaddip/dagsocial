import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createHash, createPrivateKey, sign as cryptoSign } from 'crypto';
import { initDb, closeDb } from '../../src/store/db.js';
import { insertIdentity, getIdentity } from '../../src/store/identities.js';
import { insertBox } from '../../src/store/utxo.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import {
  createInvite,
  claimInvite,
  cancelInvite,
} from '../../src/services/invites.js';
import {
  generateKeyPair,
  getUserId,
  computeBoxId,
} from '@dagsocial/types';
import type { KarmaBox } from '@dagsocial/types';
import { createRouter } from '../../src/routes/invites.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-routes-invites.sqlite';

// ---------------------------------------------------------------------------
// Ed25519 signing helper
// ---------------------------------------------------------------------------

function signData(data: string, secretKey: Uint8Array): string {
  const keyObj = createPrivateKey({
    key: Buffer.from(secretKey),
    format: 'der',
    type: 'pkcs8',
  });
  const hash = createHash('blake2b512').update(data).digest().subarray(0, 32);
  const sig = cryptoSign(null, hash, keyObj);
  return Buffer.from(sig).toString('hex');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(
  path: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const deps = {
      createInvite,
      claimInvite,
      cancelInvite,
      getIdentity,
      getCurrentHeight,
    };
    const app = express();
    app.use(express.json());
    app.use('/invites', createRouter(deps));
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const r = http.request(
        {
          hostname: 'localhost',
          port: addr.port,
          path: '/invites' + path,
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

describe('invites routes', () => {
  let inviterId: string;
  let inviterKp: ReturnType<typeof generateKeyPair>;
  let inviteCounter = 0;

  /** Create an invite via the service with unique amounts to avoid box ID collisions. */
  function createTestInvite() {
    inviteCounter++;
    const karmaAmount = 10 + inviteCounter; // unique per call
    const bondAmount = 3 + inviteCounter;   // unique per call
    const signMsg = `create-invite:${inviterId}:${karmaAmount}:${bondAmount}`;
    const sig = signData(signMsg, inviterKp.secretKey);
    return createInvite(
      inviterId,
      karmaAmount,
      bondAmount,
      inviterKp.publicKey,
      new Uint8Array(Buffer.from(sig, 'hex')),
      getCurrentHeight(),
    );
  }

  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);

    // Create inviter identity with karma
    inviterKp = generateKeyPair();
    inviterId = getUserId(inviterKp.publicKey);
    insertIdentity(inviterId, inviterKp.publicKey);

    const karmaBox: KarmaBox = {
      boxType: 'karma',
      value: 1000,
      createdAtBlock: 1,
      owner: inviterKp.publicKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 1,
    };
    const karmaBoxId = computeBoxId(karmaBox);
    insertBox({ ...karmaBox, id: karmaBoxId });
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
  });

  it('POST /invites creates invite and returns 201', async () => {
    inviteCounter++;
    const karmaAmount = 10 + inviteCounter;
    const bondAmount = 3 + inviteCounter;
    const signMsg = `create-invite:${inviterId}:${karmaAmount}:${bondAmount}`;
    const sig = signData(signMsg, inviterKp.secretKey);

    const res = await request('/', 'POST', {
      inviterId,
      karmaAmount,
      bondAmount,
      signature: sig,
    });
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(typeof body.inviteBoxId).toBe('string');
    expect(typeof body.bondBoxId).toBe('string');
    expect(typeof body.secretHash).toBe('string');
    expect((body.secretHash as string).length).toBe(64);
  });

  it('POST /invites with missing fields returns 400', async () => {
    const res = await request('/', 'POST', {});
    expect(res.status).toBe(400);
  });

  it('POST /invites/claim claims an invite and returns 201', async () => {
    const { secret, inviteBox } = createTestInvite();

    const newKp = generateKeyPair();
    const publicKey = Buffer.from(newKp.publicKey).toString('hex');
    const secretHex = Buffer.from(secret).toString('hex');

    const res = await request('/claim', 'POST', {
      inviteBoxId: inviteBox.id,
      secret: secretHex,
      publicKey,
    });
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(typeof body.userId).toBe('string');
    expect(typeof body.karmaBoxId).toBe('string');
  });

  it('POST /invites/cancel cancels an unclaimed invite and returns 200', async () => {
    const { inviteBox } = createTestInvite();

    // Cancel it via the route
    const cancelMsg = `cancel-invite:${inviteBox.id}`;
    const cancelSig = signData(cancelMsg, inviterKp.secretKey);

    const res = await request('/cancel', 'POST', {
      inviteBoxId: inviteBox.id,
      inviterId,
      signature: cancelSig,
    });
    expect(res.status).toBe(200);
  });

  it('POST /invites/cancel with wrong inviter returns 403', async () => {
    const { inviteBox } = createTestInvite();

    // Try to cancel as a different user
    const cancelMsg = `cancel-invite:${inviteBox.id}`;
    const wrongSig = signData(cancelMsg, inviterKp.secretKey);

    const res = await request('/cancel', 'POST', {
      inviteBoxId: inviteBox.id,
      inviterId: 'wrong-inviter-id',
      signature: wrongSig,
    });
    expect(res.status).toBe(403);
  });
});
