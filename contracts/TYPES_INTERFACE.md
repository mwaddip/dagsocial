# TYPES Interface Contract

**Component:** `@dagsocial/types`
**Protocol version:** 1
**Last updated:** 2026-07-29

## Scope

Shared data structures, serialization, base58 encoding, hash functions, and
protocol constants. Pure functions only — no side effects, no I/O, no imports
from other DAGsocial packages.

Exports from `packages/types/src/index.ts`. All types are importable by
consumers; functions are pure and synchronous.

---

## Identity (`identity.ts`)

An account IS its Ed25519 public key. There is no separate "account" concept,
no username table, no registration step. A user exists on the ledger the first
time a UTXO box references their public key.

| Export | Signature | Description |
|--------|-----------|-------------|
| `KeyPair` | `{ publicKey: Uint8Array(32), secretKey: Uint8Array }` | Ed25519 keypair (public: 32 raw bytes, secret: PKCS8 DER) |
| `UserId` | `Uint8Array` | 32 raw bytes — the Ed25519 public key |
| `generateKeyPair()` | `() => KeyPair` | Node `crypto.generateKeyPairSync('ed25519')`, strips SPKI DER wrapper to extract raw 32 key bytes |

`UserId` is binary. On the HTTP API wire it is hex-encoded (64 hex chars).
In CBOR it stays raw bytes. There is no `getUserId` hash function — the public
key IS the identity.

---

## Core Types (`post.ts`)

### Post

```
Post {
  content: string              // 1–MAX_CONTENT_BYTES UTF-8
  author: UserId               // 32-byte Ed25519 public key (Uint8Array)
  parentRefs: PostId[]         // 0–MAX_PARENT_REFS
  challenge: Uint8Array(32)    // Random nonce from node (anti-precomputation)
  powNonce: number             // PoW solution against challenge
  protocolVersion: number      // 1
  timestamp: number            // Unix ms
  signature: Uint8Array(64)    // Ed25519 over signingHash(post)
}

PostId = blake2b512(POST_ID_DOMAIN || postFieldBytes(post) || u64LE(powNonce))
         .subarray(0, 32).toString('hex')
         // postFieldBytes is the canonical length-prefixed encoding below
```

`PostId` is a hex string. `author` is binary (Uint8Array) — hex on the HTTP
wire, raw bytes in CBOR.

### Canonical field encoding (M-1 — injective, protocol-breaking)

The old preimages concatenated fields with **no delimiters**
(`content || author || ... || String(protocolVersion) || String(powNonce) ||
String(timestamp)`), so distinct field tuples collided: `(powNonce=5,
timestamp=23)` and `(52, 3)` produce the byte string `…"5""23"…` ==
`…"52""3"…` → the **same id**. Both the signing preimage and the id preimage
are now built from one injective, length-prefixed encoder.

```
u32LE(n)  = 4-byte little-endian unsigned
u64LE(n)  = 8-byte little-endian unsigned
LP(bytes) = u32LE(byteLength(bytes)) || bytes          // length-prefixed

postFieldBytes(post) =
      LP(utf8(content))
   || LP(author)                                        // 32 raw bytes
   || u32LE(parentRefs.length)                          // ref count
   || LP(utf8(ref))   for each ref, in array order
   || LP(challenge)                                     // 32 raw bytes
   || u32LE(protocolVersion)
   || u64LE(timestamp)

POST_ID_DOMAIN = utf8("dagsocial/post-id/1")            // domain separ/version tag
```

Every variable-length field is length-prefixed and the ref array carries an
explicit count, so no two distinct posts share a `postFieldBytes`. Numeric
fields are fixed-width little-endian, never `String(n)`. `powNonce` is **not**
in `postFieldBytes` (the author signs before mining, and PoW appends the nonce
itself); it enters only the id, as a trailing `u64LE`.

The fixed-width numeric writers are **total**: a numeric field outside the
encodable domain (non-negative safe integers ≤ 2⁵³−1) encodes to an all-ones
sentinel rather than throwing. This keeps `signingHash` panic-free on malformed
input (the `@dagsocial/validation` no-panic contract, M-5/M-6), and — because a
valid field's top bits are always zero — no malformed post can encode to the
same bytes as a well-formed one. A mirror implementation must reproduce this,
not reintroduce a throw.

`computePostId` prefixes `POST_ID_DOMAIN` so the id is a distinct, full-entropy
hash — not equal to the PoW hash `blake2b512(postFieldBytes || u64LE(powNonce))`,
which shares the same tail. `signingHash` carries no tag (it stays
`blake2b512(postFieldBytes)`, the exact bytes PoW is solved over).

**This encoding is protocol-breaking and unversioned.** It changes every post
hash and must be byte-identical in `@dagsocial/types` **and** the demo-UI JS
(`packages/node/public/index.html`). `PROTOCOL_VERSION` stays `1`; both devnet
DBs are wiped on deploy — no legacy-post path. A **golden test vector** (a fixed
`Post` → its exact `signingHash` and `postId` hex) is frozen in the types tests
and reproduced by the UI mirror; it is the cross-implementation anchor.

### Profile posts

Special `type` field for posts that carry identity metadata. The type
discriminator is embedded in `content` as a JSON object:

