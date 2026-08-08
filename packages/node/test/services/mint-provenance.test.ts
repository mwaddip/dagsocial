import { describe, it, expect } from 'vitest';
import { computeMintTxId } from '@dagsocial/types';
import type { MintReason } from '@dagsocial/types';
import {
  MINT_OUTPUT_INDEX,
  GENESIS_SYSTEM_KARMA,
  GENESIS_FAUCET_CREDITS,
  coinbaseContext,
  vouchSettleContext,
  likePayoutContext,
  postlockUnlockContext,
  postlockRemainderContext,
  decayContext,
  genesisContext,
  pruneRefundAuthorContext,
  mintTxIdFor,
} from '../../src/mint-provenance.js';
import type { MintContext } from '../../src/mint-provenance.js';

// Deterministic fixtures — no Date.now(), no randomness (Spec G §6 hygiene).
const pubkey = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const postId = (fill: string): string => fill.repeat(64).slice(0, 64);

const POST_A = postId('a');
const POST_B = postId('b');
const VOUCHER = pubkey(0x11);
const TARGET = pubkey(0x22);
const OWNER = pubkey(0x44);

/** Two prune entries, i.e. two subtrees settled at one height. */
const ROOT_A = postId('c');
const ROOT_B = postId('d');

const HEIGHT = 4242;

/** Every reason, built at one height, in the contract's table order.
 *
 * `likePayoutContext` and `decayContext` deliberately share OWNER: their
 * subjects are byte-identical (one raw pubkey), so the pairwise-distinct
 * txId test below covers the pair the reason tag alone separates.
 */
function allContexts(): Array<{ ctx: MintContext; bytes: number }> {
  return [
    { ctx: coinbaseContext(0), bytes: 4 },
    { ctx: vouchSettleContext(VOUCHER, TARGET), bytes: 64 },
    { ctx: likePayoutContext(OWNER), bytes: 32 },
    { ctx: postlockUnlockContext(POST_A), bytes: 64 },
    { ctx: postlockRemainderContext(POST_A), bytes: 64 },
    { ctx: decayContext(OWNER), bytes: 32 },
    { ctx: genesisContext(GENESIS_SYSTEM_KARMA), bytes: 4 },
    { ctx: pruneRefundAuthorContext(ROOT_A, OWNER), bytes: 96 },
  ];
}

