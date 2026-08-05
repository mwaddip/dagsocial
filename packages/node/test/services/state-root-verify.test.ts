import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeBoxId, EMPTY_STATE_ROOT } from '@dagsocial/types';
import type { CreditBox, OrderingBlock } from '@dagsocial/types';
import type Database from 'better-sqlite3';
import { makeTestIdentity, makeApplicableBlock } from '../helpers.js';

// ---------------------------------------------------------------------------
// Spec B P3 acceptance, verifier side: with VERIFY_STATE_ROOT on (the default
// since P3), a block whose header commits to state it does not produce is
// rejected, and rejecting it costs nothing — the DB is untouched and the AVL
// prover is back at its pre-block digest.
//
// The producer side (the header carries the post-block digest) is covered
// end-to-end by every suite that builds a block through the creator or through
// makeApplicableBlock and applies it; the per-mutation-class equality of the
// speculative and real digests is in journal-roundtrip.test.ts.
// ---------------------------------------------------------------------------

type DbModule = {
  initDb: (path: string) => void;
  getDb: () => Database;
  closeDb: () => void;
};

async function importDb(): Promise<DbModule> {
  return (await import('../../src/store/db.js')) as unknown as DbModule;
}

async function importBlockApply() {
  return (await import('../../src/services/block-apply.js')) as unknown as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
  };
}

async function importAvl() {
  return (await import('../../src/state/avl-prover.js')) as typeof import('../../src/state/avl-prover.js');
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    getUnspentBoxes: () => import('@dagsocial/types').AnyBox[];
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
  };
}

async function importJournalStore() {
  return (await import('../../src/store/journal.js')) as {
    getBlockJournal: (h: number) => unknown | null;
  };
}

function dumpBoxes(db: Database) {
  return db.prepare('SELECT * FROM utxo_boxes ORDER BY id').all();
}

/** Prover singleton on the test DB, seeded boxes bootstrapped — src/index.ts wiring. */
async function activateProver() {
  const avlMod = await importAvl();
  const utxo = await importUtxo();
  const handle = avlMod.createAvlProver();
  const unspent = utxo.getUnspentBoxes();
  if (unspent.length > 0) avlMod.bootstrapAvlProver(handle, unspent, 0);
  expect(avlMod.tryGetAvlProver()).not.toBeNull();
  return handle;
}

function digestHex(handle: { prover: { digest(): Uint8Array | null } }): string {
  const d = handle.prover.digest();
  expect(d).not.toBeNull();
  return Buffer.from(d!).toString('hex');
}

describe('stateRoot verification (P3 acceptance)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('is on by default', async () => {
    const { config } = await import('../../src/config.js');
    expect(config.verifyStateRoot).toBe(true);
  });

  it('rejects a block whose stateRoot is wrong, leaving the DB and prover untouched', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // A seeded box so the tree is non-empty and the digest is a real root.
    const holder = makeTestIdentity();
    const seeded: CreditBox = {
      boxType: 'credit',
      value: 100n,
      createdAtBlock: 0,
      owner: holder.userId,
      guard: 'owner_signature',
      proofSource: 0,
    };
    seeded.id = computeBoxId(seeded);
    (await importUtxo()).insertBox(seeded);

    const handle = await activateProver();
    const blockApply = await importBlockApply();
    const ordering = await importOrdering();

    // Height 1 applies normally — this is the control that the fixture and the
    // verifier agree when the root is right.
    expect(blockApply.applyOrderingBlock(await makeApplicableBlock())).toBe(true);
    expect(ordering.getCurrentHeight()).toBe(1);

    const preBoxes = dumpBoxes(db.getDb());
    const preDigest = digestHex(handle);

    // Same block in every respect but the state root: valid chain link, PoW,
    // signature, coinbase and Merkle roots — it is only the commitment to the
    // post-block state that is a lie.
    const liar = await makeApplicableBlock({
      height: 2,
      stateRoot: 'ff'.repeat(33),
    });
    expect(blockApply.applyOrderingBlock(liar)).toBe(false);

    // Rejection is total: no block, no journal, no box, no prover movement.
    expect(ordering.getCurrentHeight()).toBe(1);
    expect((await importJournalStore()).getBlockJournal(2)).toBeNull();
    expect(dumpBoxes(db.getDb())).toEqual(preBoxes);
    expect(digestHex(handle)).toBe(preDigest);

    // …and the height is still open: an honest block at 2 applies onto the
    // untouched state, so the rejection left nothing poisoned behind it.
    const honest = await makeApplicableBlock({ height: 2 });
    expect(blockApply.applyOrderingBlock(honest)).toBe(true);
    expect(ordering.getCurrentHeight()).toBe(2);
    expect(honest.header.stateRoot).toBe(digestHex(handle));
    expect(honest.header.stateRoot).not.toBe(preDigest);
  });

  it('rejects a block that carries the pre-block digest (the H-6 regression)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const handle = await activateProver();
    const blockApply = await importBlockApply();

    expect(blockApply.applyOrderingBlock(await makeApplicableBlock())).toBe(true);

    // Exactly the bug this phase fixed: the producer writing its *current*
    // digest into the header instead of the one its block produces.
    const preBlockDigest = digestHex(handle);
    const stale = await makeApplicableBlock({ height: 2, stateRoot: preBlockDigest });
    expect(blockApply.applyOrderingBlock(stale)).toBe(false);
    expect((await importOrdering()).getCurrentHeight()).toBe(1);
    expect(digestHex(handle)).toBe(preBlockDigest);
    expect(dumpBoxes(db.getDb()).length).toBeGreaterThan(0);
  });

  it('rejects a block carrying EMPTY_STATE_ROOT when a prover is running', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const handle = await activateProver();
    const blockApply = await importBlockApply();
    const preDigest = digestHex(handle);

    // The producer's no-prover fallback (NODE_INTERFACE: "A producer with no
    // prover initialized writes EMPTY_STATE_ROOT"). A verifier that does have
    // one must reject it — the contract says so explicitly.
    const rootless = await makeApplicableBlock({ stateRoot: EMPTY_STATE_ROOT });
    expect(rootless.header.stateRoot).toBe(EMPTY_STATE_ROOT);
    expect(blockApply.applyOrderingBlock(rootless)).toBe(false);
    expect((await importOrdering()).getCurrentHeight()).toBe(0);
    expect(digestHex(handle)).toBe(preDigest);
  });
});
