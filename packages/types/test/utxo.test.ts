import { describe, it, expect } from 'vitest';
import { decode as cborDecode } from 'cbor-x';
import { computeBoxId, computeTxId, serializeBox, INVITE_KARMA_AMOUNT, INVITE_BOND_KARMA } from '../src/index.js';
import type { KarmaBox, CreditBox, LikeBox, InviteBox, BondBox, UtxoTransaction } from '../src/index.js';

const owner = new Uint8Array(32).fill(0xaa);

function makeKarmaBox(overrides: Partial<KarmaBox> = {}): KarmaBox {
  return {
    boxType: 'karma',
    value: 100n,
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
    value: 500n,
    createdAtBlock: 20,
    owner,
    guard: 'owner_signature',
    proofSource: 42,
  };
}

function makeLikeBox(): LikeBox {
  return {
    boxType: 'like',
    value: 2n,
    createdAtBlock: 30,
    likerId: 'user123',
    targetPostId: 'a'.repeat(64),
    guard: 'epoch_tally',
  };
}

function makeInviteBox(): InviteBox {
  return {
    boxType: 'invite',
    value: 10n,
    createdAtBlock: 15,
    secretHash: new Uint8Array(32).fill(0xbb),
    inviterId: 'user456',
    guard: 'hash_preimage',
  };
}

function makeBondBox(): BondBox {
  return {
    boxType: 'bond',
    value: 20n,
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
      const a = makeKarmaBox({ value: 100n });
      const b = makeKarmaBox({ value: 200n });
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
      const box1 = makeKarmaBox({ value: 100n });
      const box2 = makeKarmaBox({ value: 100n, decayBurn: true });
      const id1 = computeBoxId(box1);
      const id2 = computeBoxId(box2);
      expect(id1).not.toBe(id2);
    });
  });
});

// ---------------------------------------------------------------------------
// Frozen golden vectors (P0 — bigint box values)
// ---------------------------------------------------------------------------

/**
 * Frozen golden vectors — the cross-implementation anchor for the bigint
 * `value` encoding (Spec B P0).
 *
 * `value` encodes as CBOR uint64 (`0x1b` + 8 bytes BE) on every box type;
 * `number` fields (createdAtBlock, …) stay minimal-int. The demo-UI CBOR
 * encoder must reproduce these exact bytes. Do not "fix" a failure by editing
 * the hashes — the encoding is protocol-breaking and unversioned.
 */
const GOLDEN_OWNER = new Uint8Array(32);
for (let i = 0; i < 32; i++) GOLDEN_OWNER[i] = i;

const GOLDEN_KARMA_BOX: KarmaBox = {
  boxType: 'karma',
  value: 100n,
  createdAtBlock: 70000,          // > 65536 — locks the wide-int encoding path (L-5)
  owner: GOLDEN_OWNER,
  guard: 'owner_signature',
  proofSource: 'genesis',
  lastTouchBlock: 70000,
};

const GOLDEN_CREDIT_BOX: CreditBox = {
  boxType: 'credit',
  value: 123456789n * 10n ** 8n,  // 12_345_678_900_000_000 > 2^53 — the range P0 exists for
  createdAtBlock: 70000,
  owner: GOLDEN_OWNER,
  guard: 'owner_signature',
  proofSource: 42,
};

const GOLDEN_TX: UtxoTransaction = {
  inputs: ['1111111111111111111111111111111111111111111111111111111111111111'],
  outputs: [GOLDEN_KARMA_BOX, GOLDEN_CREDIT_BOX],
  signatures: {},
  protocolVersion: 1,
};

const GOLDEN_KARMA_BOX_ID =
  '83c95fbb82c1ba033280286ea0fd5a4dd09776c6c68e1426dfdae1668947c9d1';
const GOLDEN_CREDIT_BOX_ID =
  'b256df0c3fca8bd2e7567d11ca66e4e1e4cd41b0ab148ec5956907047b596905';
const GOLDEN_TX_ID =
  '0156333db37f658f278aef3ba2c9d2ce3c2f126cf7fb98b7a835dde4ee92ac7c';

