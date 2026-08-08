import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { KarmaBox, UserId } from '@dagsocial/types';
import type { IdentityRecord } from '../../src/store/identity-records.js';
import {
  GENESIS_SYSTEM_KARMA,
  genesisContext,
  mintTxIdFor,
} from '../../src/mint-provenance.js';

/**
 * Spec G phase D — genesis writes its own identity record.
 *
 * `ensureSystemKarmaBox` is the one non-decay karma producer that runs
 * **outside** block application. `insertBox`'s choke point takes the activity
 * height from the open journal, and genesis has none, so the system identity
 * would otherwise hold 50,000 karma with no clock at all and decay would fall
 * back to "never active".
 *
 * That fallback is not equivalent. The guard (`height <= threshold` → not
 * stale) happens to make *staleness* agree, but `owedPeriods` counts from 0
 * instead of from `genesisHeight`, so the very first firing over-charges
 * whenever `(threshold + 1) % interval === 0`. The config below is chosen to sit
 * exactly on that boundary, because a config off it would let the bug through.
 */

async function importFresh() {
  const db = (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
  };
  const system = await import('../../src/store/system.js');
  const records = (await import('../../src/store/identity-records.js')) as {
    getIdentityRecord: (id: UserId) => IdentityRecord | null;
    putIdentityRecord: (id: UserId, r: IdentityRecord) => void;
  };
  const utxo = await import('../../src/store/utxo.js');
  const decay = await import('../../src/services/decay.js');
  return { ...db, system, records, utxo, decay };
}

type Store = Awaited<ReturnType<typeof importFresh>>;

function decayDeps(s: Store) {
  return {
    getKarmaBoxes: (owner: Uint8Array) => s.utxo.getKarmaBoxes(owner),
    consumeBox: s.utxo.consumeBox,
    insertBox: s.utxo.insertBox,
    getIdentityRecord: s.records.getIdentityRecord,
    putIdentityRecord: s.records.putIdentityRecord,
    getKarmaOwners: () =>
      (
        s
          .getDb()
          .prepare(
            `SELECT DISTINCT owner FROM utxo_boxes
             WHERE box_type = 'karma' AND spent_at_block IS NULL`,
          )
          .all() as { owner: Buffer }[]
      ).map((r) => new Uint8Array(r.owner)),
  };
}

describe('genesis identity record (Spec G phase D)', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('the system karma box and its clock get the same height', async () => {
    const s = await importFresh();
    s.initDb(':memory:');
    const keypair = s.system.initSystemKeypair();

    // `getCurrentHeight()` is 0 on a fresh chain, and genesis clamps to 1.
    const box = s.system.ensureSystemKarmaBox(keypair.publicKey, 0);

    // The box carries no height field any more (phase G3b), so the cross-check
    // is against the height baked into its **mint txId** — which is now the only
    // place a genesis height appears in the box, and is consensus-visible where
    // `created_at_block` never was.
    expect(box.txId).toBe(mintTxIdFor(genesisContext(GENESIS_SYSTEM_KARMA), 1));
    expect(s.records.getIdentityRecord(keypair.publicKey)).toEqual({
      lastActivityBlock: 1,
      lastDecayBlock: 0,
      likeCarry: 0n,
    });
  });

  it('a genesis at a non-zero height records that height, not the clamp', async () => {
    const s = await importFresh();
    s.initDb(':memory:');
    const keypair = s.system.initSystemKeypair();

    const box = s.system.ensureSystemKarmaBox(keypair.publicKey, 500);

    expect(box.txId).toBe(mintTxIdFor(genesisContext(GENESIS_SYSTEM_KARMA), 500));
    expect(s.records.getIdentityRecord(keypair.publicKey)).toEqual({
      lastActivityBlock: 500,
      lastDecayBlock: 0,
      likeCarry: 0n,
    });
  });

  it('is idempotent — a second call neither re-mints nor rewrites the clock', async () => {
    const s = await importFresh();
    s.initDb(':memory:');
    const keypair = s.system.initSystemKeypair();

    s.system.ensureSystemKarmaBox(keypair.publicKey, 0);
    // A later call (e.g. from `faucetGrant`) must not move the clock forward and
    // hand the system a fresh staleness window.
    s.system.ensureSystemKarmaBox(keypair.publicKey, 900);

    expect(s.records.getIdentityRecord(keypair.publicKey)).toEqual({
      lastActivityBlock: 1,
      lastDecayBlock: 0,
      likeCarry: 0n,
    });
  });

  it("the system's first decay charges from genesis height, not from zero", async () => {
    const s = await importFresh();
    s.initDb(':memory:');
    const keypair = s.system.initSystemKeypair();
    s.system.ensureSystemKarmaBox(keypair.publicKey, 0);

    // threshold 11, interval 3 — chosen so `(threshold + 1) % interval === 0`,
    // the exact boundary where counting from 0 buys a whole extra interval.
    //
    //   genesis clock (1) : floor((12 − 1) / 3) = 3 periods → burn 15
    //   never-active  (0) : floor((12 − 0) / 3) = 4 periods → burn 20
    //
    // 15 is what the box-height clock produced, `createdAtBlock` being 1.
    const entries = s.decay.applyKarmaDecay(decayDeps(s), 12, {
      staleThresholdBlocks: 11,
      decayIntervalBlocks: 3,
      decayAmount: 5n,
      karmaMinimum: 0n,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]!.burnAmount).toBe(15n);
  });

  it('the system identity is not stale before genesis height + threshold', async () => {
    const s = await importFresh();
    s.initDb(':memory:');
    const keypair = s.system.initSystemKeypair();
    s.system.ensureSystemKarmaBox(keypair.publicKey, 0);

    const cfg = {
      staleThresholdBlocks: 11,
      decayIntervalBlocks: 3,
      decayAmount: 5n,
      karmaMinimum: 0n,
    };
    const before = (s.utxo.getKarmaBoxes(keypair.publicKey)[0] as KarmaBox).value;

    expect(s.decay.applyKarmaDecay(decayDeps(s), 11, cfg)).toHaveLength(0);
    expect((s.utxo.getKarmaBoxes(keypair.publicKey)[0] as KarmaBox).value).toBe(before);
  });

  it('the faucet credit box creates no identity record', async () => {
    const s = await importFresh();
    s.initDb(':memory:');
    const keypair = s.system.initSystemKeypair();

    // Credits are not karma and carry no decay clock. Only the karma leg writes.
    s.system.ensureFaucetCreditBox(keypair.publicKey, 0);

    expect(s.records.getIdentityRecord(keypair.publicKey)).toBeNull();
  });
});
