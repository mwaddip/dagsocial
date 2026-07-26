import { txToJson, signTransaction } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createHash, generateKeyPairSync, createPrivateKey } from 'crypto';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import { getKarmaBox, getBox as storeGetBox, insertBox as storeInsertBox } from '../../src/store/utxo.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import {
  createInvite,
  claimInvite,
  cancelInvite,
} from '../../src/services/invites.js';
import {
  generateKeyPair,
  computeBoxId,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
  PROTOCOL_VERSION,
  INVITE_PROBATION_BLOCKS,
} from '@dagsocial/types';
import type { KarmaBox, InviteBox, BondBox, UtxoTransaction, AnyBox } from '@dagsocial/types';
import { createRouter } from '../../src/routes/invites.js';
import type { InvitesDeps } from '../../src/routes/invites.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-routes-invites.sqlite';

async function request(
  path: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const db = getDb();
    const deps: InvitesDeps = {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db.prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?').get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
      insertBox: (box: AnyBox) => { storeInsertBox(box); },
      consumeBox: (id: string, atBlock: number) => {
        db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(atBlock, id);
      },
      getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
      runInTransaction: (fn: () => void) => { (db.transaction(fn) as () => void)(); },
      createInvite,
      claimInvite,
      cancelInvite,
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

describe('invites routes', () => {
  let inviterId: Uint8Array;
  let inviterKp: ReturnType<typeof generateKeyPair>;
  let inviterPrivKeyObj: ReturnType<typeof createPrivateKey>;
  let inviterPubKeyHex: string;

  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);

    inviterKp = generateKeyPair();
    inviterId = inviterKp.publicKey;
    inviterPubKeyHex = Buffer.from(inviterId).toString('hex');
    inviterPrivKeyObj = createPrivateKey({
      key: Buffer.from(inviterKp.secretKey),
      format: 'der',
      type: 'pkcs8',
    });

  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
  });

  it('POST /invites creates invite and returns 201 with pending', async () => {
    const karma: KarmaBox = {
      boxType: 'karma',
      value: 100,
      createdAtBlock: 1,
      owner: inviterId,
      guard: 'owner_signature',
      proofSource: 'test-create',
      lastTouchBlock: 1,
    };
    const karmaId = computeBoxId(karma);
    storeInsertBox({ ...karma, id: karmaId, boxType: 'karma', guard: 'owner_signature' } as KarmaBox);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 50,
      createdAtBlock: 1,
      owner: inviterId,
      guard: 'owner_signature',
      proofSource: 'create-invite',
      lastTouchBlock: 1,
    };
    const newKarmaId = computeBoxId(newKarma);

    const secretHash = new Uint8Array(32).fill(0x99);
    const inviteBox: InviteBox = {
      boxType: 'invite',
      value: INVITE_KARMA_AMOUNT,
      createdAtBlock: 1,
      secretHash,
      inviterId,
      guard: 'hash_preimage_with_bond',
    };
    const inviteBoxId = computeBoxId(inviteBox);

    const bondBox: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 1,
      inviterId,
      inviteBoxId,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual',
    };
    const bondBoxId = computeBoxId(bondBox);

    const tx: UtxoTransaction = {
      inputs: [karmaId],
      outputs: [
        { ...newKarma, id: newKarmaId },
        { ...inviteBox, id: inviteBoxId },
        { ...bondBox, id: bondBoxId },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKeyObj, inviterPubKeyHex);

    const res = await request('/', 'POST', { tx: txToJson(tx) });
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

  it('POST /invites with missing tx returns 400', async () => {
    const res = await request('/', 'POST', {});
    expect(res.status).toBe(400);
  });

  it('POST /invites/claim claims an invite and returns 201 with pending', async () => {
    const secret = new Uint8Array(32).fill(0x55);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    const inviteBox: InviteBox = {
      boxType: 'invite',
      value: INVITE_KARMA_AMOUNT,
      createdAtBlock: 1,
      secretHash,
      inviterId,
      guard: 'hash_preimage_with_bond',
    };
    const inviteBoxId = computeBoxId(inviteBox);
    storeInsertBox({ ...inviteBox, id: inviteBoxId, boxType: 'invite', guard: 'hash_preimage_with_bond' } as InviteBox);

    const bondBox: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 1,
      inviterId,
      inviteBoxId,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual',
    };
    const bondBoxId = computeBoxId(bondBox);
    storeInsertBox({ ...bondBox, id: bondBoxId, boxType: 'bond', guard: 'bond_dual' } as BondBox);

    const newKp = generateKeyPair();
    const inviteePubKey = newKp.publicKey;
    const inviteePubKeyHex = Buffer.from(inviteePubKey).toString('hex');
    const inviteePrivKeyObj = createPrivateKey({
      key: Buffer.from(newKp.secretKey),
      format: 'der',
      type: 'pkcs8',
    });

    // Simulate committed BondBox
    const db = getDb();
    db.prepare(
      'UPDATE utxo_boxes SET extra_data = ? WHERE id = ?',
    ).run(
      JSON.stringify({
        inviterId: Buffer.from(inviterId).toString('hex'),
        inviteBoxId,
        inviteePublicKey: Array.from(inviteePubKey),
        probationStartBlock: 3,
        probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      }),
      bondBoxId,
    );

    const karmaOut: KarmaBox = {
      boxType: 'karma',
      value: INVITE_KARMA_AMOUNT,
      createdAtBlock: 5,
      owner: inviteePubKey,
      guard: 'owner_signature',
      proofSource: `invite-claim:${inviteBoxId}`,
      lastTouchBlock: 5,
    };
    const karmaOutId = computeBoxId(karmaOut);

    const bondOut: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: 3,
      inviterId,
      inviteBoxId,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 3,
      probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      guard: 'bond_dual',
    };
    const bondOutId = computeBoxId(bondOut);

    const tx: UtxoTransaction = {
      inputs: [inviteBoxId, bondBoxId],
      outputs: [
        { ...karmaOut, id: karmaOutId },
        { ...bondOut, id: bondOutId },
      ],
      signatures: {},
      preimages: { [inviteBoxId]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviteePrivKeyObj, inviteePubKeyHex);

    const res = await request('/claim', 'POST', { tx: txToJson(tx) });
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(typeof body.txId).toBe('string');
    expect(typeof body.expiresAtHeight).toBe('number');
    expect(typeof body.userId).toBe('string');
    expect(typeof body.karmaBoxId).toBe('string');
  });

  it('POST /invites/cancel cancels an unclaimed invite and returns 200 with pending', async () => {
    const secret = new Uint8Array(32).fill(0x33);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    const blockHeight = 10;

    const inviteBox: InviteBox = {
      boxType: 'invite',
      value: INVITE_KARMA_AMOUNT,
      createdAtBlock: blockHeight,
      secretHash,
      inviterId,
      guard: 'hash_preimage_with_bond',
    };
    const inviteBoxId = computeBoxId(inviteBox);
    storeInsertBox({ ...inviteBox, id: inviteBoxId, boxType: 'invite', guard: 'hash_preimage_with_bond' } as InviteBox);

    const bondBox: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: blockHeight,
      inviterId,
      inviteBoxId,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual',
    };
    const bondBoxId = computeBoxId(bondBox);
    storeInsertBox({ ...bondBox, id: bondBoxId, boxType: 'bond', guard: 'bond_dual' } as BondBox);

    const karmaIn: KarmaBox = {
      boxType: 'karma',
      value: 200,
      createdAtBlock: blockHeight,
      owner: inviterId,
      guard: 'owner_signature',
      proofSource: 'test-cancel',
      lastTouchBlock: blockHeight,
    };
    const karmaInId = computeBoxId(karmaIn);
    storeInsertBox({ ...karmaIn, id: karmaInId, boxType: 'karma', guard: 'owner_signature' } as KarmaBox);

    const totalValue = 200 + INVITE_KARMA_AMOUNT + INVITE_BOND_KARMA;
    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: totalValue,
      createdAtBlock: blockHeight,
      owner: inviterId,
      guard: 'owner_signature',
      proofSource: `invite-cancel:${inviteBoxId}`,
      lastTouchBlock: blockHeight,
    };
    const newKarmaId = computeBoxId(newKarma);

    const tx: UtxoTransaction = {
      inputs: [karmaInId, inviteBoxId, bondBoxId],
      outputs: [{ ...newKarma, id: newKarmaId }],
      signatures: {},
      preimages: { [inviteBoxId]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKeyObj, inviterPubKeyHex);

    const res = await request('/cancel', 'POST', { tx: txToJson(tx) });
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(typeof body.txId).toBe('string');
    expect(typeof body.expiresAtHeight).toBe('number');
  });

  it('POST /invites/cancel with wrong inviter returns 403', async () => {
    const secret = new Uint8Array(32).fill(0x44);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    const blockHeight = 20;

    const inviteBox: InviteBox = {
      boxType: 'invite',
      value: INVITE_KARMA_AMOUNT,
      createdAtBlock: blockHeight,
      secretHash,
      inviterId,
      guard: 'hash_preimage_with_bond',
    };
    const inviteBoxId = computeBoxId(inviteBox);
    storeInsertBox({ ...inviteBox, id: inviteBoxId, boxType: 'invite', guard: 'hash_preimage_with_bond' } as InviteBox);

    const bondBox: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      createdAtBlock: blockHeight,
      inviterId,
      inviteBoxId,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual',
    };
    const bondBoxId = computeBoxId(bondBox);
    storeInsertBox({ ...bondBox, id: bondBoxId, boxType: 'bond', guard: 'bond_dual' } as BondBox);

    const wrongKp = generateKeyPair();
    const wrongPubKey = wrongKp.publicKey;
    const wrongPubKeyHex = Buffer.from(wrongPubKey).toString('hex');
    const wrongPrivKeyObj = createPrivateKey({
      key: Buffer.from(wrongKp.secretKey),
      format: 'der',
      type: 'pkcs8',
    });

    const wrongKarma: KarmaBox = {
      boxType: 'karma',
      value: 200,
      createdAtBlock: blockHeight,
      owner: wrongPubKey,
      guard: 'owner_signature',
      proofSource: 'test-wrong',
      lastTouchBlock: blockHeight,
    };
    const wrongKarmaId = computeBoxId(wrongKarma);
    storeInsertBox({ ...wrongKarma, id: wrongKarmaId, boxType: 'karma', guard: 'owner_signature' } as KarmaBox);

    const totalValue = 200 + INVITE_KARMA_AMOUNT + INVITE_BOND_KARMA;
    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: totalValue,
      createdAtBlock: blockHeight,
      owner: wrongPubKey,
      guard: 'owner_signature',
      proofSource: `invite-cancel:${inviteBoxId}`,
      lastTouchBlock: blockHeight,
    };
    const newKarmaId = computeBoxId(newKarma);

    const tx: UtxoTransaction = {
      inputs: [wrongKarmaId, inviteBoxId, bondBoxId],
      outputs: [{ ...newKarma, id: newKarmaId }],
      signatures: {},
      preimages: { [inviteBoxId]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, wrongPrivKeyObj, wrongPubKeyHex);

    const res = await request('/cancel', 'POST', { tx: txToJson(tx) });
    expect(res.status).toBe(403);
  });
});
