import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createAvlProver,
  applyBlockMutations,
  checkpointProver,
} from '../../src/state/avl-prover.js';
import {
  deserializeBoxWithId,
  deserializeBox,
} from '../../src/state/serialize-box.js';
import type { AnyBox } from '@dagsocial/types';

/** Generate sequential, non-zero 64-char hex IDs starting from 1 to avoid
 *  the all-zeros key which collides with the AVL neg-inf sentinel. */
function makeIdGenerator() {
  let counter = 1;
  return (): string => (counter++).toString(16).padStart(64, '0');
}

function makeKarmaBox(id: string, value: bigint, block: number, seed: number): AnyBox {
  const owner = new Uint8Array(32);
  owner[0] = seed & 0xff;
  return {
    id,
    boxType: 'karma',
    value,
    owner,
    guard: 'owner_signature',
    proofSource: `mint-${block}-${seed}`,
  };
}

function makeCreditBox(id: string, value: bigint, block: number, seed: number): AnyBox {
  const owner = new Uint8Array(32);
  owner[0] = seed & 0xff;
  return {
    id,
    boxType: 'credit',
    value,
    owner,
    guard: 'owner_signature',
    proofSource: block,
  };
}

describe('AVL integration — full pipeline', () => {
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

  afterEach(() => {
    db.close();
  });

  it('simulates 10 blocks of UTXO mutations and verifies historical proofs', () => {
    const handle = createAvlProver(db);
    const allBoxes = new Map<string, AnyBox>();
    const nextId = makeIdGenerator();

    // -- Block 1: create 5 karma boxes -----------------------------------------
    const created1: AnyBox[] = Array.from({ length: 5 }, (_, i) =>
      makeKarmaBox(nextId(), BigInt(100 + i), 1, i),
    );
    for (const b of created1) allBoxes.set(b.id, b);
    const d1 = applyBlockMutations(handle.prover, [], created1);
    checkpointProver(handle, 1);

    expect(d1).toBeInstanceOf(Uint8Array);
    expect(d1.length).toBe(33); // 32-byte label + 1-byte height

    // Verify: all 5 boxes are present via unauthenticatedLookup
    for (const box of created1) {
      const key = Buffer.from(box.id, 'hex');
      const raw = handle.prover.unauthenticatedLookup(key);
      expect(raw, `box ${box.id} should be found after block 1`).not.toBeNull();
      const deserialized = deserializeBoxWithId(box.id, raw!);
      expect(deserialized.id).toBe(box.id);
      expect(deserialized.boxType).toBe('karma');
    }

    // -- Block 2: create 3 credit boxes, consume the first karma box -----------
    const consumed2 = [created1[0]!.id];
    allBoxes.delete(created1[0]!.id);

    const created2: AnyBox[] = Array.from({ length: 3 }, (_, i) =>
      makeCreditBox(nextId(), BigInt(50 + i), 2, i + 5),
    );
    for (const b of created2) allBoxes.set(b.id, b);

    const d2 = applyBlockMutations(handle.prover, consumed2, created2);
    checkpointProver(handle, 2);

    expect(d2).toBeInstanceOf(Uint8Array);
    expect(d2.length).toBe(33);
    expect(Buffer.from(d2).equals(Buffer.from(d1))).toBe(false);

    // Verify: consumed box is gone
    const consumedKey = Buffer.from(created1[0]!.id, 'hex');
    expect(handle.prover.unauthenticatedLookup(consumedKey)).toBeNull();

    // Verify: new credit boxes are present
    for (const box of created2) {
      const key = Buffer.from(box.id, 'hex');
      expect(handle.prover.unauthenticatedLookup(key)).not.toBeNull();
    }

    // -- Blocks 3–10: create 2 boxes each, consume oldest every other block ----
    const blockDigests: Uint8Array[] = [d1, d2];

    for (let block = 3; block <= 10; block++) {
      const created: AnyBox[] = Array.from({ length: 2 }, (_, i) =>
        makeKarmaBox(nextId(), BigInt(10 + i), block, block * 10 + i),
      );

      const consumed: string[] = [];
      if (block % 2 === 0 && allBoxes.size > 0) {
        // Consume the oldest (first-inserted) surviving box
        const oldestId = allBoxes.keys().next().value;
        if (oldestId) {
          consumed.push(oldestId);
          allBoxes.delete(oldestId);
        }
      }

      for (const b of created) allBoxes.set(b.id, b);

      applyBlockMutations(handle.prover, consumed, created);
      checkpointProver(handle, block);

      const digest = handle.prover.digest();
      expect(digest, `block ${block} digest should be non-null`).not.toBeNull();
      expect(digest!.length).toBe(33);
      blockDigests.push(digest!);

      // Verify: every consumed box is truly gone
      for (const cid of consumed) {
        expect(
          handle.prover.unauthenticatedLookup(Buffer.from(cid, 'hex')),
          `consumed box ${cid} should not be found after block ${block}`,
        ).toBeNull();
      }
    }

    // -- Final state verification ----------------------------------------------
    // All boxes tracked in allBoxes should be present in the prover
    const finalCount = allBoxes.size;
    let found = 0;

    for (const [boxId, expectedBox] of allBoxes) {
      const key = Buffer.from(boxId, 'hex');
      const value = handle.prover.unauthenticatedLookup(key);
      if (value) {
        found++;
        const box = deserializeBoxWithId(boxId, value);
        expect(box.id).toBe(boxId);
        expect(box.boxType).toBe(expectedBox.boxType);
      }
    }
    expect(found).toBe(finalCount);

    // Sanity: we should have created 5+3+16=24 boxes and consumed 5
    // (1 at block 2 + 4 at blocks 4,6,8,10), leaving 19
    expect(finalCount).toBe(19);

    // -- Rollback: restore height 1 and verify only original 5 boxes exist ----
    const d1Copy = new Uint8Array(d1);
    handle.prover.rollback(d1Copy);

    // All 5 original boxes should be present at height 1
    for (const box of created1) {
      const key = Buffer.from(box.id, 'hex');
      const raw = handle.prover.unauthenticatedLookup(key);
      expect(raw, `box ${box.id} should exist after rollback to height 1`).not.toBeNull();
      const deserialized = deserializeBoxWithId(box.id, raw!);
      expect(deserialized.boxType).toBe('karma');
      expect(deserialized.value).toBe(box.value);
    }

    // Boxes created after block 1 should NOT exist after rollback
    for (const box of created2) {
      const key = Buffer.from(box.id, 'hex');
      expect(
        handle.prover.unauthenticatedLookup(key),
        `box ${box.id} should not exist after rollback to height 1`,
      ).toBeNull();
    }

    // Consumed box should NOT exist either (it was consumed at height 2, but
    // we rolled back to height 1 where it WAS alive — wait, the box was
    // alive at height 1, so it should be present after rollback to height 1).
    // Actually: created1[0] was consumed at block 2. At block 1 it was alive.
    // So after rollback to height 1, it SHOULD be present.
    const recreatedKey = Buffer.from(created1[0]!.id, 'hex');
    const recreatedValue = handle.prover.unauthenticatedLookup(recreatedKey);
    expect(recreatedValue, 'box consumed at height 2 should be alive after rollback to height 1').not.toBeNull();

    // -- Verify deterministic: all block digests are unique ---------------------
    const hexDigests = blockDigests.map((d) => Buffer.from(d).toString('hex'));
    const uniqueDigests = new Set(hexDigests);
    expect(uniqueDigests.size).toBe(blockDigests.length);

    // -- Verify roundtrip for a sample box -------------------------------------
    const sampleBox = created1[1]!;
    const sampleKey = Buffer.from(sampleBox.id, 'hex');
    const sampleRaw = handle.prover.unauthenticatedLookup(sampleKey);
    expect(sampleRaw).not.toBeNull();

    // deserializeBox (without id) + deserializeBoxWithId (with id)
    const withoutId = deserializeBox(sampleRaw!);
    expect(withoutId.boxType).toBe('karma');
    expect(withoutId.value).toBe(sampleBox.value);

    const withId = deserializeBoxWithId(sampleBox.id, sampleRaw!);
    expect(withId.id).toBe(sampleBox.id);
    expect(withId.boxType).toBe('karma');
    // The AVL value carries provenance and must (contract 1a): "a box id is a
    // total function of the stored box" is only checkable *from a proof* if the
    // proof's value carries everything the derivation consumes.
    expect(withId.txId).toBe(sampleBox.txId);
    expect(withId.index).toBe(sampleBox.index);
  });
});
