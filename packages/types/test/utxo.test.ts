import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { decode as cborDecode } from 'cbor-x';
import {
  computeBoxId,
  computeCandidateBoxId,
  computeMintTxId,
  computeTxId,
  canonicalBoxBytes,
  u32BE,
  BOX_ID_DOMAIN,
  TX_ID_DOMAIN,
  MINT_ID_DOMAIN,
  IDENTITY_KEY_DOMAIN,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
} from '../src/index.js';
import type { CandidateOf, KarmaBox, CreditBox, LikeBox, InviteBox, BondBox, UtxoTransaction, MintReason } from '../src/index.js';

const owner = new Uint8Array(32).fill(0xaa);

function makeKarmaBox(overrides: Partial<KarmaBox> = {}): KarmaBox {
  return {
    boxType: 'karma',
    value: 100n,
    owner,
    guard: 'owner_signature',
    proofSource: 'genesis',
    ...overrides,
  };
}

function makeCreditBox(): CreditBox {
  return {
    boxType: 'credit',
    value: 500n,
    owner,
    guard: 'owner_signature',
    proofSource: 42,
  };
}

function makeLikeBox(): LikeBox {
  return {
    boxType: 'like',
    value: 2n,
    likerId: 'user123',
    targetPostId: 'a'.repeat(64),
    guard: 'epoch_tally',
  };
}

function makeInviteBox(): InviteBox {
  return {
    boxType: 'invite',
    value: 10n,
    secretHash: new Uint8Array(32).fill(0xbb),
    inviterId: 'user456',
    guard: 'hash_preimage',
  };
}

