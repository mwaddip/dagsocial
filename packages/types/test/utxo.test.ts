import { describe, it, expect } from 'vitest';
import { computeBoxId, computeTxId } from '../src/utxo.js';
import type { KarmaBox, CreditBox, LikeBox, InviteBox, BondBox, UtxoTransaction } from '../src/utxo.js';

const owner = new Uint8Array(32).fill(0xaa);

function makeKarmaBox(overrides: Partial<KarmaBox> = {}): KarmaBox {
  return {
    boxType: 'karma',
    value: 100,
    createdAtBlock: 10,
    owner,
    guard: 'owner_signature',
    proofSource: 'genesis',
    lastTouchBlock: 10,
    ...overrides,
  };
}

function makeCreditBox(): CreditBox {
  return {
    boxType: 'credit',
    value: 500,
    createdAtBlock: 20,
    owner,
    guard: 'owner_signature',
    proofSource: 42,
  };
}

function makeLikeBox(): LikeBox {
  return {
    boxType: 'like',
    value: 2,
    createdAtBlock: 30,
    likerId: 'user123',
    targetPostId: 'a'.repeat(64),
    guard: 'epoch_tally',
  };
}

function makeInviteBox(): InviteBox {
  return {
    boxType: 'invite',
    value: 10,
    createdAtBlock: 15,
    secretHash: new Uint8Array(32).fill(0xbb),
    inviterId: 'user456',
    guard: 'hash_preimage',
  };
}

function makeBondBox(): BondBox {
  return {
    boxType: 'bond',
    value: 20,
    createdAtBlock: 16,
    inviterId: 'user456',
    inviteePublicKey: new Uint8Array(32).fill(0xcc),
    probationStartBlock: 17,
    probationEndBlock: 1017,
    guard: 'inviter_signature',
  };
}

describe('boxes', () => {
  describe('computeBoxId', () => {
    it('returns a 64-char hex string', () => {
      const id = computeBoxId(makeKarmaBox());
      expect(typeof id).toBe('string');
      expect(id).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(id)).toBe(true);
    });

    it('is deterministic', () => {
      const box = makeKarmaBox();
      expect(computeBoxId(box)).toBe(computeBoxId(box));
    });

    it('changes with different value', () => {
      const a = makeKarmaBox({ value: 100 });
      const b = makeKarmaBox({ value: 200 });
      expect(computeBoxId(a)).not.toBe(computeBoxId(b));
    });

    it('changes with different boxType', () => {
      const karma = makeKarmaBox();
      const credit = makeCreditBox();
      expect(computeBoxId(karma)).not.toBe(computeBoxId(credit));
    });

    it('changes with different owner', () => {
      const a = makeKarmaBox();
      const b = makeKarmaBox({ owner: new Uint8Array(32).fill(0xff) });
      expect(computeBoxId(a)).not.toBe(computeBoxId(b));
    });

    it('ignores id field if present', () => {
      const box = makeKarmaBox();
      const withId = { ...box, id: 'some-random-id' };
      expect(computeBoxId(withId)).toBe(computeBoxId(box));
    });

    it('works for all box types', () => {
      expect(() => computeBoxId(makeCreditBox())).not.toThrow();
      expect(() => computeBoxId(makeLikeBox())).not.toThrow();
      expect(() => computeBoxId(makeInviteBox())).not.toThrow();
      expect(() => computeBoxId(makeBondBox())).not.toThrow();
    });
  });
});

describe('transactions', () => {
  describe('computeTxId', () => {
    it('returns a 64-char hex string', () => {
      const tx: UtxoTransaction = {
        inputs: [],
        outputs: [makeKarmaBox()],
        signatures: {},
        protocolVersion: 2,
      };
      const id = computeTxId(tx);
      expect(typeof id).toBe('string');
      expect(id).toHaveLength(64);
    });

    it('is deterministic', () => {
      const tx: UtxoTransaction = {
        inputs: ['in1'],
        outputs: [makeKarmaBox()],
        signatures: { 'key1': new Uint8Array(64) },
        protocolVersion: 2,
      };
      expect(computeTxId(tx)).toBe(computeTxId(tx));
    });

    it('changes with different inputs', () => {
      const tx1: UtxoTransaction = { inputs: ['in1'], outputs: [makeKarmaBox()], signatures: {}, protocolVersion: 2 };
      const tx2: UtxoTransaction = { inputs: ['in2'], outputs: [makeKarmaBox()], signatures: {}, protocolVersion: 2 };
      expect(computeTxId(tx1)).not.toBe(computeTxId(tx2));
    });

    it('changes with different outputs', () => {
      const tx1: UtxoTransaction = { inputs: [], outputs: [makeKarmaBox({ value: 100 })], signatures: {}, protocolVersion: 2 };
      const tx2: UtxoTransaction = { inputs: [], outputs: [makeKarmaBox({ value: 200 })], signatures: {}, protocolVersion: 2 };
      expect(computeTxId(tx1)).not.toBe(computeTxId(tx2));
    });

    it('excludes output id from hash (idempotent with assigned ids)', () => {
      const tx1: UtxoTransaction = { inputs: [], outputs: [makeKarmaBox()], signatures: {}, protocolVersion: 2 };
      const id1 = computeTxId(tx1);
      // Assign an id to the output — shouldn't change tx id
      const tx2: UtxoTransaction = {
        inputs: [],
        outputs: [{ ...makeKarmaBox(), id: computeBoxId(makeKarmaBox()) }],
        signatures: {},
        protocolVersion: 2,
      };
      const id2 = computeTxId(tx2);
      expect(id1).toBe(id2);
    });
  });
});
