// ---------------------------------------------------------------------------
// The envelope gate at the block funnel (`block-apply.ts`, immediately after
// `decodeTx` and BEFORE `computeTxId`).
//
// The decision this file pins: a block-embedded transaction with a malformed
// envelope is **skipped**, and the block applies without it. That matches the
// three sibling arms of the same loop — missing CBOR, decode failure, and id
// mismatch all `continue` — so every node reaches the same state
// deterministically. Whole-block rejection was never a rule; it was what the
// throw path happened to do, since `computeTxId` sits outside the local try
// and a TypeError there fell through to the outer totality catch, logged as an
// "unexpected failure during apply". Honest producers cannot embed one: their
// own pool refuses it at `validateTx` step 0.
//
// Both cases below were run against the pre-gate tree first: case 1 rejected
// the whole block through `validateTx`, case 2 through the throw path.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeTxId,
  encodeTx,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { KarmaBox, OrderingBlock, UtxoTransaction, AnyBox } from '@dagsocial/types';
import type { BlockJournal } from '../../src/store/journal.js';
import type { TestIdentity } from '../helpers.js';
import {
  makeTestIdentity,
  makeKarmaBox,
  signTransaction,
  makeApplicableBlock,
} from '../helpers.js';
// Pure and stateless, so one static instance is safe alongside this file's
// module resets.
import { checkTxEnvelope } from '../../src/services/utxo-engine.js';

async function importDb() {
  return (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    closeDb: () => void;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    getBox: (boxId: string) => AnyBox | null;
  };
}

async function importBlockApply() {
  return (await import('../../src/services/block-apply.js')) as unknown as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => OrderingBlock | null;
  };
}

async function importJournalStore() {
  return (await import('../../src/store/journal.js')) as {
    getBlockJournal: (height: number) => BlockJournal | null;
    isBlockJournalOpen: () => boolean;
  };
}

/** A conserving, signed karma self-spend over `box`. */
function karmaSelfSpend(id: TestIdentity, box: KarmaBox): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [box.id!],
    outputs: [
      {
        boxType: 'karma',
        value: box.value,
        owner: id.userId,
        guard: 'owner_signature',
        proofSource: 'genesis',
      } as unknown as KarmaBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, id.privateKey, Buffer.from(id.userId).toString('hex'));
  return tx;
}

