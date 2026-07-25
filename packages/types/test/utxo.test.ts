import { describe, it, expect } from 'vitest';
import { computeBoxId, computeTxId, INVITE_KARMA_AMOUNT, INVITE_BOND_KARMA } from '../src/index.js';
import type { KarmaBox, CreditBox, LikeBox, InviteBox, BondBox, UtxoTransaction } from '../src/index.js';

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

    it('computeBoxId differs when decayBurn differs', () => {
      const box1 = makeKarmaBox({ value: 100 });
      const box2 = makeKarmaBox({ value: 100, decayBurn: true });
      const id1 = computeBoxId(box1);
      const id2 = computeBoxId(box2);
      expect(id1).not.toBe(id2);
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

  describe('computeTxId with preimages', () => {
    it('includes preimages in tx hash', () => {
      const tx: UtxoTransaction = {
        inputs: ['box1'],
        outputs: [],
        signatures: {},
        preimages: { 'box1': new Uint8Array([1, 2, 3]) },
        protocolVersion: 1,
      };
      const id1 = computeTxId(tx);

      const tx2: UtxoTransaction = {
        ...tx,
        preimages: { 'box1': new Uint8Array([4, 5, 6]) },
      };
      const id2 = computeTxId(tx2);

      expect(id1).not.toBe(id2);
    });

    it('sorts preimage keys for determinism', () => {
      const tx: UtxoTransaction = {
        inputs: ['box_b', 'box_a'],
        outputs: [],
        signatures: {},
        preimages: {
          'box_b': new Uint8Array([2]),
          'box_a': new Uint8Array([1]),
        },
        protocolVersion: 1,
      };
      // Should not throw; determinism means consistent output
      const id1 = computeTxId(tx);
      const id2 = computeTxId(tx);
      expect(id1).toBe(id2);
    });

    it('omits preimages from hash when undefined', () => {
      const tx: UtxoTransaction = {
        inputs: ['box1'],
        outputs: [],
        signatures: {},
        protocolVersion: 1,
      };
      const id = computeTxId(tx);
      expect(typeof id).toBe('string');
      expect(id.length).toBe(64);
    });
  });

  describe('INVITE constants', () => {
    it('INVITE_KARMA_AMOUNT is 25', () => {
      expect(INVITE_KARMA_AMOUNT).toBe(25);
    });

    it('INVITE_BOND_KARMA is 25', () => {
      expect(INVITE_BOND_KARMA).toBe(25);
    });
  });
});

// ---------------------------------------------------------------------------
// selectBoxes
// ---------------------------------------------------------------------------

describe('selectBoxes', () => {
  it('returns single box when value equals required amount', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [{ value: 5, id: 'a' }];
    const result = selectBoxes(boxes, 5);
    expect(result).toEqual([{ value: 5, id: 'a' }]);
  });

  it('returns single box when value exceeds required amount', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [{ value: 10, id: 'a' }];
    const result = selectBoxes(boxes, 5);
    expect(result).toEqual([{ value: 10, id: 'a' }]);
  });

  it('selects largest-first to cover required amount', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [
      { value: 100, id: 'big' },
      { value: 50, id: 'med' },
      { value: 10, id: 'small' },
    ];
    // 100 covers 80 alone — largest-first picks just the big one
    const result = selectBoxes(boxes, 80);
    expect(result).toEqual([{ value: 100, id: 'big' }]);
  });

  it('selects multiple boxes when one is insufficient', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [
      { value: 100, id: 'big' },
      { value: 50, id: 'med' },
      { value: 10, id: 'small' },
    ];
    // 150 needs big (100) + med (50)
    const result = selectBoxes(boxes, 150);
    expect(result).toEqual([
      { value: 100, id: 'big' },
      { value: 50, id: 'med' },
    ]);
  });

  it('selects all boxes when needed', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [
      { value: 100, id: 'big' },
      { value: 50, id: 'med' },
      { value: 10, id: 'small' },
    ];
    const result = selectBoxes(boxes, 160);
    expect(result).toEqual(boxes);
  });

  it('throws when total is insufficient', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [
      { value: 10, id: 'a' },
      { value: 5, id: 'b' },
    ];
    expect(() => selectBoxes(boxes, 20)).toThrow('Insufficient total value');
  });

  it('throws on empty boxes with positive requiredAmount', async () => {
    const { selectBoxes } = await import('../src/index.js');
    expect(() => selectBoxes([], 1)).toThrow('Insufficient total value');
  });

  it('returns empty array for requiredAmount of 0', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [{ value: 10, id: 'a' }];
    const result = selectBoxes(boxes, 0);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty boxes and requiredAmount 0', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const result = selectBoxes([], 0);
    expect(result).toEqual([]);
  });
});
