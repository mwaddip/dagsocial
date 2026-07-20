import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { initDb, closeDb } from '../../src/store/db.js';
import { insertIdentity, getIdentity } from '../../src/store/identities.js';
import {
  getKarmaBox,
  getCreditBox,
  getPendingInvites,
  getBondBoxes,
  insertBox,
} from '../../src/store/utxo.js';
import {
  generateKeyPair,
  getUserId,
  computeBoxId,
} from '@dagsocial/types';
import type { KarmaBox, CreditBox, InviteBox, BondBox } from '@dagsocial/types';
import { createRouter } from '../../src/routes/utxo.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-routes-utxo.sqlite';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(
  path: string,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const deps = {
      getIdentity,
      getKarmaBox,
      getCreditBox,
      getPendingInvites,
      getBondBoxes,
    };
    const app = express();
    app.use(express.json());
    app.use(createRouter(deps));
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const r = http.request(
        {
          hostname: 'localhost',
          port: addr.port,
          path,
          method: 'GET',
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
      r.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UTXO routes', () => {
  let karmaUserId: string;
  let creditUserId: string;
  let inviteUserId: string;

  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);

    // User with karma
    const kp1 = generateKeyPair();
    karmaUserId = getUserId(kp1.publicKey);
    insertIdentity(karmaUserId, kp1.publicKey);
    const karmaBox: KarmaBox = {
      boxType: 'karma',
      value: 42,
      createdAtBlock: 1,
      owner: kp1.publicKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 1,
    };
    insertBox({ ...karmaBox, id: computeBoxId(karmaBox) });

    // User with credits
    const kp2 = generateKeyPair();
    creditUserId = getUserId(kp2.publicKey);
    insertIdentity(creditUserId, kp2.publicKey);
    const creditBox: CreditBox = {
      boxType: 'credit',
      value: 99,
      createdAtBlock: 2,
      owner: kp2.publicKey,
      guard: 'owner_signature',
      proofSource: 1,
    };
    insertBox({ ...creditBox, id: computeBoxId(creditBox) });

    // User with invites and bonds
    const kp3 = generateKeyPair();
    inviteUserId = getUserId(kp3.publicKey);
    insertIdentity(inviteUserId, kp3.publicKey);
    const inviteBox: InviteBox = {
      boxType: 'invite',
      value: 10,
      createdAtBlock: 3,
      secretHash: new Uint8Array(32).fill(0xaa),
      inviterId: inviteUserId,
      guard: 'hash_preimage',
    };
    insertBox({ ...inviteBox, id: computeBoxId(inviteBox) });
    const bondBox: BondBox = {
      boxType: 'bond',
      value: 5,
      createdAtBlock: 3,
      inviterId: inviteUserId,
      inviteePublicKey: new Uint8Array(32).fill(0xbb),
      probationStartBlock: 100,
      probationEndBlock: 1100,
      guard: 'inviter_signature',
    };
    insertBox({ ...bondBox, id: computeBoxId(bondBox) });
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
  });

  it('GET /karma/:userId returns karma balance', async () => {
    const res = await request(`/karma/${karmaUserId}`);
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.userId).toBe(karmaUserId);
    expect(body.balance).toBe(42);
    expect(typeof body.boxId).toBe('string');
    expect(body.createdAtBlock).toBe(1);
  });

  it('GET /credits/:userId returns credit balance', async () => {
    const res = await request(`/credits/${creditUserId}`);
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.userId).toBe(creditUserId);
    expect(body.balance).toBe(99);
    expect(typeof body.boxId).toBe('string');
  });

  it('GET /invites/:userId returns pending and bonds arrays', async () => {
    const res = await request(`/invites/${inviteUserId}`);
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(Array.isArray(body.pending)).toBe(true);
    expect(Array.isArray(body.bonds)).toBe(true);
    expect((body.pending as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect((body.bonds as unknown[]).length).toBeGreaterThanOrEqual(1);
  });
});
