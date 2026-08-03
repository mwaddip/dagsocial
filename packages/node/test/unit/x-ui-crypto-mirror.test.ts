/**
 * TS ↔ JS mirror for the X-style UI (`public/app`).
 *
 * The client at `public/app` mines PoW, signs, and computes post, box and
 * transaction ids in the browser; the node verifies all of them. If the two
 * encodings drift, every post and every transaction minted from that UI is
 * rejected — and no unit test in either package would notice, because neither
 * exercises the other's code.
 *
 * `public/index.html` (the demo UI) is covered by the sibling
 * `ui-crypto-mirror.test.ts`. The two clients carry independent copies of this
 * crypto; both are pinned here and there to the *same* golden vector, so a
 * change to one that is not made to the other fails CI.
 *
 * Unlike the demo, this UI keeps its crypto in a real ES module, so the test
 * imports it directly instead of scraping declarations out of HTML. Its
 * `blakejs` CDN import is the one thing Node cannot load, so it is mocked with
 * a `node:crypto` blake2b512 shim — both are plain BLAKE2b-512, which is the
 * equivalence the project already relies on (root CLAUDE.md, "Platform
 * constraint"). What this test pins is the *encoding*, which is where the two
 * implementations can actually diverge.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  computePostId,
  signingHash,
  postPowPreimage,
  computeBoxId,
  computeTxId,
} from '@dagsocial/types';
import type { Post, KarmaBox, LikeBox, UtxoTransaction } from '@dagsocial/types';

/**
 * `blakejs`-compatible shim. Asserts the UI still calls it the documented way —
 * an unkeyed 64-byte digest — so a change to how it hashes shows up as a test
 * failure rather than a silent mismatch against the node.
 */
function blake2bShim(data: Uint8Array, key: null, outlen: number): Uint8Array {
  if (key !== null) throw new Error('UI passed a key to blake2b; mirror assumes unkeyed');
  if (outlen !== 64) throw new Error(`UI requested a ${outlen}-byte digest; mirror assumes 64`);
  return new Uint8Array(createHash('blake2b512').update(data).digest());
}

vi.mock('../../public/app/js/blake2b.js', () => ({ blake2b: blake2bShim }));

const ui = await import('../../public/app/js/chain.js');

// ---------------------------------------------------------------------------
// Golden vector — must stay identical to packages/types/test/post.test.ts and
// to test/unit/ui-crypto-mirror.test.ts
// ---------------------------------------------------------------------------

const GOLDEN_AUTHOR = new Uint8Array(32);
for (let i = 0; i < 32; i++) GOLDEN_AUTHOR[i] = i;
const GOLDEN_CHALLENGE = new Uint8Array(32);
for (let i = 0; i < 32; i++) GOLDEN_CHALLENGE[i] = 0x20 + i;

const GOLDEN_POST: Post = {
  content: 'dagsocial golden vector ✓',
  author: GOLDEN_AUTHOR,
  parentRefs: [
    '1111111111111111111111111111111111111111111111111111111111111111',
    '2222222222222222222222222222222222222222222222222222222222222222',
  ],
  challenge: GOLDEN_CHALLENGE,
  powNonce: 4294967296,
  protocolVersion: 1,
  timestamp: 1767225600000,
  signature: new Uint8Array(64).fill(0xcd),
};

const GOLDEN_SIGNING_HASH = '24157bd74276c86556b41ce0402f8ef9ba4850fc086519c838eb77300ce681d0';
const GOLDEN_POST_ID = '0150b9bf676c88c715f0b1fbdf142f8bd0ccf7bb8769e2059488d6c300b6b08f';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const AUTHOR_HEX = hex(GOLDEN_AUTHOR);

/** What the UI's signPost() hashes: blake2b(buildPowInput(...)).slice(0, 32). */
function uiSigningHash(post: Post): string {
  const input = ui.buildPowInput(
    post.content, post.author, post.parentRefs,
    post.challenge, post.protocolVersion, post.timestamp,
  );
  return hex(blake2bShim(input, null, 64).slice(0, 32));
}

// ---------------------------------------------------------------------------

