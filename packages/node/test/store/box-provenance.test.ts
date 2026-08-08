import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { AnyBox, KarmaBox, CreditBox } from '@dagsocial/types';
import { fixtureProvenance } from '../helpers.js';

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
  // `id` stays caller-supplied — these cases assert on specific AVL keys — and
  // so does provenance when a case supplies it, since several of them exist
  // precisely to drive `(tx_id, output_index)` to a chosen value. Synthesized
  // provenance is only the default, applied BEFORE the overrides so a case can
  // still pin the outpoint it is testing.
  const base = {
    boxType: 'karma' as const,
    value: 100n,
    owner: OWNER,
    guard: 'owner_signature' as const,
    proofSource: 'tx-genesis-001',
  };
  return {
    id,
    ...base,
    ...fixtureProvenance(base, 1, hashNonce(id)),
    ...overrides,
  };
}

/** Stable small integer from an arbitrary string, for fixture nonces. */
function hashNonce(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 1_000_000;
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

    const unspent = getUnspentBoxes();
    const withProv = unspent.find((b) => b.id === 'dd'.repeat(32))!;

    expect(withProv.txId).toBe(txId);
    expect(withProv.index).toBe(7);
    // The "and a box WITHOUT provenance keeps none" half of this case went with
    // the columns: `tx_id`/`output_index` are NOT NULL as of phase G3b, so a box
    // with no provenance cannot be stored at all. `rowToBox` assigns both
    // unconditionally now, which is what makes the old explicit-`undefined`
    // hazard (contract 1a) unrepresentable rather than merely avoided.
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
        id: '33'.repeat(32), boxType: 'credit', value: 5000n,
        owner: OWNER, guard: 'owner_signature', proofSource: 2,
        txId: '33'.repeat(32), index: 0,
      } satisfies CreditBox,
      {
        id: '44'.repeat(32), boxType: 'credit', value: 10n,
        owner: OWNER, guard: 'owner_signature', proofSource: 2, lockedUntilBlock: 900,
        txId: '44'.repeat(32), index: 0,
      } satisfies CreditBox,
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