function makeBondBox(): BondBox {
  return {
    boxType: 'bond',
    value: 20n,
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

    it('is DETERMINED by the provenance on the box', () => {
      // The inversion of the phase C0 test that lived here. Until phase G3b the
      // assertion was that provenance is *stripped* — the legacy derivation had
      // no `txId`/`index` in the preimage, so a box hashed the same bare or
      // materialized, and the test existed to prove the single-strip-rule fix
      // was not a no-op. Under the provenance derivation that property is
      // exactly wrong: an id that ignored its own provenance would be the M-11
      // id again.
      //
      // Same boxes, opposite claim — moving the same `(txId, index)` pair must
      // move the id, and two indices under one txId must not collide.
      for (const bare of [makeKarmaBox(), makeCreditBox(), makeLikeBox(), makeInviteBox(), makeBondBox()]) {
        const at3 = { ...bare, txId: GOLDEN_TX_ID, index: 3 };
        const at4 = { ...bare, txId: GOLDEN_TX_ID, index: 4 };
        const otherTx = { ...bare, txId: 'a'.repeat(64), index: 3 };
        expect(computeBoxId(at3)).not.toBe(computeBoxId(at4));
        expect(computeBoxId(at3)).not.toBe(computeBoxId(otherTx));
        // The stored `id` field is not part of its own preimage.
        expect(computeBoxId({ ...at3, id: 'f'.repeat(64) })).toBe(computeBoxId(at3));
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
 * `number` fields stay minimal-int. The demo-UI CBOR encoder must reproduce
 * these exact bytes. Do not "fix" a failure by editing the hashes — the
 * encoding is protocol-breaking and unversioned.
 *
 * The wide-int pin **moved from `createdAtBlock` to `proofSource`** (Spec G
 * phase G3b). `createdAtBlock: 70000` used to be the only box field above
 * 65536, which is what locked L-5's wide-int encoding path; deleting the field
 * would otherwise have dropped that coverage silently, because a karma box's
 * canonical bytes now carry **no number field at all** (`index` is stripped).
 * `CreditBox.proofSource` is a block height and carries the pin now.
 *
 * Candidates and boxes are separate because the derivation is layered: the
 * candidates define the transaction, the transaction defines its id, and that id
 * plus an index defines each box. Writing it in that order is also what shows
 * this path has no circularity.
 */
const GOLDEN_OWNER = new Uint8Array(32);
for (let i = 0; i < 32; i++) GOLDEN_OWNER[i] = i;

const GOLDEN_KARMA_CANDIDATE: CandidateOf<KarmaBox> = {
  boxType: 'karma',
  value: 100n,
  owner: GOLDEN_OWNER,
  guard: 'owner_signature',
  proofSource: 'genesis',
};

const GOLDEN_CREDIT_CANDIDATE: CandidateOf<CreditBox> = {
  boxType: 'credit',
  value: 123456789n * 10n ** 8n,  // 12_345_678_900_000_000 > 2^53 — the range P0 exists for
  owner: GOLDEN_OWNER,
  guard: 'owner_signature',
  proofSource: 70000,             // > 65536 — locks the wide-int encoding path (L-5)
};

const GOLDEN_TX: UtxoTransaction = {
  inputs: ['1111111111111111111111111111111111111111111111111111111111111111'],
  outputs: [GOLDEN_KARMA_CANDIDATE, GOLDEN_CREDIT_CANDIDATE],
  signatures: {},
  protocolVersion: 1,
};

const GOLDEN_KARMA_BOX_ID =
  '778a084f4d14df3118b1598cc9cdaac603d18412beb2de56d0290200e30c4622';
const GOLDEN_CREDIT_BOX_ID =
  '14e4bdb5a820ddbc7c8f8e99d6bdac69fa5b5935b576949fbab53bae5323bc9d';
const GOLDEN_TX_ID =
  '43d122fc103ffb4931710add70c900ee14e0684de9a4b02eadb8a0ea437e47a0';

/** The two candidates as block application materializes them out of GOLDEN_TX. */
const GOLDEN_KARMA_BOX: KarmaBox = { ...GOLDEN_KARMA_CANDIDATE, txId: GOLDEN_TX_ID, index: 0 };
const GOLDEN_CREDIT_BOX: CreditBox = { ...GOLDEN_CREDIT_CANDIDATE, txId: GOLDEN_TX_ID, index: 1 };

/**
 * Full canonical identity bytes, frozen. The substring assertions below say
 * *why* particular byte forms matter; these pin the whole encoding, including
 * cbor-x's fixed two-byte map header (`b9 0007`) and the untagged `5820` byte
 * string for `owner`. A mirror implementation reproducing minimal-length
 * canonical CBOR (`a7`), or tagging typed arrays (`d840`, which the deleted
 * `serializeBox` did), computes a different box id.
 */
const GOLDEN_KARMA_BOX_BYTES =
  'b9000567626f7854797065656b61726d616567756172646f6f776e65725f7369676e6174757265656f776e' +
  '65725820000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f6b70726f6f6653' +
  '6f757263656767656e657369736576616c75651b0000000000000064';
const GOLDEN_CREDIT_BOX_BYTES =
  'b9000567626f7854797065666372656469746567756172646f6f776e65725f7369676e6174757265656f77' +
  '6e65725820000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f6b70726f6f66' +
  '536f757263651a000111706576616c75651b002bdc545d587500';

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
    // A number field above 65536 stays minimal-int (uint32 form 1a00011170,
    // not the 1b… uint64 form `value` uses). Asserted on the credit box:
    // `proofSource` carries this pin since phase G3b deleted `createdAtBlock`,
    // after which a karma box's canonical bytes hold no number field at all.
    expect(creditHex).toContain('1a00011170');
    expect(creditHex).not.toContain('1b0000000000011170');
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
    expect(typeof decoded.proofSource).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Spec G — provenance-derived identity
// ---------------------------------------------------------------------------

/**
 * Independent mirror of the src writer — the encoding under test, not a reuse of
 * it. Stays hand-written now that `u32BE` is exported: the golden vectors below
 * are only an anchor if the bytes they feed come from somewhere other than the
 * function under test, and it is the *in-domain* half this pins, so the mirror
 * deliberately omits the sentinel branch.
 */
function u32BEMirror(n: number): Uint8Array {
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
  'prune-refund-author',
  'prune-refund-liker',
];

/**
 * Frozen golden vectors for the provenance derivation — the cross-implementation
 * anchor for node and the demo UI. `GOLDEN_TX` creates these two boxes, so the
 * karma box sits at index 0 and the credit box at index 1 of that transaction.
 * Do not "fix" a failure by editing the hashes: the derivation is
 * protocol-breaking and unversioned.
 */
const GOLDEN_CANDIDATE_KARMA_ID =
  '778a084f4d14df3118b1598cc9cdaac603d18412beb2de56d0290200e30c4622';
const GOLDEN_CANDIDATE_CREDIT_ID =
  '14e4bdb5a820ddbc7c8f8e99d6bdac69fa5b5935b576949fbab53bae5323bc9d';
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

describe('u32BE', () => {
  const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');

  it('writes 4 bytes big-endian', () => {
    // Byte order is protocol-visible: a little-endian mirror derives different
    // mint txIds and therefore different box ids.
    expect(hexOf(u32BE(0))).toBe('00000000');
    expect(hexOf(u32BE(1))).toBe('00000001');          // '01000000' if little-endian
    expect(hexOf(u32BE(258))).toBe('00000102');
    expect(hexOf(u32BE(0x12345678))).toBe('12345678'); // '78563412' if little-endian
    expect(hexOf(u32BE(0xfffffffe))).toBe('fffffffe'); // top of the encodable domain
  });

  it('agrees with the independent in-domain mirror', () => {
    for (const n of [0, 1, 2, 255, 256, 258, 65535, 70000, 0x12345678, 0xfffffffe]) {
      expect(hexOf(u32BE(n)), `n=${n}`).toBe(hexOf(u32BEMirror(n)));
    }
  });

  it('is total: out-of-domain input takes the sentinel rather than throwing', () => {
    // M-5 no-panic contract. Light clients derive ids from attacker-supplied
    // fields, so a throw here is a denial-of-service, not a validation error.
    const bad: number[] = [-1, 1.5, NaN, Infinity, -Infinity, 2 ** 32, Number.MAX_SAFE_INTEGER];
    for (const n of bad) {
      expect(() => u32BE(n), `n=${n}`).not.toThrow();
      expect(hexOf(u32BE(n)), `n=${n}`).toBe('ffffffff');
    }
    // The typeof guard, reachable only from untyped callers (JS, JSON).
    for (const n of [undefined, null, '7', {}]) {
      expect(hexOf(u32BE(n as unknown as number)), `n=${String(n)}`).toBe('ffffffff');
    }
  });

  it('excludes the sentinel from the encodable domain', () => {
    // Why a well-formed index or height can never collide with a malformed one:
    // 0xffffffff is not itself encodable, so nothing valid produces those bytes.
    expect(hexOf(u32BE(0xffffffff))).toBe('ffffffff');
    expect(hexOf(u32BE(0xffffffff))).toBe(hexOf(u32BE(-1)));
  });

  it('always returns exactly 4 bytes', () => {
    for (const n of [0, 1, 0xfffffffe, -1, NaN, 2 ** 32]) {
      expect(u32BE(n).length, `n=${n}`).toBe(4);
    }
  });

  it('is the writer the id derivations actually use', () => {
    // Pins the export against a frozen vector rather than against itself: the
    // coinbase golden was captured with the module-private writer feeding
    // `subject`, and the same bytes come back out of the exported one.
    expect(computeMintTxId(70000, 'coinbase', u32BE(0))).toBe(GOLDEN_MINT_COINBASE_ID);
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

  it('IS computeBoxId — one derivation, not two', () => {
    // The inversion of the phase-A test that asserted these two must not be
    // confusable, back when `computeBoxId` still carried the legacy content
    // hash. Phase G3b collapsed them: `computeBoxId(box)` is defined as
    // `computeCandidateBoxId(box, box.txId, box.index)`.
    //
    // This is the property the whole spec turns on — a creator predicting an id
    // before the box exists and a verifier re-deriving it from the stored box
    // must run the *same* function, or "predictable" and "honest" are two
    // different ids again.
    expect(computeBoxId(GOLDEN_KARMA_BOX)).toBe(
      computeCandidateBoxId(GOLDEN_KARMA_CANDIDATE, GOLDEN_TX_ID, 0),
    );
    expect(computeBoxId(GOLDEN_CREDIT_BOX)).toBe(
      computeCandidateBoxId(GOLDEN_CREDIT_CANDIDATE, GOLDEN_TX_ID, 1),
    );
  });

  it('a stored box re-derives its own id — honesty is structural', () => {
    // M-11 stated as an invariant: `stored.id === computeBoxId(stored)`. Under
    // the content hash this could not hold once apply mutated `createdAtBlock`.
    for (const [candidate, index] of [
      [GOLDEN_KARMA_CANDIDATE, 0],
      [GOLDEN_CREDIT_CANDIDATE, 1],
    ] as const) {
      const id = computeCandidateBoxId(candidate, GOLDEN_TX_ID, index);
      const stored = { ...candidate, txId: GOLDEN_TX_ID, index, id };
      expect(computeBoxId(stored)).toBe(stored.id);
    }
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
    expect(computeMintTxId(70000, 'coinbase', u32BEMirror(0))).toBe(GOLDEN_MINT_COINBASE_ID);
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

  it('separates the two prune-refund legs for the same subject', () => {
    // The collision the second prune reason exists to prevent: one user who both
    // authored and liked inside a single pruned subtree gets two refund mints at
    // the same height, from the same `settlePruneUtxo` call, with the same
    // `(rootPostHash, owner)` subject. One reason would derive one txId twice at
    // index 0, trip UNIQUE(tx_id, output_index) and reject a legitimate block.
    //
    // Subject shape is node's (NODE_INTERFACE → reason/subject table), built
    // here only so the scenario is the real one: utf8(rootPostHash) ‖ raw(owner).
    const subject = new Uint8Array(96);
    subject.set(Buffer.from('c'.repeat(64), 'utf8'), 0);
    subject.set(new Uint8Array(32).fill(0x22), 64);
    expect(computeMintTxId(70000, 'prune-refund-author', subject))
      .not.toBe(computeMintTxId(70000, 'prune-refund-liker', subject));
  });

  it('the two prune-refund reasons are distinct from every other reason', () => {
    // Widening the set must not let a new tag land on an existing mint id.
    const subject = new Uint8Array(96).fill(0x33);
    const ids = ALL_MINT_REASONS.map((r) => computeMintTxId(70000, r, subject));
    expect(new Set(ids).size).toBe(ALL_MINT_REASONS.length);
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
  describe('domain separation (found by G3b mutation testing)', () => {
    // Dropping `TX_ID_DOMAIN` from `computeTxId` was killed ONLY by frozen
    // goldens and the UI mirror — three assertions, all of the form "this id
    // equals this constant". Nothing pinned what the tag is *for*: that box ids,
    // transaction ids, mint txIds and identity-record keys share one 32-byte
    // keyspace and must be provably disjoint (TYPES_INTERFACE → Domain tags).
    //
    // A golden catches removal only because the golden was regenerated after the
    // tag was added. These pin the property, so a future id that forgets its tag
    // fails on meaning rather than on a number someone might "fix".

    it('every domain tag is distinct', () => {
      const tags = [BOX_ID_DOMAIN, TX_ID_DOMAIN, MINT_ID_DOMAIN, IDENTITY_KEY_DOMAIN]
        .map((t) => Buffer.from(t).toString('hex'));
      expect(new Set(tags).size).toBe(tags.length);
    });

    it('no domain tag is a prefix of another', () => {
      // Same argument the MintReason set rests on: the tag is followed directly
      // by caller bytes with no length prefix, so a prefix relation would let
      // one preimage be read as another domain's.
      const tags = [BOX_ID_DOMAIN, TX_ID_DOMAIN, MINT_ID_DOMAIN, IDENTITY_KEY_DOMAIN]
        .map((t) => Buffer.from(t).toString('hex'));
      for (const a of tags) {
        for (const b of tags) {
          if (a !== b) expect(a.startsWith(b)).toBe(false);
        }
      }
    });

    it('the txId preimage is domain-tagged — independently recomputed', () => {
      // Independent mirror of `computeTxId`, in the shape `u32BEMirror` uses:
      // written from the contract rather than by calling the function under
      // test, so removing the tag from the implementation fails HERE and not
      // only against a frozen hash.
      const h = createHash('blake2b512');
      h.update(Buffer.from('dagsocial/tx-id/1'));
      for (const input of GOLDEN_TX.inputs) h.update(input);
      for (const out of GOLDEN_TX.outputs) h.update(canonicalBoxBytes(out));
      h.update(String(GOLDEN_TX.protocolVersion));
      expect(h.digest().subarray(0, 32).toString('hex')).toBe(computeTxId(GOLDEN_TX));
    });

    it('the box-id preimage is domain-tagged — independently recomputed', () => {
      const h = createHash('blake2b512');
      h.update(Buffer.from('dagsocial/box-id/1'));
      h.update(canonicalBoxBytes(GOLDEN_KARMA_CANDIDATE));
      h.update(Buffer.from(GOLDEN_TX_ID, 'utf8'));
      h.update(u32BE(0));
      expect(h.digest().subarray(0, 32).toString('hex'))
        .toBe(computeCandidateBoxId(GOLDEN_KARMA_CANDIDATE, GOLDEN_TX_ID, 0));
    });

    it('a tx id and a box id over the same bytes cannot collide', () => {
      // The concrete reason the tags exist: without them these two derivations
      // could be fed preimages that coincide, and both keys live in one AVL
      // keyspace. With the tags they are unconditionally distinct.
      const oneOutput: UtxoTransaction = {
        inputs: [], outputs: [GOLDEN_KARMA_CANDIDATE], signatures: {}, protocolVersion: 1,
      };
      expect(computeTxId(oneOutput))
        .not.toBe(computeCandidateBoxId(GOLDEN_KARMA_CANDIDATE, '', 0));
    });
  });

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