```
ProfileRoot = Post with content { type: "profile" }
BioPost     = Post with content { type: "bio", ... }
NamePost    = Post with content { type: "display_name", ... }
AvatarPost  = Post with content { type: "avatar", ... }
UsernameClaim = Post with content { type: "username_claim", claim: "@alice" }
```

### Hashing functions

| Export | Signature | Description |
|--------|-----------|-------------|
| `postPowPreimage(post)` | `(Post) => Uint8Array` | `postFieldBytes(post)` — the canonical length-prefixed encoding (see above). What PoW is solved over and what `signingHash` hashes. Excludes `powNonce` and `signature`. |
| `signingHash(post)` | `(Post) => Buffer(32)` | `blake2b512(postFieldBytes(post)).subarray(0,32)` — what the author signs. Excludes `powNonce` and `signature`. |
| `computePostId(post)` | `(Post) => PostId` | `blake2b512(POST_ID_DOMAIN \|\| postFieldBytes(post) \|\| u64LE(powNonce)).subarray(0,32).toString('hex')` — includes PoW nonce; domain-tagged so it ≠ the PoW hash |
| `getPostDiscriminator(content)` | `(string) => string \| null` | Parse JSON content and extract `type` field, or null |
| `buildProfileContent(type, extra)` | `(string, Record?) => string` | Build JSON content string with type discriminator |

`powNonce` is intentionally excluded from `signingHash` — the author signs
before finding the PoW nonce. It is included in `computePostId` to ensure
uniqueness. `signature` is excluded from both.

### Merkle primitives (`merkle.ts`)

| Export | Description |
|--------|-------------|
| `leafHash(domain, data)` | `blake2b512(utf8(domain ‖ "\0") ‖ data)[:32]` — domain-separated leaf so a leaf in one tree can't collide with a leaf in another. |
| `nodeHash(left, right)` | `blake2b512(NODE_TAG ‖ left ‖ right)[:32]` — internal-node hash of two children. |
| `buildMerkleRoot(leaves)` | Binary Merkle root over ordered leaf hashes. Empty → 32 zero bytes; single leaf → that leaf. |

**Leaf/node domain separation (L-9).** `nodeHash` carries a fixed `NODE_TAG`
(one reserved byte that is not a valid `leafHash` domain prefix — leaves begin
with a domain string, so e.g. `0x00` works) so an internal node can never be
reinterpreted as a leaf, and vice versa. Without it, a 64-byte leaf preimage
could be presented as `nodeHash(left,right)` for a forged inclusion proof
(second-preimage). This is **protocol-breaking** — it changes every Merkle root
(`subBlockRoot`, `utxoTxRoot`), unversioned, devnet DBs wiped on deploy. No demo-UI
mirror (the UI computes no roots). Node re-derives all roots through `types`, so
producer and verifier stay consistent automatically.

---

## UTXO Types (`utxo.ts`)

### BoxId

```
BoxId = string  // hex, 32 bytes
boxId = blake2b512( BOX_ID_DOMAIN ‖ canonicalCbor(candidate) ‖ txId ‖ u32BE(index) )[0:32]
```

Box identity derives from **creating-transaction provenance**, not from content alone
(Spec G — `docs/specs/2026-08-05-box-identity.md`). A pure content hash cannot be
simultaneously *honest* (matching an apply-mutated box) and *predictable* (known at signing
time); provenance gives both, and makes collisions structurally impossible.

Two types, not one:

```
interface BoxCandidate {
  boxType: "karma" | "credit" | "like" | "invite" | "bond" | "post_lock" | "vouch"
  value: bigint                // integer base units — uniform bigint (see "Value denomination")
  // ...per-type fields
}

interface BoxBase extends BoxCandidate {
  id: BoxId                    // blake2b512 over candidate ‖ provenance
  txId: TxId                   // creating transaction — real or synthetic (see Mint identity)
  index: number                // u32, position within that transaction's outputs
}
```

A `BoxCandidate` is what a creator builds and what `computeTxId` hashes. A `BoxBase` is what
exists in the ledger, the store, and the AVL value. The split makes "has an id but no
provenance" — the M-11 state — unrepresentable.

`computeBoxId` is a **total function of a stored box**: drop `id`/`txId`/`index` to recover
candidate bytes, then re-derive. So `stored.id === computeBoxId(stored)` holds by construction
for every box in the UTXO set, and a light client, indexer, or AVL prover derives the same id
the node did.

**`createdAtBlock` is NOT a box field.** It was the only apply-mutated field, and its presence
is what made the id dishonest. The node records the settled height in a store column;
**consensus code must never read that column**, since it is not committed in the `stateRoot`
and a node bootstrapping from an AVL snapshot cannot reconstruct it. The decay clock reads a
committed per-identity record instead — see `NODE_INTERFACE.md`.

#### Mint identity

Boxes created by block application rather than by a user transaction (coinbase, karma mints,
decay, epoch post-locks, genesis) derive a **synthetic transaction id**, so there is exactly
one derivation path:

```
mintTxId = blake2b512( MINT_ID_DOMAIN ‖ u32BE(height) ‖ reason ‖ subject )[0:32]
```

`reason` is an ASCII tag from a closed set; `subject` is a canonical byte encoding defined per
reason. The discriminant is **semantic, never positional** — deriving it from journal position
would make identity order-dependent, the failure class M-12 closed for the AVL feed. Full
reason/subject table in `NODE_INTERFACE.md`.

