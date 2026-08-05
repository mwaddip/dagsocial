import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { AnyBox, KarmaBox, CreditBox, LikeBox } from '@dagsocial/types';

/**
 * Spec G phase B — box provenance columns (`tx_id`, `output_index`).
 *
 * The consensus hazard these tests exist for: `state/serialize-box.ts` strips
 * only `id`/`boxType`, so provenance reaches the AVL *value*, and cbor-x
 * distinguishes an absent key from a present-but-`undefined` one. If `rowToBox`
 * assigned `txId: undefined`/`index: undefined` unconditionally, a box read back
 * from SQLite would serialize to different bytes than the same box built by a
 * producer — so a node that restarts and re-bootstraps its prover from
 * `getUnspentBoxes` would compute a different `stateRoot` than one that stayed
 * up. A restart-triggered consensus fork, from nothing but an object shape.
 */

async function importDbFresh() {
  return (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importUtxoFresh() {
  return (await import('../../src/store/utxo.js')) as {
    getBox: (boxId: string) => AnyBox | null;
    getUnspentBoxes: () => AnyBox[];
    insertBox: (box: AnyBox) => void;
  };
}

function bytes(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

const OWNER = bytes(32);

function makeKarmaBox(id: string, overrides: Partial<KarmaBox> = {}): KarmaBox {
  return {
    id,
    boxType: 'karma',
    value: 100n,
    createdAtBlock: 1,
    owner: OWNER,
    guard: 'owner_signature',
    proofSource: 'tx-genesis-001',
    lastTouchBlock: 1,
    ...overrides,
  };
}

/** In-memory DB carrying just the AVL storage schema, for an isolated prover. */
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

describe('box provenance columns (Spec G phase B)', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  // --- round-trip, provenance unset (the phase-B state) ---------------------

  it('a box inserted without provenance reads back with NO txId/index keys at all', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    initDb(':memory:');

    const box = makeKarmaBox('aa'.repeat(32));
    expect('txId' in box).toBe(false);
    insertBox(box);

    const result = getBox(box.id!)!;
    expect(result).not.toBeNull();

    // Not `toBeUndefined()` — that passes for an explicit undefined too, which
    // is exactly the shape that forks the chain. Key *presence* is the assertion.
    expect('txId' in result).toBe(false);
    expect('index' in result).toBe(false);
    expect(Object.keys(result)).not.toContain('txId');
    expect(Object.keys(result)).not.toContain('index');
  });

  // --- round-trip, provenance set (what phase C will produce) --------------

  it('provenance round-trips through insertBox -> rowToBox when set', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    initDb(':memory:');

    const txId = 'cd'.repeat(32);
    const box = makeKarmaBox('bb'.repeat(32), { txId, index: 3 });
    insertBox(box);

    const result = getBox(box.id!)!;
    expect(result.txId).toBe(txId);
    expect(result.index).toBe(3);
    // `output_index` comes back from SQLite as bigint under .safeIntegers();
    // it must be narrowed to number or it serializes differently.
    expect(typeof result.index).toBe('number');
  });

  it('index 0 round-trips as 0, not dropped as falsy', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    initDb(':memory:');

    const txId = 'ef'.repeat(32);
    const box = makeKarmaBox('cc'.repeat(32), { txId, index: 0 });
    insertBox(box);

    const result = getBox(box.id!)!;
    expect(result.index).toBe(0);
    expect('index' in result).toBe(true);
  });

  it('provenance survives getUnspentBoxes as well as getBox', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getUnspentBoxes } = await importUtxoFresh();
    initDb(':memory:');

    const txId = '12'.repeat(32);
    insertBox(makeKarmaBox('dd'.repeat(32), { txId, index: 7 }));
    insertBox(makeKarmaBox('ee'.repeat(32)));

    const unspent = getUnspentBoxes();
    const withProv = unspent.find((b) => b.id === 'dd'.repeat(32))!;
    const without = unspent.find((b) => b.id === 'ee'.repeat(32))!;

    expect(withProv.txId).toBe(txId);
    expect(withProv.index).toBe(7);
    expect('txId' in without).toBe(false);
    expect('index' in without).toBe(false);
  });

  // --- the AVL-value byte identity that makes a restart safe ---------------

  it('serializeBox is byte-identical for a producer box and its rowToBox reconstruction', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { serializeBox } = await import('../../src/state/serialize-box.js');
    initDb(':memory:');

    const producer = makeKarmaBox('ab'.repeat(32));
    insertBox(producer);
    const restored = getBox(producer.id!)!;

    expect(Buffer.from(serializeBox(restored)).toString('hex')).toBe(
      Buffer.from(serializeBox(producer)).toString('hex'),
    );
  });

  it('bootstrap-from-store and live-producer provers agree on the digest', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getUnspentBoxes } = await importUtxoFresh();
    const { createAvlProver, bootstrapAvlProver } = await import(
      '../../src/state/avl-prover.js'
    );
    initDb(':memory:');

    // A mixed set: every box type reachable through rowToBox's conditional
    // branches, so a regression in any one of them moves the digest.
    const produced: AnyBox[] = [
      makeKarmaBox('11'.repeat(32)),
      makeKarmaBox('22'.repeat(32), { decayBurn: true }),
      {
        id: '33'.repeat(32), boxType: 'credit', value: 5000n, createdAtBlock: 2,
        owner: OWNER, guard: 'owner_signature', proofSource: 2,
      } satisfies CreditBox,
      {
        id: '44'.repeat(32), boxType: 'credit', value: 10n, createdAtBlock: 2,
        owner: OWNER, guard: 'owner_signature', proofSource: 2, lockedUntilBlock: 900,
      } satisfies CreditBox,
      {
        id: '55'.repeat(32), boxType: 'like', value: 2n, createdAtBlock: 5,
        likerId: bytes(32), targetPostId: 'post456', guard: 'epoch_tally',
      } satisfies LikeBox,
    ];
    for (const box of produced) insertBox(box);

    // "Stayed up": the prover was fed the producer-built objects.
    const live = createAvlProver(makeAvlDb());
    bootstrapAvlProver(live, produced, 0, []);

    // "Restarted": the prover re-bootstraps from the store.
    const restarted = createAvlProver(makeAvlDb());
    bootstrapAvlProver(restarted, getUnspentBoxes(), 0, []);

    const dLive = live.prover.digest();
    const dRestarted = restarted.prover.digest();
    expect(dLive).not.toBeNull();
    expect(dRestarted).not.toBeNull();
    expect(Buffer.from(dRestarted!).toString('hex')).toBe(
      Buffer.from(dLive!).toString('hex'),
    );
  });

  // --- UNIQUE(tx_id, output_index) ----------------------------------------

  it('UNIQUE(tx_id, output_index) rejects a genuine duplicate outpoint', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox } = await importUtxoFresh();
    initDb(':memory:');

    const txId = '99'.repeat(32);
    insertBox(makeKarmaBox('a1'.repeat(32), { txId, index: 0 }));

    // Different box id, same (txId, index) — a derivation bug, not a valid block.
    expect(() =>
      insertBox(makeKarmaBox('a2'.repeat(32), { txId, index: 0, value: 7n })),
    ).toThrow(/UNIQUE|constraint/i);
  });

  it('the same index under a different txId is accepted', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getUnspentBoxes } = await importUtxoFresh();
    initDb(':memory:');

    insertBox(makeKarmaBox('b1'.repeat(32), { txId: '01'.repeat(32), index: 0 }));
    insertBox(makeKarmaBox('b2'.repeat(32), { txId: '02'.repeat(32), index: 0 }));
    expect(getUnspentBoxes()).toHaveLength(2);
  });

  it('two outputs of one tx at different indices are accepted', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getUnspentBoxes } = await importUtxoFresh();
    initDb(':memory:');

    const txId = '77'.repeat(32);
    insertBox(makeKarmaBox('c1'.repeat(32), { txId, index: 0 }));
    insertBox(makeKarmaBox('c2'.repeat(32), { txId, index: 1 }));
    expect(getUnspentBoxes()).toHaveLength(2);
  });

  it('the migration window survives: many boxes with NULL provenance coexist', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getUnspentBoxes } = await importUtxoFresh();
    initDb(':memory:');

    // SQLite treats NULLs as distinct, which is what lets the unique index
    // stand while producers have not moved over yet (phase C).
    for (let i = 0; i < 5; i++) {
      insertBox(makeKarmaBox(String(i).repeat(64)));
    }
    expect(getUnspentBoxes()).toHaveLength(5);
  });

  it('id PRIMARY KEY still throws on a colliding box rather than silently replacing it', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox } = await importUtxoFresh();
    initDb(':memory:');

    // Pins that insertBox is a plain INSERT, not INSERT OR REPLACE: dropping a
    // box on collision would be silent state corruption, where the throw is
    // turned into a block rejection by the apply funnel's totality catch.
    const box = makeKarmaBox('f0'.repeat(32));
    insertBox(box);
    expect(() => insertBox(makeKarmaBox('f0'.repeat(32), { value: 999n }))).toThrow(
      /UNIQUE|constraint/i,
    );
  });
});