describe('golden vectors (bigint value encoding)', () => {
  it('golden vector: karma boxId is frozen', () => {
    expect(computeBoxId(GOLDEN_KARMA_BOX)).toBe(GOLDEN_KARMA_BOX_ID);
  });

  it('golden vector: credit boxId (value > 2^53) is frozen', () => {
    expect(computeBoxId(GOLDEN_CREDIT_BOX)).toBe(GOLDEN_CREDIT_BOX_ID);
  });

  it('golden vector: txId is frozen', () => {
    expect(computeTxId(GOLDEN_TX)).toBe(GOLDEN_TX_ID);
  });

  it('value serializes in the 0x1b uint64 form; number fields stay minimal-int', () => {
    const karmaHex = Buffer.from(serializeBox(GOLDEN_KARMA_BOX)).toString('hex');
    const creditHex = Buffer.from(serializeBox(GOLDEN_CREDIT_BOX)).toString('hex');
    // value 100n → 1b + u64BE(100); value 12345678900000000n → 1b + u64BE
    expect(karmaHex).toContain('1b0000000000000064');
    expect(creditHex).toContain('1b002bdc545d587500');
    // createdAtBlock 70000 stays minimal-int (uint32 form 1a00011170, not 1b…)
    expect(karmaHex).toContain('1a00011170');
    expect(karmaHex).not.toContain('1b0000000000011170');
  });

  it('value round-trips as bigint through serializeBox → decode', () => {
    const decoded = cborDecode(Buffer.from(serializeBox(GOLDEN_CREDIT_BOX)));
    expect(typeof decoded.value).toBe('bigint');
    expect(decoded.value).toBe(12345678900000000n);
    expect(typeof decoded.createdAtBlock).toBe('number');
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
      const tx1: UtxoTransaction = { inputs: [], outputs: [makeKarmaBox({ value: 100n })], signatures: {}, protocolVersion: 2 };
      const tx2: UtxoTransaction = { inputs: [], outputs: [makeKarmaBox({ value: 200n })], signatures: {}, protocolVersion: 2 };
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
    it('INVITE_KARMA_AMOUNT is 25n', () => {
      expect(INVITE_KARMA_AMOUNT).toBe(25n);
    });

    it('INVITE_BOND_KARMA is 25n', () => {
      expect(INVITE_BOND_KARMA).toBe(25n);
    });
  });
});

// ---------------------------------------------------------------------------
// selectBoxes
// ---------------------------------------------------------------------------

describe('selectBoxes', () => {
  it('returns single box when value equals required amount', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [{ value: 5n, id: 'a' }];
    const result = selectBoxes(boxes, 5n);
    expect(result).toEqual([{ value: 5n, id: 'a' }]);
  });

  it('returns single box when value exceeds required amount', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [{ value: 10n, id: 'a' }];
    const result = selectBoxes(boxes, 5n);
    expect(result).toEqual([{ value: 10n, id: 'a' }]);
  });

  it('selects largest-first to cover required amount', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [
      { value: 100n, id: 'big' },
      { value: 50n, id: 'med' },
      { value: 10n, id: 'small' },
    ];
    // 100 covers 80 alone — largest-first picks just the big one
    const result = selectBoxes(boxes, 80n);
    expect(result).toEqual([{ value: 100n, id: 'big' }]);
  });

  it('selects multiple boxes when one is insufficient', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [
      { value: 100n, id: 'big' },
      { value: 50n, id: 'med' },
      { value: 10n, id: 'small' },
    ];
    // 150 needs big (100) + med (50)
    const result = selectBoxes(boxes, 150n);
    expect(result).toEqual([
      { value: 100n, id: 'big' },
      { value: 50n, id: 'med' },
    ]);
  });

  it('selects all boxes when needed', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [
      { value: 100n, id: 'big' },
      { value: 50n, id: 'med' },
      { value: 10n, id: 'small' },
    ];
    const result = selectBoxes(boxes, 160n);
    expect(result).toEqual(boxes);
  });

  it('throws when total is insufficient', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [
      { value: 10n, id: 'a' },
      { value: 5n, id: 'b' },
    ];
    expect(() => selectBoxes(boxes, 20n)).toThrow('Insufficient total value');
  });

  it('throws on empty boxes with positive requiredAmount', async () => {
    const { selectBoxes } = await import('../src/index.js');
    expect(() => selectBoxes([], 1n)).toThrow('Insufficient total value');
  });

  it('returns empty array for requiredAmount of 0', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [{ value: 10n, id: 'a' }];
    const result = selectBoxes(boxes, 0n);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty boxes and requiredAmount 0', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const result = selectBoxes([], 0n);
    expect(result).toEqual([]);
  });
});
