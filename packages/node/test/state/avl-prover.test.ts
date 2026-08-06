import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BatchAVLProver } from '@ergots/avltree';
import { SqliteAvlStorage } from '../../src/state/avl-storage.js';
import {
  createAvlProver,
  applyBlockMutations,
  bootstrapAvlProver,
  checkpointProver,
  HEIGHT_SENTINEL,
  encodeHeight,
} from '../../src/state/avl-prover.js';
import { serializeBox } from '../../src/state/serialize-box.js';
import { config } from '../../src/config.js';

/** Storage codec config -- must match the prover createAvlProver() builds. */
const AVL_CONFIG = { keyLength: config.avlKeyLength, valueLengthOpt: null };

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
    const box = makeKarmaBox('aa'.repeat(32), 100n, 1);
    const consumed: string[] = [];
    const created = [box];

    const newDigest = applyBlockMutations(prover, consumed, created);
    expect(newDigest).not.toEqual(initialDigest);
    expect(newDigest.length).toBe(33);
  });

  it('consume + create produces different digest than create alone', () => {
    const { prover } = createAvlProver(db);

    const box1 = makeKarmaBox('aa'.repeat(32), 100n, 1);
    const box2 = makeKarmaBox('bb'.repeat(32), 50n, 2);

    // Create box1
    const d1 = applyBlockMutations(prover, [], [box1]);

    // Create box2, consume box1
    const d2 = applyBlockMutations(prover, ['aa'.repeat(32)], [box2]);

    expect(Buffer.from(d1).equals(Buffer.from(d2))).toBe(false);
  });

  it('deterministic: same operations produce same digest', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db);

    const box = makeKarmaBox('cc'.repeat(32), 42n, 1);
    const d1 = applyBlockMutations(p1, [], [box]);
    const d2 = applyBlockMutations(p2, [], [box]);

    expect(Buffer.from(d1).equals(Buffer.from(d2))).toBe(true);
  });
});

describe('block-apply integration', () => {
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

  it('prover tracks insertBox and consumeBox correctly', () => {
    const { prover: handle } = createAvlProver(db);

    // Simulate block application: create two boxes, consume one
    const box1 = makeKarmaBox('11'.repeat(32), 100n, 1);
    const box2 = makeKarmaBox('22'.repeat(32), 50n, 1);

    applyBlockMutations(handle, [], [box1, box2]);
    checkpointProver({ prover: handle, storage: new SqliteAvlStorage(db, AVL_CONFIG) }, 1);
    const digestAfterCreate = handle.digest()!;

    // Consume box1, create box3
    const box3 = makeKarmaBox('33'.repeat(32), 25n, 2);
    applyBlockMutations(handle, ['11'.repeat(32)], [box3]);
    checkpointProver({ prover: handle, storage: new SqliteAvlStorage(db, AVL_CONFIG) }, 2);
    const digestAfterConsume = handle.digest()!;

    expect(Buffer.from(digestAfterCreate).equals(Buffer.from(digestAfterConsume))).toBe(false);
  });

  it('prover state survives checkpoint and can be queried', () => {
    const { prover: handle } = createAvlProver(db);

    const box1 = makeKarmaBox('aa'.repeat(32), 100n, 1);
    applyBlockMutations(handle, [], [box1]);
    checkpointProver({ prover: handle, storage: new SqliteAvlStorage(db, AVL_CONFIG) }, 1);

    // After checkpoint, digest should still be accessible
    const digest = handle.digest();
    expect(digest).not.toBeNull();
    expect(digest!.length).toBe(33);
  });
});

// ---------------------------------------------------------------------------
// Spec B P2 (M-12): the AVL digest is insertion-order-sensitive, so the
// prover boundary sorts every feed. Same box sets in any input order must
// land on the identical digest.
// ---------------------------------------------------------------------------