> **Injectivity is only half-guaranteed here, and the other half is `NODE_INTERFACE.md`'s.**
> *Across* reasons it holds unconditionally, because no `MintReason` is a prefix of another
> (verified and test-pinned). *Within* one reason it does **not** hold automatically: `subject`
> carries no length prefix, so two different subjects could concatenate identically. Every
> per-reason subject encoding MUST therefore be **fixed-length or self-delimiting**. This
> package cannot enforce it — the caller owns the bytes.

#### Pinned byte forms

Protocol-visible: a mirror implementation (demo UI, light client) that chooses differently
computes different ids.

- **`txId` enters a preimage as the UTF-8 bytes of its 64-character hex string**, not as the 32
  decoded bytes. Consistent with how every other id already enters a preimage here
  (`computeTxId` hashes input `BoxId`s as text, `postFieldBytes` encodes `parentRefs` as text);
  keeps derivation **total** on untrusted input, since a hex decode throws on a malformed
  `txId` and light clients derive ids from attacker-supplied fields; and is strictly more
  injective, as decoding would collapse `AB…` and `ab…` onto one id. `reason` likewise enters
  as ASCII.
- **`u32BE` is total, never throwing.** Input outside `[0, 2³²−1)` writes the all-ones
  sentinel, following `post.ts`'s numeric-writer discipline for the M-5 no-panic contract. The
  encodable domain excludes the sentinel, so a well-formed index or height never collides with
  a malformed one. A mirror that throws instead would diverge.

#### Domain tags

| Constant | Preimage it separates |
|---|---|
| `BOX_ID_DOMAIN` | box id |
| `TX_ID_DOMAIN` | transaction id |
| `MINT_ID_DOMAIN` | synthetic mint transaction id |
| `IDENTITY_KEY_DOMAIN` | per-identity record key in the AVL tree |

Box ids, tx ids and identity-record keys share one 32-byte keyspace and the AVL tree now holds
two entity kinds, so the separation must be in the preimage. (`computePostId` already works
this way via `POST_ID_DOMAIN`; box ids previously had no tag.)

#### Canonical encoding

Exactly one encoder defines `canonicalCbor` for identity: the `cbor-x` `Encoder` in `utxo.ts`
(`{ tagUint8Array: false, useRecords: false, mapsAsObjects: true }`), exported as
`canonicalBoxBytes(candidate)` so tests and mirror implementations assert against the encoder
that actually computes ids. Node's AVL value encoder (`state/serialize-box.ts`) is a
**separate, tagged** encoding for tree values and is not interchangeable with it.
`serialization.ts` must not export a third — it previously did, using cbor-x's *default*
`encode`, which is neither. `computeTxId` hashes its outputs through `canonicalBoxBytes` for
the same reason: one strip rule, so tx and box derivation cannot drift.

⚠ **`canonicalBoxBytes` is cbor-x framing, NOT RFC 8949 canonical CBOR.** It emits the fixed
two-byte map header (`b9 00NN`), not the minimal-length form (`a7`). The name invites the wrong
assumption — a mirror written to the CBOR canonicalisation rules computes different ids. The
demo UI already encodes this way; full bytes are pinned as golden vectors in
`test/utxo.test.ts`.

#### Migration window (Spec G phases A–F)

During implementation `txId`/`index` are **optional** and `createdAtBlock` is retained, so every
phase lands workspace-green. Phase G tightens them to required, deletes `createdAtBlock` and
`lastTouchBlock`, and switches the derivation. **This subsection is deleted with phase G.**

Two things the Functions table below describes in their **end state** but which are
deliberately not yet true, so the contract is not read as demanding them early:

- **`computeBoxId` keeps its legacy content-hash derivation** until phase G. It is the M-11
  derivation and cannot be honest, but switching it before node's producers set provenance
  would break every existing consumer at once.

  ⚠ **Its strip rule was a separate defect — fixed in phase C0, before phase C.** The legacy
  implementation destructured only `id` and did not route through `canonicalBoxBytes`, so the
  moment a producer set `txId`/`index` and called it, those fields entered the hash and the id
  moved. Measured against the repo's own golden vectors, pre-fix:

  | Golden | Bare | With `txId`/`index` set |
  |---|---|---|
  | `GOLDEN_KARMA_BOX_ID` | `83c95fbb82c1ba03…` | `7f8b0ba3…` |
  | `GOLDEN_CREDIT_BOX_ID` | `b256df0c3fca8bd2…` | `32ff8e72…` |

  Left unfixed, phase C would have changed **every box id** — the one thing no phase before G
  may do — and would have broken the demo UI mirror and the invite flow's predicted
  `inviteBoxId`, since the client computes ids from a box with no provenance.

  `computeBoxId` now hashes `canonicalBoxBytes(box)`, so there is exactly one strip rule and it
  cannot drift from `computeCandidateBoxId` — the same fix phase A applied to `computeTxId`
  (report §8), in the one place that pass did not reach. The **derivation** is untouched: no
  domain tag, no `txId`/`index` in the preimage, until phase G.

  The change was **inert**: no box carried provenance, so destructuring absent keys yielded an
  identical `rest`, and both goldens plus node's 747 tests were unmoved. That inertness is what
  made it safe to land early — and it is also why a test is non-vacuous only when it hashes a
  box that *does* carry provenance.