describe('X UI ↔ @dagsocial/types post encoding (M-1)', () => {
  it('reproduces the frozen golden signingHash', () => {
    expect(uiSigningHash(GOLDEN_POST)).toBe(GOLDEN_SIGNING_HASH);
  });

  it('reproduces the frozen golden postId', () => {
    expect(ui.computePostId(GOLDEN_POST)).toBe(GOLDEN_POST_ID);
  });

  it('agrees with types on the frozen golden vector', () => {
    // Pins both live implementations to the constants, not just to each other.
    expect(signingHash(GOLDEN_POST).toString('hex')).toBe(GOLDEN_SIGNING_HASH);
    expect(computePostId(GOLDEN_POST)).toBe(GOLDEN_POST_ID);
  });

  it('produces a byte-identical PoW preimage', () => {
    const uiBytes = ui.buildPowInput(
      GOLDEN_POST.content, GOLDEN_POST.author, GOLDEN_POST.parentRefs,
      GOLDEN_POST.challenge, GOLDEN_POST.protocolVersion, GOLDEN_POST.timestamp,
    );
    expect(hex(uiBytes)).toBe(hex(postPowPreimage(GOLDEN_POST)));
  });

  it('accepts hex-string author and challenge identically', () => {
    // The posting flow passes hex straight from the API response.
    const hexPost = {
      ...GOLDEN_POST,
      author: AUTHOR_HEX,
      challenge: hex(GOLDEN_CHALLENGE),
    };
    expect(ui.computePostId(hexPost)).toBe(GOLDEN_POST_ID);
  });

  it('agrees with types across a spread of posts', () => {
    const variants: Post[] = [
      { ...GOLDEN_POST, content: 'a', parentRefs: [] },
      { ...GOLDEN_POST, content: '', parentRefs: [''] },
      { ...GOLDEN_POST, content: '🙂 multi-byte ✓ ünïcode', parentRefs: ['ab', 'cd'] },
      { ...GOLDEN_POST, powNonce: 0, timestamp: 0 },
      { ...GOLDEN_POST, powNonce: Number.MAX_SAFE_INTEGER, timestamp: Number.MAX_SAFE_INTEGER },
      { ...GOLDEN_POST, parentRefs: Array.from({ length: 8 }, (_, i) => String(i).repeat(64)) },
    ];
    for (const v of variants) {
      expect(ui.computePostId(v)).toBe(computePostId(v));
      expect(uiSigningHash(v)).toBe(signingHash(v).toString('hex'));
    }
  });

  it('keeps the M-1 collision pair distinct', () => {
    const a = { ...GOLDEN_POST, powNonce: 5, timestamp: 23 };
    const b = { ...GOLDEN_POST, powNonce: 52, timestamp: 3 };
    expect(ui.computePostId(a)).toBe(computePostId(a));
    expect(ui.computePostId(b)).toBe(computePostId(b));
    expect(ui.computePostId(a)).not.toBe(ui.computePostId(b));
  });

  it('matches the TS fixed-width encoders bit for bit', () => {
    expect(hex(ui.encodeU32LE(0))).toBe('00000000');
    expect(hex(ui.encodeU32LE(1))).toBe('01000000');
    expect(hex(ui.encodeU32LE(0x12345678))).toBe('78563412');
    expect(hex(ui.encodeLE64(0))).toBe('0000000000000000');
    expect(hex(ui.encodeLE64(2 ** 32))).toBe('0000000001000000');
    expect(hex(ui.encodeLE64(1767225600000))).toBe('00a8da769b010000');
    // Out-of-domain values normalize to the sentinel rather than throwing.
    for (const bad of [NaN, Infinity, -1, 1.5]) {
      expect(hex(ui.encodeLE64(bad))).toBe('ffffffffffffffff');
      expect(hex(ui.encodeU32LE(bad))).toBe('ffffffff');
    }
  });
});

