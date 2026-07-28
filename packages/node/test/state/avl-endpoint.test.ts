import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { createAvlProver, applyBlockMutations, checkpointProver } from '../../src/state/avl-prover.js';
import { registerProofEndpoint } from '../../src/state/avl-endpoint.js';

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
      value: 100,
      createdAtBlock: 1,
      owner: new Uint8Array(32).fill(0xaa),
      guard: 'owner_signature' as const,
      proofSource: 'mint-1',
      lastTouchBlock: 1,
    };
    applyBlockMutations(handle.prover, [], [box]);
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
    expect(res.body.proof).toBeTruthy(); // base64 proof
    expect(res.body.stateRoot).toBeTruthy(); // hex state root
  });

  it('returns value=null for a non-existent box', async () => {
    const res = await request(app)
      .get('/api/v1/proof/' + 'bb'.repeat(32))
      .expect(200);

    expect(res.body.value).toBeNull();
    expect(res.body.proof).toBeTruthy(); // exclusion proof still returned
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