describe('canonical prover-feed ordering (M-12)', () => {
  let db: Database.Database;
  let db2: Database.Database;

  beforeEach(() => {
    db = makeAvlDb();
    db2 = makeAvlDb();
  });

  afterEach(() => {
    db.close();
    db2.close();
  });

  /** Ids deliberately NOT in sorted order, so input order ≠ canonical order. */
  const BASE_IDS = ['55', 'aa', '11', 'ee', '88'].map((b) => b.repeat(32));

  /** Fresh prover with the same five-box starting tree. */
  function seededProver(database: Database.Database) {
    const { prover } = createAvlProver(database);
    applyBlockMutations(prover, [], BASE_IDS.map((id) => makeKarmaBox(id, 10n, 1)));
    return prover;
  }

  it('same consumed/created sets in shuffled orders → identical digest', () => {
    const p1 = seededProver(db);
    const p2 = seededProver(db2);

    const consumed = ['ee'.repeat(32), '11'.repeat(32), '88'.repeat(32)];
    const created = ['cc', '22', '99'].map((b) => makeKarmaBox(b.repeat(32), 7n, 2));

    const d1 = applyBlockMutations(p1, consumed, created);
    const d2 = applyBlockMutations(
      p2,
      [consumed[2]!, consumed[0]!, consumed[1]!],
      [created[1]!, created[2]!, created[0]!],
    );

    expect(Buffer.from(d1).equals(Buffer.from(d2))).toBe(true);
  });

  it('empty mutation set leaves the digest unchanged on both provers', () => {
    const p1 = seededProver(db);
    const p2 = seededProver(db2);
    const before = new Uint8Array(p1.digest()!);

    const d1 = applyBlockMutations(p1, [], []);
    const d2 = applyBlockMutations(p2, [], []);

    expect(Buffer.from(d1).equals(Buffer.from(before))).toBe(true);
    expect(Buffer.from(d1).equals(Buffer.from(d2))).toBe(true);
  });

  it('removes-only in shuffled orders → identical digest', () => {
    const p1 = seededProver(db);
    const p2 = seededProver(db2);

    const d1 = applyBlockMutations(
      p1,
      ['aa'.repeat(32), '55'.repeat(32), 'ee'.repeat(32)],
      [],
    );
    const d2 = applyBlockMutations(
      p2,
      ['ee'.repeat(32), 'aa'.repeat(32), '55'.repeat(32)],
      [],
    );

    expect(Buffer.from(d1).equals(Buffer.from(d2))).toBe(true);
  });

  it('inserts-only in shuffled orders → identical digest', () => {
    const p1 = seededProver(db);
    const p2 = seededProver(db2);

    const boxes = ['cc', '22', '99', '44'].map((b) => makeKarmaBox(b.repeat(32), 5n, 2));
    const d1 = applyBlockMutations(p1, [], boxes);
    const d2 = applyBlockMutations(p2, [], [...boxes].reverse());

    expect(Buffer.from(d1).equals(Buffer.from(d2))).toBe(true);
  });

  it('bootstrapAvlProver: same unspent set in shuffled orders → identical digest', () => {
    const h1 = createAvlProver(db);
    const h2 = createAvlProver(db2);

    const boxes = ['bb', '33', 'dd', '66', '11'].map((b) =>
      makeKarmaBox(b.repeat(32), 12n, 0),
    );
    bootstrapAvlProver(h1, boxes, 0, []);
    bootstrapAvlProver(h2, [...boxes].reverse(), 0, []);

    const d1 = h1.prover.digest();
    const d2 = h2.prover.digest();
    expect(d1).not.toBeNull();
    expect(d2).not.toBeNull();
    expect(Buffer.from(d1!).equals(Buffer.from(d2!))).toBe(true);
  });

  // --- Two entity kinds through bootstrap (Spec G phase D) -----------------

  it('bootstrapAvlProver: shuffled records → identical digest', () => {
    const h1 = createAvlProver(db);
    const h2 = createAvlProver(db2);

    const records = ['ee', '77', '55'].map((b) => ({
      key: b.repeat(32),
      record: { lastActivityBlock: 4, lastDecayBlock: 2 },
    }));
    bootstrapAvlProver(h1, [], 0, records);
    bootstrapAvlProver(h2, [], 0, [...records].reverse());

    expect(
      Buffer.from(h1.prover.digest()!).equals(Buffer.from(h2.prover.digest()!)),
    ).toBe(true);
  });

  it('a bootstrapped tree and a live tree agree once records exist', () => {
    // The restart fork this parameter exists to prevent. A node that stays up
    // grows its tree block by block through `applyBlockMutations`; a node that
    // restarts with empty AVL storage rebuilds it from the store through
    // `bootstrapAvlProver`. Both hold two committed entity kinds, and if the
    // rebuild fed only boxes the two nodes would disagree on `stateRoot` while
    // agreeing on every committed byte — undetectable until a block is rejected.
    const boxes = ['bb', '33', 'dd'].map((b) => makeKarmaBox(b.repeat(32), 12n, 0));
    const records = ['ee', '77'].map((b, i) => ({
      key: b.repeat(32),
      record: { lastActivityBlock: 10 + i, lastDecayBlock: i },
    }));

    // Live: boxes and records arrive together, as one block's mutations.
    const live = createAvlProver(db);
    applyBlockMutations(live.prover, [], boxes, records);

    // Restarted: same committed state, rebuilt from the store.
    const restarted = createAvlProver(db2);
    bootstrapAvlProver(restarted, boxes, 0, records);

    expect(
      Buffer.from(live.prover.digest()!).equals(Buffer.from(restarted.prover.digest()!)),
    ).toBe(true);
  });

  it('a bootstrap that drops the records does NOT agree with the live tree', () => {
    // Non-vacuity for the test above: if the digests matched with the records
    // omitted, the comparison would prove nothing about them.
    const boxes = ['bb', '33'].map((b) => makeKarmaBox(b.repeat(32), 12n, 0));
    const records = [
      { key: 'ee'.repeat(32), record: { lastActivityBlock: 10, lastDecayBlock: 1 } },
    ];

    const live = createAvlProver(db);
    applyBlockMutations(live.prover, [], boxes, records);

    const restarted = createAvlProver(db2);
    bootstrapAvlProver(restarted, boxes, 0, []); // the forgotten argument

    expect(
      Buffer.from(live.prover.digest()!).equals(Buffer.from(restarted.prover.digest()!)),
    ).toBe(false);
  });

  it('bootstrap record values are committed, not just their keys', () => {
    // Two trees over the same key with different clocks must differ, or the
    // record would be a membership marker rather than committed state.
    const a = createAvlProver(db);
    const b = createAvlProver(db2);
    const key = 'ee'.repeat(32);

    bootstrapAvlProver(a, [], 0, [{ key, record: { lastActivityBlock: 10, lastDecayBlock: 1 } }]);
    bootstrapAvlProver(b, [], 0, [{ key, record: { lastActivityBlock: 11, lastDecayBlock: 1 } }]);

    expect(
      Buffer.from(a.prover.digest()!).equals(Buffer.from(b.prover.digest()!)),
    ).toBe(false);
  });
});

/** In-memory DB carrying the AVL storage schema (mirrors the suite setup). */
function makeAvlDb(): Database.Database {
  const database = new Database(':memory:');
  database.pragma('journal_mode = WAL');
  database.exec(`
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
  return database;
}

function makeKarmaBox(id: string, value: bigint, height: number) {
  return {
    id,
    boxType: 'karma' as const,
    value,
    owner: new Uint8Array(32).fill(0x77),
    guard: 'owner_signature' as const,
    proofSource: 'mint-1',
  };
}