// ---------------------------------------------------------------------------
// Box and transaction ids
// ---------------------------------------------------------------------------
//
// The UI's minimal CBOR encoder has to reproduce cbor-x's output for every box
// shape the client builds. A box id that disagrees is worse than a rejected tx:
// `buildCreateInviteTx` embeds the InviteBox id inside the BondBox, so a drift
// there produces a transaction the node accepts as well-formed but that names a
// box which does not exist.

/** The same box twice: hex fields for the UI, raw bytes for types. */
function karmaBox(value: number, block: number) {
  const shared = { boxType: 'karma' as const, value, createdAtBlock: block };
  return {
    ui: { ...shared, owner: AUTHOR_HEX, guard: 'owner_signature', proofSource: 'post-1', lastTouchBlock: block },
    ts: { ...shared, owner: GOLDEN_AUTHOR, guard: 'owner_signature', proofSource: 'post-1', lastTouchBlock: block } as KarmaBox,
  };
}

function likeBox(value: number, block: number, targetPostId: string) {
  const shared = { boxType: 'like' as const, value, createdAtBlock: block };
  return {
    ui: { ...shared, likerId: AUTHOR_HEX, targetPostId, guard: 'epoch_tally' },
    ts: { ...shared, likerId: GOLDEN_AUTHOR, targetPostId, guard: 'epoch_tally' } as LikeBox,
  };
}

describe('X UI ↔ @dagsocial/types box ids', () => {
  it('matches computeBoxId for a karma box', () => {
    const box = karmaBox(42, 7);
    expect(ui.computeBoxId(box.ui)).toBe(computeBoxId(box.ts));
  });

  it('matches computeBoxId for a like box', () => {
    const box = likeBox(2, 7, GOLDEN_POST_ID);
    expect(ui.computeBoxId(box.ui)).toBe(computeBoxId(box.ts));
  });

  it('matches computeBoxId for a post-lock box', () => {
    const shared = { boxType: 'post_lock' as const, value: 5, createdAtBlock: 9 };
    const uiBox = { ...shared, originalValue: 5, owner: AUTHOR_HEX, targetPostId: GOLDEN_POST_ID, guard: 'epoch_tally' };
    const tsBox = { ...shared, originalValue: 5, owner: GOLDEN_AUTHOR, targetPostId: GOLDEN_POST_ID, guard: 'epoch_tally' };
    expect(ui.computeBoxId(uiBox)).toBe(computeBoxId(tsBox as never));
  });

  it('matches computeBoxId for the invite and bond pair', () => {
    const secretHash = 'ab'.repeat(32);
    const uiInvite = {
      boxType: 'invite', value: 25, createdAtBlock: 3,
      secretHash, inviterId: AUTHOR_HEX, guard: 'hash_preimage_with_bond',
    };
    const tsInvite = {
      boxType: 'invite', value: 25, createdAtBlock: 3,
      secretHash: Buffer.from(secretHash, 'hex'), inviterId: GOLDEN_AUTHOR,
      guard: 'hash_preimage_with_bond',
    };
    const inviteId = ui.computeBoxId(uiInvite);
    expect(inviteId).toBe(computeBoxId(tsInvite as never));

    const uiBond = {
      boxType: 'bond', value: 25, createdAtBlock: 3, inviterId: AUTHOR_HEX,
      inviteBoxId: inviteId, inviteePublicKey: '00'.repeat(32),
      probationStartBlock: 0, probationEndBlock: 0, guard: 'bond_dual',
    };
    const tsBond = {
      boxType: 'bond', value: 25, createdAtBlock: 3, inviterId: GOLDEN_AUTHOR,
      inviteBoxId: inviteId, inviteePublicKey: new Uint8Array(32),
      probationStartBlock: 0, probationEndBlock: 0, guard: 'bond_dual',
    };
    expect(ui.computeBoxId(uiBond)).toBe(computeBoxId(tsBond as never));
  });

  it('ignores a pre-set `id` when hashing, exactly as types does', () => {
    const box = karmaBox(42, 7);
    const withId = { ...box.ui, id: 'ff'.repeat(32) };
    expect(ui.computeBoxId(withId)).toBe(computeBoxId(box.ts));
  });
});

