import { describe, it, expect } from 'vitest';
import { decode as cborDecode } from 'cbor-x';
import {
  computeBoxId,
  computeCandidateBoxId,
  computeMintTxId,
  computeTxId,
  canonicalBoxBytes,
  BOX_ID_DOMAIN,
  TX_ID_DOMAIN,
  MINT_ID_DOMAIN,
  IDENTITY_KEY_DOMAIN,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
} from '../src/index.js';
import type { KarmaBox, CreditBox, LikeBox, InviteBox, BondBox, UtxoTransaction, MintReason } from '../src/index.js';

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

    it('is unaffected by provenance set on the box', () => {
      // Spec G phase C0. The legacy derivation stays legacy — no domain tag, no
      // txId/index in the preimage — but it must strip through the *single*
      // canonical rule. From phase C on, producers materialize boxes with
      // txId/index set; a local `{ id, ...rest }` strip would hash those into
      // the legacy id and move every box id, which no phase before G may do.
      // The demo UI mirror and the invite flow's predicted inviteBoxId both
      // compute ids from a box with no provenance, so they would diverge too.
      //
      // The fix itself is inert on today's tree — no producer sets provenance
      // yet, so it moves no existing id, and that is what makes it safe to land
      // before phase C. This test is what keeps it distinguishable from no fix
      // at all: it hashes a box that *does* carry provenance.
      for (const bare of [makeKarmaBox(), makeCreditBox(), makeLikeBox(), makeInviteBox(), makeBondBox()]) {
        const materialized = {
          ...bare,
          id: 'f'.repeat(64),
          txId: '0156333db37f658f278aef3ba2c9d2ce3c2f126cf7fb98b7a835dde4ee92ac7c',
          index: 3,
        };
        expect(computeBoxId(materialized)).toBe(computeBoxId(bare));
      }
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

/**
 * Full canonical identity bytes, frozen. The substring assertions below say
 * *why* particular byte forms matter; these pin the whole encoding, including
 * cbor-x's fixed two-byte map header (`b9 0007`) and the untagged `5820` byte
 * string for `owner`. A mirror implementation reproducing minimal-length
 * canonical CBOR (`a7`), or tagging typed arrays (`d840`, which the deleted
 * `serializeBox` did), computes a different box id.
 */
const GOLDEN_KARMA_BOX_BYTES =
  'b9000767626f7854797065656b61726d616576616c75651b00000000000000646e63726561746564417' +
  '4426c6f636b1a00011170656f776e65725820000102030405060708090a0b0c0d0e0f10111213141516' +
  '1718191a1b1c1d1e1f6567756172646f6f776e65725f7369676e61747572656b70726f6f66536f75726' +
  '3656767656e657369736e6c617374546f756368426c6f636b1a00011170';
const GOLDEN_CREDIT_BOX_BYTES =
  'b9000667626f7854797065666372656469746576616c75651b002bdc545d5875006e6372656174656441' +
  '74426c6f636b1a00011170656f776e65725820000102030405060708090a0b0c0d0e0f10111213141516' +
  '1718191a1b1c1d1e1f6567756172646f6f776e65725f7369676e61747572656b70726f6f66536f757263' +
  '65182a';

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
    const karmaHex = Buffer.from(canonicalBoxBytes(GOLDEN_KARMA_BOX)).toString('hex');
    const creditHex = Buffer.from(canonicalBoxBytes(GOLDEN_CREDIT_BOX)).toString('hex');
    // value 100n → 1b + u64BE(100); value 12345678900000000n → 1b + u64BE
    expect(karmaHex).toContain('1b0000000000000064');
    expect(creditHex).toContain('1b002bdc545d587500');
    // createdAtBlock 70000 stays minimal-int (uint32 form 1a00011170, not 1b…)
    expect(karmaHex).toContain('1a00011170');
    expect(karmaHex).not.toContain('1b0000000000011170');
  });

  it('golden vector: full canonical identity bytes are frozen', () => {
    expect(Buffer.from(canonicalBoxBytes(GOLDEN_KARMA_BOX)).toString('hex')).toBe(GOLDEN_KARMA_BOX_BYTES);
    expect(Buffer.from(canonicalBoxBytes(GOLDEN_CREDIT_BOX)).toString('hex')).toBe(GOLDEN_CREDIT_BOX_BYTES);
    // Uint8Array fields are untagged: `5820` (byte string, 32) with no `d840`
    // typed-array tag. The deleted `serializeBox` emitted the tag — which is
    // precisely why it was the wrong encoder to pin box bytes against.
    expect(GOLDEN_KARMA_BOX_BYTES).toContain('656f776e65725820');
    expect(GOLDEN_KARMA_BOX_BYTES).not.toContain('d840');
  });

  it('value round-trips as bigint through canonicalBoxBytes → decode', () => {
    const decoded = cborDecode(Buffer.from(canonicalBoxBytes(GOLDEN_CREDIT_BOX)));
    expect(typeof decoded.value).toBe('bigint');
    expect(decoded.value).toBe(12345678900000000n);
    expect(typeof decoded.createdAtBlock).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Spec G — provenance-derived identity
// ---------------------------------------------------------------------------

/** Independent mirror of the src writer — the encoding under test, not a reuse of it. */
function u32BE(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

const ALL_MINT_REASONS: MintReason[] = [
  'coinbase',
  'vouch-settle',
  'author-reward',
  'liker-refund',
  'postlock-unlock',
  'postlock-remainder',
  'decay',
  'genesis',
];

/**
 * Frozen golden vectors for the provenance derivation — the cross-implementation
 * anchor for node and the demo UI. `GOLDEN_TX` creates these two boxes, so the
 * karma box sits at index 0 and the credit box at index 1 of that transaction.
 * Do not "fix" a failure by editing the hashes: the derivation is
 * protocol-breaking and unversioned.
 */
const GOLDEN_CANDIDATE_KARMA_ID =
  'ca9de5d61004c54f75b89d73fa3a031ebfa5beeea5e9b1c39a6209fba05ff0f3';
const GOLDEN_CANDIDATE_CREDIT_ID =
  '98de447636ea488345fe44eba052c60c2b267a98e4fc30264598edeac762b542';
const GOLDEN_MINT_COINBASE_ID =
  'd44c27ca83b922dace550bbb138c5067a5b2ef51a74d640db41477629b9911c4';
const GOLDEN_MINT_DECAY_ID =
  '3d8fda7968acaddd5f1b5b79c7270a105613ce7030200e1ec56afd4edf47c08c';

describe('canonicalBoxBytes', () => {
  it('is deterministic', () => {
    const a = canonicalBoxBytes(GOLDEN_KARMA_BOX);
    const b = canonicalBoxBytes(GOLDEN_KARMA_BOX);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });

  it('excludes id', () => {
    const withId = { ...makeKarmaBox(), id: 'should-be-excluded' };
    const bytes = canonicalBoxBytes(withId);
    const decoded = cborDecode(Buffer.from(bytes));
    expect(decoded.id).toBeUndefined();
    expect(decoded.boxType).toBe('karma');
    expect(Buffer.compare(Buffer.from(bytes), Buffer.from(canonicalBoxBytes(makeKarmaBox())))).toBe(0);
  });

  it('excludes provenance, so a stored box yields its candidate bytes', () => {
    const candidate = makeKarmaBox();
    const stored = { ...candidate, id: 'x'.repeat(64), txId: GOLDEN_TX_ID, index: 3 };
    expect(Buffer.compare(
      Buffer.from(canonicalBoxBytes(stored)),
      Buffer.from(canonicalBoxBytes(candidate)),
    )).toBe(0);
  });
});

describe('computeCandidateBoxId', () => {
  it('golden vector: karma box at (GOLDEN_TX_ID, 0) is frozen', () => {
    expect(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_TX_ID, 0)).toBe(GOLDEN_CANDIDATE_KARMA_ID);
  });

  it('golden vector: credit box at (GOLDEN_TX_ID, 1) is frozen', () => {
    expect(computeCandidateBoxId(GOLDEN_CREDIT_BOX, GOLDEN_TX_ID, 1)).toBe(GOLDEN_CANDIDATE_CREDIT_ID);
  });

  it('returns 64-char lowercase hex', () => {
    const id = computeCandidateBoxId(makeKarmaBox(), GOLDEN_TX_ID, 0);
    expect(id).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(id)).toBe(true);
  });

  it('is deterministic', () => {
    const c = makeKarmaBox();
    expect(computeCandidateBoxId(c, GOLDEN_TX_ID, 0)).toBe(computeCandidateBoxId(c, GOLDEN_TX_ID, 0));
  });

  // --- provenance sensitivity: the whole point of the scheme ---

  it('same candidate, different txId → different id', () => {
    const c = makeKarmaBox();
    const a = computeCandidateBoxId(c, GOLDEN_TX_ID, 0);
    const b = computeCandidateBoxId(c, '2'.repeat(64), 0);
    expect(a).not.toBe(b);
  });

  it('same candidate and txId, different index → different id', () => {
    // Kills the mutation that drops `index` from the preimage — which is what
    // makes two byte-identical outputs of one transaction collide.
    const c = makeKarmaBox();
    const a = computeCandidateBoxId(c, GOLDEN_TX_ID, 0);
    const b = computeCandidateBoxId(c, GOLDEN_TX_ID, 1);
    expect(a).not.toBe(b);
  });

  it('two byte-identical candidates in one tx get different ids', () => {
    const identical = makeKarmaBox();
    const ids = [0, 1, 2].map((i) => computeCandidateBoxId(identical, GOLDEN_TX_ID, i));
    expect(new Set(ids).size).toBe(3);
  });

  it('differs from the legacy content-hash id', () => {
    // computeBoxId's *derivation* stays legacy until phase G (phase C0 changed
    // only what it strips); the two derivations must not be confusable.
    expect(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_TX_ID, 0)).not.toBe(computeBoxId(GOLDEN_KARMA_BOX));
  });

  it('hashes txId as hex text, not as decoded bytes', () => {
    // Pins the preimage choice. Decoding to 32 raw bytes would make these two
    // spellings of one txId collide; hashing the hex text keeps them distinct.
    const c = makeKarmaBox();
    const lower = 'ab'.repeat(32);
    const upper = 'AB'.repeat(32);
    expect(computeCandidateBoxId(c, lower, 0)).not.toBe(computeCandidateBoxId(c, upper, 0));
  });

  it('does not throw on an unencodable index (M-5 no-panic)', () => {
    // Total, in post.ts's shape: out-of-domain numbers take the sentinel rather
    // than turning id derivation into a panic on untrusted input.
    const c = makeKarmaBox();
    for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(() => computeCandidateBoxId(c, GOLDEN_TX_ID, bad)).not.toThrow();
      expect(computeCandidateBoxId(c, GOLDEN_TX_ID, bad)).toHaveLength(64);
    }
  });
});