- **`TX_ID_DOMAIN` is exported but not yet applied** in `computeTxId`. Applying it changes
  every txId and node's golden vectors with it — phase G, alongside the `computeBoxId` switch.

#### Value denomination (P0 — Spec B, 8-decimal BigInt)

`value` is a **`bigint`** on every box type — **uniform**, one serialization
path (karma/like/vouch hold small bigints; credits are integer base units of
10⁻⁸ credit). Float math is non-deterministic across platforms, and credit sums
exceed `Number.MAX_SAFE_INTEGER` (2⁵³) once scaled ×10⁸ — both break consensus.
See `docs/specs/2026-08-01-node-consensus-determinism.md` P0.

- **`value < 2⁶⁴` (enforced invariant).** cbor-x encodes a bigint `< 2⁶⁴` as a
  CBOR uint64 (`0x1b` + 8 bytes big-endian); at/above 2⁶⁴ it escalates to a
  tag-2 bignum — a different layout. The `< 2⁶⁴` bound keeps every value in the
  uniform `0x1b` form. Comfortably above any planned supply.
- **Box ids and the AVL `stateRoot` change** vs. the old `number` encoding
  (measured: number `5` → `05`; bigint `5n` → `1b0000000000000005`). Hard,
  unversioned format break ⇒ **fresh chain / DB reset, coordinated all-node
  cutover.** No in-place migration.
- The demo-UI CBOR encoder MUST emit the identical `0x1b`+uint64 form for
  `value` and minimal-int for the remaining `number` fields. Spec G removes
  `createdAtBlock` from the box, so box encoding no longer carries a block
  height — but L-5's `cborEncodeInt` cap (integers to 65535, string/byte
  lengths to 255) still binds every other height-bearing structure the UI
  builds, and remains Spec F P1's to fix.

### KarmaBox

```
KarmaBox extends BoxBase {
  boxType: "karma"
  owner: Uint8Array            // 32 raw bytes — Ed25519 public key
  guard: "owner_signature"     // Only owner may spend
  proofSource: string          // PostId | StumpHash | InviteTxId
}
```

Karma boxes are non-tradeable. They can only be consumed by the owner to:
- Create invite boxes
- Create like boxes
- Create a new karma box for the same owner (balance change)
- Create a post lock box (when posting)

`lastTouchBlock` was removed by Spec G — it had no reader anywhere in `src`, and the activity
clock it nominally represented now lives in the committed per-identity record
(`NODE_INTERFACE.md`), not on a box.

> **Known defect, out of Spec G's scope:** `proofSource` is not trustworthy on a karma box.
> Forced consolidation in `mintKarma` inherits the *first* consumed box's `proofSource`
> arbitrarily, so provenance is lost after the first merge, and nothing reads the field. Fixed
> by the consolidation-removal follow-up, which the karma track owns.

### CreditBox

```
CreditBox extends BoxBase {
  boxType: "credit"
  owner: Uint8Array            // 32 raw bytes
  guard: "owner_signature"
  proofSource: number          // Ordering block height that minted these credits
  lockedUntilBlock?: number    // Block height before which credits cannot be spent
}
```

Credits are freely transferable between any accounts. Locked credits (from
coinbase) cannot be spent until `lockedUntilBlock` passes.

### LikeBox

```
LikeBox extends BoxBase {
  boxType: "like"
  value: 2n                    // LIKE_COST — always 2n (bigint)
  likerId: UserId
  targetPostId: PostId
  guard: "epoch_tally"         // Locked until epoch tally. Consumed by ordering block processor.
}
```

### InviteBox

```
InviteBox extends BoxBase {
  boxType: "invite"
  value: bigint                       // N karma transferred
  secretHash: Uint8Array(32)          // H(s) — blake2b512(s).subarray(0,32)
  inviterId: UserId
  guard: "hash_preimage_with_bond"    // H(s_preimage) == secretHash ∧ committed BondBox present
}
```

Cancel path: inviter provides the preimage to spend the InviteBox alongside
an uncommitted BondBox. Reveal path: invitee provides the preimage alongside a
BondBox committed to their pubkey.

### BondBox

```
BondBox extends BoxBase {
  boxType: "bond"
  value: bigint                       // D karma deposited
  inviterId: UserId                   // Owner — the inviter
  inviteBoxId: BoxId                  // Which InviteBox this pairs with
  inviteePublicKey: Uint8Array        // empty = unclaimed, 32 bytes = committed
  probationStartBlock: number         // Set during commit
  probationEndBlock: number           // probationStartBlock + INVITE_PROBATION_BLOCKS
  guard: "bond_dual"                  // inviter_signature (reclaim) OR hash_preimage (commit)
}
```

### PostLockBox

```
PostLockBox extends BoxBase {
  boxType: "post_lock"
  value: bigint                // Current locked karma (decreases each epoch as likes accumulate)
  originalValue: bigint        // Initial lock amount (POST_LOCK_THREAD_COST or POST_LOCK_REPLY_COST)
  owner: Uint8Array            // 32 raw bytes — post author's Ed25519 public key
  targetPostId: PostId         // The post this lock secures
  guard: "epoch_tally"         // Only consumed by epoch processing (unlock schedule)
}
```

