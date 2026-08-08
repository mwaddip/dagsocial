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
| `buildMerkleRoot(leaves)` | Binary Merkle root over ordered leaf hashes. Empty → 32 zero bytes; single leaf → that leaf. **Odd levels PROMOTE the unpaired last node unchanged — they do NOT duplicate it** (see below). |

**Odd-level rule — NORMATIVE, and it is not the Bitcoin default.** When a level has an
odd number of nodes the unpaired last node is **promoted to the next level unchanged**;
it is **not** duplicated and paired with itself. This is why the tree is not vulnerable
to CVE-2012-2459: under promotion `[A,B,C]` → `H(0x00‖H(0x00‖A‖B)‖C)` while `[A,B,C,C]`
→ `H(0x00‖H(0x00‖A‖B)‖H(0x00‖C‖C))`, which are distinct. **Duplicate-last-node is what an
independent implementer reaches for first, and it yields a different root for every
odd-sized level — roughly half of all blocks.**

**`NODE_TAG` is `0x00`. Exactly that byte — this is a pinned constant, not an example.**
A mirror choosing a different reserved byte computes different roots everywhere.

**Leaf/node domain separation (L-9).** `nodeHash` carries `NODE_TAG` (a reserved byte that
is not a valid `leafHash` domain prefix — leaves begin
with a domain string) so an internal node can never be
reinterpreted as a leaf, and vice versa. Without it, a 64-byte leaf preimage
could be presented as `nodeHash(left,right)` for a forged inclusion proof
(second-preimage).

> **Forward constraint — this is a consensus rule with no test behind it.** The scheme is
> sound only while **every** leaf domain is a non-empty printable ASCII string, so that no
> leaf preimage can ever begin with `0x00`. The five live domains are `stump`, `subblock`,
> `prune`, `utxotx`, `coinbase` — all printable, none a prefix of another, so the NUL
> delimiter suffices. (`likebox` and `epoch` were retired by P2-D; both strings stay
> **reserved** — a future domain reusing them would collide with historical leaf meanings.)
> **Adding a leaf domain that begins with a non-printable byte silently reopens
> leaf/internal-node confusion.** No test enforces
> this; it is a contract and review rule, recorded here because it previously existed only
> as a comment in `merkle.ts`.

This is **protocol-breaking** — it changes every Merkle root
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

Two shapes, not one:

```
interface BoxCandidate {              // the shared BASE — no per-type fields
  boxType: "karma" | "credit" | "like" | "invite" | "bond" | "post_lock" | "vouch"
  value: bigint                // integer base units — uniform bigint (see "Value denomination")
}

interface BoxBase extends BoxCandidate {
  id?: BoxId                   // blake2b512 over candidate ‖ provenance — see the note below
  txId: TxId                   // creating transaction — real or synthetic (see Mint identity)
  index: number                // u32, position within that transaction's outputs
}

type CandidateOf<B extends BoxBase> = Omit<B, "id" | "txId" | "index">
type AnyBoxCandidate = CandidateOf<KarmaBox> | CandidateOf<CreditBox> | …   // all seven
```

**`BoxCandidate` is the base, `CandidateOf<B>` is the per-type candidate.** An earlier draft of
this block wrote `BoxCandidate` with a `…per-type fields` placeholder, which read as though one
name covered both; it does not, and typing `UtxoTransaction.outputs` as the base would erase
`owner`, `guard`, `targetPostId` and force a cast at every consumer. `Omit` is applied **per union
member** — omitting from a union collapses it to the common keys. `UtxoTransaction.outputs` is
`AnyBoxCandidate[]`.

A candidate is what a creator builds and what `computeTxId` hashes. A `BoxBase` is what exists
in the ledger, the store, and the AVL value. The split makes "has provenance-free identity" —
the M-11 state — unrepresentable.

> **`id` is optional, and deliberately.** A producer builds the candidate-plus-provenance object
> and hashes *it* to obtain the id, so the value is genuinely absent for exactly one expression,
> and `computeBoxId` takes `Omit<BoxBase, "id">`. Requiring it would mean a second "box without
> an id yet" type at every producer, for no safety the invariant below does not already give.
> **Every box in the ledger, the store and the AVL value has one** — that is an invariant, not a
> type-level guarantee.

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
decay, post-lock vesting, genesis) derive a **synthetic transaction id**, so there is exactly
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

