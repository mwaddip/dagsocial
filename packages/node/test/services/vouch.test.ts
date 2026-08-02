import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import {
  computeBoxId,
  decodeTx,
  VOUCH_KARMA_AMOUNT,
  VOUCH_MIN_BALANCE,
  VOUCH_COOLDOWN_BLOCKS,
  MEMPOOL_EXPIRY_BLOCKS,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { KarmaBox, VouchBox, UtxoTransaction, AnyBox } from '@dagsocial/types';
import Database from 'better-sqlite3';

import {
  initDb,
  closeDb,
  getDb,
  getKarmaBox,
  insertBox,
  insertVouchCooldown,
  getBox as storeGetBox,
  getPendingEntries,
} from '../../src/store/index.js';
import { castVouch, initiateUnvouch } from '../../src/services/vouch.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';
import { rawPublicKey, signTransaction } from '../helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create and insert a karma box, returning it with its computed id. */
function createKarmaBox(
  owner: Uint8Array,
  value: number,
  createdAtBlock: number,
): KarmaBox {
  const box: Omit<KarmaBox, 'id'> & { id?: string } = {
    boxType: 'karma',
    value,
    createdAtBlock,
    owner,
    guard: 'owner_signature',
    proofSource: 'test',
    lastTouchBlock: createdAtBlock,
  };
  const id = computeBoxId(box);
  const full: KarmaBox = { ...box, id, boxType: 'karma', guard: 'owner_signature' };
  insertBox(full);
  return full;
}

/** Create and insert a vouch box, returning it with its computed id. */
function createVouchBox(
  voucherId: Uint8Array,
  targetId: Uint8Array,
  createdAtBlock: number,
): VouchBox {
  const box: Omit<VouchBox, 'id'> & { id?: string } = {
    boxType: 'vouch',
    value: VOUCH_KARMA_AMOUNT,
    voucherId,
    targetId,
    guard: 'owner_signature',
    createdAtBlock,
  };
  const id = computeBoxId(box);
  const full: VouchBox = { ...box, id, boxType: 'vouch', guard: 'owner_signature' };
  insertBox(full);
  return full;
}

/** An unsigned vouch tx — for rejections that fire before validateTx. */
function vouchTxFor(
  voucherId: Uint8Array,
  targetId: Uint8Array,
  createdAtBlock: number,
): UtxoTransaction {
  return {
    inputs: [],
    outputs: [
      {
        boxType: 'vouch' as const,
        value: VOUCH_KARMA_AMOUNT,
        voucherId,
        targetId,
        guard: 'owner_signature' as const,
        createdAtBlock,
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('vouch service', () => {
  let db: Database.Database;
  let voucherPubKey: Uint8Array;
  let voucherPrivKey: KeyObject;
  let voucherPubKeyHex: string;
  let targetPubKey: Uint8Array;
  let targetPubKeyHex: string;
  let deps: UtxoEngineDeps;

  function makeDeps(): UtxoEngineDeps {
    return {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db
          .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
          .get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
      insertBox: (box: AnyBox) => {
        insertBox(box);
      },
      consumeBox: (id: string, atBlock: number) => {
        db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(atBlock, id);
      },
      getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
    };
  }

  /** A fully-formed, signed vouch tx that passes validateTx. */
  function signedVouchTx(
    karmaBoxId: string,
    owner: Uint8Array,
    targetId: Uint8Array,
    atBlock: number,
    privKey?: KeyObject,
  ): UtxoTransaction {
    const ownerHex = Buffer.from(owner).toString('hex');
    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 99,
      createdAtBlock: atBlock,
      owner,
      guard: 'owner_signature',
      proofSource: `vouch:${Buffer.from(targetId).toString('hex')}`,
      lastTouchBlock: atBlock,
    };
    const vouchBox: Omit<VouchBox, 'id'> & { id?: string } = {
      boxType: 'vouch',
      value: VOUCH_KARMA_AMOUNT,
      voucherId: owner,
      targetId,
      guard: 'owner_signature',
      createdAtBlock: atBlock,
    };
    const tx: UtxoTransaction = {
      inputs: [karmaBoxId],
      outputs: [
        { ...newKarma, id: computeBoxId(newKarma) },
        { ...vouchBox, id: computeBoxId(vouchBox) } as VouchBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, privKey ?? voucherPrivKey, ownerHex);
    return tx;
  }

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();

    // Voucher identity
    const voucherKeys = generateKeyPairSync('ed25519');
    voucherPubKey = rawPublicKey(voucherKeys.publicKey);
    voucherPrivKey = voucherKeys.privateKey;
    voucherPubKeyHex = Buffer.from(voucherPubKey).toString('hex');

    // Target identity (different from voucher)
    const targetKeys = generateKeyPairSync('ed25519');
    targetPubKey = rawPublicKey(targetKeys.publicKey);
    targetPubKeyHex = Buffer.from(targetPubKey).toString('hex');

    deps = makeDeps();
  });

  afterEach(() => {
    closeDb();
  });

  // -----------------------------------------------------------------------
  // castVouch — error cases
  // -----------------------------------------------------------------------

  describe('castVouch', () => {
    it('rejects if no VouchBox in outputs', () => {
      const tx: UtxoTransaction = {
        inputs: [],
        outputs: [],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      expect(() => castVouch(deps, tx, 5)).toThrow(
        'Transaction must contain a VouchBox output',
      );
    });

    it('rejects invalid target (all zeros)', () => {
      const tx: UtxoTransaction = {
        inputs: [],
        outputs: [
          {
            boxType: 'vouch' as const,
            value: VOUCH_KARMA_AMOUNT,
            voucherId: voucherPubKey,
            targetId: new Uint8Array(32), // all zeros
            guard: 'owner_signature' as const,
            createdAtBlock: 5,
          },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      expect(() => castVouch(deps, tx, 5)).toThrow(
        'Invalid vouch target: must be a 32-byte public key',
      );
    });

    it('rejects self-vouch', () => {
      const tx: UtxoTransaction = {
        inputs: [],
        outputs: [
          {
            boxType: 'vouch' as const,
            value: VOUCH_KARMA_AMOUNT,
            voucherId: voucherPubKey,
            targetId: voucherPubKey, // same as voucher
            guard: 'owner_signature' as const,
            createdAtBlock: 5,
          },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      expect(() => castVouch(deps, tx, 5)).toThrow('Cannot vouch for yourself');
    });

    it('rejects insufficient karma (< 11)', () => {
      // Create a karma box with only 10 karma (below VOUCH_MIN_BALANCE of 11)
      createKarmaBox(voucherPubKey, 10, 1);

      const tx: UtxoTransaction = {
        inputs: [],
        outputs: [
          {
            boxType: 'vouch' as const,
            value: VOUCH_KARMA_AMOUNT,
            voucherId: voucherPubKey,
            targetId: targetPubKey,
            guard: 'owner_signature' as const,
            createdAtBlock: 5,
          },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      expect(() => castVouch(deps, tx, 5)).toThrow(
        `Insufficient karma: need at least ${VOUCH_MIN_BALANCE} to vouch`,
      );
    });

    it('rejects duplicate vouch (pair already exists)', () => {
      // Give voucher enough karma to pass the balance check
      createKarmaBox(voucherPubKey, 100, 1);

      // Create an existing vouch box for the same pair
      createVouchBox(voucherPubKey, targetPubKey, 5);

      const tx: UtxoTransaction = {
        inputs: [],
        outputs: [
          {
            boxType: 'vouch' as const,
            value: VOUCH_KARMA_AMOUNT,
            voucherId: voucherPubKey,
            targetId: targetPubKey,
            guard: 'owner_signature' as const,
            createdAtBlock: 10,
          },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      expect(() => castVouch(deps, tx, 10)).toThrow(
        'Already vouching for an identity',
      );
    });

    // -------------------------------------------------------------------
    // Single active vouch, across all targets (audit L-4). The check used
    // to be pair-scoped, so one identity could hold many concurrent
    // VouchBoxes just by picking a different target each time.
    // -------------------------------------------------------------------

    it('rejects a second vouch aimed at a different target', () => {
      createKarmaBox(voucherPubKey, 100, 1);
      createVouchBox(voucherPubKey, targetPubKey, 5);

      const otherTarget = rawPublicKey(generateKeyPairSync('ed25519').publicKey);
      const tx = vouchTxFor(voucherPubKey, otherTarget, 10);

      expect(() => castVouch(deps, tx, 10)).toThrow(
        'Already vouching for an identity',
      );
    });

    it('rejects a second vouch while the first is still pending in the mempool', () => {
      const karma = createKarmaBox(voucherPubKey, 100, 1);

      // First vouch — validated and queued, no VouchBox in the UTXO set yet.
      const firstTx = signedVouchTx(karma.id!, voucherPubKey, targetPubKey, 5);
      expect(castVouch(deps, firstTx, 5).status).toBe('pending');

      const otherTarget = rawPublicKey(generateKeyPairSync('ed25519').publicKey);
      const secondTx = vouchTxFor(voucherPubKey, otherTarget, 6);

      expect(() => castVouch(deps, secondTx, 6)).toThrow('Vouch already pending');
    });

    it('control — a voucher with no active or pending vouch is accepted', () => {
      const karma = createKarmaBox(voucherPubKey, 100, 1);
      const tx = signedVouchTx(karma.id!, voucherPubKey, targetPubKey, 5);
      expect(castVouch(deps, tx, 5).status).toBe('pending');
    });

    it('control — a different voucher is unaffected by another identity vouching', () => {
      createKarmaBox(voucherPubKey, 100, 1);
      createVouchBox(voucherPubKey, targetPubKey, 5);

      const otherKeys = generateKeyPairSync('ed25519');
      const otherPub = rawPublicKey(otherKeys.publicKey);
      const otherKarma = createKarmaBox(otherPub, 100, 1);
      const tx = signedVouchTx(otherKarma.id!, otherPub, targetPubKey, 10, otherKeys.privateKey);

      expect(castVouch(deps, tx, 10).status).toBe('pending');
    });

    it('rejects if cooldown active', () => {
      // Give voucher enough karma
      createKarmaBox(voucherPubKey, 100, 1);

      // Set up a different target that has an active cooldown
      const cooldownTarget = (() => {
        const keys = generateKeyPairSync('ed25519');
        return rawPublicKey(keys.publicKey);
      })();

      // Insert an active cooldown for (voucher, cooldownTarget)
      insertVouchCooldown(
        voucherPubKey,
        cooldownTarget,
        999, // release far in the future
        VOUCH_KARMA_AMOUNT,
      );

      const tx: UtxoTransaction = {
        inputs: [],
        outputs: [
          {
            boxType: 'vouch' as const,
            value: VOUCH_KARMA_AMOUNT,
            voucherId: voucherPubKey,
            targetId: cooldownTarget,
            guard: 'owner_signature' as const,
            createdAtBlock: 10,
          },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      expect(() => castVouch(deps, tx, 10)).toThrow(
        'Vouch cooldown active — cannot re-vouch yet',
      );
    });

    // -------------------------------------------------------------------
    // castVouch — success
    // -------------------------------------------------------------------

    it('accepts valid vouch and inserts into mempool', () => {
      const karma = createKarmaBox(voucherPubKey, 100, 1);

      const newKarma: KarmaBox = {
        boxType: 'karma',
        value: 99,
        createdAtBlock: 5,
        owner: voucherPubKey,
        guard: 'owner_signature',
        proofSource: `vouch:${targetPubKeyHex}`,
        lastTouchBlock: 5,
      };
      const newKarmaId = computeBoxId(newKarma);

      const vouchBox: Omit<VouchBox, 'id'> & { id?: string } = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        voucherId: voucherPubKey,
        targetId: targetPubKey,
        guard: 'owner_signature',
        createdAtBlock: 5,
      };
      const vouchBoxId = computeBoxId(vouchBox);

      const tx: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [
          { ...newKarma, id: newKarmaId },
          { ...vouchBox, id: vouchBoxId } as VouchBox,
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      signTransaction(tx, voucherPrivKey, voucherPubKeyHex);

      const result = castVouch(deps, tx, 5);

      expect(result.status).toBe('pending');
      expect(result.txId).toBeDefined();
      expect(typeof result.txId).toBe('string');
      expect(result.expiresAtHeight).toBe(5 + MEMPOOL_EXPIRY_BLOCKS);

      // Verify mempool has the entry
      const entries = getPendingEntries(100);
      const matching = entries.filter((e) => {
        if (e.entryType !== 'utxo_tx' || !e.utxoTxCbor) return false;
        const storedTx = decodeTx(e.utxoTxCbor);
        return storedTx.outputs.some(
          (o) => o.boxType === 'vouch',
        );
      });
      expect(matching.length).toBe(1);
    });

    it('karma is unchanged after castVouch (pending only)', () => {
      const karma = createKarmaBox(voucherPubKey, 100, 1);

      const newKarma: KarmaBox = {
        boxType: 'karma',
        value: 99,
        createdAtBlock: 5,
        owner: voucherPubKey,
        guard: 'owner_signature',
        proofSource: `vouch:${targetPubKeyHex}`,
        lastTouchBlock: 5,
      };
      const newKarmaId = computeBoxId(newKarma);

      const vouchBox: Omit<VouchBox, 'id'> & { id?: string } = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        voucherId: voucherPubKey,
        targetId: targetPubKey,
        guard: 'owner_signature',
        createdAtBlock: 5,
      };
      const vouchBoxId = computeBoxId(vouchBox);

      const tx: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [
          { ...newKarma, id: newKarmaId },
          { ...vouchBox, id: vouchBoxId } as VouchBox,
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      signTransaction(tx, voucherPrivKey, voucherPubKeyHex);
      castVouch(deps, tx, 5);

      // Karma should be unchanged (pending in mempool, not applied)
      const karmaBox = getKarmaBox(voucherPubKey);
      expect(karmaBox).not.toBeNull();
      expect(karmaBox!.value).toBe(100);
    });
  });

  // -----------------------------------------------------------------------
  // initiateUnvouch
  // -----------------------------------------------------------------------

  describe('initiateUnvouch', () => {
    it('rejects if no VouchBox in inputs', () => {
      // Create a tx with a random input that does not exist in the DB
      const fakeInputId = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
      const tx: UtxoTransaction = {
        inputs: [fakeInputId],
        outputs: [],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      expect(() => initiateUnvouch(deps, tx, 5)).toThrow(
        'Transaction does not consume a VouchBox',
      );
    });

    it('rejects if signer is not the voucher', () => {
      // Create a vouch box owned by voucher
      const vouchBox = createVouchBox(voucherPubKey, targetPubKey, 1);

      // Build tx that consumes the vouch box
      const tx: UtxoTransaction = {
        inputs: [vouchBox.id!],
        outputs: [],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      // Sign with target's key (not the voucher's key)
      const targetKeys = generateKeyPairSync('ed25519');
      const targetPrivKey = targetKeys.privateKey;
      const wrongPubKeyHex = targetPubKeyHex;

      signTransaction(tx, targetPrivKey, wrongPubKeyHex);

      expect(() => initiateUnvouch(deps, tx, 5)).toThrow(
        'VouchBox does not belong to signer',
      );
    });

    it('accepts valid unvouch and inserts into mempool', () => {
      const vouchBox = createVouchBox(voucherPubKey, targetPubKey, 1);

      const tx: UtxoTransaction = {
        inputs: [vouchBox.id!],
        outputs: [],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      signTransaction(tx, voucherPrivKey, voucherPubKeyHex);

      const result = initiateUnvouch(deps, tx, 5);

      expect(result.status).toBe('pending');
      expect(result.txId).toBeDefined();
      expect(typeof result.txId).toBe('string');
      expect(result.expiresAtHeight).toBe(5 + MEMPOOL_EXPIRY_BLOCKS);
      expect(result.karmaReturnsAtBlock).toBe(5 + VOUCH_COOLDOWN_BLOCKS);

      // Verify mempool has the entry
      const entries = getPendingEntries(100);
      const matching = entries.filter((e) => {
        if (e.entryType !== 'utxo_tx' || !e.utxoTxCbor) return false;
        const storedTx = decodeTx(e.utxoTxCbor);
        return storedTx.inputs.includes(vouchBox.id!);
      });
      expect(matching.length).toBe(1);
    });
  });
});
