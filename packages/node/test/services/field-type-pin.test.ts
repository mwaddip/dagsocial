/**
 * Field-type pin (NODE_INTERFACE → "Output shape"): output fields carry
 * runtime types, and the shape check runs at validateTx step 4 — the first
 * consumer of `tx.outputs`.
 *
 * Four layers:
 *  - the TOTALITY property: for any contents of `tx.outputs` — missing
 *    fields, wrong-typed fields, `null`/non-object entries, unknown or
 *    prototype-colliding boxTypes — `validateTx` returns `{valid: false}`
 *    and never throws. Corpus transactions are deliberately UNSIGNED: the
 *    shape gate must reject before guards are ever consulted, so a
 *    signature-shaped error (or a throw) here is a placement regression;
 *  - PER-FIELD rejects: for each boxType, each pinned field with a
 *    wrong-typed value → invalid, error names index, boxType, and key;
 *  - ACCEPT controls the guard-shape suite does not already cover: the
 *    honest bond commit (typed probation numbers — the class-4c coercion
 *    shape, now dead) and the honest unvouch;
 *  - CBOR INGRESS: a block embedding the class-3 poison tx (string
 *    `originalValue`) is REJECTED by the funnel through the clean
 *    `{valid:false}` path — not the totality catch — and nothing lands in
 *    the store. On the pre-pin tree the same block APPLIED and the stored
 *    row made every later read of it throw (the before-leg probes).
 *
 * The accept controls for every other legal transition live in
 * output-shape.test.ts (guard-shape pin) and utxo-engine.test.ts; the
 * id-integrity discriminator, fed the class-4 mutants, lives in
 * output-shape-id-integrity.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, createHash, type KeyObject } from 'crypto';
import {
  computeBoxId,
  computeTxId,
  encodeTx,
  decodeTx,
  POST_LOCK_THREAD_COST,
  INVITE_PROBATION_BLOCKS,
} from '@dagsocial/types';
import type { AnyBox, AnyBoxCandidate, KarmaBox, UtxoTransaction } from '@dagsocial/types';
import Database from 'better-sqlite3';
import {
  fixtureProvenance,
  seedAsOneTx,
  makeTestIdentity,
  makeKarmaBox,
  makeApplicableBlock,
  type TestIdentity,
} from '../helpers.js';
import {
  initDb,
  closeDb,
  getDb,
  getBox as storeGetBox,
  getBoxByProvenance as storeGetBoxByProvenance,
  getKarmaBox,
  getKarmaBoxes,
  insertBox as storeInsertBox,
  consumeBox as storeConsumeBox,
  hasActiveVouchCooldown as storeHasActiveVouchCooldown,
} from '../../src/store/index.js';
import { validateTx, checkOutputShape } from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';
import { applyOrderingBlock } from '../../src/services/block-apply.js';

function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

const bytes32 = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

describe('field-type pin', () => {
  let db: Database.Database;
  let ownerPubKey: Uint8Array;
  let ownerPrivKey: KeyObject;
  let deps: UtxoEngineDeps;

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    ownerPubKey = rawPublicKey(publicKey);
    ownerPrivKey = privateKey;
    deps = {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db
          .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
          .get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
      getBoxByProvenance: storeGetBoxByProvenance,
      insertBox: (box: AnyBox) => storeInsertBox(box),
      consumeBox: (id: string, atBlock: number) => storeConsumeBox(id, atBlock),
      getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
      getKarmaValue: (owner: Uint8Array) =>
        getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
      hasActiveVouchCooldown: storeHasActiveVouchCooldown,
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
    };
  });

  afterEach(() => closeDb());

  function seedKarma(value: bigint): KarmaBox {
    const box: Omit<KarmaBox, 'id'> & { id?: string } = {
      boxType: 'karma',
      value,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
    };
    Object.assign(box, fixtureProvenance(box, 1));
    const full = { ...box, id: computeBoxId(box) } as KarmaBox;
    storeInsertBox(full);
    return full;
  }

  function signedTx(inputs: string[], outputs: unknown[]): UtxoTransaction {
    const tx: UtxoTransaction = {
      inputs,
      outputs: outputs as UtxoTransaction['outputs'],
      signatures: {},
      protocolVersion: 1,
    };
    const hash = Buffer.from(computeTxId(tx), 'hex');
    tx.signatures[Buffer.from(ownerPubKey).toString('hex')] = new Uint8Array(
      cryptoSign(null, hash, ownerPrivKey),
    );
    return tx;
  }

  function karmaChange(value: bigint): Record<string, unknown> {
    return {
      boxType: 'karma',
      value,
      owner: ownerPubKey,
      guard: 'owner_signature',
      proofSource: 'test',
    };
  }

  // -------------------------------------------------------------------------
  // Totality: validateTx never throws, whatever tx.outputs holds
  // -------------------------------------------------------------------------

  describe('totality of validateTx over malformed outputs', () => {
    /**
     * Corpus of malformed outputs. Each runs as the outputs of an UNSIGNED
     * transaction over one live karma input: the step-4 gate must produce the
     * reject before conservation, guards, or transitions can read the object
     * (an unsigned tx surfacing a signature error — or a throw — means the
     * gate moved).
     */
    const karmaOwner32 = bytes32(0x11);
    const CORPUS: Array<[string, unknown]> = [
      // -- missing fields (the class-1 validate-time-throw sites) --
      ['karma missing owner', { boxType: 'karma', value: 10n, guard: 'owner_signature', proofSource: 't' }],
      ['karma missing value', { boxType: 'karma', owner: karmaOwner32, guard: 'owner_signature', proofSource: 't' }],
      ['vouch missing voucherId', { boxType: 'vouch', value: 1n, targetId: karmaOwner32, guard: 'owner_signature' }],
      ['bond missing inviteePublicKey', { boxType: 'bond', value: 10n, inviterId: karmaOwner32, inviteOutputIndex: 0, probationStartBlock: 0, probationEndBlock: 0, guard: 'bond_dual' }],
      ['post_lock missing originalValue', { boxType: 'post_lock', value: 10n, owner: karmaOwner32, targetPostId: 'a'.repeat(64), guard: 'block_apply' }],
      // -- wrong-typed fields, one per FieldType --
      ['karma value as number', { ...honest('karma'), value: 10 }],
      ['karma value negative bigint', { ...honest('karma'), value: -1n }],
      ['karma value at 2^64', { ...honest('karma'), value: 1n << 64n }],
      ['karma owner as hex string', { ...honest('karma'), owner: 'aa'.repeat(32) }],
      ['karma owner 31 bytes', { ...honest('karma'), owner: new Uint8Array(31) }],
      ['karma owner 33 bytes', { ...honest('karma'), owner: new Uint8Array(33) }],
      ['karma owner as number', { ...honest('karma'), owner: 5 }],
      ['karma proofSource as number', { ...honest('karma'), proofSource: 42 }],
      ['karma decayBurn as string', { ...honest('karma'), decayBurn: 'yes' }],
      ['credit proofSource as string', { ...honest('credit'), proofSource: 'x' }],
      ['credit proofSource as -0', { ...honest('credit'), proofSource: -0 }],
      ['credit proofSource fractional', { ...honest('credit'), proofSource: 1.5 }],
      ['credit lockedUntilBlock negative', { ...honest('credit'), lockedUntilBlock: -1 }],
      ['credit lockedUntilBlock as -0', { ...honest('credit'), lockedUntilBlock: -0 }],
      ['post_lock originalValue as string (the class-3 poison)', { ...honest('post_lock'), originalValue: 'x' }],
      ['post_lock targetPostId as number', { ...honest('post_lock'), targetPostId: 123 }],
      ['bond inviteOutputIndex above u32', { ...honest('bond'), inviteOutputIndex: 0x1_0000_0000 }],
      ['bond inviteOutputIndex as string', { ...honest('bond'), inviteOutputIndex: '0' }],
      ['bond inviteOutputIndex NaN', { ...honest('bond'), inviteOutputIndex: Number.NaN }],
      ['bond inviteePublicKey 1 byte', { ...honest('bond'), inviteePublicKey: new Uint8Array(1) }],
      ['bond inviteePublicKey 31 bytes', { ...honest('bond'), inviteePublicKey: new Uint8Array(31) }],
      ['bond inviteePublicKey 33 bytes', { ...honest('bond'), inviteePublicKey: new Uint8Array(33) }],
      ['bond probationStartBlock as string (the class-4c coercion)', { ...honest('bond'), probationStartBlock: '25' }],
      ['bond probationEndBlock fractional', { ...honest('bond'), probationEndBlock: 1.5 }],
      ['invite secretHash 31 bytes', { ...honest('invite'), secretHash: new Uint8Array(31) }],
      ['invite inviterId as string', { ...honest('invite'), inviterId: 'aa'.repeat(32) }],
      ['vouch voucherId 31 bytes', { ...honest('vouch'), voucherId: new Uint8Array(31) }],
      ['vouch targetId as string', { ...honest('vouch'), targetId: 'cc'.repeat(32) }],
      // -- entries that are not objects at all --
      ['null entry', null],
      ['number entry', 42],
      ['string entry', 'box'],
      ['boolean entry', true],
      ['array entry', []],
      // -- unknown and prototype-colliding boxTypes --
      ["boxType 'constructor'", { boxType: 'constructor', value: 10n, guard: 'owner_signature' }],
      ["boxType 'toString'", { boxType: 'toString', value: 10n, guard: 'owner_signature' }],
      ["boxType 'like' (retired)", { boxType: 'like', value: 10n, guard: 'owner_signature' }],
      ['boxType as number', { boxType: 7, value: 10n, guard: 'owner_signature' }],
      ['boxType missing', { value: 10n, guard: 'owner_signature' }],
    ];

    function honest(boxType: string): Record<string, unknown> {
      switch (boxType) {
        case 'karma':
          return { boxType, value: 10n, owner: karmaOwner32, guard: 'owner_signature', proofSource: 't' };
        case 'credit':
          return { boxType, value: 10n, owner: karmaOwner32, guard: 'owner_signature', proofSource: 7 };
        case 'invite':
          return { boxType, value: 10n, secretHash: bytes32(0xaa), inviterId: karmaOwner32, guard: 'hash_preimage_with_bond' };
        case 'bond':
          return { boxType, value: 10n, inviterId: karmaOwner32, inviteOutputIndex: 0, inviteePublicKey: new Uint8Array(0), probationStartBlock: 0, probationEndBlock: 0, guard: 'bond_dual' };
        case 'post_lock':
          return { boxType, value: 10n, originalValue: 10n, owner: karmaOwner32, targetPostId: 'a'.repeat(64), guard: 'block_apply' };
        case 'vouch':
          return { boxType, value: 1n, voucherId: karmaOwner32, targetId: bytes32(0xcc), guard: 'owner_signature' };
        default:
          throw new Error(boxType);
      }
    }

    for (const [label, output] of CORPUS) {
      it(`rejects without throwing: ${label}`, () => {
        const karma = seedKarma(100n);
        const tx: UtxoTransaction = {
          inputs: [karma.id!],
          outputs: [output] as UtxoTransaction['outputs'],
          signatures: {}, // unsigned on purpose — see the corpus doc comment
          protocolVersion: 1,
        };
        let result: ReturnType<typeof validateTx> | undefined;
        expect(() => {
          result = validateTx(deps, tx, 10);
        }).not.toThrow();
        expect(result!.valid).toBe(false);
        expect(result!.error).toMatch(/Invalid output shape/);
      });
    }

    it('rejects a malformed output at index 1 without evaluating arms on it (mixed with an honest change)', () => {
      const karma = seedKarma(100n);
      const tx: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [karmaChange(90n), { ...honest('karma'), owner: 5 }] as UtxoTransaction['outputs'],
        signatures: {},
        protocolVersion: 1,
      };
      const r = validateTx(deps, tx, 10);
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/index 1 \(karma\): field 'owner'/);
    });
  });

  // -------------------------------------------------------------------------
  // Per-field rejects: error names index, boxType, and key
  // -------------------------------------------------------------------------

  describe('per-field type rejects (direct checkOutputShape)', () => {
    /** Honest candidate per boxType (all fields typed per TYPES_INTERFACE). */
    function honestCandidate(boxType: string): Record<string, unknown> {
      switch (boxType) {
        case 'karma':
          return { boxType, value: 10n, owner: bytes32(1), guard: 'owner_signature', proofSource: 't', decayBurn: false };
        case 'credit':
          return { boxType, value: 10n, owner: bytes32(1), guard: 'owner_signature', proofSource: 7, lockedUntilBlock: 5 };
        case 'invite':
          return { boxType, value: 10n, secretHash: bytes32(0xaa), inviterId: bytes32(1), guard: 'hash_preimage_with_bond' };
        case 'bond':
          return { boxType, value: 10n, inviterId: bytes32(1), inviteOutputIndex: 1, inviteePublicKey: bytes32(2), probationStartBlock: 3, probationEndBlock: 1003, guard: 'bond_dual' };
        case 'post_lock':
          return { boxType, value: 10n, originalValue: 10n, owner: bytes32(1), targetPostId: 'a'.repeat(64), guard: 'block_apply' };
        case 'vouch':
          return { boxType, value: 1n, voucherId: bytes32(1), targetId: bytes32(0xcc), guard: 'owner_signature' };
        default:
          throw new Error(boxType);
      }
    }

    // For each boxType, every pinned field and a value violating its spec.
    // (guard/boxType are pinned by their own arms, tested in the guard-shape
    // suite.)
    const WRONG: Record<string, Record<string, unknown>> = {
      karma: { value: 10, owner: new Uint8Array(31), proofSource: 42, decayBurn: 1 },
      credit: { value: -1n, owner: 'aa'.repeat(32), proofSource: 1.5, lockedUntilBlock: -1 },
      invite: { value: 1n << 64n, secretHash: new Uint8Array(33), inviterId: 7 },
      bond: {
        value: Number.NaN,
        inviterId: new Uint8Array(0),
        inviteOutputIndex: 0x1_0000_0000,
        inviteePublicKey: new Uint8Array(16),
        probationStartBlock: '3',
        probationEndBlock: -0,
      },
      post_lock: { value: 'x', originalValue: 5, owner: null, targetPostId: false },
      vouch: { value: [], voucherId: true, targetId: new Uint8Array(64) },
    };

    for (const [boxType, fields] of Object.entries(WRONG)) {
      for (const [key, badValue] of Object.entries(fields)) {
        it(`${boxType}.${key} wrong-typed → invalid, error names index/boxType/key`, () => {
          const candidate = { ...honestCandidate(boxType), [key]: badValue };
          const r = checkOutputShape([candidate] as unknown as AnyBoxCandidate[]);
          expect(r.valid).toBe(false);
          expect(r.error).toMatch(new RegExp(`index 0 \\(${boxType}\\): field '${key}'`));
        });
      }
    }

    it('accepts every honest candidate above (the wrong-value table mutates from a green baseline)', () => {
      for (const boxType of Object.keys(WRONG)) {
        const r = checkOutputShape([honestCandidate(boxType)] as unknown as AnyBoxCandidate[]);
        expect(r.valid, `${boxType}: ${r.error}`).toBe(true);
      }
    });

    it('-0 is rejected where 0 is accepted (bond probation fields)', () => {
      const zero = { ...honestCandidate('bond'), inviteePublicKey: new Uint8Array(0), probationStartBlock: 0, probationEndBlock: 0 };
      expect(checkOutputShape([zero] as unknown as AnyBoxCandidate[]).valid).toBe(true);
      const negZero = { ...zero, probationStartBlock: -0 };
      const r = checkOutputShape([negZero] as unknown as AnyBoxCandidate[]);
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/field 'probationStartBlock'.*got -0/);
    });

    it('u32 boundary: inviteOutputIndex 0xFFFFFFFF accepted, 0x100000000 rejected', () => {
      const atMax = { ...honestCandidate('bond'), inviteOutputIndex: 0xffffffff };
      expect(checkOutputShape([atMax] as unknown as AnyBoxCandidate[]).valid).toBe(true);
      const over = { ...honestCandidate('bond'), inviteOutputIndex: 0x1_0000_0000 };
      expect(checkOutputShape([over] as unknown as AnyBoxCandidate[]).valid).toBe(false);
    });

    it('u64 boundary: value 2^64−1 accepted, 2^64 rejected', () => {
      const atMax = { ...honestCandidate('karma'), value: (1n << 64n) - 1n };
      expect(checkOutputShape([atMax] as unknown as AnyBoxCandidate[]).valid).toBe(true);
      const over = { ...honestCandidate('karma'), value: 1n << 64n };
      expect(checkOutputShape([over] as unknown as AnyBoxCandidate[]).valid).toBe(false);
    });

    it('credit proofSource -1 is accepted (the live transfer sentinel)', () => {
      const transfer = { ...honestCandidate('credit'), proofSource: -1 };
      const r = checkOutputShape([transfer] as unknown as AnyBoxCandidate[]);
      expect(r.valid, r.error).toBe(true);
    });

    it('credit proofSource -5 is rejected (the value set is closed: heights or -1)', () => {
      const lying = { ...honestCandidate('credit'), proofSource: -5 };
      const r = checkOutputShape([lying] as unknown as AnyBoxCandidate[]);
      expect(r.valid).toBe(false);
      expect(r.error).toContain(
        "field 'proofSource' must be a block height (non-negative safe integer) or -1",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Accept controls the guard-shape suite does not cover
  // -------------------------------------------------------------------------

  describe('accept controls (honest typed outputs through validateTx)', () => {
    function seedInviteBondPair(inviter: TestIdentity, secret: Uint8Array) {
      const secretHash = new Uint8Array(
        createHash('blake2b512').update(secret).digest().subarray(0, 32),
      );
      const invite = {
        boxType: 'invite' as const,
        value: 25n,
        secretHash,
        inviterId: inviter.userId,
        guard: 'hash_preimage_with_bond' as const,
      };
      const bond = {
        boxType: 'bond' as const,
        value: 25n,
        inviterId: inviter.userId,
        inviteOutputIndex: 0,
        inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0,
        probationEndBlock: 0,
        guard: 'bond_dual' as const,
      };
      const [seededInvite, seededBond] = seedAsOneTx([invite, bond]);
      storeInsertBox(seededInvite!);
      storeInsertBox(seededBond!);
      return { seededInvite: seededInvite!, seededBond: seededBond! };
    }

    it('honest bond commit (typed numbers, inviteePublicKey 32 bytes) validates', () => {
      const inviter = makeTestIdentity();
      const invitee = makeTestIdentity();
      const secret = new Uint8Array(32).fill(7);
      const { seededBond } = seedInviteBondPair(inviter, secret);

      const bondOut = {
        boxType: 'bond',
        value: 25n,
        inviterId: inviter.userId,
        inviteOutputIndex: 0,
        inviteePublicKey: invitee.userId,
        probationStartBlock: 25,
        probationEndBlock: 25 + INVITE_PROBATION_BLOCKS,
        guard: 'bond_dual',
      };
      const tx: UtxoTransaction = {
        inputs: [seededBond.id!],
        outputs: [bondOut] as unknown as UtxoTransaction['outputs'],
        signatures: {},
        preimages: { [seededBond.id!]: secret },
        protocolVersion: 1,
      };
      const hash = Buffer.from(computeTxId(tx), 'hex');
      tx.signatures[Buffer.from(invitee.userId).toString('hex')] = new Uint8Array(
        cryptoSign(null, hash, invitee.privateKey),
      );

      const r = validateTx(deps, tx, 100);
      expect(r.valid, r.error).toBe(true);
    });

    it('honest unvouch (vouch → zero outputs) validates', () => {
      const vouch = {
        boxType: 'vouch' as const,
        value: 1n,
        voucherId: ownerPubKey,
        targetId: bytes32(0xcc),
        guard: 'owner_signature' as const,
      };
      const seeded = { ...vouch, ...fixtureProvenance(vouch, 1) } as AnyBox;
      seeded.id = computeBoxId(seeded);
      storeInsertBox(seeded);
      const r = validateTx(deps, signedTx([seeded.id!], []), 10);
      expect(r.valid, r.error).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // CBOR ingress: the block funnel inherits the gate from validateTx
  // -------------------------------------------------------------------------

  describe('CBOR ingress (block funnel)', () => {
    it('a block embedding the class-3 poison tx is REJECTED cleanly — nothing lands, no totality catch', async () => {
      const attacker = makeTestIdentity();
      const karma = makeKarmaBox(100n, attacker.userId, 0);
      storeInsertBox(karma);
      const tx: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [
          {
            boxType: 'karma',
            value: 100n - POST_LOCK_THREAD_COST,
            owner: attacker.userId,
            guard: 'owner_signature',
            proofSource: 'test',
          },
          {
            boxType: 'post_lock',
            value: POST_LOCK_THREAD_COST,
            originalValue: 'x', // the read-time poison of the before-leg
            owner: attacker.userId,
            targetPostId: 'b'.repeat(64),
            guard: 'block_apply',
          },
        ] as unknown as UtxoTransaction['outputs'],
        signatures: {},
        protocolVersion: 1,
      };
      const hash = Buffer.from(computeTxId(tx), 'hex');
      tx.signatures[Buffer.from(attacker.userId).toString('hex')] = new Uint8Array(
        cryptoSign(null, hash, attacker.privateKey),
      );

      // The embedded tx rides the block as encodeTx() CBOR; apply decodes it
      // and re-validates with validateTx — the single gate the funnel
      // inherits. On the pre-pin tree this block APPLIED (before-leg P2b).
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const block = await makeApplicableBlock({ utxoTxs: [tx] });
        expect(applyOrderingBlock(block)).toBe(false);
        // The clean rejection path, not the totality catch converting a throw.
        const unexpected = errSpy.mock.calls.filter((c) =>
          String(c[0]).includes('unexpected failure during apply'),
        );
        expect(unexpected).toHaveLength(0);
      } finally {
        errSpy.mockRestore();
      }

      // Nothing landed: the input is unspent, no post_lock row exists.
      expect(storeGetBox(karma.id!)).not.toBeNull();
      const locks = db
        .prepare("SELECT COUNT(*) AS n FROM utxo_boxes WHERE box_type = 'post_lock'")
        .get() as { n: number | bigint };
      expect(Number(locks.n)).toBe(0);
    });

    it('control: the same block shape with an honest typed lock APPLIES (and pins what decodeTx yields)', async () => {
      const author = makeTestIdentity();
      const karma = makeKarmaBox(100n, author.userId, 0);
      storeInsertBox(karma);
      const tx: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [
          {
            boxType: 'karma',
            value: 100n - POST_LOCK_THREAD_COST,
            owner: author.userId,
            guard: 'owner_signature',
            proofSource: 'test',
          },
          {
            boxType: 'post_lock',
            value: POST_LOCK_THREAD_COST,
            originalValue: POST_LOCK_THREAD_COST,
            owner: author.userId,
            targetPostId: 'b'.repeat(64),
            guard: 'block_apply',
          },
        ] as unknown as UtxoTransaction['outputs'],
        signatures: {},
        protocolVersion: 1,
      };
      const hash = Buffer.from(computeTxId(tx), 'hex');
      tx.signatures[Buffer.from(author.userId).toString('hex')] = new Uint8Array(
        cryptoSign(null, hash, author.privateKey),
      );

      // What the funnel's decoder actually hands the gate: byte fields as
      // Uint8Array (NOT Buffer — pinned here because the fix's `instanceof
      // Uint8Array` covers both, and a cbor-x behavior change should be loud),
      // amounts as bigint.
      const decoded = decodeTx(encodeTx(tx));
      const decodedKarma = decoded.outputs[0] as { owner: unknown; value: unknown };
      expect(decodedKarma.owner).toBeInstanceOf(Uint8Array);
      expect(Buffer.isBuffer(decodedKarma.owner)).toBe(false);
      expect(typeof decodedKarma.value).toBe('bigint');

      const block = await makeApplicableBlock({ utxoTxs: [tx] });
      expect(applyOrderingBlock(block)).toBe(true);
      const locks = db
        .prepare("SELECT COUNT(*) AS n FROM utxo_boxes WHERE box_type = 'post_lock'")
        .get() as { n: number | bigint };
      expect(Number(locks.n)).toBe(1);
    });
  });
});
