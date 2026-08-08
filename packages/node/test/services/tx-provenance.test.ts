import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeBoxId } from '@dagsocial/types';
import type { AnyBox, CreditBox, KarmaBox } from '@dagsocial/types';
import type Database from 'better-sqlite3';

/**
 * Spec G phase C3 — outputs of a user transaction take the real creating
 * transaction's id and their position in `tx.outputs`.
 *
 * The hazard specific to this path, and absent from the mint paths: outputs are
 * **attacker-controlled CBOR**. `computeTxId` hashes them through
 * `canonicalBoxBytes`, so a client can put `txId`/`index` keys anywhere in an
 * output without changing the transaction id that gets signed and checked. If
 * materialization overwrote those keys in place rather than stripping and
 * re-appending them, the stored box would serialize differently from the same
 * box read back through `rowToBox` — and a node that restarted would compute a
 * different `stateRoot` than one that stayed up.
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
    insertBox: (box: AnyBox) => void;
    getBox: (boxId: string) => AnyBox | null;
  };
}

const user = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const TX_ID = 'fe'.repeat(32);

function creditCandidate(value: bigint, owner: Uint8Array): CreditBox {
  return {
    boxType: 'credit',
    value,
    owner,
    guard: 'owner_signature',
    proofSource: -1,
  };
}

describe('transaction output provenance (Spec G phase C3)', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('takes the real txId and the output position as index', async () => {
    const { materializeOutput } = await import('../../src/services/utxo-engine.js');

    const outputs = [
      creditCandidate(100n, user(0xa1)),
      creditCandidate(25n, user(0xa2)),
    ].map((box, index) => materializeOutput(box, TX_ID, index));

    expect(outputs[0]!.txId).toBe(TX_ID);
    expect(outputs[1]!.txId).toBe(TX_ID);
    expect(outputs[0]!.index).toBe(0);
    expect(outputs[1]!.index).toBe(1);
  });

  it('binds the box id to the transaction and the position it was created at', async () => {
    const { materializeOutput } = await import('../../src/services/utxo-engine.js');
    const { computeCandidateBoxId } = await import('@dagsocial/types');

    // Inverted by phase G3b. This asserted that attaching provenance must NOT
    // move an id — the load-bearing invariant for every phase *before* G, since
    // ids had to stay put while producers moved over. From G3b on the opposite
    // is required: an id that ignored its own provenance would be the M-11 id.
    const candidate = creditCandidate(100n, user(0xb1));
    const materialized = materializeOutput(candidate, TX_ID, 3);

    expect(materialized.id).toBe(computeCandidateBoxId(candidate, TX_ID, 3));
    // Same candidate, different outpoint — different box. This is what makes
    // two byte-identical outputs in one transaction distinguishable, which the
    // content hash could not do (the `utxo_boxes.id` PK collision).
    expect(materializeOutput(candidate, TX_ID, 4).id).not.toBe(materialized.id);
    expect(materializeOutput(candidate, 'a'.repeat(64), 3).id).not.toBe(materialized.id);
  });

  it('the store reconstruction is byte-identical (key order is canonical now)', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { serializeBox } = await import('../../src/state/serialize-box.js');
    const { materializeOutput } = await import('../../src/services/utxo-engine.js');
    initDb(':memory:');

    const produced = materializeOutput(creditCandidate(100n, user(0xc1)), TX_ID, 1);
    const keys = Object.keys(produced).filter((k) => k !== 'id');
    expect(keys.slice(-2)).toEqual(['txId', 'index']);

    insertBox(produced);
    const restored = getBox(produced.id!)!;
    expect(Buffer.from(serializeBox(restored)).toString('hex')).toBe(
      Buffer.from(serializeBox(produced)).toString('hex'),
    );
  });

  it('strips client-supplied provenance rather than overwriting it in place', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { serializeBox } = await import('../../src/state/serialize-box.js');
    const { materializeOutput } = await import('../../src/services/utxo-engine.js');
    initDb(':memory:');

    // A hostile output: provenance keys planted *before* the candidate fields,
    // carrying values the client chose. Overwriting in place would keep them in
    // these positions and silently fork a restarted node's stateRoot.
    const hostile = {
      boxType: 'credit',
      txId: 'aa'.repeat(32),
      index: 99,
      value: 100n,
      owner: user(0xd1),
      guard: 'owner_signature',
      proofSource: -1,
    } as unknown as CreditBox;

    const produced = materializeOutput(hostile, TX_ID, 0);
    expect(produced.txId).toBe(TX_ID);
    expect(produced.index).toBe(0);

    const keys = Object.keys(produced).filter((k) => k !== 'id');
    expect(keys.slice(-2)).toEqual(['txId', 'index']);
    // And the canonical position is the only one they appear in.
    expect(keys.indexOf('txId')).toBe(keys.lastIndexOf('txId'));

    insertBox(produced);
    const restored = getBox(produced.id!)!;
    expect(Buffer.from(serializeBox(restored)).toString('hex')).toBe(
      Buffer.from(serializeBox(produced)).toString('hex'),
    );
  });

  it('is total over every box type, appending after each type\'s own fields', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { serializeBox } = await import('../../src/state/serialize-box.js');
    const { materializeOutput } = await import('../../src/services/utxo-engine.js');
    initDb(':memory:');

    // `post_lock` is deliberately absent: it carries a pre-existing
    // producer-vs-`rowToBox` field order divergence (`originalValue` and
    // `createdAtBlock` swapped) that phase G owns (contract 1b), so byte
    // identity does not hold for it and never did.
    const candidates: AnyBox[] = [
      {
        boxType: 'karma', value: 5n, owner: user(0xe1),
        guard: 'owner_signature', proofSource: 'p', 
      } satisfies KarmaBox,
      creditCandidate(7n, user(0xe2)),
      {
        boxType: 'credit', value: 8n, owner: user(0xe3),
        guard: 'owner_signature', proofSource: -1, lockedUntilBlock: 900,
      } satisfies CreditBox,
      {
        boxType: 'invite', value: 1n, secretHash: user(0xe5),
        inviterId: user(0xe6), guard: 'hash_preimage_with_bond',
      },
      {
        boxType: 'bond', value: 3n, inviterId: user(0xe7),
        inviteOutputIndex: 0, inviteePublicKey: user(0xe8),
        probationStartBlock: 1, probationEndBlock: 9, guard: 'bond_dual',
      },
      {
        boxType: 'vouch', value: 1n, voucherId: user(0xe9),
        targetId: user(0xea), guard: 'owner_signature',
      },
    ] as AnyBox[];

    candidates.forEach((candidate, index) => {
      const produced = materializeOutput(candidate, TX_ID, index);
      const keys = Object.keys(produced).filter((k) => k !== 'id');
      expect(keys.slice(-2)).toEqual(['txId', 'index']);

      insertBox(produced);
      const restored = getBox(produced.id!)!;
      expect(Buffer.from(serializeBox(restored)).toString('hex')).toBe(
        Buffer.from(serializeBox(produced)).toString('hex'),
      );
    });
  });

  it('applyTx stores the materialized box unchanged, and the height goes to the column', async () => {
    // Was "applyTx rewrites createdAtBlock without displacing provenance".
    // There is no rewrite any more: that rewrite WAS M-11 — it moved the box's
    // height while leaving the id committed to the client's declared one — and
    // phase G3b closes it by deleting the field rather than by rewriting it.
    //
    // Two things replace the old assertion. The stored box must be byte-identical
    // to what `materializeOutput` produced, because any key added or reordered on
    // the way in now changes the id. And the settled height must still reach the
    // `created_at_block` store column, taken from the open journal — the only
    // place `insertBox` can now get it (checklist item 7).
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { serializeBox } = await import('../../src/state/serialize-box.js');
    const { materializeOutput, applyTx } = await import(
      '../../src/services/utxo-engine.js'
    );
    const { getDb } = await importDbFresh();
    initDb(':memory:');

    const produced = materializeOutput(creditCandidate(100n, user(0xf1)), TX_ID, 0);
    applyTx(
      {
        getBox,
        insertBox,
        consumeBox: () => {},
        getKarmaBox: () => null,
        runInTransaction: (fn: () => void) => { getDb().transaction(fn)(); },
      } as never,
      { inputs: [], outputs: [], signatures: {}, protocolVersion: 1 },
      [produced],
      777,
    );

    const restored = getBox(produced.id!)!;
    expect(restored.txId).toBe(TX_ID);
    expect(restored.index).toBe(0);
    // The box carries no height at all — that is the point of the deletion.
    expect('createdAtBlock' in restored).toBe(false);
    expect('lastTouchBlock' in restored).toBe(false);
    expect(Buffer.from(serializeBox(restored)).toString('hex')).toBe(
      Buffer.from(serializeBox({ ...produced })).toString('hex'),
    );
  });
});