Post lock karma is gradually unlocked at epoch boundaries: every
`POST_LOCK_UNLOCK_PER_LIKES` (10) lifetime likes on the target post unlocks
1 karma back to the author.

### VouchBox

```
VouchBox extends BoxBase {
  boxType: "vouch"
  value: 1n                    // VOUCH_KARMA_AMOUNT — always 1n (bigint)
  voucherId: UserId            // 32 raw bytes — who staked the karma
  targetId: UserId             // 32 raw bytes — who is being vouched for
  guard: "owner_signature"     // Only the voucher may spend (unvouch)
}
```

### BoxGuard

```
type BoxGuard = "owner_signature" | "epoch_tally" | "hash_preimage" | "inviter_signature" | "bond_dual" | "hash_preimage_with_bond"
```

### UtxoTransaction

```
UtxoTransaction {
  inputs: BoxId[]                          // Boxes consumed
  outputs: BoxCandidate[]                  // Boxes created — candidates: no id, no txId, no index
  signatures: Record<string, Uint8Array>   // publicKey (hex) → Ed25519 sig (64 bytes) over TxId
  preimages?: Record<string, Uint8Array>   // boxId → hash preimage, for hash_preimage guards
  protocolVersion: number                  // 1
}

TxId = blake2b512( TX_ID_DOMAIN ‖ inputs ‖ canonicalCbor(outputs, in order)
                   ‖ preimages (sorted by boxId) ‖ protocolVersion )[0:32]
```

`outputs` carries **candidates**, not boxes. A transaction cannot name its own outputs' ids
without circularity, so ids are derived once `TxId` is known; the ledger materializes candidate
`i` into a `BoxBase` with `txId` and `index: i` at apply. (Pre-Spec-G this was `AnyBox[]` whose
per-output `id` was excluded from the hash — the same exclusion, now expressed in the type.)

> `preimages` was already present in the code (`types/src/utxo.ts:133`) and hashed into `TxId`
> (`:153-159`) but missing from this contract. Documented here, not introduced.

Transaction signatures are over the transaction hash (`computeTxId`), not over
domain messages. The signer signs `TxId` with their Ed25519 key; verifiers
recompute the hash and check the signature.

### Functions

| Export | Signature | Description |
|--------|-----------|-------------|
| `computeBoxId(box)` | `(BoxBase) => BoxId` | Box id from `candidate ‖ txId ‖ index`. Total function of a stored box — no second argument, so `stored.id === computeBoxId(stored)` is checkable anywhere |
| `computeCandidateBoxId(candidate, txId, index)` | `(BoxCandidate, TxId, number) => BoxId` | Same derivation, for a candidate not yet materialized. Used by creators and by clients predicting an id at signing time |
| `computeTxId(tx)` | `(UtxoTransaction) => TxId` | Transaction id over candidates |
| `computeMintTxId(height, reason, subject)` | `(number, MintReason, Uint8Array) => TxId` | Synthetic transaction id for boxes created by block application. `subject` encoding is defined per reason — see `NODE_INTERFACE.md` |
| `canonicalBoxBytes(candidate)` | `(BoxCandidate) => Uint8Array` | The single canonical identity encoding. Exported so tests and mirror implementations (demo UI, light client) assert against the encoder that computes ids, not a lookalike |

---

## Stump Types (`stump.ts`)

```
PruneIntent {
  rootPostHash: PostId
  authorId: UserId
  subtreeMerkleRoot: Uint8Array(32)  // Merkle root over subtree postIds
  subtreePostIds: PostId[]           // All postIds in the subtree
  signature: Uint8Array(64)           // Ed25519 over blake2b512(rootPostHash || subtreeMerkleRoot)
  trigger?: "author" | "storage_prune"
}

PruneEntry {
  rootPostHash: PostId
  authorId: UserId
  subtreeMerkleRoot: Uint8Array(32)  // Merkle root over subtree postIds
  subtreePostIds: PostId[]           // All postIds in the subtree
  signature: Uint8Array(64)           // Ed25519 over blake2b512(rootPostHash || subtreeMerkleRoot)
  trigger: "author" | "storage_prune"
  protocolVersion: number
}

Stump {
  rootPostHash: PostId
  authorId: UserId
  replyCount: number
  upvoteCount: number
  trigger: "author" | "storage_prune"
  protocolVersion: number
  compactedAtBlockHeight: number
}
```

| Export | Signature | Description |
|--------|-----------|-------------|
| `computePruneEntryId(entry)` | `(PruneEntry) => string` | Deterministic PruneEntry ID |
| `serializePruneEntry(entry)` | `(PruneEntry) => Uint8Array` | Canonical CBOR encoding |

---

## Block Types (`block.ts`)

### Sub-block

```
SubBlock {
  subBlockId: PostId             // = post.postId (the post IS the sub-block)
  post: Post                     // The post (with PoW = sub-block proof)
  likeBoxes: LikeBox[]           // Pending likes riding as sidecars
  producerId: UserId             // = post.author
  protocolVersion: number        // 1
}
```

Sub-blocks are user-produced. A sub-block carries exactly one post plus any
pending like boxes queued since the last sub-block. Sub-block identity IS post
identity — they are the same object.

### Block header