describe('computeMintTxId', () => {
  it('golden vector: coinbase mint is frozen', () => {
    expect(computeMintTxId(70000, 'coinbase', u32BE(0))).toBe(GOLDEN_MINT_COINBASE_ID);
  });

  it('golden vector: decay mint (subject = owner key) is frozen', () => {
    expect(computeMintTxId(70000, 'decay', GOLDEN_OWNER)).toBe(GOLDEN_MINT_DECAY_ID);
  });

  it('varies with height, reason and subject independently', () => {
    const base = computeMintTxId(70000, 'decay', GOLDEN_OWNER);
    expect(computeMintTxId(70001, 'decay', GOLDEN_OWNER)).not.toBe(base);
    expect(computeMintTxId(70000, 'genesis', GOLDEN_OWNER)).not.toBe(base);
    expect(computeMintTxId(70000, 'decay', new Uint8Array(32).fill(0xff))).not.toBe(base);
  });

  it('separates author-reward from postlock-unlock for the same subject', () => {
    // The two mints that otherwise land on the same author, for the same post,
    // at the same height — the collision the `reason` tag exists to prevent.
    const subject = new Uint8Array(32).fill(0x11);
    expect(computeMintTxId(70000, 'author-reward', subject))
      .not.toBe(computeMintTxId(70000, 'postlock-unlock', subject));
  });

  it('no reason is a prefix of another', () => {
    // `reason ‖ subject` carries no length prefix, so cross-reason injectivity
    // rests on prefix-freeness of the reason set.
    for (const a of ALL_MINT_REASONS) {
      for (const b of ALL_MINT_REASONS) {
        if (a !== b) expect(b.startsWith(a)).toBe(false);
      }
    }
  });

  it('does not throw on an unencodable height (M-5 no-panic)', () => {
    for (const bad of [-1, 1.5, NaN, Infinity]) {
      expect(() => computeMintTxId(bad, 'decay', GOLDEN_OWNER)).not.toThrow();
    }
  });
});

