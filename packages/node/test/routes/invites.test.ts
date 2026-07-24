import { uid } from '../helpers.js';
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
  computeBoxId,
} from '@dagsocial/types';
import type { KarmaBox, InviteBox, BondBox } from '@dagsocial/types';
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
      if (body !== undefined) r.write(JSON.stringify(body, (_k, v) => v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v));
      r.end();
    });
  });
}

/** Insert a karma box into UTXO. */
function insertKarmaBox(
  owner: Uint8Array,
  value: number,
  createdAtBlock: number,
): KarmaBox {
  const box: Omit<KarmaBox, 'id'> & { id?: string } = {
    boxType: 'karma',
    value,
    createdAtBlock,
    owner,
    guard: 'owner_signature',
    proofSource: 'test',
    lastTouchBlock: createdAtBlock,
  };
  const id = computeBoxId(box);
  const full: KarmaBox = { ...box, id, boxType: 'karma', guard: 'owner_signature' };
  insertBox(full);
  return full;
}

/** Insert an invite box into UTXO. */
function insertInviteBox(
  value: number,
  createdAtBlock: number,
  secretHash: Uint8Array,
  inviterId: Uint8Array,
): InviteBox {
  const box: Omit<InviteBox, 'id'> & { id?: string } = {
    boxType: 'invite',
    value,
    createdAtBlock,
    secretHash,
    inviterId,
    guard: 'hash_preimage',
  };
  const id = computeBoxId(box);
  const full: InviteBox = { ...box, id, boxType: 'invite', guard: 'hash_preimage' };
  insertBox(full);
  return full;
}

/** Insert a bond box into UTXO. */
function insertBondBox(
  value: number,
  createdAtBlock: number,
  inviterId: Uint8Array,
): BondBox {
  const box: Omit<BondBox, 'id'> & { id?: string } = {
    boxType: 'bond',
    value,
    createdAtBlock,
    inviterId,
    inviteePublicKey: new Uint8Array(0),
    probationStartBlock: 0,
    probationEndBlock: 0,
    guard: 'inviter_signature',
  };
  const id = computeBoxId(box);
  const full: BondBox = { ...box, id, boxType: 'bond', guard: 'inviter_signature' };
  insertBox(full);
  return full;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('invites routes', () => {
  let inviterId: Uint8Array;
  let inviterKp: ReturnType<typeof generateKeyPair>;
  let inviteCounter = 0;

  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);

    // Create inviter identity with karma
    inviterKp = generateKeyPair();
    inviterId = inviterKp.publicKey;
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

  it('POST /invites creates invite and returns 201 with pending', async () => {
    inviteCounter++;
    const karmaAmount = 10 + inviteCounter;
    const bondAmount = 3 + inviteCounter;
    const inviterIdHex = Buffer.from(inviterId).toString('hex');
    const signMsg = `create-invite:${inviterIdHex}:${karmaAmount}:${bondAmount}`;
    const sig = signData(signMsg, inviterKp.secretKey);

    const res = await request('/', 'POST', {
      inviterId: inviterIdHex,
      karmaAmount,
      bondAmount,
      signature: sig,
    });
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(typeof body.txId).toBe('string');
    expect(typeof body.expiresAtHeight).toBe('number');
    expect(typeof body.inviteBoxId).toBe('string');
    expect(typeof body.bondBoxId).toBe('string');
    expect(typeof body.secretHash).toBe('string');
    expect((body.secretHash as string).length).toBe(64);
  });

  it('POST /invites with missing fields returns 400', async () => {
    const res = await request('/', 'POST', {});
    expect(res.status).toBe(400);
  });

  it('POST /invites/claim claims an invite and returns 201 with pending', async () => {
    inviteCounter++;
    const bondAmount = 10 + inviteCounter; // unique per test to avoid ID collision
    const secret = new Uint8Array(32).fill(inviteCounter);
    const secretHex = Buffer.from(secret).toString('hex');
    const secretHash = createHash('blake2b512')
      .update(Buffer.from(secret))
      .digest()
      .subarray(0, 32);

    // Manually insert invite and bond boxes into UTXO (simulating confirmed invite)
    const inviteBox = insertInviteBox(15, 1, secretHash, inviterId);
    insertBondBox(bondAmount, 1, inviterId);

    const newKp = generateKeyPair();
    const publicKey = Buffer.from(newKp.publicKey).toString('hex');

    const res = await request('/claim', 'POST', {
      inviteBoxId: inviteBox.id,
      secret: secretHex,
      publicKey,
    });
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(typeof body.txId).toBe('string');
    expect(typeof body.expiresAtHeight).toBe('number');
    expect(typeof body.userId).toBe('string');
    expect(typeof body.karmaBoxId).toBe('string');
  });

  it('POST /invites/cancel cancels an unclaimed invite and returns 200 with pending', async () => {
    inviteCounter++;
    const bondAmount = 10 + inviteCounter; // unique per test to avoid ID collision
    const secretHash = createHash('blake2b512')
      .update(Buffer.from(new Uint8Array(32).fill(inviteCounter)))
      .digest()
      .subarray(0, 32);

    // Manually insert invite and bond boxes into UTXO
    const inviteBox = insertInviteBox(15, 1, secretHash, inviterId);
    insertBondBox(bondAmount, 1, inviterId);

    const cancelMsg = `cancel-invite:${inviteBox.id}`;
    const cancelSig = signData(cancelMsg, inviterKp.secretKey);

    const res = await request('/cancel', 'POST', {
      inviteBoxId: inviteBox.id,
      inviterId: Buffer.from(inviterId).toString('hex'),
      signature: cancelSig,
    });
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(typeof body.txId).toBe('string');
    expect(typeof body.expiresAtHeight).toBe('number');
  });

  it('POST /invites/cancel with wrong inviter returns 403', async () => {
    inviteCounter++;
    const bondAmount = 10 + inviteCounter; // unique per test to avoid ID collision
    const secretHash = createHash('blake2b512')
      .update(Buffer.from(new Uint8Array(32).fill(inviteCounter)))
      .digest()
      .subarray(0, 32);

    // Manually insert invite and bond boxes into UTXO
    const inviteBox = insertInviteBox(15, 1, secretHash, inviterId);
    insertBondBox(bondAmount, 1, inviterId);

    const cancelMsg = `cancel-invite:${inviteBox.id}`;
    const wrongSig = signData(cancelMsg, inviterKp.secretKey);

    const res = await request('/cancel', 'POST', {
      inviteBoxId: inviteBox.id,
      inviterId: uid('wrong-inviter-id'),
      signature: wrongSig,
    });
    expect(res.status).toBe(403);
  });
});
