import { computeMintTxId, u32BE } from '@dagsocial/types';
import type { MintReason, PostId, TxId } from '@dagsocial/types';

/**
 * Why a box is being minted — the half of a synthetic transaction id that only
 * the caller knows (Spec G phase C; NODE_INTERFACE → "Box Identity and Mint
 * Provenance").
 *
 * `mintKarma`/`mintCredits` and the direct producers know the *height*; they do
 * not know whether they are settling a vouch, paying an author or unlocking a
 * post lock. Threading that in as a value, rather than as a txId the caller
 * derives itself, is what keeps derivation at one site: `computeMintTxId`
 * commits to height, and a caller that passed both a height and a pre-derived
 * txId could pass two different heights with nothing forcing a match — a box
 * whose id encodes a height it did not settle at.
 */
export interface MintContext {
  readonly reason: MintReason;
  readonly subject: Uint8Array;
}

/**
 * Every mint event emits exactly one box, so its position within its own
 * synthetic transaction is always 0 (NODE_INTERFACE → "`index` is always 0 for
 * mints"). Named rather than inlined so the eight producers cannot drift.
 */
export const MINT_OUTPUT_INDEX = 0;

/** `genesis` subject selectors. See `genesisContext`. */
export const GENESIS_SYSTEM_KARMA = 0;
export const GENESIS_FAUCET_CREDITS = 1;

const utf8 = new TextEncoder();

// `u32BE` is *imported* from types, not mirrored here (phase G checklist item
// 9). It was a byte-for-byte copy until types exported it, and a copy is
// exactly what could not be allowed to drift: these bytes land in a `subject`,
// which types hashes as opaque input, so a divergence would silently move mint
// txIds — and therefore box ids — with nothing to catch it. One implementation
// now feeds both `computeMintTxId`'s height field and the subjects below,
// sentinel behaviour included.

/**
 * Concatenate subject parts. Plain byte concatenation with no length prefix —
 * which is why every multi-part encoding below ends in a fixed-width field.
 */
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-reason contexts
// ---------------------------------------------------------------------------
//
// One function per reason, each producing the fixed-width `subject` the
// contract's reason/subject table specifies. This module exists so that rule is
// reviewable in one place instead of at every call site.
//
// Each returns a whole `MintContext` rather than bare bytes, so "right subject,
// wrong reason" is unrepresentable at a call site. That pairing is load-bearing
// for exactly two pairs, both of which mint the same value to the same key at
// the same height and are separated by nothing but the reason tag:
// `author-reward`/`postlock-unlock` at epoch tally, and
// `prune-refund-author`/`prune-refund-liker` for a user who both authored and
// liked inside one pruned subtree. Getting one wrong produces a box-id
// collision, not an error.
//
// Byte forms follow TYPES_INTERFACE → "Pinned byte forms": a hex-typed value
// (`PostId`) enters as the UTF-8 bytes of its hex text, a `Uint8Array`-typed
// value (pubkeys) as its raw bytes.

/** `coinbase` — 4 bytes. One event per coinbase output, not one N-output tx. */
export function coinbaseContext(outputIndex: number): MintContext {
  return { reason: 'coinbase', subject: u32BE(outputIndex) };
}

/** `vouch-settle` — 64 bytes: two 32-byte pubkeys. */
export function vouchSettleContext(voucherId: Uint8Array, targetId: Uint8Array): MintContext {
  return { reason: 'vouch-settle', subject: concat(voucherId, targetId) };
}

/** `author-reward` — 64 bytes: the post id as hex text. */
export function authorRewardContext(targetPostId: PostId): MintContext {
  return { reason: 'author-reward', subject: utf8.encode(targetPostId) };
}

/**
 * `liker-refund` — 96 bytes: post id as hex text, then the liker's 32 raw
 * pubkey bytes.
 *
 * The only two-part encoding whose parts are not both fixed-width by type. It
 * is still unambiguous because the *suffix* is: a 32-byte pubkey pins the split
 * point from the right regardless of what precedes it, so no two
 * `(postId, likerId)` pairs concatenate to the same bytes.
 */