describe('X UI ↔ @dagsocial/types transaction ids', () => {
  it('matches computeTxId for a karma-lock tx', () => {
    const change = karmaBox(37, 7);
    const lockUi = {
      boxType: 'post_lock', value: 5, createdAtBlock: 7, originalValue: 5,
      owner: AUTHOR_HEX, targetPostId: GOLDEN_POST_ID, guard: 'epoch_tally',
    };
    const lockTs = { ...lockUi, owner: GOLDEN_AUTHOR };

    const uiTx = { inputs: ['aa'.repeat(32)], outputs: [change.ui, lockUi], signatures: {}, protocolVersion: 1 };
    const tsTx = {
      inputs: ['aa'.repeat(32)],
      outputs: [change.ts, lockTs],
      signatures: {},
      protocolVersion: 1,
    } as unknown as UtxoTransaction;

    expect(ui.computeTxId(uiTx)).toBe(computeTxId(tsTx));
  });

  it('matches computeTxId for a multi-input like tx', () => {
    const change = karmaBox(10, 12);
    const like = likeBox(2, 12, GOLDEN_POST_ID);
    const inputs = ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)];

    const uiTx = { inputs, outputs: [change.ui, like.ui], signatures: {}, protocolVersion: 1 };
    const tsTx = {
      inputs, outputs: [change.ts, like.ts], signatures: {}, protocolVersion: 1,
    } as unknown as UtxoTransaction;

    expect(ui.computeTxId(uiTx)).toBe(computeTxId(tsTx));
  });

  it('matches computeTxId when preimages are present and unsorted', () => {
    const change = karmaBox(25, 20);
    // Keys deliberately out of order: both sides must sort before hashing.
    const secretA = 'de'.repeat(32);
    const secretB = 'ad'.repeat(32);
    const idA = 'ff'.repeat(32);
    const idB = '00'.repeat(32);

    const uiTx = {
      inputs: [idA, idB],
      outputs: [change.ui],
      signatures: {},
      preimages: { [idA]: secretA, [idB]: secretB },
      protocolVersion: 1,
    };
    const tsTx = {
      inputs: [idA, idB],
      outputs: [change.ts],
      signatures: {},
      preimages: { [idA]: Buffer.from(secretA, 'hex'), [idB]: Buffer.from(secretB, 'hex') },
      protocolVersion: 1,
    } as unknown as UtxoTransaction;

    expect(ui.computeTxId(uiTx)).toBe(computeTxId(tsTx));
  });
});

// ---------------------------------------------------------------------------
// Behaviour the UI relies on beyond raw encoding
// ---------------------------------------------------------------------------

