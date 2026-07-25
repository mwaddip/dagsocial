import { uid } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createPrivateKey, sign } from 'crypto';
import { initDb, closeDb } from '../../src/store/db.js';
import {
  getKarmaBox,
  getKarmaBoxes,
  getCreditBox,
  getCreditBoxes,
  getPendingInvites,
  getBondBoxes,
  insertBox,
  getBox,
  consumeBox,
} from '../../src/store/utxo.js';
import {
  initSystemKeypair,
  getSystemKeypair,
} from '../../src/store/system.js';
import {
  generateKeyPair,
  computeBoxId,
  computeTxId,
  selectBoxes,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { KarmaBox, CreditBox, InviteBox, BondBox, UtxoTransaction } from '@dagsocial/types';
import { createRouter } from '../../src/routes/utxo.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-routes-utxo.sqlite';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const deps = {
      getKarmaBox,
      getKarmaBoxes,
      getCreditBox,
      getCreditBoxes,
      getPendingInvites,
      getBondBoxes,
      getCurrentHeight: () => 100,
      getUtxoEngineDeps: () => ({
        getBox,
        insertBox,
        consumeBox,
        getKarmaBox,
        getKarmaBoxes: (owner: Uint8Array) => [getKarmaBox(owner)].filter(Boolean) as KarmaBox[],
        runInTransaction: (fn: () => void) => fn(),
      }),
    };
    const app = express();
    app.use(express.json());
    app.use(createRouter(deps));
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const req = http.request(
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
      if (body !== undefined) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UTXO routes', () => {
  let karmaUserId: Uint8Array;
  let karmaUserIdHex: string;
  let creditUserId: Uint8Array;
  let creditUserIdHex: string;
  let inviteUserId: Uint8Array;
  let inviteUserIdHex: string;

  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);

    // User with karma
    const kp1 = generateKeyPair();
    karmaUserId = kp1.publicKey;
    karmaUserIdHex = Buffer.from(karmaUserId).toString('hex');
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

    // Second karma box for same user — multi-box total must sum across all boxes
    const karmaBox2: KarmaBox = {
      boxType: 'karma',
      value: 58,
      createdAtBlock: 2,
      owner: kp1.publicKey,
      guard: 'owner_signature',
      proofSource: 'test',
      lastTouchBlock: 2,
    };
    insertBox({ ...karmaBox2, id: computeBoxId(karmaBox2) });

    // User with credits
    const kp2 = generateKeyPair();
    creditUserId = kp2.publicKey;
    creditUserIdHex = Buffer.from(creditUserId).toString('hex');
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
    inviteUserId = kp3.publicKey;
    inviteUserIdHex = Buffer.from(inviteUserId).toString('hex');
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

    // Initialize system keypair for faucet tests
    initSystemKeypair();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
  });

  it('GET /karma/:userId returns karma balance', async () => {
    const res = await request(`/karma/${karmaUserIdHex}`);
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.userId).toBe(karmaUserIdHex);
    expect(body.total).toBe(42 + 58);
    expect(Array.isArray(body.boxes)).toBe(true);
    expect(body.boxes).toHaveLength(2);
    expect(typeof (body.boxes as unknown[])[0]).toBe('object');
    const b0 = (body.boxes as unknown[])[0] as Record<string, unknown>;
    expect(typeof b0.boxId).toBe('string');
    // Vary order: ensure both box values exist (avoids assuming query order)
    const boxValues = (body.boxes as unknown[]).map((b: unknown) => (b as Record<string, unknown>).value);
    expect(boxValues).toEqual(expect.arrayContaining([42, 58]));
  });

  it('GET /credits/:userId returns credit balance (multi-box)', async () => {
    const res = await request(`/credits/${creditUserIdHex}`);
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.userId).toBe(creditUserIdHex);
    expect(body.total).toBe(99);
    expect(Array.isArray(body.boxes)).toBe(true);
    expect(body.boxes).toHaveLength(1);
    const b0 = (body.boxes as unknown[])[0] as Record<string, unknown>;
    expect(typeof b0.boxId).toBe('string');
    expect(b0.value).toBe(99);
  });

  it('GET /invites/:userId returns pending and bonds arrays', async () => {
    const res = await request(`/invites/${inviteUserIdHex}`);
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(Array.isArray(body.pending)).toBe(true);
    expect(Array.isArray(body.bonds)).toBe(true);
    expect((body.pending as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect((body.bonds as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // Credit transfer tests
  // ---------------------------------------------------------------------------

  describe('POST /credits/transfer', () => {
    let senderPubKey: Uint8Array;
    let senderPrivKey: Uint8Array;
    let senderHex: string;
    let receiverPubKey: Uint8Array;
    let receiverHex: string;

    beforeAll(() => {
      const sender = generateKeyPair();
      senderPubKey = sender.publicKey;
      senderPrivKey = sender.secretKey;
      senderHex = Buffer.from(senderPubKey).toString('hex');

      const receiver = generateKeyPair();
      receiverPubKey = receiver.publicKey;
      receiverHex = Buffer.from(receiverPubKey).toString('hex');

      // Seed sender with 200 credits
      const box: CreditBox = {
        boxType: 'credit',
        value: 200,
        createdAtBlock: 10,
        owner: senderPubKey,
        guard: 'owner_signature',
        proofSource: 10,
      };
      insertBox({ ...box, id: computeBoxId(box) });
    });

    it('rejects missing from', async () => {
      const res = await request('/credits/transfer', 'POST', {
        to: receiverHex,
        amount: 50,
        signature: 'AAAA',
      });
      expect(res.status).toBe(400);
      expect((res.data as Record<string, unknown>).error).toContain('from');
    });

    it('rejects missing to', async () => {
      const res = await request('/credits/transfer', 'POST', {
        from: senderHex,
        amount: 50,
        signature: 'AAAA',
      });
      expect(res.status).toBe(400);
      expect((res.data as Record<string, unknown>).error).toContain('to');
    });

    it('rejects missing amount', async () => {
      const res = await request('/credits/transfer', 'POST', {
        from: senderHex,
        to: receiverHex,
        signature: 'AAAA',
      });
      expect(res.status).toBe(400);
      expect((res.data as Record<string, unknown>).error).toContain('amount');
    });

    it('rejects zero amount', async () => {
      const res = await request('/credits/transfer', 'POST', {
        from: senderHex,
        to: receiverHex,
        amount: 0,
        signature: 'AAAA',
      });
      expect(res.status).toBe(400);
    });

    it('rejects missing signature', async () => {
      const res = await request('/credits/transfer', 'POST', {
        from: senderHex,
        to: receiverHex,
        amount: 50,
      });
      expect(res.status).toBe(400);
      expect((res.data as Record<string, unknown>).error).toContain('signature');
    });

    it('rejects invalid signature', async () => {
      const res = await request('/credits/transfer', 'POST', {
        from: senderHex,
        to: receiverHex,
        amount: 50,
        signature: Buffer.from(new Uint8Array(64).fill(0xaa)).toString('base64'),
      });
      expect(res.status).toBe(401);
    });

    it('rejects unknown sender', async () => {
      const unknownHex = Buffer.from(new Uint8Array(32).fill(0xcc)).toString('hex');
      const res = await request('/credits/transfer', 'POST', {
        from: unknownHex,
        to: receiverHex,
        amount: 50,
        signature: Buffer.from(new Uint8Array(64)).toString('base64'),
      });
      expect(res.status).toBe(404);
    });

    it('completes a valid transfer', async () => {
      const amount = 50;
      const currentHeight = 100;

      // Precompute txId the same way sendCredits does
      const unlocked = [getCreditBox(senderPubKey)!];
      const selected = selectBoxes(unlocked, amount);
      const totalSelected = selected.reduce((s, b) => s + b.value, 0);
      const change = totalSelected - amount;

      const outputs: CreditBox[] = [{
        boxType: 'credit',
        value: amount,
        createdAtBlock: currentHeight,
        owner: receiverPubKey,
        guard: 'owner_signature',
        proofSource: -1,
      }];
      if (change > 0) {
        outputs.push({
          boxType: 'credit',
          value: change,
          createdAtBlock: currentHeight,
          owner: senderPubKey,
          guard: 'owner_signature',
          proofSource: -1,
        });
      }

      const tx: UtxoTransaction = {
        inputs: selected.map(b => b.id!),
        outputs: outputs.map(b => ({ ...b, id: computeBoxId(b) })),
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      const txId = computeTxId(tx);

      // Sign with sender's private key (PKCS8 DER)
      const privKey = createPrivateKey({
        key: Buffer.from(senderPrivKey),
        format: 'der',
        type: 'pkcs8',
      });
      const sig = sign(null, Buffer.from(txId, 'hex'), privKey);
      const sigBase64 = Buffer.from(sig).toString('base64');

      const res = await request('/credits/transfer', 'POST', {
        from: senderHex,
        to: receiverHex,
        amount,
        signature: sigBase64,
      });
      expect(res.status).toBe(200);
      const body = res.data as Record<string, unknown>;
      expect(body.sent).toBe(amount);
      expect(body.change).toBe(change);
      expect(typeof body.txId).toBe('string');
    });
  });

  // ---------------------------------------------------------------------------
  // Credit faucet tests
  // ---------------------------------------------------------------------------

  describe('POST /credits/faucet', () => {
    let faucetRecipientHex: string;

    beforeAll(() => {
      const recipient = generateKeyPair();
      const recipientPubKey = recipient.publicKey;
      faucetRecipientHex = Buffer.from(recipientPubKey).toString('hex');
    });

    it('rejects missing to', async () => {
      const res = await request('/credits/faucet', 'POST', {});
      expect(res.status).toBe(400);
      expect((res.data as Record<string, unknown>).error).toContain('to');
    });

    it('rejects invalid to encoding', async () => {
      const res = await request('/credits/faucet', 'POST', {
        to: 'not-hex!!!',
      });
      expect(res.status).toBe(400);
    });

    it('grants faucet credits to any valid userId (no registration needed)', async () => {
      const anyHex = Buffer.from(new Uint8Array(32).fill(0xdd)).toString('hex');
      const res = await request('/credits/faucet', 'POST', {
        to: anyHex,
      });
      expect(res.status).toBe(200);
      const body = res.data as Record<string, unknown>;
      expect(body.amount).toBe(1000);
    });

    it('grants faucet credits to a valid recipient', async () => {
      const res = await request('/credits/faucet', 'POST', {
        to: faucetRecipientHex,
      });
      expect(res.status).toBe(200);
      const body = res.data as Record<string, unknown>;
      expect(body.amount).toBe(1000);
      expect(typeof body.txId).toBe('string');
    });
  });
});