export function likerRefundContext(targetPostId: PostId, likerId: Uint8Array): MintContext {
  return { reason: 'liker-refund', subject: concat(utf8.encode(targetPostId), likerId) };
}

/**
 * `like-payout` — 32 bytes: the credited author's raw pubkey (P2-D per-block
 * like settlement). Fixed length, so the injectivity rule holds by
 * construction. One mint per author per block, which is what makes
 * `(height, 'like-payout', author)` unique: the settlement consolidates every
 * like the author received in the block into a single mint.
 *
 * Copied rather than aliased, same as `decayContext`.
 */
export function likePayoutContext(author: Uint8Array): MintContext {
  return { reason: 'like-payout', subject: Uint8Array.from(author) };
}

/** `postlock-unlock` — 64 bytes. Distinguished from `author-reward` only by the tag. */
export function postlockUnlockContext(targetPostId: PostId): MintContext {
  return { reason: 'postlock-unlock', subject: utf8.encode(targetPostId) };
}

/** `postlock-remainder` — 64 bytes. The replacement PostLockBox after a tally. */
export function postlockRemainderContext(targetPostId: PostId): MintContext {
  return { reason: 'postlock-remainder', subject: utf8.encode(targetPostId) };
}

/**
 * `decay` — 32 bytes: the owner's raw pubkey.
 *
 * Copied rather than aliased, so a `MintContext` never shares mutable state
 * with the box it describes; every other encoder here allocates.
 */
export function decayContext(owner: Uint8Array): MintContext {
  return { reason: 'decay', subject: Uint8Array.from(owner) };
}

/**
 * `genesis` — 4 bytes: which genesis box.
 *
 * A `u32BE` selector, deliberately **not** the ASCII tags `system-karma` /
 * `faucet-credits` that Spec G §3.2 sketched. Those are variable-length and
 * merely prefix-free — sufficient for this pair by accident, but not a property
 * the fixed-length-or-self-delimiting rule can check per encoding. Adding a
 * third genesis box then costs one integer rather than a re-examination.
 */
export function genesisContext(which: number): MintContext {
  return { reason: 'genesis', subject: u32BE(which) };
}

/**
 * `prune-refund-author` — 96 bytes: the pruned subtree's root post id as hex
 * text, then the refunded author's 32 raw pubkey bytes. Unambiguous by the same
 * argument as `likerRefundContext`: the 32-byte suffix pins the split point.
 *
 * The subject names the **prune entry**, not the post the karma was locked
 * against — refunds are aggregated per user across the whole subtree, so no
 * single postId is available to name. `rootPostHash` is load-bearing rather
 * than decoration: `settlePruneUtxo` runs once per prune entry, so a block
 * carrying two entries calls it twice at one height. Without the entry's
 * identity in the subject, an author with refunds in both subtrees derives the
 * same `mintTxId` twice at `index` 0, trips `UNIQUE(tx_id, output_index)`, and
 * a legitimate block is rejected.
 */
export function pruneRefundAuthorContext(rootPostHash: PostId, owner: Uint8Array): MintContext {
  return { reason: 'prune-refund-author', subject: concat(utf8.encode(rootPostHash), owner) };
}

/**
 * `prune-refund-liker` — 96 bytes, the same encoding against the liker.
 *
 * Two reasons rather than one, for the same reason `author-reward` and
 * `liker-refund` are two at epoch tally: the same user can be both an author
 * and a liker within one pruned subtree — they replied in a thread they also
 * liked — and a single tag would give both of that user's mints an identical
 * `(height, reason, subject)`.
 */
export function pruneRefundLikerContext(rootPostHash: PostId, likerId: Uint8Array): MintContext {
  return { reason: 'prune-refund-liker', subject: concat(utf8.encode(rootPostHash), likerId) };
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * The single site where a mint's synthetic transaction id is derived.
 *
 * `mintKarma`, `mintCredits` and the direct producers (decay, the epoch
 * remainder post-lock, genesis) all route through here, so the height that
 * reaches `computeMintTxId` is always the height the box settles at.
 */
export function mintTxIdFor(ctx: MintContext, blockHeight: number): TxId {
  return computeMintTxId(blockHeight, ctx.reason, ctx.subject);
}
