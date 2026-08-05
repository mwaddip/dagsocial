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
    createdAtBlock: 12,
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

  it('leaves the box id unmoved — provenance is stripped before it is hashed', async () => {
    const { materializeOutput } = await import('../../src/services/utxo-engine.js');

    // The load-bearing invariant for every phase before G: attaching provenance
    // must not move an id. `computeBoxId` strips it via `canonicalBoxBytes`.
    const candidate = creditCandidate(100n, user(0xb1));
    const materialized = materializeOutput(candidate, TX_ID, 3);
    expect(materialized.id).toBe(computeBoxId(candidate));
  });

  it('appends provenance last, so the store reconstruction is byte-identical', async () => {
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
      createdAtBlock: 12,
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
        boxType: 'karma', value: 5n, createdAtBlock: 12, owner: user(0xe1),
        guard: 'owner_signature', proofSource: 'p', lastTouchBlock: 12,
      } satisfies KarmaBox,
      creditCandidate(7n, user(0xe2)),
      {
        boxType: 'credit', value: 8n, createdAtBlock: 12, owner: user(0xe3),
        guard: 'owner_signature', proofSource: -1, lockedUntilBlock: 900,
      } satisfies CreditBox,
      {
        boxType: 'like', value: 2n, createdAtBlock: 12, likerId: user(0xe4),
        targetPostId: 'ab'.repeat(32), guard: 'epoch_tally',
      },
      {
        boxType: 'invite', value: 1n, createdAtBlock: 12, secretHash: user(0xe5),
        inviterId: user(0xe6), guard: 'hash_preimage_with_bond',
      },
      {
        boxType: 'bond', value: 3n, createdAtBlock: 12, inviterId: user(0xe7),
        inviteBoxId: 'cd'.repeat(32), inviteePublicKey: user(0xe8),
        probationStartBlock: 1, probationEndBlock: 9, guard: 'bond_dual',
      },
      {
        boxType: 'vouch', value: 1n, createdAtBlock: 12, voucherId: user(0xe9),
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

  it('applyTx rewrites createdAtBlock without displacing provenance', async () => {
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

    // `createdAtBlock` is an existing key, so the rewrite updates it in place
    // and provenance stays at the end. The id is deliberately NOT re-derived —
    // that is M-11, and phase G closes it by deleting the field.
    const restored = getBox(produced.id!)!;
    expect(restored.createdAtBlock).toBe(777);
    expect(restored.txId).toBe(TX_ID);
    expect(restored.index).toBe(0);
    expect(Buffer.from(serializeBox(restored)).toString('hex')).toBe(
      Buffer.from(serializeBox({ ...produced, createdAtBlock: 777 })).toString('hex'),
    );
  });
});
