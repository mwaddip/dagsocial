import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { computeBoxId, computeMintTxId } from '@dagsocial/types';
import type { AnyBox } from '@dagsocial/types';
import type { BlockJournal, BoxMutation } from '../../src/store/journal.js';

/**
 * Spec G phase C1 — the mint producers attach provenance.
 *
 * Two things are under test that the phase-B suite cannot reach, because no
 * producer set provenance then:
 *
 *  1. **No box id moves.** Phase C0 made `computeBoxId` hash
 *     `canonicalBoxBytes(box)`, which strips `id`/`txId`/`index`. Attaching
 *     provenance must therefore leave every existing id unchanged — the one
 *     thing no phase before G may break.
 *  2. **Provenance is appended last.** `serializeBox` spreads box keys in
 *     insertion order under `variableMapSize: false`, so a producer that
 *     interleaved `txId`/`index` among the candidate fields would serialize to
 *     different bytes than the same box read back through `rowToBox` — a
 *     restart-triggered stateRoot fork.
 *
 * The producer-built objects come from the **block journal**, not from a
 * test-local reconstruction: the journal records the object `insertBox`
 * actually received, so these assertions bite on the shipped producer rather
 * than on a mirror of it (the trap phase B's report §4a documents).
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
  };
}

async function importJournalFresh() {
  return (await import('../../src/store/journal.js')) as {
    beginBlockJournal: (height: number) => void;
    finishBlockJournal: () => BlockJournal;
  };
}

/** Run `fn` with a journal open, returning the boxes producers inserted. */
async function producedBoxes(height: number, fn: () => void): Promise<AnyBox[]> {
  const journal = await importJournalFresh();
  journal.beginBlockJournal(height);
  fn();
  return journal
    .finishBlockJournal()
    .mutations.filter((m): m is BoxMutation => m.kind === 'box' && m.op === 'insert')
    .map((m) => m.box as AnyBox);
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

// Deterministic fixtures — no randomness, no Date.now() (Spec G §6 hygiene).
const user = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const POST_A = 'a1'.repeat(32);
const HEIGHT = 700;

describe('mint producers attach provenance (Spec G phase C1)', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  // --- the invariant the whole phase rests on ------------------------------

  // Reworded at phase G2b, same invariant. The "without" arm used to be a
  // second `mintKarma` call passing `null`; `ctx` is required now, so that arm
  // is unreachable through the producer. It is reconstructed from the produced
  // box instead — strip `id`/`txId`/`index` and re-derive — which asserts the
  // same equality against the **shipped** producer rather than against a
  // second, differently-configured call.
  it('the minted id BINDS its provenance — stripping it changes the id', async () => {
    const { initDb } = await importDbFresh();
    const { getBox } = await importUtxoFresh();
    const { mintKarma } = await import('../../src/services/karma.js');
    const { authorRewardContext } = await import('../../src/mint-provenance.js');
    initDb(':memory:');

    const minted = mintKarma(user(0x01), 40n, HEIGHT, authorRewardContext(POST_A));
    const stored = getBox(minted)!;

    // Inverted by phase G3b. This asserted the opposite — that stripping
    // provenance left the id unmoved — which is what the *legacy* derivation
    // guaranteed and is precisely what made ids dishonest (M-11). Under the
    // provenance derivation the id must depend on `txId`/`index`, so the same
    // fixture now proves the reverse.
    expect(stored.txId).toBeDefined();
    expect(stored.index).toBe(0);

    // The stored box re-derives its own id: honesty, structurally.
    expect(computeBoxId(stored)).toBe(minted);

    // And the same box under different provenance does not.
    expect(computeBoxId({ ...stored, index: 1 })).not.toBe(minted);
    expect(computeBoxId({ ...stored, txId: 'a'.repeat(64) })).not.toBe(minted);
    expect(minted).toMatch(/^[0-9a-f]{64}$/);
  });

  // --- the provenance itself ------------------------------------------------

  it('mintKarma stamps the txId its context derives, at index 0', async () => {
    const { initDb } = await importDbFresh();
    const { getBox } = await importUtxoFresh();
    const { mintKarma } = await import('../../src/services/karma.js');
    const { authorRewardContext } = await import('../../src/mint-provenance.js');
    initDb(':memory:');

    const ctx = authorRewardContext(POST_A);
    const boxId = mintKarma(user(0x02), 10n, HEIGHT, ctx);

    const stored = getBox(boxId)!;
    expect(stored.txId).toBe(computeMintTxId(HEIGHT, 'author-reward', ctx.subject));
    expect(stored.index).toBe(0);
  });

  it('mintCredits stamps provenance, and does so on the locked branch too', async () => {
    const { initDb } = await importDbFresh();
    const { getBox } = await importUtxoFresh();
    const { mintCredits } = await import('../../src/services/credits.js');
    const { coinbaseContext } = await import('../../src/mint-provenance.js');
    initDb(':memory:');

    const ctx = coinbaseContext(1);
    const boxId = mintCredits(user(0x03), 500n, HEIGHT, ctx, HEIGHT + 90);

    const stored = getBox(boxId)!;
    expect(stored.txId).toBe(computeMintTxId(HEIGHT, 'coinbase', ctx.subject));
    expect(stored.index).toBe(0);
    expect((stored as { lockedUntilBlock?: number }).lockedUntilBlock).toBe(HEIGHT + 90);
  });

  // A test pinning the `null`-context shape lived here until phase G2b. It was
  // deleted rather than adapted: `mintKarma`/`mintCredits` now take a required
  // `MintContext`, so the state it described is unreachable — and keeping it
  // would have forced `| null` to stay alive purely to satisfy it, inverting
  // the dependency. (The store-side half, NOT NULL on
  // `utxo_boxes.tx_id`/`output_index`, lands at G3 with the fixture migration
  // those columns force.)

  // --- key order: provenance appended last ---------------------------------

  it('serializeBox is byte-identical for a minted box and its store reconstruction', async () => {
    const { initDb } = await importDbFresh();
    const { getBox } = await importUtxoFresh();
    const { serializeBox } = await import('../../src/state/serialize-box.js');
    const { mintKarma } = await import('../../src/services/karma.js');
    const { mintCredits } = await import('../../src/services/credits.js');
    const {
      authorRewardContext,
      coinbaseContext,
      decayContext,
    } = await import('../../src/mint-provenance.js');
    initDb(':memory:');

    // Distinct owners, so no mint merge-consumes another's box.
    const produced = await producedBoxes(HEIGHT, () => {
      mintKarma(user(0x11), 10n, HEIGHT, authorRewardContext(POST_A));
      mintKarma(user(0x12), 20n, HEIGHT, decayContext(user(0x12)));
      mintCredits(user(0x13), 30n, HEIGHT, coinbaseContext(0));
      mintCredits(user(0x14), 40n, HEIGHT, coinbaseContext(1), HEIGHT + 5);
    });
    expect(produced.length).toBe(4);

    for (const box of produced) {
      // Provenance must be the last two keys the producer set — anything else
      // and the two encodings below diverge.
      const keys = Object.keys(box).filter((k) => k !== 'id');
      expect(keys.slice(-2)).toEqual(['txId', 'index']);

      const restored = getBox(box.id!)!;
      expect(Buffer.from(serializeBox(restored)).toString('hex')).toBe(
        Buffer.from(serializeBox(box)).toString('hex'),
      );
    }
  });

  it('bootstrap-from-store and live-producer provers agree over real minted boxes', async () => {
    const { initDb } = await importDbFresh();
    const { getUnspentBoxes } = await importUtxoFresh();
    const { createAvlProver, bootstrapAvlProver } = await import(
      '../../src/state/avl-prover.js'
    );
    const { mintKarma } = await import('../../src/services/karma.js');
    const { mintCredits } = await import('../../src/services/credits.js');
    const {
      authorRewardContext,
      coinbaseContext,
      decayContext,
    } = await import('../../src/mint-provenance.js');
    initDb(':memory:');

    const produced = await producedBoxes(HEIGHT, () => {
      mintKarma(user(0x21), 10n, HEIGHT, authorRewardContext(POST_A));
      mintKarma(user(0x22), 20n, HEIGHT, decayContext(user(0x22)));
      mintCredits(user(0x23), 30n, HEIGHT, coinbaseContext(0));
      mintCredits(user(0x24), 40n, HEIGHT, coinbaseContext(1), HEIGHT + 5);
    });

    // "Stayed up": the prover holds the producer-built objects.
    const live = createAvlProver(makeAvlDb());
    bootstrapAvlProver(live, produced, 0, []);

    // "Restarted": the prover re-bootstraps from SQLite.
    const restarted = createAvlProver(makeAvlDb());
    bootstrapAvlProver(restarted, getUnspentBoxes(), 0, []);

    const dLive = live.prover.digest();
    const dRestarted = restarted.prover.digest();
    expect(dLive).not.toBeNull();
    expect(Buffer.from(dRestarted!).toString('hex')).toBe(
      Buffer.from(dLive!).toString('hex'),
    );
  });

  // --- the pair the reason tag exists for ----------------------------------

  it('author-reward and postlock-unlock to one author, one post, one height differ', async () => {
    const { initDb } = await importDbFresh();
    const { mintKarma } = await import('../../src/services/karma.js');
    const { authorRewardContext, postlockUnlockContext } = await import(
      '../../src/mint-provenance.js'
    );
    initDb(':memory:');

    const author = user(0x31);
    // Both legs, exactly as `applyMutationPhase` runs them: same author, same
    // post, same height. The second merge-consumes the first, so both boxes are
    // visible only through the journal.
    const produced = await producedBoxes(HEIGHT, () => {
      mintKarma(author, 3n, HEIGHT, authorRewardContext(POST_A));
      mintKarma(author, 5n, HEIGHT, postlockUnlockContext(POST_A));
    });

    expect(produced.length).toBe(2);
    const [reward, unlock] = produced;
    expect(reward!.txId).toBeDefined();
    expect(unlock!.txId).toBeDefined();
    // Same (height, subject); only the reason tag separates them. Equal txIds
    // here would mean a `UNIQUE(tx_id, output_index)` violation in one block —
    // and, from phase G, two boxes claiming one identity.
    expect(unlock!.txId).not.toBe(reward!.txId);
    expect(reward!.id).not.toBe(unlock!.id);
  });
});

