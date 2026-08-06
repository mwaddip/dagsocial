import { createHash } from 'crypto';
import { Encoder } from 'cbor-x';
const hashEncoder = new Encoder({ tagUint8Array: false, useRecords: false, mapsAsObjects: true });
import type { UserId } from './identity.js';
import type { PostId } from './post.js';

// ---------------------------------------------------------------------------
// Box identity
// ---------------------------------------------------------------------------

export type BoxId = string;
export type TxId = string;

const encoder = new TextEncoder();

/**
 * Domain separators (Spec G).
 *
 * Box ids, transaction ids and identity-record keys all live in one 32-byte
 * keyspace, and the AVL tree holds more than one entity kind, so the
 * separation has to be in the preimage rather than in the caller's head.
 * `computePostId` already works this way via its module-local `POST_ID_DOMAIN`;
 * these are exported because node and the demo UI must mirror them byte for
 * byte.
 */
export const BOX_ID_DOMAIN = encoder.encode('dagsocial/box-id/1');
export const TX_ID_DOMAIN = encoder.encode('dagsocial/tx-id/1');
export const MINT_ID_DOMAIN = encoder.encode('dagsocial/mint-tx-id/1');
export const IDENTITY_KEY_DOMAIN = encoder.encode('dagsocial/identity-key/1');

/** cbor-x returns Buffer; cast to Uint8Array for hash.update compatibility. */
function encodeForHash(data: unknown): Uint8Array {
  return hashEncoder.encode(data) as unknown as Uint8Array;
}

/**
 * The single canonical identity encoding for a box.
 *
 * This is the encoder that actually computes ids — exported so tests and mirror
 * implementations (demo UI, light client) assert against it instead of a
 * lookalike. Two other box encoders exist and neither is interchangeable with
 * it: node's `state/serialize-box.ts` is a tagged encoding for AVL *values*,
 * and `serialization.ts` used to export a third built on cbor-x's default
 * `encode` (deleted in Spec G phase 0 — its output differs from this one by the
 * two-byte `d840` typed-array tag on every `Uint8Array` field).
 *
 * Provenance fields are stripped, so this is total over both a `BoxCandidate`
 * and a stored box: `canonicalBoxBytes(box)` recovers the candidate bytes the
 * creator hashed.
 *
 * Mirror implementations must reproduce cbor-x's exact framing, notably the
 * fixed two-byte map header (`b9 <count>`), not minimal-length canonical CBOR.
 *
 * **Key order is imposed here, not inherited from the caller** (Spec G phase
 * G3b, contract hazard 1b). cbor-x emits map keys in JS insertion order, so
 * before this every producer's field order was consensus-visible: the same box
 * built two ways hashed to two ids, and `post_lock` really did diverge between
 * its producer and `rowToBox`. Sorting at the single encode site retires that
 * whole class — a producer can no longer get key order wrong, because it no
 * longer chooses it.
 */
export function canonicalBoxBytes(candidate: BoxCandidate): Uint8Array {
  // Strip id/provenance at runtime — TS `Omit<>` does not enforce it, and the
  // same call must work on a stored box.
  const { id: _id, txId: _txId, index: _index, ...rest } = candidate as BoxBase;
  return encodeForHash(sortKeys(rest));
}

/**
 * Impose a total, caller-independent order on an object's own keys.
 *
 * `Array.prototype.sort` with no comparator compares UTF-16 code units and is
 * **not** locale-aware (that is `localeCompare`), so this is deterministic
 * across platforms and reproducible by any mirror implementation. Every box
 * field name is ASCII, so the order is plain byte order.
 *
 * Shallow by design: box fields are primitives, strings and `Uint8Array`s, with
 * no nested objects. A nested object added later would need this applied
 * recursively — and would be a protocol change either way.
 */
function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