describe('block funnel — a malformed envelope is skipped, not fatal', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('applies the block, applies the valid tx, skips the malformed one', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();

    const alice = makeTestIdentity();
    const mallory = makeTestIdentity();
    const aliceBox = makeKarmaBox(100n, alice.userId, 0, 0);
    const malloryBox = makeKarmaBox(40n, mallory.userId, 0, 1);
    utxo.insertBox(aliceBox);
    utxo.insertBox(malloryBox);

    const valid = karmaSelfSpend(alice, aliceBox);

    // Envelope-invalid but still hashable and encodable, so the block's
    // Merkle commitment over it is honest: an UPPERCASE input id names no box
    // `computeBoxId` can ever emit. Pre-gate this reached `getBox`, returned
    // "Input box not found", and rejected the ENTIRE block.
    const malformed = karmaSelfSpend(mallory, malloryBox);
    malformed.inputs = [malloryBox.id!.toUpperCase()];

    // The state assertions below cannot tell the gate apart from the apply
    // loop's input-liveness pre-pass: an id naming no live box also parks the
    // tx in `remaining`, where it is silently dropped after MAX_PASSES, for
    // the same observable outcome. The warn is what discriminates — only the
    // funnel's `checkTxEnvelope` call emits this wording, and it emits it
    // before the liveness pass ever sees the transaction.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const block = await makeApplicableBlock({ utxoTxs: [valid, malformed] });
    const applied = (await importBlockApply()).applyOrderingBlock(block);

    const warnings = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();

    expect(
      warnings.filter(
        (w) =>
          w.includes(`Rejected UTXO tx ${computeTxId(malformed)} from block`) &&
          w.includes('Invalid tx envelope: inputs[0] must be 64 lowercase hex characters'),
      ),
      // Exactly once — the real apply. `makeApplicableBlock`'s creator-side
      // speculation short-circuits at `no-prover` in a prover-less suite and
      // never reaches the tx loop, so it contributes no warn.
      `envelope warn missing; got ${JSON.stringify(warnings)}`,
    ).toHaveLength(1);
    // Nothing was rejected for a liveness or validation reason.
    expect(warnings.some((w) => w.includes('failed re-validation'))).toBe(false);

    expect(applied).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).not.toBeNull();
    expect(ordering.getCurrentHeight()).toBe(1);

    // The valid transaction applied: its input is consumed.
    expect(utxo.getBox(aliceBox.id!)).toBeNull();
    // The malformed one did nothing at all — its input is untouched.
    expect(utxo.getBox(malloryBox.id!)).not.toBeNull();

    // Journal clean: exactly one applied tx, and the journal is closed.
    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).not.toBeNull();
    expect(saved!.appliedUtxoTxs.map((t) => t.txId)).toEqual([computeTxId(valid)]);
    expect(saved!.appliedUtxoTxs.map((t) => t.txId)).not.toContain(computeTxId(malformed));
    expect(journal.isBlockJournalOpen()).toBe(false);

    // The stored header is byte-identical to the one apply accepted. NOT a
    // digest-agreement proof: this suite runs prover-less, so the speculation
    // returned `no-prover`, the header carries EMPTY_STATE_ROOT, and apply
    // skips the H-6 check entirely. Creator/apply agreement across the gate
    // belongs to a prover-bearing suite and is not measured here.
    expect(ordering.getOrderingBlock(1)!.header.stateRoot).toBe(block.header.stateRoot);
  });

  it('an envelope that makes computeTxId throw is skipped, not a whole-block kill', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();

    const alice = makeTestIdentity();
    const aliceBox = makeKarmaBox(100n, alice.userId, 0, 0);
    utxo.insertBox(aliceBox);
    const valid = karmaSelfSpend(alice, aliceBox);

    // A decoy that also gets skipped, so the creator-side speculation and the
    // apply-side run agree on the resulting state either way.
    const decoy = karmaSelfSpend(alice, aliceBox);
    decoy.inputs = [aliceBox.id!.toUpperCase()];

    const block = await makeApplicableBlock({ utxoTxs: [valid, decoy] });

    // Swap the decoy's CBOR for an envelope `computeTxId` cannot hash at all —
    // `h.update(null)`. The tree's Merkle root commits to the tx IDS only, and
    // the header signature covers the header, so the block stays internally
    // consistent; the id simply no longer matches its body, which is exactly
    // the malicious-producer shape. Pre-gate: this threw at block-apply's
    // `computeTxId(tx)` into the outer catch and killed the whole block.
    // Its ONE defect is the field that makes the hasher throw — inputs,
    // outputs, signatures and protocolVersion are all well-formed.
    const poison = {
      ...karmaSelfSpend(alice, aliceBox),
      likeTarget: null,
    } as unknown as UtxoTransaction;
    expect(() => computeTxId(poison)).toThrow();
    block.utxoTxTree.utxoTxs[1] = encodeTx(poison);

    const applied = (await importBlockApply()).applyOrderingBlock(block);
    expect(applied).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).not.toBeNull();
    expect(utxo.getBox(aliceBox.id!)).toBeNull(); // the valid tx still applied

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)!.appliedUtxoTxs.map((t) => t.txId)).toEqual([
      computeTxId(valid),
    ]);
  });

  it('non-vacuity: an INVALID-but-well-enveloped tx still rejects the whole block', async () => {
    // The rule the skip does NOT touch, and the reason the two cases above
    // are not just "the funnel got more permissive". A transaction whose
    // envelope is clean but whose contents `validateTx` refuses — an unsigned
    // spend of a live box — remains a whole-block rejection. The funnel skips
    // only what it cannot structurally read.
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();

    const alice = makeTestIdentity();
    const victim = makeTestIdentity();
    const aliceBox = makeKarmaBox(100n, alice.userId, 0, 0);
    const victimBox = makeKarmaBox(50n, victim.userId, 0, 1);
    utxo.insertBox(aliceBox);
    utxo.insertBox(victimBox);

    const valid = karmaSelfSpend(alice, aliceBox);
    const forged = karmaSelfSpend(victim, victimBox);
    forged.signatures = {}; // well-formed envelope, no authorisation

    expect(checkTxEnvelope(forged)).toEqual({ valid: true });

    const block = await makeApplicableBlock({ utxoTxs: [valid, forged] });
    const applied = (await importBlockApply()).applyOrderingBlock(block);

    expect(applied).toBe(false);
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);
    // Nothing the block would have done survives — not even the valid tx.
    expect(utxo.getBox(aliceBox.id!)).not.toBeNull();
  });
});
