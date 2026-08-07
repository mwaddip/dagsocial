import {
  seedAsOneTx,
  fixtureProvenance,
  txToJson, signTransaction } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { createHash, generateKeyPairSync, createPrivateKey } from 'crypto';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import {
  getBoxByProvenance as storeGetBoxByProvenance, getKarmaBox, getKarmaBoxes, getBox as storeGetBox, insertBox as storeInsertBox } from '../../src/store/utxo.js';
import { hasActiveVouchCooldown as storeHasActiveVouchCooldown } from '../../src/store/vouch-cooldowns.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import {
  createInvite,
  claimInvite,
  cancelInvite,
  commitInvite,
} from '../../src/services/invites.js';
import {
  generateKeyPair,
  computeBoxId,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
  PROTOCOL_VERSION,
  INVITE_PROBATION_BLOCKS,
} from '@dagsocial/types';
import type {
  CandidateOf, KarmaBox, InviteBox, BondBox, UtxoTransaction, AnyBox } from '@dagsocial/types';
import { createRouter } from '../../src/routes/invites.js';
import type { InvitesDeps } from '../../src/routes/invites.js';
import { ClientError } from '../../src/services/client-error.js';
import { MempoolFullError } from '../../src/store/mempool.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-routes-invites.sqlite';

async function request(
  path: string,
  method: string,
  body?: unknown,
  depOverrides?: Partial<InvitesDeps>,
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
      getBoxByProvenance: storeGetBoxByProvenance,
      insertBox: (box: AnyBox) => { storeInsertBox(box); },
      consumeBox: (id: string, atBlock: number) => {
        db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(atBlock, id);
      },
      getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
      getKarmaValue: (owner: Uint8Array) =>
        getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
      hasActiveVouchCooldown: storeHasActiveVouchCooldown,
      runInTransaction: (fn: () => void) => { (db.transaction(fn) as () => void)(); },
      createInvite,
      claimInvite,
      cancelInvite,
      commitInvite,
      getCurrentHeight,
    };
    const app = express();
    app.use(express.json());
    app.use('/invites', createRouter({ ...deps, ...depOverrides }));
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
      value: 100n,
      owner: inviterId,
      guard: 'owner_signature',
      proofSource: 'test-create',
    };
    Object.assign(karma, fixtureProvenance(karma, 1));
    const karmaId = computeBoxId(karma);
    storeInsertBox({ ...karma, id: karmaId, boxType: 'karma', guard: 'owner_signature' } as KarmaBox);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 50n,
      owner: inviterId,
      guard: 'owner_signature',
      proofSource: 'create-invite',
    };
    Object.assign(newKarma, fixtureProvenance(newKarma, 1));
    const newKarmaId = computeBoxId(newKarma);

    const secretHash = new Uint8Array(32).fill(0x99);
    const inviteBox: InviteBox = {
      boxType: 'invite',
      value: INVITE_KARMA_AMOUNT,
      secretHash,
      inviterId,
      guard: 'hash_preimage_with_bond',
    };
    Object.assign(inviteBox, fixtureProvenance(inviteBox, 1));
    const inviteBoxId = computeBoxId(inviteBox);

    const bondBox: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      inviterId,
      inviteOutputIndex: 1,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual',
    };
    Object.assign(bondBox, fixtureProvenance(bondBox, 1));
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

  it('POST /invites/commit commits to BondBox and returns 201 with pending', async () => {
    const secret = new Uint8Array(32).fill(0x66);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    const inviteBox: InviteBox = {
      boxType: 'invite',
      value: INVITE_KARMA_AMOUNT,
      secretHash,
      inviterId,
      guard: 'hash_preimage_with_bond',
    };
    // Invite and bond are seeded as outputs 0 and 1 of ONE synthetic
    // transaction: the bond resolves its invite from
    // `(bond.txId, bond.inviteOutputIndex)`, so seeding them independently
    // would leave the bond addressing a transaction with no invite at that
    // index — the mispairing the index form makes inexpressible.
    const bondCandidate = {
      boxType: 'bond' as const,
      value: INVITE_BOND_KARMA,
      inviterId,
      inviteOutputIndex: 0,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual' as const,
    };
    const [seededInvite, seededBond] = seedAsOneTx([inviteBox, bondCandidate]);
    const inviteBoxId = seededInvite!.id!;
    const bondBoxId = seededBond!.id!;
    storeInsertBox(seededInvite!);
    storeInsertBox(seededBond!);

    const newKp = generateKeyPair();
    const inviteePubKey = newKp.publicKey;
    const inviteePubKeyHex = Buffer.from(inviteePubKey).toString('hex');
    const inviteePrivKeyObj = createPrivateKey({
      key: Buffer.from(newKp.secretKey),
      format: 'der',
      type: 'pkcs8',
    });

    // `checkTransitions` requires the output bond to preserve the input's
    // `inviteOutputIndex`, which the seeded pair above put at 0.
    const bondOut: CandidateOf<BondBox> = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      inviterId,
      inviteOutputIndex: 0,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 5,
      probationEndBlock: 5 + INVITE_PROBATION_BLOCKS,
      guard: 'bond_dual',
    };

    const tx: UtxoTransaction = {
      inputs: [bondBoxId],
      outputs: [bondOut],
      signatures: {},
      preimages: { [bondBoxId]: secret },
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviteePrivKeyObj, inviteePubKeyHex);

    // P2-B phase 1 pins `probationStartBlock <= settle height`. This suite seeds
    // boxes straight into the store and stores no ordering block, so the real
    // `getCurrentHeight` returns 0 and no window could satisfy both that bound
    // and `probationStartBlock > 0`. A bond box cannot exist on-chain at height
    // 0 — reaching it takes a confirmed invite-create — so the honest fixture is
    // a height at which this bond could actually be sitting there.
    const res = await request('/commit', 'POST', { tx: txToJson(tx) }, {
      getCurrentHeight: () => 5,
    });
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(typeof body.txId).toBe('string');
    expect(typeof body.expiresAtHeight).toBe('number');
    expect(typeof body.bondBoxId).toBe('string');
  });

  it('POST /invites/commit with missing tx returns 400', async () => {
    const res = await request('/commit', 'POST', {});
    expect(res.status).toBe(400);
  });

  it('POST /invites/claim claims an invite and returns 201 with pending', async () => {
    const secret = new Uint8Array(32).fill(0x55);
    const secretHash = createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32);

    const inviteBox: InviteBox = {
      boxType: 'invite',
      value: INVITE_KARMA_AMOUNT,
      secretHash,
      inviterId,
      guard: 'hash_preimage_with_bond',
    };
    // Invite and bond are seeded as outputs 0 and 1 of ONE synthetic
    // transaction: the bond resolves its invite from
    // `(bond.txId, bond.inviteOutputIndex)`, so seeding them independently
    // would leave the bond addressing a transaction with no invite at that
    // index — the mispairing the index form makes inexpressible.
    const bondCandidate = {
      boxType: 'bond' as const,
      value: INVITE_BOND_KARMA,
      inviterId,
      inviteOutputIndex: 0,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual' as const,
    };
    const [seededInvite, seededBond] = seedAsOneTx([inviteBox, bondCandidate]);
    const inviteBoxId = seededInvite!.id!;
    const bondBoxId = seededBond!.id!;
    storeInsertBox(seededInvite!);
    storeInsertBox(seededBond!);

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
        inviteOutputIndex: 1,
        inviteePublicKey: Array.from(inviteePubKey),
        probationStartBlock: 3,
        probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      }),
      bondBoxId,
    );

    const karmaOut: KarmaBox = {
      boxType: 'karma',
      value: INVITE_KARMA_AMOUNT,
      owner: inviteePubKey,
      guard: 'owner_signature',
      proofSource: `invite-claim:${inviteBoxId}`,
    };
    Object.assign(karmaOut, fixtureProvenance(karmaOut, 1));
    const karmaOutId = computeBoxId(karmaOut);

    const bondOut: BondBox = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      inviterId,
      inviteOutputIndex: 1,
      inviteePublicKey: inviteePubKey,
      probationStartBlock: 3,
      probationEndBlock: 3 + INVITE_PROBATION_BLOCKS,
      guard: 'bond_dual',
    };
    Object.assign(bondOut, fixtureProvenance(bondOut, 1));
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
      secretHash,
      inviterId,
      guard: 'hash_preimage_with_bond',
    };
    // Invite and bond are seeded as outputs 0 and 1 of ONE synthetic
    // transaction: the bond resolves its invite from
    // `(bond.txId, bond.inviteOutputIndex)`, so seeding them independently
    // would leave the bond addressing a transaction with no invite at that
    // index — the mispairing the index form makes inexpressible.
    const bondCandidate = {
      boxType: 'bond' as const,
      value: INVITE_BOND_KARMA,
      inviterId,
      inviteOutputIndex: 0,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual' as const,
    };
    const [seededInvite, seededBond] = seedAsOneTx([inviteBox, bondCandidate]);
    const inviteBoxId = seededInvite!.id!;
    const bondBoxId = seededBond!.id!;
    storeInsertBox(seededInvite!);
    storeInsertBox(seededBond!);

    const karmaIn: KarmaBox = {
      boxType: 'karma',
      value: 200n,
      owner: inviterId,
      guard: 'owner_signature',
      proofSource: 'test-cancel',
    };
    Object.assign(karmaIn, fixtureProvenance(karmaIn, 1));
    const karmaInId = computeBoxId(karmaIn);
    storeInsertBox({ ...karmaIn, id: karmaInId, boxType: 'karma', guard: 'owner_signature' } as KarmaBox);

    const totalValue = 200n + INVITE_KARMA_AMOUNT + INVITE_BOND_KARMA;
    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: totalValue,
      owner: inviterId,
      guard: 'owner_signature',
      proofSource: `invite-cancel:${inviteBoxId}`,
    };
    Object.assign(newKarma, fixtureProvenance(newKarma, 1));
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
      secretHash,
      inviterId,
      guard: 'hash_preimage_with_bond',
    };
    // Invite and bond are seeded as outputs 0 and 1 of ONE synthetic
    // transaction: the bond resolves its invite from
    // `(bond.txId, bond.inviteOutputIndex)`, so seeding them independently
    // would leave the bond addressing a transaction with no invite at that
    // index — the mispairing the index form makes inexpressible.
    const bondCandidate = {
      boxType: 'bond' as const,
      value: INVITE_BOND_KARMA,
      inviterId,
      inviteOutputIndex: 0,
      inviteePublicKey: new Uint8Array(0),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual' as const,
    };
    const [seededInvite, seededBond] = seedAsOneTx([inviteBox, bondCandidate]);
    const inviteBoxId = seededInvite!.id!;
    const bondBoxId = seededBond!.id!;
    storeInsertBox(seededInvite!);
    storeInsertBox(seededBond!);

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
      value: 200n,
      owner: wrongPubKey,
      guard: 'owner_signature',
      proofSource: 'test-wrong',
    };
    Object.assign(wrongKarma, fixtureProvenance(wrongKarma, 1));
    const wrongKarmaId = computeBoxId(wrongKarma);
    storeInsertBox({ ...wrongKarma, id: wrongKarmaId, boxType: 'karma', guard: 'owner_signature' } as KarmaBox);

    const totalValue = 200n + INVITE_KARMA_AMOUNT + INVITE_BOND_KARMA;
    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: totalValue,
      owner: wrongPubKey,
      guard: 'owner_signature',
      proofSource: `invite-cancel:${inviteBoxId}`,
    };
    Object.assign(newKarma, fixtureProvenance(newKarma, 1));
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

  // ---------------------------------------------------------------------------
  // Route error policy (audit L-12, M-8). These routes answer with the bare
  // `{ error: <message> }` shape, so the assertions below read `error`.
  // ---------------------------------------------------------------------------

  describe('error policy', () => {
    const SECRET = 'SQLITE_BUSY: database is locked at /srv/dagsocial.db';
    const EMPTY_TX = { inputs: [], outputs: [], signatures: {}, protocolVersion: 1 };

    it('returns a generic 500 and logs when the service throws an unexpected error', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await request('/', 'POST', { tx: EMPTY_TX }, {
          createInvite: () => {
            throw new Error(SECRET);
          },
        });

        expect(res.status).toBe(500);
        expect((res.data as Record<string, unknown>).error).toBe('Internal error');
        expect(JSON.stringify(res.data)).not.toContain('SQLITE_BUSY');
        expect(JSON.stringify(res.data)).not.toContain('/srv/dagsocial.db');
        expect(
          error.mock.calls.some((c) => c.some((a) => String((a as Error)?.message ?? a).includes('SQLITE_BUSY'))),
        ).toBe(true);
      } finally {
        error.mockRestore();
      }
    });

    it('control — an intentional rejection still returns its message with 400', async () => {
      const res = await request('/', 'POST', { tx: EMPTY_TX }, {
        createInvite: () => {
          throw new ClientError('Invite limit reached: 5 pending invites (max 5)');
        },
      });

      expect(res.status).toBe(400);
      expect((res.data as Record<string, unknown>).error).toBe(
        'Invite limit reached: 5 pending invites (max 5)',
      );
    });

    it('carries a 409 on the typed error instead of sniffing the message', async () => {
      const res = await request('/commit', 'POST', { tx: EMPTY_TX }, {
        commitInvite: () => {
          throw new ClientError('BondBox already committed', 409);
        },
      });

      expect(res.status).toBe(409);
      expect((res.data as Record<string, unknown>).error).toBe('BondBox already committed');
    });

    it('maps a full mempool to 503 with a generic body', async () => {
      const res = await request('/claim', 'POST', { tx: EMPTY_TX }, {
        claimInvite: () => {
          throw new MempoolFullError(10000);
        },
      });

      expect(res.status).toBe(503);
      expect(res.data).toEqual({ error: 'mempool full' });
    });

    it('keeps returning decode errors verbatim with 400', async () => {
      const res = await request('/', 'POST', { tx: { outputs: [{ value: -1 }] } });

      expect(res.status).toBe(400);
      expect(String((res.data as Record<string, unknown>).error)).toContain(
        'box value must be a non-negative bigint',
      );
    });
  });
});