describe('domain separation', () => {
  it('the four domain tags are pairwise distinct', () => {
    const tags = [BOX_ID_DOMAIN, TX_ID_DOMAIN, MINT_ID_DOMAIN, IDENTITY_KEY_DOMAIN]
      .map((t) => Buffer.from(t).toString('hex'));
    expect(new Set(tags).size).toBe(4);
  });

  it('a mint id never equals a box id built from the same material', () => {
    // Deliberate collision attempt, not a random-input assertion: every byte the
    // box derivation consumes after its domain tag — the candidate encoding, the
    // txId text and the u32 — is fed to the mint derivation as well.
    //
    // The two preimage tails cannot be made *byte*-identical with a valid
    // MintReason: the box tail begins with the candidate's CBOR map header
    // (`b9 00…`) while the mint tail has `reason` at offset 4, and no member of
    // the closed reason set matches a candidate encoding there. Domain tags
    // remove the question entirely.
    const material = Buffer.concat([
      Buffer.from(canonicalBoxBytes(GOLDEN_KARMA_BOX)),
      Buffer.from(GOLDEN_TX_ID, 'utf8'),
    ]);
    const boxId = computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_TX_ID, 7);
    const mintId = computeMintTxId(7, 'genesis', new Uint8Array(material));
    expect(mintId).not.toBe(boxId);
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

    it('is unaffected by provenance set on an output', () => {
      // Outputs are hashed as *candidates*. From Spec G phase C on, producers
      // materialize outputs with txId/index set; if computeTxId hashed those,
      // the txId would depend on ids derived from the txId itself — circular.
      // One strip rule (canonicalBoxBytes) is what makes this hold.
      const tx: UtxoTransaction = {
        inputs: ['in1'],
        outputs: [makeKarmaBox(), makeCreditBox()],
        signatures: {},
        protocolVersion: 2,
      };
      const before = computeTxId(tx);

      const materialized: UtxoTransaction = {
        ...tx,
        outputs: tx.outputs.map((o, i) => ({ ...o, id: 'f'.repeat(64), txId: before, index: i })),
      };
      expect(computeTxId(materialized)).toBe(before);
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