/**
 * Write `n` as 4 bytes big-endian.
 *
 * Deliberately *total*, in the shape `post.ts` uses for its little-endian
 * writers: a value outside the encodable domain writes the all-ones sentinel
 * rather than throwing, so a malformed box can never turn id derivation into a
 * panic on untrusted input (audit M-5). The encodable domain excludes the
 * sentinel itself, so a well-formed index or height never collides with a
 * malformed one.
 *
 * **Exported because callers own their `subject` bytes.** Two mint reasons
 * encode a `u32BE` subject (`coinbase`, `genesis`) and `computeMintTxId` takes
 * those bytes opaquely, so node's `mint-provenance.ts` had to reimplement this
 * writer, sentinel included. A silent divergence between the two would move
 * mint txIds — and therefore box ids — with nothing to catch it, while
 * `NODE_INTERFACE.md`'s reason/subject table mandates the encoding. One
 * implementation is the only way to hold that. A mirror that cannot import it
 * (the demo UI) must reproduce the sentinel too, and must not throw.
 */
const U32_SENTINEL = 0xffffffff;

export function u32BE(n: number): Uint8Array {
  const encodable = typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n < U32_SENTINEL;
  const v = encodable ? n : U32_SENTINEL;
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

/**
 * Box id from creating-transaction provenance (Spec G):
 *
 *   blake2b512( BOX_ID_DOMAIN ‖ canonicalBoxBytes(candidate)
 *               ‖ utf8(txId) ‖ u32BE(index) )[0:32]
 *
 * `txId` is hashed as the **UTF-8 bytes of its 64-char hex string**, not as the
 * 32 decoded bytes. That matches how every other id already enters a preimage
 * here (`computeTxId` hashes input `BoxId`s as text; `postFieldBytes` encodes
 * `parentRefs` postIds as text), keeps the function total on untrusted input —
 * a hex decode would throw on a malformed `txId` field — and is strictly more
 * injective, since decoding would map `AB…`/`ab…` onto one id.
 *
 * Honest, predictable and collision-free at once: the derivation binds content
 * *and* the position that content was created at, so it is knowable at signing
 * time and cannot be invalidated by anything block application does.
 */
export function computeCandidateBoxId(candidate: BoxCandidate, txId: TxId, index: number): BoxId {
  return createHash('blake2b512')
    .update(BOX_ID_DOMAIN)
    .update(canonicalBoxBytes(candidate))
    .update(encoder.encode(txId))
    .update(u32BE(index))
    .digest()
    .subarray(0, 32)
    .toString('hex');
}

/**
 * Why a box created by block application rather than by a user transaction
 * still has one — coinbase, karma mints, decay, epoch post-locks, genesis,
 * prune settlement. The discriminant is semantic, never positional: deriving it
 * from journal position would put ordering back into *identity*, which is the
 * failure class M-12 closed for the AVL feed.
 *
 * Subject bytes are the caller's, per `NODE_INTERFACE.md`'s reason/subject
 * table; this package never sees a postId. A member may only be added while the
 * set stays **prefix-free** — cross-reason injectivity rests on it, since
 * `reason ‖ subject` carries no length prefix — which is test-pinned over the
 * whole set rather than left to inspection.
 *
 * The two `prune-refund-*` tags are **two, not one**: the same user can be both
 * an author and a liker within one pruned subtree, so a single tag would give
 * both of `settlePruneUtxo`'s mints the same `(height, reason, subject)` and
 * collide — exactly why `author-reward` and `liker-refund` are separate at epoch
 * tally. They describe today's prune settlement and are expected to be retired
 * by the karma-economics track.
 */
export type MintReason =
  | 'coinbase'
  | 'vouch-settle'
  | 'author-reward'
  | 'liker-refund'
  | 'postlock-unlock'
  | 'postlock-remainder'
  | 'decay'
  | 'genesis'
  | 'prune-refund-author'
  | 'prune-refund-liker';

/**
 * Synthetic transaction id for a mint event:
 *
 *   blake2b512( MINT_ID_DOMAIN ‖ u32BE(height) ‖ utf8(reason) ‖ subject )[0:32]
 *
 * Feeding this to `computeCandidateBoxId` gives mints and user transactions one
 * derivation path rather than two id schemes.
 *
 * `subject` bytes are the **caller's** to encode — this package does not know
 * what a postId or a voucher pair is; the per-reason encoding table belongs to
 * `NODE_INTERFACE.md`. Note that `subject` is neither length-prefixed nor
 * required to be fixed-width here, so uniqueness within one reason rests on
 * that table keeping each reason's encoding fixed-length or self-delimiting.
 * Across reasons it holds unconditionally: no `MintReason` is a prefix of
 * another.
 */
export function computeMintTxId(height: number, reason: MintReason, subject: Uint8Array): TxId {
  return createHash('blake2b512')
    .update(MINT_ID_DOMAIN)
    .update(u32BE(height))
    .update(encoder.encode(reason))
    .update(subject)
    .digest()
    .subarray(0, 32)
    .toString('hex');
}

/**
 * Box id of a **stored** box — a total function of the box itself.
 *
 * As of Spec G phase G3b this is exactly `computeCandidateBoxId` applied to the
 * box's own provenance, so there is one derivation rather than two. The legacy
 * content hash it replaced (`blake2b512(canonicalBoxBytes(box))`, no domain tag,
 * no provenance in the preimage) is gone — that derivation is what M-11 was:
 * it hashed the apply-mutated `createdAtBlock`, so a stored box could not match
 * its own id. Deleting the field and binding the id to `txId ‖ index` is what
 * makes `stored.id === computeBoxId(stored)` hold **by construction** for every
 * box in the UTXO set, checkable by any light client, indexer or AVL prover.
 *
 * Takes one argument, and must keep taking one: a second argument would mean the
 * box no longer carries what its id derives from.
 */
export function computeBoxId(box: Omit<BoxBase, 'id'>): BoxId {
  return computeCandidateBoxId(box, box.txId, box.index);
}

// ---------------------------------------------------------------------------
// Box types
// ---------------------------------------------------------------------------

export type BoxGuard = 'owner_signature' | 'epoch_tally' | 'hash_preimage' | 'inviter_signature' | 'bond_dual' | 'hash_preimage_with_bond';

/**
 * The creator-chosen fields — what a client builds and what `computeTxId`
 * hashes. No `id`, no provenance.
 */
export interface BoxCandidate {
  boxType: 'karma' | 'credit' | 'like' | 'invite' | 'bond' | 'post_lock' | 'vouch';
  value: bigint;        // integer base units, uniform across box types; value < 2^64 keeps the CBOR uint64 form
  // `createdAtBlock` was here and is **deleted** (Spec G phase G3b, D3). It was
  // the only apply-mutated field, and its presence is what made the id
  // dishonest. The node still records the settled height in a `created_at_block`
  // store column, which consensus code must never read: it is not committed in
  // the `stateRoot`, so a node bootstrapping from an AVL snapshot cannot
  // reconstruct it. The decay clock reads a committed per-identity record.
}

/**
 * A box as it exists in the ledger, the store and the AVL value: a candidate
 * plus the provenance that gives it identity.
 *
 * `txId`/`index` are **required** (Spec G phase G3a), which is what makes "has
 * an id but no provenance" — the M-11 state — unrepresentable rather than merely
 * discouraged. A producer that forgets provenance is now a compile error, in the
 * same way phase G2 turned a missing `MintContext` into one.
 *
 * `id` stays optional: producers build the candidate-plus-provenance object and
 * hash *it* to get the id, so the value is genuinely absent for one expression.
 * Every stored box has one — see the invariant in `TYPES_INTERFACE.md`.
 */
export interface BoxBase extends BoxCandidate {
  id?: BoxId;           // Computed via computeBoxId; absent only mid-construction
  txId: TxId;           // Creating transaction — real or synthetic (see computeMintTxId)
  index: number;        // u32, position within that transaction's outputs
}

/**
 * A box as its creator builds it: the per-type fields, with identity and
 * provenance removed.
 *
 * `BoxCandidate` above is the shared *base*; this is the per-box-type form the
 * contract's `interface BoxCandidate { …per-type fields }` describes. `Omit` is
 * applied per member rather than to `AnyBox` as a whole, because omitting from a
 * union collapses it to the common keys.
 */
export type CandidateOf<B extends BoxBase> = Omit<B, 'id' | 'txId' | 'index'>;

// --- Karma ---

export interface KarmaBox extends BoxBase {
  boxType: 'karma';
  owner: Uint8Array;          // 32 raw bytes — Ed25519 public key
  guard: 'owner_signature';
  proofSource: string;        // PostId | StumpHash | InviteTxId
  // `lastTouchBlock` was here and is **deleted** (Spec G phase G3b). It had no
  // reader anywhere in `src` — the decay clock reads the committed per-identity
  // record, not box ages.
  decayBurn?: boolean;
}

// --- Credit ---

export interface CreditBox extends BoxBase {
  boxType: 'credit';
  owner: Uint8Array;          // 32 raw bytes
  guard: 'owner_signature';
  proofSource: number;        // Ordering block height that minted these credits
  lockedUntilBlock?: number;  // Block height before which credits cannot be spent
}

// --- Like ---

export interface LikeBox extends BoxBase {
  boxType: 'like';
  value: 2n;                  // LIKE_COST — always 2n
  likerId: UserId;
  targetPostId: PostId;
  guard: 'epoch_tally';       // Locked until epoch tally
}

// --- Invite ---

export interface InviteBox extends BoxBase {
  boxType: 'invite';
  value: bigint;                    // N karma transferred
  secretHash: Uint8Array;           // 32 bytes — H(s) = blake2b512(s).subarray(0,32)
  inviterId: UserId;
  guard: 'hash_preimage_with_bond'; // Unlocked by preimage + committed BondBox
}

// --- Bond ---

export interface BondBox extends BoxBase {
  boxType: 'bond';
  value: bigint;                    // D karma deposited
  inviterId: UserId;               // Owner — the inviter
  /**
   * Which output of this bond's **own creating transaction** is the paired
   * InviteBox. Replaces `inviteBoxId: BoxId` (user decision, 2026-08-06).
   *
   * A box id here would be **circular**: the id derives from the creating
   * transaction's `txId`, and this is a content field, so it sits inside the
   * bytes `computeTxId` hashes. Measured: no fixed point exists. Spec G §3.1's
   * "no circularity" argument covers *provenance* fields (`computeTxId` excludes
   * `id`/`txId`/`index`) and does not reach a content field carrying a box id.
   *
   * An index is not merely a workaround for that. The bond and the invite are
   * always outputs of one transaction, so pairing by position makes a bond that
   * points at *someone else's* invite inexpressible rather than caught late —
   * the old field could name any box in the world and was only checked when it
   * was dereferenced, one transaction later. The invite resolves from
   * `(bond.txId, inviteOutputIndex)`, which `UNIQUE(tx_id, output_index)`
   * already indexes.
   */
  inviteOutputIndex: number;
  inviteePublicKey: Uint8Array;    // 32 raw bytes — set during commit
  probationStartBlock: number;     // Set during commit
  probationEndBlock: number;       // probationStartBlock + INVITE_PROBATION_BLOCKS
  guard: 'bond_dual';              // inviter_signature (reclaim) OR hash_preimage (commit)
}

// --- Post Lock ---

export interface PostLockBox extends BoxBase {
  boxType: 'post_lock';
  value: bigint;              // Current locked karma (decreases each epoch as likes accumulate)
  originalValue: bigint;      // Initial lock amount (POST_LOCK_THREAD_COST or POST_LOCK_REPLY_COST)
  owner: Uint8Array;          // 32 raw bytes — post author's Ed25519 public key
  targetPostId: PostId;       // The post this lock secures
  guard: 'epoch_tally';       // Only consumable by epoch processing
}

// --- Vouch ---

export interface VouchBox extends BoxBase {
  boxType: 'vouch';
  value: 1n;                         // always 1 karma
  voucherId: UserId;                 // who staked the karma
  targetId: UserId;                  // who is being vouched for
  guard: 'owner_signature';          // voucher controls spend
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

export type AnyBox = KarmaBox | CreditBox | LikeBox | InviteBox | BondBox | PostLockBox | VouchBox;

/** Every box type in its creator-built form — no `id`, no provenance. */
export type AnyBoxCandidate =
  | CandidateOf<KarmaBox>
  | CandidateOf<CreditBox>
  | CandidateOf<LikeBox>
  | CandidateOf<InviteBox>
  | CandidateOf<BondBox>
  | CandidateOf<PostLockBox>
  | CandidateOf<VouchBox>;

// ---------------------------------------------------------------------------
// UTXO transaction
// ---------------------------------------------------------------------------

export interface UtxoTransaction {
  inputs: BoxId[];
  /**
   * Candidates, not boxes (Spec G phase G3a). A transaction's outputs cannot
   * carry provenance: their `txId` is the id of the very transaction being
   * built, so a signed output with an `id` in it would be circular. Block
   * application materializes them — see node's `materializeOutput`.
   */
  outputs: AnyBoxCandidate[];
  signatures: Record<string, Uint8Array>;  // publicKey (hex) → Ed25519 sig (64 bytes) over txId
  preimages?: Record<string, Uint8Array>;  // boxId → hash preimage for hash_preimage guards
  protocolVersion: number;
}

/**
 * Deterministic transaction ID. Hashes inputs, outputs as candidate bytes,
 * preimages (sorted by boxId) when present, and protocolVersion.
 *
 * Outputs go through `canonicalBoxBytes`, so identity has exactly **one** strip
 * rule rather than two that must be kept in agreement. This matters from phase C
 * on: once producers materialize outputs with `txId`/`index` set, a local
 * `{ id, ...rest }` strip would hash provenance into the very txId that
 * provenance is derived from — circular, and it would make a transaction's id
 * depend on ids that cannot exist until that id is known.
 *
 * `TX_ID_DOMAIN` is applied as of Spec G phase G3b. Box ids, transaction ids and
 * identity-record keys share one 32-byte keyspace and the AVL tree holds two
 * entity kinds, so the separation has to be in the preimage. This is also **the
 * only implementation** — node's `utxo-engine.ts` carried a second one until
 * G3b deleted it; it verified signatures against an untagged id while every
 * builder signed a tagged one.
 */
export function computeTxId(tx: UtxoTransaction): TxId {
  const h = createHash('blake2b512');
  h.update(TX_ID_DOMAIN);
  for (const input of tx.inputs) {
    h.update(input);
  }
  for (const output of tx.outputs) {
    h.update(canonicalBoxBytes(output));
  }
  // Include preimages in tx identity for hash_preimage guard validation
  if (tx.preimages) {
    const sortedKeys = Object.keys(tx.preimages).sort();
    for (const boxId of sortedKeys) {
      h.update(boxId);
      h.update(tx.preimages[boxId]!);
    }
  }
  h.update(String(tx.protocolVersion));
  return h.digest().subarray(0, 32).toString('hex');
}

// ---------------------------------------------------------------------------
// Box selection
// ---------------------------------------------------------------------------

/**
 * Largest-first UTXO selection. Returns the minimal subset of boxes whose
 * combined value covers `requiredAmount`. Assumes boxes are pre-sorted by
 * value descending. Throws if the total value of all boxes is insufficient.
 */
export function selectBoxes<T extends { value: bigint }>(
  boxes: T[],
  requiredAmount: bigint,
): T[] {
  if (requiredAmount <= 0n) return [];

  let accumulated = 0n;
  const selected: T[] = [];
  for (const box of boxes) {
    accumulated += box.value;
    selected.push(box);
    if (accumulated >= requiredAmount) break;
  }

  if (accumulated < requiredAmount) {
    throw new Error('Insufficient total value');
  }

  return selected;
}
