// ---------------------------------------------------------------------------
// Vouch routes THROUGH THE JSON EDGE (NODE_INTERFACE → Vouches, "The JSON
// edge").
//
// These did not exist, and that absence is what hid the defect: vouch coverage
// was service-level only, handing `castVouch`/`initiateUnvouch` raw
// `Uint8Array` objects that never touched `jsonToTx`. Over real HTTP the cast
// was INEXPRESSIBLE — `BINARY_BOX_FIELDS` lacked `voucherId`/`targetId`, so
// both arrived as hex strings and died at `validateTx`'s step-4 schema, which
// wants `bytes32`. A whole route pair, unreachable, with a green suite.
//
// The demo UI's vouch buttons are still unmigrated (they POST `{userId,
// targetId}` with no `tx` and die at the routes' `tx required` 400). That is a
// separate recorded phase; this file restores the edge underneath it and stops
// there.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import Database from 'better-sqlite3';
import {
  computeBoxId,
  computeTxId,
  PROTOCOL_VERSION,
  VOUCH_KARMA_AMOUNT,
  VOUCH_MIN_BALANCE,
} from '@dagsocial/types';
import type { AnyBox, KarmaBox, UtxoTransaction, VouchBox } from '@dagsocial/types';

import { fixtureProvenance, rawPublicKey, signTransaction, txToJson } from '../helpers.js';
import {
  initDb,
  closeDb,
  getDb,
  getBox as storeGetBox,
  getBoxByProvenance,
  getKarmaBox,
  getKarmaBoxes,
  insertBox,
  consumeBox,
  hasActiveVouchCooldown,
} from '../../src/store/index.js';
import { castVouch, initiateUnvouch } from '../../src/services/vouch.js';
import { materializeOutput } from '../../src/services/utxo-engine.js';
import { jsonToTx } from '../../src/routes/json-to-tx.js';
import { createRouter } from '../../src/routes/vouches.js';

const HEIGHT = 100;

