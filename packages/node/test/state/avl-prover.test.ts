import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BatchAVLProver } from '@ergots/avltree';
import { SqliteAvlStorage } from '../../src/state/avl-storage.js';
import {
  createAvlProver,
  applyBlockMutations,
  HEIGHT_SENTINEL,
  encodeHeight,
} from '../../src/state/avl-prover.js';
import { serializeBox } from '../../src/state/serialize-box.js';

describe('avl-prover', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE avl_tree_versions (
        version BLOB PRIMARY KEY,
        height INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE avl_tree_nodes (
        version BLOB NOT NULL REFERENCES avl_tree_versions(version),
        label BLOB NOT NULL,
        node_data BLOB NOT NULL,
        PRIMARY KEY (version, label)
      );
    `);
  });

  afterEach(() => { db.close(); });

  it('createAvlProver() returns a PersistentBatchAVLProver with non-null digest on empty DB', () => {
    const { prover } = createAvlProver(db);
    expect(prover.digest()).not.toBeNull();
    // Empty tree still has a digest (the sentinel neg-inf leaf)
  });

  it('applyBlockMutations() updates the prover and returns new digest', () => {
    const { prover } = createAvlProver(db);
    const initialDigest = prover.digest()!;

    // Create a box
    const box = makeKarmaBox('aa'.repeat(32), 100, 1);
    const consumed: string[] = [];
    const created = [box];

    const newDigest = applyBlockMutations(prover, consumed, created);
    expect(newDigest).not.toEqual(initialDigest);
    expect(newDigest.length).toBe(33);
  });

  it('consume + create produces different digest than create alone', () => {
    const { prover } = createAvlProver(db);

    const box1 = makeKarmaBox('aa'.repeat(32), 100, 1);
    const box2 = makeKarmaBox('bb'.repeat(32), 50, 2);

    // Create box1
    const d1 = applyBlockMutations(prover, [], [box1]);

    // Create box2, consume box1
    const d2 = applyBlockMutations(prover, ['aa'.repeat(32)], [box2]);

    expect(Buffer.from(d1).equals(Buffer.from(d2))).toBe(false);
  });

  it('deterministic: same operations produce same digest', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db);

    const box = makeKarmaBox('cc'.repeat(32), 42, 1);
    const d1 = applyBlockMutations(p1, [], [box]);
    const d2 = applyBlockMutations(p2, [], [box]);

    expect(Buffer.from(d1).equals(Buffer.from(d2))).toBe(true);
  });
});

function makeKarmaBox(id: string, value: number, height: number) {
  return {
    id,
    boxType: 'karma' as const,
    value,
    createdAtBlock: height,
    owner: new Uint8Array(32).fill(0x77),
    guard: 'owner_signature' as const,
    proofSource: 'mint-1',
    lastTouchBlock: height,
  };
}
