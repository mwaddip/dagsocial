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

---

## UTXO Types (`utxo.ts`)

### BoxId

```
BoxId = string  // blake2b512(canonicalCbor(box)).subarray(0,32).toString('hex')
```

All box types share a common envelope:

```
interface BoxBase {
  id?: BoxId           // Computed via computeBoxId; optional during construction
  boxType: "karma" | "credit" | "like" | "invite" | "bond" | "post_lock" | "vouch"
  value: number
  createdAtBlock: number
}
```

Box identity is deterministic: `computeBoxId` encodes the box (minus its `id`
field) as canonical CBOR, hashes with blake2b512, and takes the first 32 bytes
as a hex string.

### KarmaBox

```
KarmaBox extends BoxBase {
  boxType: "karma"
  owner: Uint8Array            // 32 raw bytes — Ed25519 public key
  guard: "owner_signature"     // Only owner may spend
  proofSource: string          // PostId | StumpHash | InviteTxId
  lastTouchBlock: number       // = createdAtBlock on creation
}
```

Karma boxes are non-tradeable. They can only be consumed by the owner to:
- Create invite boxes
- Create like boxes
- Create a new karma box for the same owner (balance change, resets activity clock)
- Create a post lock box (when posting)

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
  value: 2                     // LIKE_COST — always 2
  likerId: UserId
  targetPostId: PostId
  guard: "epoch_tally"         // Locked until epoch tally. Consumed by ordering block processor.
}
```

### InviteBox

```
InviteBox extends BoxBase {
  boxType: "invite"
  value: number                       // N karma transferred
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
  value: number                       // D karma deposited
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
  value: number                // Current locked karma (decreases each epoch as likes accumulate)
  originalValue: number        // Initial lock amount (POST_LOCK_THREAD_COST or POST_LOCK_REPLY_COST)
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
  value: 1                     // VOUCH_KARMA_AMOUNT — always 1
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
  inputs: BoxId[]               // Boxes consumed
  outputs: AnyBox[]             // Boxes created (AnyBox = KarmaBox | CreditBox | LikeBox | InviteBox | BondBox | PostLockBox)
  signatures: Record<string, Uint8Array>  // publicKey (hex) → Ed25519 sig (64 bytes)
  protocolVersion: number       // 1
}

TxId = blake2b512(inputs || serializedOutputs || protocolVersion)
       .subarray(0, 32).toString('hex')
```

Transaction signatures are over the transaction hash (`computeTxId`), not over
domain messages. The signer signs `TxId` with their Ed25519 key; verifiers
recompute the hash and check the signature.

### Functions

| Export | Signature | Description |
|--------|-----------|-------------|
| `computeBoxId(box)` | `(Omit<BoxBase, 'id'>) => BoxId` | Deterministic box ID from canonical CBOR |
| `computeTxId(tx)` | `(UtxoTransaction) => TxId` | Deterministic transaction ID |

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

### Ordering block

```
OrderingBlock {
  height: number                   // Monotonically increasing, starting from 1
  hash: string                     // blake2b512(serializeBlock(...)).subarray(0,32).toString('hex')
  prevBlockHash: string            // Previous ordering block hash (64 hex)
  subBlockRefs: PostId[]           // Sub-blocks anchored by this block
  likeBoxIds: BoxId[]              // Standalone likes (no sub-block to ride)
  utxoTxIds: TxId[]                // UTXO transactions in this block
  pruneEntries: PruneEntry[]      // Prune entries committed in this block
  validatorId: UserId              // Block producer
  validatorSignature: Uint8Array(64)  // Ed25519 over body hash
  powNonce: number                 // PoW solution
  powTargetBits: number            // Difficulty target for this block
  coinbaseOutputs: CoinbaseOutput[] // Block reward distribution
  epochTallyResults?: EpochTally   // Present if epoch transition triggered
  protocolVersion: number          // 1
  createdAt: number                // Unix ms
}
```

### Coinbase output

```
CoinbaseOutput {
  owner: UserId              // 32-byte recipient public key
  value: number              // Credits minted
  lockedUntilBlock: number   // Height at which credits become spendable
  isTreasury: boolean        // Treasury or miner output
}
```

### Epoch tally

```
EpochTally {
  rewards: Record<PostId, LikeReward>
}

LikeReward {
  targetPostId: PostId
  likeCount: number
  authorReward: number
  likerRefunds: Record<string, number>  // likerId → net karma refund
  postLockKarmaUnlocked?: number         // Karma released from post lock this epoch
}
```

---

## Serialization (`serialization.ts`)

All wire format is CBOR via `cbor-x`. HTTP API is JSON. Signatures and public
keys are hex-encoded on wire (HTTP JSON); raw bytes in CBOR.

| Export | Signature | Description |
|--------|-----------|-------------|
| `serializeBox(box)` | `(BoxBase) => Uint8Array` | Canonical CBOR encode for box identity |
| `serializeTx(tx)` | `(UtxoTransaction) => Uint8Array` | Canonical CBOR encode for tx identity |
| `encodePost(post)` | `(Post) => Uint8Array` | CBOR encode |
| `decodePost(bytes)` | `(Uint8Array) => Post` | CBOR decode |
| `encodeStump(stump)` | `(Stump) => Uint8Array` | CBOR encode |
| `decodeStump(bytes)` | `(Uint8Array) => Stump` | CBOR decode |
| `encodeSubBlock(sb)` | `(SubBlock) => Uint8Array` | CBOR encode |
| `decodeSubBlock(bytes)` | `(Uint8Array) => SubBlock` | CBOR decode |
| `encodeOrderingBlock(b)` | `(OrderingBlock) => Uint8Array` | CBOR encode |
| `decodeOrderingBlock(bytes)` | `(Uint8Array) => OrderingBlock` | CBOR decode |
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
- Box identity is deterministic: `blake2b512(canonicalCbor(box)).subarray(0,32)`
- Post identity includes PoW nonce; signing hash excludes it
- Sub-block identity IS post identity (they are the same object)
- `UserId` IS the 32-byte Ed25519 public key — no hashing, no separate account concept