describe('vouch routes — the JSON edge', () => {
  let db: Database.Database;
  let voucher: { pub: Uint8Array; hex: string; priv: KeyObject };
  let target: { pub: Uint8Array; hex: string };

  function makeKeys() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = rawPublicKey(publicKey);
    return { pub, hex: Buffer.from(pub).toString('hex'), priv: privateKey };
  }

  function engineDeps() {
    return {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db
          .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
          .get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
      getBoxByProvenance,
      insertBox: (box: AnyBox) => insertBox(box),
      consumeBox: (id: string, atBlock: number) => consumeBox(id, atBlock),
      getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
      getKarmaValue: (owner: Uint8Array): bigint =>
        getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
      hasActiveVouchCooldown,
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
    };
  }

  /** Drive the real router over real HTTP, exactly as a client would. */
  async function request(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
  ): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve) => {
      const deps = {
        ...engineDeps(),
        castVouch,
        initiateUnvouch,
        getCurrentHeight: () => HEIGHT,
      };
      const app = express();
      app.use(express.json());
      app.use(createRouter(deps));
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        // Content-Length is set explicitly rather than left to Node. Node
        // disables chunked-encoding-by-default for DELETE (as for GET/HEAD/
        // OPTIONS), so a written body would go out with no framing header at
        // all and `express.json()` — which needs `content-length` or
        // `transfer-encoding` to believe a body exists — would hand the
        // handler `{}`, producing a "tx required" 400. A test artifact, not a
        // product defect: every real client (fetch, curl -d, axios) sets the
        // header itself.
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const req = http.request(
          {
            hostname: 'localhost',
            port: addr.port,
            path,
            method,
            headers: {
              'Content-Type': 'application/json',
              ...(payload ? { 'Content-Length': String(payload.length) } : {}),
            },
          },
          (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => {
              server.close();
              try {
                resolve({ status: res.statusCode!, data: JSON.parse(d) });
              } catch {
                resolve({ status: res.statusCode!, data: d });
              }
            });
          },
        );
        if (payload) req.write(payload);
        req.end();
      });
    });
  }

  function seedKarma(owner: Uint8Array, value: bigint, nonce = 0): KarmaBox {
    const candidate = {
      boxType: 'karma' as const,
      value,
      owner,
      guard: 'owner_signature' as const,
      proofSource: 'test',
    };
    Object.assign(candidate, fixtureProvenance(candidate, 1, nonce));
    const box = { ...candidate, id: computeBoxId(candidate) } as KarmaBox;
    insertBox(box);
    return box;
  }

  function seedVouchBox(voucherId: Uint8Array, targetId: Uint8Array, nonce = 0): VouchBox {
    const candidate = {
      boxType: 'vouch' as const,
      value: VOUCH_KARMA_AMOUNT,
      voucherId,
      targetId,
      guard: 'owner_signature' as const,
    };
    Object.assign(candidate, fixtureProvenance(candidate, 1, nonce));
    const box = { ...candidate, id: computeBoxId(candidate) } as unknown as VouchBox;
    insertBox(box);
    return box;
  }

  /**
   * A signed vouch cast built with RAW BYTES — the reference construction.
   * `txToJson` then hex-encodes it into what a client actually sends.
   */
  function rawVouchCast(karmaBox: KarmaBox): UtxoTransaction {
    const change: KarmaBox = {
      boxType: 'karma',
      value: karmaBox.value - VOUCH_KARMA_AMOUNT,
      owner: voucher.pub,
      guard: 'owner_signature',
      proofSource: `vouch:${target.hex}`,
    };
    const vouchOut = {
      boxType: 'vouch' as const,
      value: VOUCH_KARMA_AMOUNT,
      voucherId: voucher.pub,
      targetId: target.pub,
      guard: 'owner_signature' as const,
    };
    const tx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [change, vouchOut as unknown as VouchBox],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, voucher.priv, voucher.hex);
    return tx;
  }

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();
    voucher = makeKeys();
    target = makeKeys();
  });

  afterEach(() => {
    closeDb();
  });

  // -------------------------------------------------------------------------
  // Cast
  // -------------------------------------------------------------------------

  it('POST /vouches accepts a JSON-built cast with hex voucherId/targetId', async () => {
    const karmaBox = seedKarma(voucher.pub, VOUCH_MIN_BALANCE + VOUCH_KARMA_AMOUNT);
    const tx = rawVouchCast(karmaBox);
    const json = txToJson(tx);

    // What actually crosses the wire: both VouchBox identity fields as hex
    // STRINGS. Before `BINARY_BOX_FIELDS` gained them this is where it died.
    const vouchJson = (json.outputs as Array<Record<string, unknown>>)[1]!;
    expect(typeof vouchJson['voucherId']).toBe('string');
    expect(typeof vouchJson['targetId']).toBe('string');
    expect(vouchJson['voucherId']).toBe(voucher.hex);
    expect(vouchJson['targetId']).toBe(target.hex);

    const res = await request('/', 'POST', { tx: json });
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body['status']).toBe('pending');
    expect(body['txId']).toBe(computeTxId(tx));
    expect(body['expiresAtHeight']).toBeGreaterThan(HEIGHT);
  });

  it('id integrity: the JSON edge converts hex to bytes BEFORE the id preimage', async () => {
    // The class-4 discriminator. `canonicalBoxBytes` hashes whatever the field
    // holds, so a hex STRING and its 32 bytes produce different box ids — and
    // different tx ids. If the conversion happened after the preimage (or not
    // at all), the two constructions would disagree here while both still
    // "working" end to end. Nothing else in the suite would notice.
    const karmaBox = seedKarma(voucher.pub, VOUCH_MIN_BALANCE + VOUCH_KARMA_AMOUNT);
    const raw = rawVouchCast(karmaBox);
    const throughEdge = jsonToTx(txToJson(raw));

    expect(computeTxId(throughEdge)).toBe(computeTxId(raw));

    const txId = computeTxId(raw);
    const edgeBox = materializeOutput(throughEdge.outputs[1]!, txId, 1);
    const rawBox = materializeOutput(raw.outputs[1]!, txId, 1);
    expect(edgeBox.id).toBe(rawBox.id);

    // And the field really is bytes on the far side, not a 64-char string.
    const edgeVouch = throughEdge.outputs[1] as unknown as VouchBox;
    expect(edgeVouch.voucherId).toBeInstanceOf(Uint8Array);
    expect(edgeVouch.targetId).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(edgeVouch.voucherId).toString('hex')).toBe(voucher.hex);
    expect(Buffer.from(edgeVouch.targetId).toString('hex')).toBe(target.hex);
  });

  it('POST /vouches still requires a tx — the unmigrated UI shape 400s', async () => {
    // Documents, not fixes, the recorded UI phase: the demo's button sends
    // this and gets a 400 before `jsonToTx` runs.
    const res = await request('/', 'POST', { userId: voucher.hex, targetId: target.hex });
    expect(res.status).toBe(400);
    expect((res.data as Record<string, unknown>)['reason']).toBe('tx required');
  });

  // -------------------------------------------------------------------------
  // Unvouch
  // -------------------------------------------------------------------------

  it('DELETE /vouches/:targetId accepts a JSON-built unvouch', async () => {
    const vouchBox = seedVouchBox(voucher.pub, target.pub);
    const tx: UtxoTransaction = {
      inputs: [vouchBox.id!],
      outputs: [],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, voucher.priv, voucher.hex);

    const res = await request(`/${target.hex}`, 'DELETE', { tx: txToJson(tx) });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body['status']).toBe('pending');
    expect(body['txId']).toBe(computeTxId(tx));
    expect(body['karmaReturnsAtBlock']).toBeGreaterThan(HEIGHT);
  });

  // -------------------------------------------------------------------------
  // The read surface an unvouch builder needs
  // -------------------------------------------------------------------------

  it('GET /vouches?voucher=X names the VouchBox each entry would spend', async () => {
    const vouchBox = seedVouchBox(voucher.pub, target.pub);

    const res = await request(`/?voucher=${voucher.hex}`, 'GET');
    expect(res.status).toBe(200);
    const body = res.data as { vouches: Array<Record<string, unknown>>; count: number };
    expect(body.count).toBe(1);
    expect(body.vouches[0]).toEqual({
      boxId: vouchBox.id,
      voucherId: voucher.hex,
      targetId: target.hex,
    });
    // Without this an unvouch was unbuildable from the API alone: the
    // transaction spends a NAMED box and no read surface exposed one.
    expect(body.vouches[0]!['boxId']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the boxId a listing hands out is the one an unvouch can actually spend', async () => {
    // End-to-end closure of the loop: list, then spend exactly what was listed.
    seedVouchBox(voucher.pub, target.pub);
    const listed = (
      (await request(`/?voucher=${voucher.hex}`, 'GET')).data as {
        vouches: Array<{ boxId: string }>;
      }
    ).vouches[0]!.boxId;

    const tx: UtxoTransaction = {
      inputs: [listed],
      outputs: [],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, voucher.priv, voucher.hex);

    const res = await request(`/${target.hex}`, 'DELETE', { tx: txToJson(tx) });
    expect(res.status).toBe(200);
  });
});
