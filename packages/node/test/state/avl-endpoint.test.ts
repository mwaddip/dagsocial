import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { createAvlProver, applyBlockMutations, checkpointProver } from '../../src/state/avl-prover.js';
import { registerProofEndpoint } from '../../src/state/avl-endpoint.js';

/** An identity-record AVL key. Not a box id, and not distinguishable as one. */
const RECORD_KEY = 'cc'.repeat(32);

describe('GET /api/v1/proof/:boxId', () => {
  let app: express.Express;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE avl_tree_versions (version BLOB PRIMARY KEY, height INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE avl_tree_nodes (version BLOB NOT NULL REFERENCES avl_tree_versions(version), label BLOB NOT NULL, node_data BLOB NOT NULL, PRIMARY KEY (version, label));
    `);

    const handle = createAvlProver(db);

    // Create a box at height 1
    const box = {
      id: 'aa'.repeat(32),
      boxType: 'karma' as const,
      value: 100n,
      owner: new Uint8Array(32).fill(0xaa),
      guard: 'owner_signature' as const,
      proofSource: 'mint-1',
    };
    // Spec G phase D: the tree holds two entity kinds, so the fixture does too.
    applyBlockMutations(handle.prover, [], [box], [
      { key: RECORD_KEY, record: { lastActivityBlock: 7, lastDecayBlock: 3, likeCarry: 0n } },
    ]);
    checkpointProver(handle, 1);

    app = express();
    app.use(express.json());
    registerProofEndpoint(app, handle);
  });

  afterEach(() => { db.close(); });

  it('returns box data for an existing box at current tip', async () => {
    const res = await request(app)
      .get('/api/v1/proof/' + 'aa'.repeat(32))
      .expect(200);

    expect(res.body.boxId).toBe('aa'.repeat(32));
    expect(res.body.atHeight).toBe(1);
    expect(res.body.value).not.toBeNull();
    expect(res.body.value.boxType).toBe('karma');
    expect(res.body.kind).toBe('box');
    expect(res.body.proof).toBeTruthy(); // base64 proof
    expect(res.body.stateRoot).toBeTruthy(); // hex state root
  });

  it('returns value=null for a non-existent box', async () => {
    const res = await request(app)
      .get('/api/v1/proof/' + 'bb'.repeat(32))
      .expect(200);

    expect(res.body.value).toBeNull();
    expect(res.body.kind).toBeNull();
    expect(res.body.proof).toBeTruthy(); // exclusion proof still returned
  });

  // --- Two entity kinds (Spec G phase D) -----------------------------------

  it('serves an identity record instead of throwing on it', async () => {
    // The phase-D obligation. Keys are indistinguishable from outside — both
    // kinds are 32 bytes of hash output — so a client can ask for a record key,
    // and before this the endpoint decoded every value as a box and 500'd.
    const res = await request(app)
      .get('/api/v1/proof/' + RECORD_KEY)
      .expect(200);

    expect(res.body.kind).toBe('record');
    // `likeCarry` rides JSON as a decimal string — the same discipline as box
    // `value`; JSON.stringify throws on bigint.
    expect(res.body.value).toEqual({ lastActivityBlock: 7, lastDecayBlock: 3, likeCarry: '0' });
    expect(res.body.proof).toBeTruthy();
    expect(res.body.stateRoot).toBeTruthy();
  });

  it('does not present a record as a box', async () => {
    // A record served under a box-shaped response would be worse than the 500:
    // a light client would verify the proof, read `boxType: undefined`, and
    // treat committed state as a malformed box rather than another entity.
    const res = await request(app)
      .get('/api/v1/proof/' + RECORD_KEY)
      .expect(200);

    expect(res.body.value.boxType).toBeUndefined();
    expect(res.body.kind).not.toBe('box');
  });

  it('a record answer is still a proof at the same stateRoot as a box answer', async () => {
    // Both kinds share one tree and one digest; the endpoint must not serve
    // records from some side channel.
    const boxRes = await request(app).get('/api/v1/proof/' + 'aa'.repeat(32)).expect(200);
    const recRes = await request(app).get('/api/v1/proof/' + RECORD_KEY).expect(200);

    expect(recRes.body.stateRoot).toBe(boxRes.body.stateRoot);
    expect(recRes.body.atHeight).toBe(boxRes.body.atHeight);
  });

  it('serves a record from a historical version too', async () => {
    // The rollback branch is a separate code path from the at-tip branch, and
    // it had its own `deserializeBoxWithId` call.
    const handle = createAvlProver(db);
    applyBlockMutations(handle.prover, [], [], [
      { key: RECORD_KEY, record: { lastActivityBlock: 9, lastDecayBlock: 9, likeCarry: 0n } },
    ]);
    checkpointProver(handle, 2);

    const app2 = express();
    app2.use(express.json());
    registerProofEndpoint(app2, handle);

    const atTip = await request(app2).get('/api/v1/proof/' + RECORD_KEY).expect(200);
    expect(atTip.body.value).toEqual({ lastActivityBlock: 9, lastDecayBlock: 9, likeCarry: '0' });

    const historical = await request(app2)
      .get('/api/v1/proof/' + RECORD_KEY + '?atHeight=1')
      .expect(200);
    expect(historical.body.kind).toBe('record');
    expect(historical.body.value).toEqual({ lastActivityBlock: 7, lastDecayBlock: 3, likeCarry: '0' });
  });

  it('returns 400 for invalid boxId length', async () => {
    await request(app)
      .get('/api/v1/proof/abc')
      .expect(400);
  });

  it('returns 404 for unavailable height', async () => {
    await request(app)
      .get('/api/v1/proof/' + 'aa'.repeat(32) + '?atHeight=999')
      .expect(404);
  });
});