```
BlockHeader {
  protocolVersion: number        // 1
  height: number                 // Monotonically increasing, starting from 1
  prevBlockHash: string          // hex(32) — hash of the previous block's header
  subBlockRoot: string           // hex(32) — Merkle root over the sub-block tree (DAG content)
  utxoTxRoot: string             // hex(32) — Merkle root over the UTXO tx tree
  stateRoot: string              // hex(33) — AVL+ digest (EMPTY_STATE_ROOT until enabled)
  validatorId: UserId            // Block producer's 32-byte public key
  powNonce: number               // PoW solution
  powTargetBits: number          // Difficulty target for this block
  createdAt: number              // Unix ms
}
```

The header is what gets hashed. `blockHash(header) = blake2b512(encodeHeader(header))[:32]`
(hex) is both the block's canonical hash — the next block's `prevBlockHash` — and the
message the validator signs. The PoW preimage is the same encoding with `powNonce`
zeroed (`computePowHash`). Both functions live in `@dagsocial/validation`. The body is
bound into the header transitively through `subBlockRoot` / `utxoTxRoot` / `stateRoot`,
so the header alone commits to the whole block.

### Ordering block

Validator-produced, and a **nested** structure — a header plus two body trees and a
signature. There is no flat `hash` field (the hash is derived on demand via
`blockHash(header)`), and `height` / `powNonce` / `validatorId` / `prevBlockHash` live
on `header`, not on the block.

```
OrderingBlock {
  header: BlockHeader
  subBlockTree: SubBlockTree
  utxoTxTree: UtxoTxTree
  validatorSignature: Uint8Array(64)  // raw Ed25519 over blockHash(header)
}

SubBlockTree {
  subBlockRefs: PostId[]            // sub-block IDs anchored by this block (ordering)
  subBlockEntries: SubBlockEntry[]  // committed topology, aligned 1:1 with subBlockRefs
  pruneEntries: PruneEntry[]        // prune entries committed in this block
}

SubBlockEntry {
  postId: string        // hex(32) post ID
  parentRefs: string[]  // hex(32) parent post IDs (0–8)
  author: string        // hex(32) author public key of the post (consensus-carried, audit H-3)
}

UtxoTxTree {
  utxoTxIds: TxId[]                  // UTXO transaction IDs
  utxoTxs: Uint8Array[]              // CBOR-encoded UtxoTransactions, aligned with utxoTxIds
  likeBoxIds: BoxId[]                // standalone likes (no sub-block to ride)
  coinbaseOutputs: CoinbaseOutput[]  // block reward distribution
  epochTallyResults?: EpochTally     // present if an epoch transition triggered
}
```

`SubBlockEntry.author` is the consensus-carried authorship claim for the confirmed
post: it is committed under `subBlockRoot`, so every node — including one that
synced from ordering blocks alone and never saw the post content — records an
identical author per post. `author` is a `postId`-preimage field, so any node
holding the content can verify the claim by recomputing the id; nodes holding
the post at apply time MUST reject a block whose entry contradicts it (see
`NODE_INTERFACE.md`, apply-time authorization). This is what makes prune
authorship (audit H-3) checkable deterministically without DAG content.

### Coinbase output

```
CoinbaseOutput {
  owner: UserId              // 32-byte recipient public key
  value: bigint              // Credits minted (integer base units)
  lockedUntilBlock: number   // Height at which credits become spendable
  isTreasury: boolean        // Treasury or miner output
}
```

### Epoch tally

```
EpochTally {
  rewards: Record<PostId, LikeReward>       // per-post like rewards this epoch
  talliedLockedLikeBoxIds: string[]         // locked like boxes marked tallied (anti-double-count)
  processedFreeLikeIds: string[]            // free like rows marked processed
  consumedPostLockBoxIds: string[]          // post lock boxes consumed during this tally
  newPostLockBoxes: PostLockBox[]           // replacement post lock boxes (reduced value; empty if fully unlocked)
}

LikeReward {
  targetPostId: PostId
  likeCount: number                      // a count — stays number
  authorReward: bigint                   // karma amount (bigint; feeds mintKarma)
  likerRefunds: Record<string, bigint>   // likerId → net karma refund (bigint)
  postLockKarmaUnlocked?: bigint          // Karma released from post lock this epoch (bigint)
}
```

---

## Serialization (`serialization.ts`)

All wire format is CBOR via `cbor-x`. HTTP API is JSON. Signatures and public
keys are hex-encoded on wire (HTTP JSON); raw bytes in CBOR.

`serializeBox` was removed here by Spec G phase 0. No `src` caller existed — box serialization
goes through node's tagged `state/serialize-box.ts` (AVL values) or the identity encoder in
`utxo.ts` (ids) — but **two test files did call it, and it was the wrong encoder for what they
asserted**: `serialization.ts` used cbor-x's default `encode`, not the configured `hashEncoder`
that computes identity, so the P0 golden test pinning the `0x1b` uint64 value form was pinning
bytes no production path produces. Those assertions were re-pointed at the identity encoder,
which is now exported as `canonicalBoxBytes` — see "Canonical encoding" under BoxId.