describe('X UI chain helpers', () => {
  it('mines a nonce whose digest clears the target', async () => {
    const input = ui.buildPowInput('hello', GOLDEN_AUTHOR, [], GOLDEN_CHALLENGE, 1, 1767225600000);
    const nonce = await ui.solvePoW(input, 8);
    const combined = new Uint8Array([...input, ...ui.encodeLE64(nonce)]);
    const digest = blake2bShim(combined, null, 64).slice(0, 32);
    expect(digest[0]).toBe(0);
  });

  it('yields to the event loop while mining', async () => {
    // A synchronous solve would freeze the tab for the whole ~1M-hash run at
    // the node's default 20-bit difficulty, and the progress text the caller is
    // updating would never paint. This asserts other tasks still get to run.
    //
    // 16 bits needs ~65k hashes — several times the 20k-hash slice, so a
    // yielding miner is certain to hand the loop back at least once, while the
    // work itself stays around a second. The generous timeout is for the tail:
    // the hash count is geometric, so the mean says little about the maximum.
    const input = ui.buildPowInput('yield check', GOLDEN_AUTHOR, [], GOLDEN_CHALLENGE, 1, 1);
    let interleaved = 0;
    const ticker = setInterval(() => { interleaved++; }, 1);
    try {
      await ui.solvePoW(input, 16);
    } finally {
      clearInterval(ticker);
    }
    expect(interleaved).toBeGreaterThan(0);
  }, 60_000);

  it('measures content in UTF-8 bytes, not characters', () => {
    // The composer's ring counts against MAX_CONTENT_BYTES, which the node
    // enforces in bytes — a character count would let over-long posts through.
    expect(ui.utf8Length('abc')).toBe(3);
    expect(ui.utf8Length('✓')).toBe(3);
    expect(ui.utf8Length('🙂')).toBe(4);
    expect(ui.MAX_CONTENT_BYTES).toBe(300);
  });

  it('selects boxes largest-first and refuses to under-fund', () => {
    const boxes = [{ value: 10 }, { value: 5 }, { value: 1 }];
    expect(ui.selectBoxes(boxes, 12)).toEqual([{ value: 10 }, { value: 5 }]);
    expect(ui.selectBoxes(boxes, 0)).toEqual([]);
    expect(() => ui.selectBoxes(boxes, 100)).toThrow(/Insufficient/);
  });

  it('conserves value in every transaction builder', () => {
    // The node rejects any user tx where sum(inputs) !== sum(outputs); these
    // builders are the only thing standing between a user and that rejection.
    const karma = { total: 20, boxes: [{ boxId: 'a'.repeat(64), value: 20 }] };

    const lock = ui.buildKarmaLockTx(karma, 5, GOLDEN_POST_ID, AUTHOR_HEX, 4);
    expect(lock.outputs.reduce((s: number, o: { value: number }) => s + o.value, 0)).toBe(20);

    const like = ui.buildLikeTx(karma, GOLDEN_POST_ID, AUTHOR_HEX, 4);
    expect(like.outputs.reduce((s: number, o: { value: number }) => s + o.value, 0)).toBe(20);

    // Unlike consumes a LikeBox worth LIKE_COST and returns exactly that.
    const unlike = ui.buildUnlikeTx('b'.repeat(64), AUTHOR_HEX, 4);
    expect(unlike.outputs[0].value).toBe(ui.LIKE_COST);

    // A free like minted no box, so the removal re-emits its source's own value.
    const freeUnlike = ui.buildFreeUnlikeTx({ boxId: 'c'.repeat(64), value: 13 }, AUTHOR_HEX, 4);
    expect(freeUnlike.outputs[0].value).toBe(13);

    const invite = ui.buildCreateInviteTx(
      { total: 60, boxes: [{ boxId: 'd'.repeat(64), value: 60 }] }, AUTHOR_HEX, 'ab'.repeat(32), 4,
    );
    expect(invite.outputs.reduce((s: number, o: { value: number }) => s + o.value, 0)).toBe(60);

    const transfer = ui.buildCreditTransferTx(
      { total: 50, boxes: [{ boxId: 'e'.repeat(64), value: 50 }] }, 'ab'.repeat(32), 20, AUTHOR_HEX, 4,
    );
    expect(transfer.outputs.reduce((s: number, o: { value: number }) => s + o.value, 0)).toBe(50);
  });

  it('binds the BondBox to the InviteBox id it was minted with', () => {
    const tx = ui.buildCreateInviteTx(
      { total: 60, boxes: [{ boxId: 'd'.repeat(64), value: 60 }] }, AUTHOR_HEX, 'ab'.repeat(32), 4,
    );
    const [, invite, bond] = tx.outputs;
    expect(invite.id).toBe(ui.computeBoxId(invite));
    expect(bond.inviteBoxId).toBe(invite.id);
    expect(bond.inviteePublicKey).toBe('00'.repeat(32));
  });

  it('skips credit boxes that are still locked', () => {
    const credits = {
      total: 30,
      boxes: [
        { boxId: 'a'.repeat(64), value: 20, lockedUntilBlock: 100 },
        { boxId: 'b'.repeat(64), value: 10 },
      ],
    };
    const tx = ui.buildCreditTransferTx(credits, 'ab'.repeat(32), 10, AUTHOR_HEX, 50);
    expect(tx.inputs).toEqual(['b'.repeat(64)]);
    // Past the lock height the larger box becomes spendable again.
    const later = ui.buildCreditTransferTx(credits, 'ab'.repeat(32), 15, AUTHOR_HEX, 150);
    expect(later.inputs).toEqual(['a'.repeat(64)]);
  });
});