#### Key ordering is canonical (Spec G phase G3b)

`canonicalBoxBytes` **imposes** a total key order — a lexicographic sort of the candidate's own
keys — rather than inheriting the caller's insertion order. Node's `serializeBox` and the demo
UI's mirror apply the identical rule.

This retires contract hazards **1b and 1c** in `NODE_INTERFACE.md`. cbor-x emits map keys in JS
insertion order, so before this a producer's field order was consensus-visible: the same box
built two ways hashed to two ids, and `post_lock` genuinely diverged between its producer and
`rowToBox`. The fix is at the single encode site, **not** at the diverging producer — a producer
can no longer get key order wrong because it no longer chooses it, and the "make every producer
match `rowToBox`" discipline is retired with it.

`Array.prototype.sort` with no comparator compares UTF-16 code units and is **not** locale-aware
(that is `localeCompare`), so it is deterministic across platforms. Every box field name is
ASCII, so the order is plain byte order. The sort is **shallow**: box fields are primitives,
strings and `Uint8Array`s, and a nested object added later would need it applied recursively.

> A mirror implementation that sorts differently — or not at all — computes different ids for
> every box. This sits alongside the cbor-x-framing warning above as the second thing a mirror
> must get right.

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
  decayBurn?: boolean          // Set by the decay engine on its burn outputs; gates the decay clock
}
```

Karma boxes are non-tradeable. They can only be consumed by the owner to:
- Create invite boxes
- Burn `LIKE_KARMA_COST` in a like transaction (`likeTarget` — there is no like box, P2-D)
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
  proofSource: number          // Minting block height, OR -1: the transfer sentinel
  lockedUntilBlock?: number    // Block height before which credits cannot be spent
}
```

`proofSource` on a credit box is **a block height or `-1`, nothing else** —
the closed value set the field-type pin enforces (`heightOrTransfer`). Mint
paths stamp the ordering-block height; every user-path transfer and faucet
grant stamps `-1`, the "transfer" convention `routes/utxo.ts` documents. (This
contract said "block height" alone until 2026-08-08; the field-type pin's
executor found the live `-1` producers, and the sentinel is now the recorded
rule. P2-C row **C8** deletes `proofSource` from the consensus bytes entirely,
retiring the sentinel with it.)

Credits are freely transferable between any accounts. Locked credits (from
coinbase) cannot be spent until `lockedUntilBlock` passes.

### ~~LikeBox~~ — DELETED (P2-D)

**There is no like box.** A like burns its karma at cast, so there is no held value and
nothing for a box to carry — a like is a **transaction** (`UtxoTransaction.likeTarget`,
below) plus a node-side `(liker, post)` record. The boxType string **`'like'` is reserved,
never to be reused**: a future box type wearing it would make old-vs-new greps and
historical debugging ambiguous forever.

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
  inviteOutputIndex: number           // Output index of the paired InviteBox in the creating tx — (txId, index) names it until C9 pins the box id at commit
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
  value: bigint                // Current locked karma (decreases per block as likes accumulate)
  originalValue: bigint        // Initial lock amount (POST_LOCK_THREAD_COST or POST_LOCK_REPLY_COST)
  owner: Uint8Array            // 32 raw bytes — post author's Ed25519 public key
  targetPostId: PostId         // The post this lock secures
  guard: "block_apply"         // Consumable only by block application (per-block vesting)
}
```

Post lock karma vests **per block** (P2-D — there is no epoch): every
`POST_LOCK_UNLOCK_PER_LIKES` (10) lifetime likes on the target post unlocks
1 karma back to the author, evaluated at the end of any block in which the
post received likes (`ARCHITECTURE §Likes → Post karma locking`).

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
type BoxGuard = "owner_signature" | "block_apply" | "hash_preimage" | "inviter_signature" | "bond_dual" | "hash_preimage_with_bond"
// "block_apply" replaced "epoch_tally" in P2-D — there is no epoch, and the meaning was
//   always "consumable only by block application". The string 'epoch_tally' is RESERVED,
//   never to be reused; guard strings are box content, inside the box-id preimage.
// ⚠ "hash_preimage" and "inviter_signature" are UNREACHABLE — no box type can carry them.
//   Every box fixes its guard to a literal (InviteBox → 'hash_preimage_with_bond',
//   BondBox → 'bond_dual', rest → 'owner_signature' | 'block_apply'). The engine switches
//   only on the live names, the store writes only the live names, and db.ts carries a
//   migration that DELETES rows still holding the old ones.
//   Low severity, but it is why stale test fixtures using them look plausible, and it
//   invites a new box type to be given a guard the engine has no case for.
```