// ---------------------------------------------------------------------------
// C2 — the producers that build boxes directly rather than through mintKarma
// ---------------------------------------------------------------------------

describe('direct mint producers attach provenance (Spec G phase C2)', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  /** Store-backed `DecayDeps`, so decay runs against real boxes. */
  async function decayDeps() {
    const utxo = await import('../../src/store/utxo.js');
    const { getDb } = await import('../../src/store/db.js');
    // Spec G phase D: the decay clock is committed state, read and written
    // through the same injected seam as the boxes.
    const records = await import('../../src/store/identity-records.js');
    return {
      getKarmaBoxes: utxo.getKarmaBoxes,
      consumeBox: utxo.consumeBox,
      insertBox: utxo.insertBox,
      getIdentityRecord: records.getIdentityRecord,
      putIdentityRecord: records.putIdentityRecord,
      getKarmaOwners: () =>
        (
          getDb()
            .prepare(
              `SELECT DISTINCT owner FROM utxo_boxes
               WHERE box_type = 'karma' AND spent_at_block IS NULL`,
            )
            .all() as { owner: Buffer }[]
        ).map((r) => new Uint8Array(r.owner)),
    };
  }

  const DECAY_CFG = {
    staleThresholdBlocks: 10,
    decayIntervalBlocks: 5,
    decayAmount: 1n,
    karmaMinimum: 0n,
  };

  it('applyKarmaDecay stamps the decay txId over the raw owner, at index 0', async () => {
    const { initDb } = await importDbFresh();
    const { getBox } = await importUtxoFresh();
    const { mintKarma } = await import('../../src/services/karma.js');
    const { applyKarmaDecay } = await import('../../src/services/decay.js');
    const { authorRewardContext, decayContext } = await import(
      '../../src/mint-provenance.js'
    );
    initDb(':memory:');

    const owner = user(0x41);
    mintKarma(owner, 50n, 1, authorRewardContext(POST_A));

    const entries = applyKarmaDecay(await decayDeps(), HEIGHT, DECAY_CFG);
    expect(entries.length).toBe(1);

    const decayed = getBox(entries[0]!.newBoxId)!;
    expect(decayed.txId).toBe(
      computeMintTxId(HEIGHT, 'decay', decayContext(owner).subject),
    );
    expect(decayed.index).toBe(0);
    expect((decayed as { decayBurn?: boolean }).decayBurn).toBe(true);
  });

  it('a decay box does not inherit the identity of the box it replaces', async () => {
    const { initDb } = await importDbFresh();
    const { getBox } = await importUtxoFresh();
    const { mintKarma } = await import('../../src/services/karma.js');
    const { applyKarmaDecay } = await import('../../src/services/decay.js');
    const { authorRewardContext } = await import('../../src/mint-provenance.js');
    initDb(':memory:');

    // The across-heights adjacency: a decay box replacing an earlier mint's box
    // must take a different identity, or the two would share an outpoint.
    //
    // (The *same-block* adjacency is reachable too, via vouch settlement —
    // `processVouchCooldowns` runs after `applyKarmaDecay` in the mutation
    // phase. That case is covered separately below.)
    const owner = user(0x42);
    const mintedId = mintKarma(owner, 50n, 1, authorRewardContext(POST_A));
    const minted = getBox(mintedId)!;

    const deps = await decayDeps();
    const decayed = await producedBoxes(HEIGHT, () => {
      applyKarmaDecay(deps, HEIGHT, DECAY_CFG);
    });
    expect(decayed.length).toBe(1);
    expect(minted.txId).toBeDefined();
    expect(decayed[0]!.txId).toBeDefined();
    expect(decayed[0]!.txId).not.toBe(minted.txId);
    expect(decayed[0]!.id).not.toBe(minted.id);
  });

  it('a decayed box round-trips byte-identically and keeps the digest', async () => {
    const { initDb } = await importDbFresh();
    const { getUnspentBoxes, getBox } = await importUtxoFresh();
    const { serializeBox } = await import('../../src/state/serialize-box.js');
    const { createAvlProver, bootstrapAvlProver } = await import(
      '../../src/state/avl-prover.js'
    );
    const { mintKarma } = await import('../../src/services/karma.js');
    const { applyKarmaDecay } = await import('../../src/services/decay.js');
    const { authorRewardContext } = await import('../../src/mint-provenance.js');
    initDb(':memory:');

    mintKarma(user(0x43), 50n, 1, authorRewardContext(POST_A));
    const deps = await decayDeps();
    const produced = await producedBoxes(HEIGHT, () => {
      applyKarmaDecay(deps, HEIGHT, DECAY_CFG);
    });
    expect(produced.length).toBe(1);

    // `decayBurn` is the producer's last candidate field, so provenance must
    // follow it — this is the ordering `rowToBox` reconstructs.
    const keys = Object.keys(produced[0]!).filter((k) => k !== 'id');
    expect(keys.slice(-2)).toEqual(['txId', 'index']);

    const restored = getBox(produced[0]!.id!)!;
    expect(Buffer.from(serializeBox(restored)).toString('hex')).toBe(
      Buffer.from(serializeBox(produced[0]!)).toString('hex'),
    );

    const live = createAvlProver(makeAvlDb());
    bootstrapAvlProver(live, produced, 0, []);
    const restarted = createAvlProver(makeAvlDb());
    bootstrapAvlProver(restarted, getUnspentBoxes(), 0, []);
    expect(Buffer.from(restarted.prover.digest()!).toString('hex')).toBe(
      Buffer.from(live.prover.digest()!).toString('hex'),
    );
  });

  it('the two genesis boxes get distinct provenance under one selector each', async () => {
    const { initDb } = await importDbFresh();
    const { getBox } = await importUtxoFresh();
    const { serializeBox } = await import('../../src/state/serialize-box.js');
    const system = await import('../../src/store/system.js');
    const {
      genesisContext,
      GENESIS_SYSTEM_KARMA,
      GENESIS_FAUCET_CREDITS,
    } = await import('../../src/mint-provenance.js');
    initDb(':memory:');

    const sysKey = user(0x51);
    const produced = await producedBoxes(1, () => {
      system.ensureSystemKarmaBox(sysKey, 0);
      system.ensureFaucetCreditBox(sysKey, 0);
    });
    expect(produced.length).toBe(2);

    // `currentHeight = 0` clamps to 1 for both the recorded block and the txId
    // height — one derivation, so they cannot disagree.
    const [karmaBox, creditBox] = produced;
    expect(karmaBox!.txId).toBe(
      computeMintTxId(1, 'genesis', genesisContext(GENESIS_SYSTEM_KARMA).subject),
    );
    expect(creditBox!.txId).toBe(
      computeMintTxId(1, 'genesis', genesisContext(GENESIS_FAUCET_CREDITS).subject),
    );
    expect(karmaBox!.txId).not.toBe(creditBox!.txId);
    expect(karmaBox!.index).toBe(0);
    expect(creditBox!.index).toBe(0);

    for (const box of produced) {
      expect(Buffer.from(serializeBox(getBox(box.id!)!)).toString('hex')).toBe(
        Buffer.from(serializeBox(box)).toString('hex'),
      );
    }
  });
});