| Export | Signature | Description |
|--------|-----------|-------------|
| `serializeTx(tx)` | `(UtxoTransaction) => Uint8Array` | Canonical CBOR encode for tx identity |
| `encodePost(post)` | `(Post) => Uint8Array` | CBOR encode |
| `decodePost(bytes)` | `(Uint8Array) => Post` | CBOR decode |
| `encodeStump(stump)` | `(Stump) => Uint8Array` | CBOR encode |
| `decodeStump(bytes)` | `(Uint8Array) => Stump` | CBOR decode |
| `encodeSubBlock(sb)` | `(SubBlock) => Uint8Array` | CBOR encode |
| `decodeSubBlock(bytes)` | `(Uint8Array) => SubBlock` | CBOR decode |
| `encodeHeader(h)` | `(BlockHeader) => Uint8Array` | CBOR encode — the input to `blockHash` / `computePowHash` |
| `decodeHeader(bytes)` | `(Uint8Array) => BlockHeader` | CBOR decode |
| `encodeSubBlockTree(t)` | `(SubBlockTree) => Uint8Array` | CBOR encode (body section) |
| `decodeSubBlockTree(bytes)` | `(Uint8Array) => SubBlockTree` | CBOR decode |
| `encodeUtxoTxTree(t)` | `(UtxoTxTree) => Uint8Array` | CBOR encode (body section) |
| `decodeUtxoTxTree(bytes)` | `(Uint8Array) => UtxoTxTree` | CBOR decode |
| `encodeOrderingBlock(b)` | `(OrderingBlock) => Uint8Array` | Length-prefixed wire framing: `u32BE(len)‖headerCbor ‖ … ‖ validatorSignature(64)` |
| `decodeOrderingBlock(bytes)` | `(Uint8Array) => OrderingBlock` | Inverse of `encodeOrderingBlock` |
| `encodeTx(tx)` | `(UtxoTransaction) => Uint8Array` | CBOR encode |
| `decodeTx(bytes)` | `(Uint8Array) => UtxoTransaction` | CBOR decode |

---

## Base58 (`base58.ts`)

| Export | Signature | Description |
|--------|-----------|-------------|
| `base58Encode(buf)` | `(Uint8Array) => string` | Bitcoin-style base58 (alphabet: `123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`) |
| `base58Decode(str)` | `(string) => Uint8Array` | Throws on invalid characters |

---

## Protocol Constants (`constants.ts`)

### Denomination (P0 — Spec B)

Constants split by kind: **amount** constants are `bigint`; **count / block /
threshold / percentage / bits** constants stay `number`.
- **Credit amounts → `bigint`, rescaled ×10⁸** (base units of 10⁻⁸ credit):
  `CREDIT_INITIAL_REWARD`, `CREDIT_REWARD_REDUCTION`, `CREDIT_TAIL_REWARD`,
  `GENESIS_CREDITS_PER_MEMBER`, and the node/UI faucet credit amounts.
- **Karma amounts → `bigint` literals, NOT rescaled** (karma is indivisible):
  `KARMA_POSTING_MINIMUM`, `KARMA_DECAY_AMOUNT`, `KARMA_MINIMUM`,
  `POST_LOCK_THREAD_COST`, `POST_LOCK_REPLY_COST`, `LIKE_COST`,
  `LIKE_MAX_AUTHOR_REWARD`, `INVITE_MIN_KARMA`, `INVITE_BOND_KARMA`,
  `INVITE_KARMA_THRESHOLD`, `VOUCH_KARMA_AMOUNT`, `VOUCH_MIN_BALANCE`,
  `GENESIS_KARMA_PER_MEMBER`.
- **Stay `number`:** all `*_BLOCKS`, `*_TARGET_BITS`/`*_FLOOR`, `LIKE_THRESHOLD`,
  `LIKE_FREE_THRESHOLD`, `POST_LOCK_UNLOCK_PER_LIKES`, `EPOCH_BLOCKS`, `MAX_*`,
  `CREDIT_MINER_REWARD_DELAY` (a block count, NOT an amount), `CREDIT_TREASURY_PCT`
  (percentage). The exhaustive per-constant classification rides in the dispatch prompt.

### Version

```typescript
export const PROTOCOL_VERSION = 1;
```

### Content limits

```typescript
export const MAX_CONTENT_BYTES = 300;
export const MAX_PARENT_REFS = 8;
```

### PoW

```typescript
export const POST_POW_TARGET_BITS = 20;       // Difficulty (higher = harder)
export const CHALLENGE_WINDOW_BLOCKS = 10;     // Blocks before challenge expires
```

### Karma

```typescript
export const KARMA_POSTING_MINIMUM = 1;              // Minimum karma to post
export const KARMA_STALE_THRESHOLD_BLOCKS = 20160;   // 28d grace period at 2m blocks
export const KARMA_DECAY_INTERVAL_BLOCKS = 720;      // 24h decay period at 2m blocks
export const KARMA_DECAY_AMOUNT = 5;                 // Karma burned per interval
export const KARMA_MINIMUM = 10;                     // Floor — decay never reduces below
```

### Post lock

```typescript
export const POST_LOCK_THREAD_COST = 5;           // Karma locked for new threads
export const POST_LOCK_REPLY_COST = 3;            // Karma locked for replies
export const POST_LOCK_UNLOCK_PER_LIKES = 10;     // Every N likes unlocks 1 karma
```

### Likes

```typescript
export const LIKE_COST = 2;                    // Karma locked to cast a like
export const LIKE_THRESHOLD = 5;               // Absolute like count per multiplier step
export const LIKE_MAX_AUTHOR_REWARD = 10;      // Max karma an author earns per post
export const LIKE_FREE_THRESHOLD = 10;         // 10× LIKE_THRESHOLD; beyond this, likes are free
```