describe('mint provenance — subject encodings', () => {
  // The fixed-length rule is the invariant this module exists to satisfy:
  // `subject` carries no length prefix, so within one reason two different
  // subjects could otherwise concatenate to identical bytes and collide.
  it('every reason encodes a subject of exactly the width the contract pins', () => {
    const widths = allContexts().map(({ ctx, bytes }) => [ctx.reason, ctx.subject.length, bytes]);
    expect(widths).toEqual([
      ['coinbase', 4, 4],
      ['vouch-settle', 64, 64],
      ['like-payout', 32, 32],
      ['postlock-unlock', 64, 64],
      ['postlock-remainder', 64, 64],
      ['decay', 32, 32],
      ['genesis', 4, 4],
      ['prune-refund-author', 96, 96],
    ]);
  });

  it('covers every MintReason exactly once — the table is the whole union', () => {
    // Full-coverage claim, restored by T2b: `MintReason` has exactly 8 members
    // after the retired epoch/prune-liker reasons left the union, and every one
    // has exactly one context encoder in this table (N2b gap closed —
    // `likePayoutContext` existed in src but was missing here).
    const reasons = allContexts().map(({ ctx }) => ctx.reason);
    const expected: MintReason[] = [
      'coinbase',
      'vouch-settle',
      'like-payout',
      'postlock-unlock',
      'postlock-remainder',
      'decay',
      'genesis',
      'prune-refund-author',
    ];
    expect([...reasons].sort()).toEqual([...expected].sort());
    expect(new Set(reasons).size).toBe(8);
  });

  it('hex-typed values enter as UTF-8 text, raw-typed values as raw bytes', () => {
    // TYPES_INTERFACE → "Pinned byte forms". A mirror that decodes the hex
    // instead computes different ids.
    expect(Buffer.from(postlockUnlockContext(POST_A).subject).toString()).toBe(POST_A);

    expect(decayContext(OWNER).subject).toEqual(OWNER);
    expect(likePayoutContext(OWNER).subject).toEqual(OWNER);
    expect(vouchSettleContext(VOUCHER, TARGET).subject.subarray(0, 32)).toEqual(VOUCHER);
    expect(vouchSettleContext(VOUCHER, TARGET).subject.subarray(32)).toEqual(TARGET);

    // The prune leg: entry root as hex text, then the refunded key raw.
    const pruneAuthor = pruneRefundAuthorContext(ROOT_A, OWNER);
    expect(Buffer.from(pruneAuthor.subject.subarray(0, 64)).toString()).toBe(ROOT_A);
    expect(pruneAuthor.subject.subarray(64)).toEqual(OWNER);
  });

  it('u32BE subjects are big-endian, and total on out-of-domain input', () => {
    expect(coinbaseContext(0).subject).toEqual(new Uint8Array([0, 0, 0, 0]));
    expect(coinbaseContext(1).subject).toEqual(new Uint8Array([0, 0, 0, 1]));
    expect(coinbaseContext(258).subject).toEqual(new Uint8Array([0, 0, 1, 2]));
    // Mirrors the sentinel discipline in types' u32BE: writes all-ones rather
    // than throwing, so id derivation never panics on untrusted input (M-5).
    expect(coinbaseContext(-1).subject).toEqual(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    expect(coinbaseContext(2 ** 32).subject).toEqual(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  });

  it('genesis selectors are distinct', () => {
    expect(GENESIS_SYSTEM_KARMA).toBe(0);
    expect(GENESIS_FAUCET_CREDITS).toBe(1);
    expect(mintTxIdFor(genesisContext(GENESIS_SYSTEM_KARMA), 1)).not.toBe(
      mintTxIdFor(genesisContext(GENESIS_FAUCET_CREDITS), 1),
    );
  });

  it('every mint emits exactly one box, so index is 0', () => {
    expect(MINT_OUTPUT_INDEX).toBe(0);
  });
});

describe('mint provenance — txId uniqueness', () => {
  it('all table reasons produce pairwise-distinct txIds at one height', () => {
    const ids = allContexts().map(({ ctx }) => mintTxIdFor(ctx, HEIGHT));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  // Why `rootPostHash` is in the subject at all: `settlePruneUtxo` runs once
  // per prune entry, so two entries in one block call it twice at one height.
  // Without the entry's identity these two would be the same id at `index` 0.
  it('the same refund leg in two prune entries at one height produces different txIds', () => {
    expect(mintTxIdFor(pruneRefundAuthorContext(ROOT_A, OWNER), HEIGHT)).not.toBe(
      mintTxIdFor(pruneRefundAuthorContext(ROOT_B, OWNER), HEIGHT),
    );
  });

  it('postlock-unlock and postlock-remainder do not collide either', () => {
    expect(mintTxIdFor(postlockUnlockContext(POST_A), HEIGHT)).not.toBe(
      mintTxIdFor(postlockRemainderContext(POST_A), HEIGHT),
    );
  });

  it('the same reason at different heights produces different txIds', () => {
    expect(mintTxIdFor(postlockUnlockContext(POST_A), HEIGHT)).not.toBe(
      mintTxIdFor(postlockUnlockContext(POST_A), HEIGHT + 1),
    );
  });

  it('the same reason with different subjects produces different txIds', () => {
    expect(mintTxIdFor(postlockUnlockContext(POST_A), HEIGHT)).not.toBe(
      mintTxIdFor(postlockUnlockContext(POST_B), HEIGHT),
    );
    expect(mintTxIdFor(pruneRefundAuthorContext(ROOT_A, OWNER), HEIGHT)).not.toBe(
      mintTxIdFor(pruneRefundAuthorContext(ROOT_A, pubkey(0x99)), HEIGHT),
    );
    expect(mintTxIdFor(vouchSettleContext(VOUCHER, TARGET), HEIGHT)).not.toBe(
      mintTxIdFor(vouchSettleContext(TARGET, VOUCHER), HEIGHT),
    );
    expect(mintTxIdFor(coinbaseContext(0), HEIGHT)).not.toBe(
      mintTxIdFor(coinbaseContext(1), HEIGHT),
    );
  });

  it('mintTxIdFor is exactly computeMintTxId at the derivation height', () => {
    // Pins that the module adds no derivation of its own — the one place a
    // height could otherwise disagree with itself.
    const ctx = postlockUnlockContext(POST_A);
    expect(mintTxIdFor(ctx, HEIGHT)).toBe(computeMintTxId(HEIGHT, ctx.reason, ctx.subject));
  });

  it('a MintContext does not alias the caller-owned bytes it was built from', () => {
    const owner = pubkey(0x55);
    const ctx = decayContext(owner);
    const before = mintTxIdFor(ctx, HEIGHT);
    owner[0] = 0xee;
    expect(mintTxIdFor(ctx, HEIGHT)).toBe(before);
  });
});