### UtxoTransaction

```
UtxoTransaction {
  inputs: BoxId[]                          // Boxes consumed
  outputs: BoxCandidate[]                  // Boxes created — candidates: no id, no txId, no index
  signatures: Record<string, Uint8Array>   // publicKey (hex) → Ed25519 sig (64 bytes) over TxId
  preimages?: Record<string, Uint8Array>   // boxId → hash preimage, for hash_preimage guards
  protocolVersion: number                  // 1
  likeTarget?: PostId                      // Present ⟺ this tx is a like (P2-D) — see below
}

TxId = blake2b512( TX_ID_DOMAIN ‖ inputs ‖ canonicalCbor(outputs, in order)
                   ‖ preimages (sorted by boxId) ‖ protocolVersion
                   ‖ ("like:" ‖ likeTarget, iff present) )[0:32]
```

**`likeTarget`** names the liked post from inside the signed bytes — a relay cannot
re-point a like. Its preimage contribution is the ASCII marker `like:` followed by the
64-char hex, appended after `protocolVersion` **only when the field is present**; absence
appends nothing. The marker makes absent/present unambiguous at the tail (a
`protocolVersion` decimal string can never produce `like:`). This package defines only the
field and its encoding; the **biconditional rule** — `likeTarget` present ⟺ the
transaction burns exactly `LIKE_KARMA_COST`, the only legal karma deficit in any user
transaction — is consensus validation and lives in `NODE_INTERFACE.md` (UTXO engine).
P2-C's C1 (length-prefixed preimage rework) absorbs this field when it lands.

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
  producerId: UserId             // = post.author
  protocolVersion: number        // 1
}
```

Sub-blocks are user-produced. A sub-block carries exactly one post and nothing
else — the `likeBoxes` sidecar field died with `LikeBox` (P2-D; likes are
ordinary UTXO transactions). Sub-block identity IS post identity — they are the
same object.

### Block header

```
BlockHeader {
  protocolVersion: number        // 1
  networkType: NetworkType       // ⚠ NOT IMPLEMENTED — 'mainnet' | 'testnet' | 'devnet'
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

> ⚠ **NOT IMPLEMENTED — `networkType` is new, decided 2026-08-06.** It sits beside
> `protocolVersion` because it answers the sibling question: `protocolVersion` is *which
> rules*, `networkType` is *which chain*. Rejected at the structure gate when it does not
> match the node's own profile.
>
> **It is not redundant.** Id derivation is network-agnostic by decision (§Domain tags are
> network-agnostic), so this field is the **only** consensus-visible network commitment
> short of genesis. Without it a wrong-network block is rejected as a chain-link failure —
> true, but opaque.
>
> This is a **divergence from Ergo**, whose header carries no network field. Recorded so it
> is not later "corrected" by someone checking Ergo and finding no such field. Ergo can omit
> it because its network separation rides in address serialization and genesis; Notis has no
> address layer, since a box `owner` is a raw pubkey. ⚠ **Adding a header field changes
> `blockHash` and the PoW preimage** — it is part of the P2-C break bundle.

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
  utxoTxIds: TxId[]                  // UTXO transaction IDs (likes included — P2-D)
  utxoTxs: Uint8Array[]              // CBOR-encoded UtxoTransactions, aligned with utxoTxIds
  coinbaseOutputs: CoinbaseOutput[]  // block reward distribution
}
```

`likeBoxIds` and `epochTallyResults` were deleted by P2-D: likes ride `utxoTxIds` like
every other transaction, and per-block settlement is **derived state** computed identically
by every node at apply — nothing to carry in the block. (The `EpochTally` structure, its
`epoch` Merkle leaf and `canonicalEpochTallyJson` died with it; audit C-6's
key-order-divergence problem is closed by not existing.)

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

### ~~Epoch tally~~ — DELETED (P2-D)

`EpochTally` and `LikeReward` are gone with the epoch. Settlement is per-block and derived
— see `ARCHITECTURE §Likes` for the accrual arithmetic and `NODE_INTERFACE.md` for the
apply-time algorithm. Nothing epoch-shaped may return to the block structure.

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
| ~~`serializeTx(tx)`~~ | — | ⚠ **DELETED (G3b) — and the description was never true.** It was built on cbor-x's default `encode`, which is neither of the two encoders that matter, so its bytes were consumed by no identity path. Transaction identity comes from `computeTxId`. Doubly wrong: the function is gone *and* "canonical CBOR encode for tx identity" never described it |
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

> ⚠ **No consumer anywhere in the repo, and the round-trip is broken for zero-valued input.**
> Nothing in node, net, validation, wire or the demo UI imports either function — the only
> references are the barrel export and its own test. Meanwhile `base58Encode(Uint8Array([0]))`
> → `"11"` and `base58Decode("11")` → `[0,0,0]`; a 32-byte zero buffer encodes to 33 `'1'`s
> and decodes to 34 bytes. Empty input is asymmetric too (`""` encodes from empty, decodes to
> one zero byte). Non-zero inputs, including those with leading zero bytes, round-trip fine —
> the defect is confined to buffers whose numeric value is zero, which the existing test does
> not cover.
>
> Inert today because nothing calls it. **It becomes real the moment base58 is adopted for
> what it exists for — rendering a key or an address — where an all-zero value is exactly
> the case a fuzzer reaches first.** Fix the round-trip before adopting, or delete the
> module.

| Export | Signature | Description |
|--------|-----------|-------------|
| `base58Encode(buf)` | `(Uint8Array) => string` | Bitcoin-style base58 (alphabet: `123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`) |
| `base58Decode(str)` | `(string) => Uint8Array` | Throws on invalid characters |

---

## Protocol Constants (`constants.ts`)

### Network profiles

> ⚠ **NOT IMPLEMENTED — decided 2026-08-06.** No profile type, table or selector exists.
> Today the values marked per-network below are plain module constants, and nine of them
> are additionally overridable per-process from the environment in the node
> (`⚠ VIOLATED`, `NODE_INTERFACE §Configuration`). See `ARCHITECTURE §Network Identity`
> for the mechanism and the reasoning; this section is the type surface only.

```typescript
export type NetworkType = 'mainnet' | 'testnet' | 'devnet';