### Epoch

```typescript
export const EPOCH_BLOCKS = 60;                // Like processing every N ordering blocks
```

### Invites

```typescript
export const MAX_PENDING_INVITES = 5;              // Max concurrent unclaimed invites per account
export const INVITE_MIN_KARMA = KARMA_POSTING_MINIMUM;
export const INVITE_BOND_KARMA = 10;               // Karma deposit locked during probation
export const INVITE_PROBATION_BLOCKS = 1000;        // Probation window in blocks
export const INVITE_KARMA_THRESHOLD = 20;          // Invitee karma target for early bond return
```

### Vouch

```typescript
export const VOUCH_KARMA_AMOUNT = 1;              // Karma escrowed per vouch
export const VOUCH_MIN_BALANCE = 11;               // Minimum karma balance to cast a vouch
export const VOUCH_COOLDOWN_BLOCKS = 60;           // Blocks before escrowed karma is released on unvouch
```

### Genesis

```typescript
export const GENESIS_COMMITTEE_KEYS: string[] = [];  // TBD at genesis
export const GENESIS_KARMA_PER_MEMBER = 1000;
export const GENESIS_CREDITS_PER_MEMBER = 10000;
export const BOOTSTRAP_PERIOD_BLOCKS = 10000;         // Blocks before committee dissolution
```

### Credit emission (Ergo-style linear decay)

```typescript
export const CREDIT_FIXED_RATE_BLOCKS = 1_051_200;    // ~2 years at 60s blocks
export const CREDIT_INITIAL_REWARD = 100;              // Credits per block in fixed-rate period
export const CREDIT_EPOCH_BLOCKS = 129_600;            // ~90 days — reward reduction interval
export const CREDIT_REWARD_REDUCTION = 2;               // Credits reduced per epoch
export const CREDIT_TAIL_REWARD = 2;                   // Flat reward after emission ends
export const CREDIT_MINER_REWARD_DELAY = 720;           // Blocks before coinbase is spendable (~12h)
export const CREDIT_TREASURY_PCT = 10;                  // Percent of each reward to treasury
```

### Ordering block PoW

```typescript
export const ORDERING_BLOCK_POW_TARGET_BITS = 12;       // Initial difficulty (~4K hashes)
export const ORDERING_BLOCK_POW_TARGET_FLOOR = 4;        // Sanity floor
```

---

## PostStore Interface Types

`StoreEntry`:
```
{
  typeId: uint8,
  id: bytes[32],
  sequence: uint32,
  data: bytes
}
```

`PeerRecord`:
```
{
  peerId: string,
  lastSeenMs: uint64,
  addresses: string[],
  features: bytes
}
```

## Journal Event Types

`JournalEvent`:
```
{
  event: string,        // stable marker identifier
  level: "INFO" | "WARN" | "ERROR",
  timestamp: string,    // ISO 8601
  ...fields             // event-specific fields per JOURNAL_EVENTS.md
}
```

## DAG Structural Types

`CanonicalBranchEntry`:
```
{
  depth: uint32,
  postId: bytes[32]
}
```

`PostScore`:
```
{
  postId: bytes[32],
  cumulativeScore: uint64
}
```

---

## Preconditions
- Node.js ≥ 22
- `cbor-x` installed
- No other DAGsocial packages needed at build time

## Postconditions
- Build produces `dist/index.js` (ESM) + `dist/index.d.ts`
- All functions are pure — no side effects, no module-level state
- Types are importable by consumers without runtime cost (type-only imports)

## Invariants
- Must not import from `@dagsocial/node`, `@dagsocial/net`, or `@dagsocial/web`
- Hash algorithm: `blake2b512` with `.subarray(0, 32)` for all 32-byte outputs
- Base58 alphabet: Bitcoin-style (no `0OIl`)
- CBOR is the canonical wire format; JSON for HTTP API
- `protocolVersion` field present on all wire types
- Secret keys never in any exported type or serialized output
- Box identity is deterministic **and provenance-derived**:
  `blake2b512(BOX_ID_DOMAIN ‖ canonicalCbor(candidate) ‖ txId ‖ u32BE(index)).subarray(0,32)`
- `computeBoxId` takes **one argument**. Any need for a second means the box is missing
  provenance, which the `BoxCandidate`/`BoxBase` split is there to prevent
- `stored.id === computeBoxId(stored)` for every box in the UTXO set — no exceptions, no
  apply-time field mutation that the id does not cover
- Every id preimage carries a domain tag; box ids, tx ids and identity-record keys share one
  32-byte keyspace and must not be forgeable across it
- A box carries **no block height**. Consensus-relevant time lives in explicit named fields
  (`lockedUntilBlock`, `probationStartBlock`, `probationEndBlock`) or in committed per-identity
  state — never in an implicit creation stamp
- Box `value` is `bigint` integer base units (uniform across box types), `< 2⁶⁴`
  so it CBOR-encodes as a uint64 (`0x1b`); no float math anywhere in consensus
  value arithmetic
- Post identity includes PoW nonce; signing hash excludes it
- Sub-block identity IS post identity (they are the same object)
- `UserId` IS the 32-byte Ed25519 public key — no hashing, no separate account concept