export interface NetworkProfile {
  readonly networkType: NetworkType;
  readonly magic: number;              // wire frame magic — one per network

  // Difficulty
  readonly orderingBlockPowTargetBits: number;
  readonly postPowTargetBits: number;

  // Block-denominated durations
  readonly karmaDecayIntervalBlocks: number;
  readonly karmaStaleThresholdBlocks: number;
  readonly vouchCooldownBlocks: number;
  readonly inviteProbationBlocks: number;
  readonly creditMinerRewardDelay: number;
  readonly bootstrapPeriodBlocks: number;

  // Emission schedule
  readonly creditFixedRateBlocks: number;
  readonly creditEpochBlocks: number;

  // Genesis
  readonly genesisCommitteeKeys: readonly string[];
  readonly genesisKarmaPerMember: bigint;
  readonly genesisCreditsPerMember: bigint;
  readonly treasuryPubKey: string;
}

export const NETWORK_PROFILES: Readonly<Record<NetworkType, NetworkProfile>>;
export function profileFor(network: NetworkType): NetworkProfile;

// The network magics live here, not in @dagsocial/wire — see below
export const MAGIC_MAINNET = 0x4D444147;  // "MDAG"
export const MAGIC_TESTNET = 0x54444147;  // "TDAG"
export const MAGIC_DEVNET  = 0x44444147;  // "DDAG"
/** The canonical set. `net` must derive its frame-magic check from this, never a local literal. */
export const KNOWN_FRAME_MAGICS: readonly number[];
```

**This is the sole definition of the network magics.** `@dagsocial/wire` exported duplicates
until P2-A phase 5 deleted them. They live here rather than `NetworkType` living in wire
because **wire has zero runtime dependencies and keeps them**: `@dagsocial/types` cannot
import from wire, and wire must not import from types. Wire's `encodeFrame` / `decodeFrame`
take `magic` as a parameter and read no magic constant — the codec is magic-agnostic by
construction and does not own network identity.

⚠ **`KNOWN_FRAME_MAGICS` must be imported, never re-declared.** `net/src/node.ts` held it as
a local literal until phase 3a. A magic missing from the set is classified as not-a-frame,
falls through to the legacy raw-CBOR path, decodes as malformed, and **permanently bans the
peer** — so a stale copy turns a routine cross-network misconnection into a ban. Note the set
is consulted *only* for frames that fail the own-magic compare, so a stale copy does not
break same-network peering; the damage is entirely cross-network.

**Every constant not listed in `NetworkProfile` is universal across networks**, including
consensus ones — the format limits (`MAX_CONTENT_BYTES`, `MAX_PARENT_REFS`,
`PROTOCOL_VERSION`, `AVL_KEY_LENGTH`) and every karma and credit cost. The split is
normative and stated in `ARCHITECTURE §Network Identity`: **compress time, never
economics.** A constant moved into `NetworkProfile` is a place devnet may behave unlike
mainnet, which is where a defect hides from the test meant to catch it.

The profile is resolved **once at startup** from `NETWORK_TYPE` and frozen. Nothing
downstream re-reads the environment, and no function takes a profile override argument —
an override parameter is the same defect as the environment read, reached by a different
door.

⚠ **Values are not pinned here.** `devnet`'s compressed timings and both public networks'
difficulty belong to the constants-pinning session, together with the two figures already
flagged open below (`KARMA_STALE_THRESHOLD_BLOCKS`'s duration, and `CREDIT_TAIL_REWARD`'s
removal). **Do not read any number in this contract as decided.**

### Domain tags are network-agnostic — deliberately

The five id-derivation domain tags — `BOX_ID_DOMAIN`, `TX_ID_DOMAIN`, `MINT_ID_DOMAIN`,
`IDENTITY_KEY_DOMAIN`, `POST_ID_DOMAIN` — **do not carry the network, and must not be
changed to.** No derivation function takes a network argument, and this package holds no
module-level network state.

This was proposed and **rejected on 2026-08-06**. Recorded here because the proposal is
attractive and will recur:

- **It breaks this contract's own Postcondition** — *"All functions are pure — no side
  effects, no module-level state"* — and its `computeBoxId` one-argument invariant. Five
  packages derive consensus bytes from these functions; a module-level network resolved at
  import time is the config-read-at-a-distance defect that `ARCHITECTURE §Network Identity`
  exists to remove.
- **The motivating analogy was false.** It was argued as the equivalent of Ergo's address
  prefix. An address prefix is a *serialization* concern, and **Ergo's own box and
  transaction ids are network-agnostic content hashes.** Scoping derivation would exceed
  Ergo, not match it.
- **It buys little.** Cross-network transaction replay is already impossible: input box id
  chains root at a genesis that differs per network, so a foreign transaction names inputs
  that do not exist. The only gap left open is cross-network **post** replay, accepted as a
  spam vector rather than a value defect.

Network separation lives in genesis, the header `networkType`, and the wire magic. See
`ARCHITECTURE §Network Identity → How the network is committed`.

### Denomination (P0 — Spec B)

Constants split by kind: **amount** constants are `bigint`; **count / block /
threshold / percentage / bits** constants stay `number`.
- **Credit amounts → `bigint`, rescaled ×10⁸** (base units of 10⁻⁸ credit):
  `CREDIT_INITIAL_REWARD`, `CREDIT_REWARD_REDUCTION`, `CREDIT_TAIL_REWARD`,
  `GENESIS_CREDITS_PER_MEMBER`, and the node/UI faucet credit amounts.
- **Karma amounts → `bigint` literals, NOT rescaled** (karma is indivisible):
  `KARMA_POSTING_MINIMUM`, `KARMA_DECAY_AMOUNT`, `KARMA_MINIMUM`,
  `POST_LOCK_THREAD_COST`, `POST_LOCK_REPLY_COST`, `LIKE_KARMA_COST`,
  `INVITE_MIN_KARMA`, `INVITE_BOND_KARMA`,
  `INVITE_KARMA_THRESHOLD`, `VOUCH_KARMA_AMOUNT`, `VOUCH_MIN_BALANCE`,
  `GENESIS_KARMA_PER_MEMBER`.
- **Stay `number`:** all `*_BLOCKS`, `*_TARGET_BITS`/`*_FLOOR`,
  `LIKES_PER_KARMA_PAYOUT` (a count), `POST_LOCK_UNLOCK_PER_LIKES`, `MAX_*`,
  `CREDIT_MINER_REWARD_DELAY` (a block count, NOT an amount), `CREDIT_TREASURY_PCT`
  (percentage). The exhaustive per-constant classification rides in the dispatch prompt.
  (`LIKE_COST`, `LIKE_THRESHOLD`, `LIKE_MAX_AUTHOR_REWARD`, `LIKE_FREE_THRESHOLD` and
  `EPOCH_BLOCKS` were deleted by P2-D.)

### Version

```typescript
export const PROTOCOL_VERSION = 1;
```

### Content limits

```typescript
export const MAX_CONTENT_BYTES = 300;
export const MAX_PARENT_REFS = 8;
```

### State format

```typescript
export const AVL_KEY_LENGTH = 32;   // bytes
```

The AVL+ tree's key width. It **sets the shape of every `stateRoot`**
(`packages/node/src/state/avl-prover.ts`), so two nodes holding different values compute
different digests for identical state — which makes it a consensus constant, not a tuning
knob. It is universal rather than per-network: a network has no reason to differ on a
format width, so it does **not** belong in `NetworkProfile`.

`packages/node/src/config.ts` imports it and plumbs it through `Config.avlKeyLength`, which
`state/avl-prover.ts` reads. That plumbing field is permitted, but its value originates here —
`node/test/config.test.ts` §8 compares the plumbed field against this export, which goes red if
node ever regrows a divergent local definition. A value pin alone cannot catch that: if this
constant moves while a stale local pin holds node at the old number, both remain self-consistent
and only the origination comparison fails.

### PoW

```typescript
export const POST_POW_TARGET_BITS = 20;       // Difficulty (higher = harder)
export const CHALLENGE_WINDOW_BLOCKS = 10;     // Blocks before challenge expires
```

### Karma

```typescript
export const KARMA_POSTING_MINIMUM = 1n;             // consensus — minimum karma to post
export const KARMA_STALE_THRESHOLD_BLOCKS = 40320;   // consensus — 28d grace at 60s blocks
export const KARMA_DECAY_INTERVAL_BLOCKS = 1440;     // consensus — 24h decay period at 60s blocks
export const KARMA_DECAY_AMOUNT = 5n;                // consensus — karma burned per interval
export const KARMA_MINIMUM = 10n;                    // consensus — floor, decay never reduces below
```

> ⚠ **The two `*_BLOCKS` values above are CORRECTED and the code still holds the old ones**
> (`20160` / `720`). Decision 2026-08-06: **the target block time is 60 seconds**, so these
> are recomputed from a 2-minute basis. Phase 2 changes `constants.ts`.
>
> **This was a unit error, not a tuning question.** The constants were annotated "28 days"
> and "24 hours" while `ORDERING_BLOCK_INTERVAL_MS` is `60000` and every other time-derived
> constant is 60s-based — `CREDIT_MINER_REWARD_DELAY` and `MEMPOOL_EXPIRY_BLOCKS` are both
> `720` for "~12h" (720 minutes ✓), `CREDIT_EPOCH_BLOCKS` is `129_600` for "~90 days" ✓,
> and `CREDIT_FIXED_RATE_BLOCKS` says "at 60s blocks" outright. **The karma pair were the
> only constants on a 2-minute basis**, so at the block time the node actually runs they
> delivered **14 days and 12 hours — half their stated durations.** Decay bit twice as fast
> and twice as often as documented.
>
> ⚠ **Separately, 28 days is itself probably the wrong duration.** The economics design
> track calls for a **short, days-scale window — "e.g. ~5, not 28"** — so this correction
> fixes the *unit* while leaving the *value* open. Do not read `40320` as a decided number;
> it is the faithful translation of a figure that is itself pending the constants-pinning
> session. **Two independent problems, and only one is fixed here.**

### Post lock

```typescript
export const POST_LOCK_THREAD_COST = 5;           // Karma locked for new threads
export const POST_LOCK_REPLY_COST = 3;            // Karma locked for replies
export const POST_LOCK_UNLOCK_PER_LIKES = 10;     // Every N likes unlocks 1 karma
```

### Likes

```typescript
export const LIKE_KARMA_COST = 1n;             // Karma burned by the liker per like (bigint)
export const LIKES_PER_KARMA_PAYOUT = 5;       // x: per x likes an author accrues x−1; 1 burned
```

The four retired like constants (`LIKE_COST`, `LIKE_THRESHOLD`, `LIKE_MAX_AUTHOR_REWARD`,
`LIKE_FREE_THRESHOLD`) and the epoch (`EPOCH_BLOCKS`) are **deleted** — P2-D. Names
reserved; the deletion-proof grep for the old mechanics depends on them never returning.

### Invites

```typescript
export const MAX_PENDING_INVITES = 5;              // consensus — max concurrent unclaimed invites
export const INVITE_MIN_KARMA = KARMA_POSTING_MINIMUM;  // consensus
export const INVITE_KARMA_AMOUNT = 25n;            // consensus — karma carried by an InviteBox
export const INVITE_BOND_KARMA = 25n;              // consensus — bond locked during probation (was 10)
export const INVITE_PROBATION_BLOCKS = 1000;       // consensus — probation window in blocks
export const INVITE_KARMA_THRESHOLD = 20n;         // consensus — invitee target for early bond return
```

### Vouch

```typescript
export const VOUCH_KARMA_AMOUNT = 1n;              // consensus — karma escrowed per vouch
export const VOUCH_MIN_BALANCE = 11n;              // consensus — minimum balance to cast a vouch
export const VOUCH_COOLDOWN_BLOCKS = 60;           // consensus — blocks before escrow is released
```

### Genesis

```typescript
export const GENESIS_COMMITTEE_KEYS: string[] = [];        // consensus — TBD at genesis
export const GENESIS_KARMA_PER_MEMBER = 1000n;             // consensus
export const GENESIS_CREDITS_PER_MEMBER = 10000n * 10n ** 8n;  // consensus — 10000 credits in base units
export const BOOTSTRAP_PERIOD_BLOCKS = 10000;              // consensus — blocks before committee dissolution
```

### Mempool and encoding

```typescript
export const MEMPOOL_EXPIRY_BLOCKS = 720;          // local — blocks before mempool entries expire (~12h)
export const ED25519_SPKI_PREFIX = '302a300506032b6570032100';  // SPKI wrapper stripped from raw keys
```

### Credit emission (Ergo-style linear decay)

```typescript
export const CREDIT_FIXED_RATE_BLOCKS = 1_051_200;     // consensus — ~2 years at 60s blocks
export const CREDIT_INITIAL_REWARD = 100n * 10n ** 8n; // consensus — 100 credits/block, base units
export const CREDIT_EPOCH_BLOCKS = 129_600;            // consensus — ~90 days, reduction interval
export const CREDIT_REWARD_REDUCTION = 2n * 10n ** 8n; // consensus — 2 credits reduced per epoch
export const CREDIT_TAIL_REWARD = 2n * 10n ** 8n;      // ⚠ TO BE DELETED — see below
export const CREDIT_MINER_REWARD_DELAY = 720;          // consensus — blocks before coinbase spendable
export const CREDIT_TREASURY_PCT = 10;                 // consensus — percent of each reward to treasury
```

> ⚠ **Every value in this block was shown pre-P0 until 2026-08-06.** The BigInt rescale
> updated the Denomination prose above and left these literals at their unscaled values
> (`100`, `2`, `2`) — and the literals are what people copy. Same defect in the Invite,
> Vouch and Genesis blocks, now corrected.

> ⚠ **`CREDIT_TAIL_REWARD` is being removed.** Emission **terminates** — the authoritative
> docs state credits are "issued on a schedule that tapers toward a fixed cap … instead of
> inflating forever," with the perpetual security budget coming from **fees and storage
> rent**, which are recycled rather than minted. The reward function must end
> `return max(reward, 0)`; today it floors at `CREDIT_TAIL_REWARD` and mints 2 credits per
> block indefinitely. Note the constant equals exactly what decay epoch 49 already pays, so
> the "tail" was never a distinct phase — only a floor stopping the curve reaching zero.
> **`MINING_INTERFACE.md`'s emission table and its total-supply figure both change; do not
> copy any current total-supply number.**

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
