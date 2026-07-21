# TYPES Interface Contract

**Component:** `@dagsocial/types`
**Protocol version:** 1 (Phase 2 design — will be 2 when implemented)
**Last updated:** 2026-07-20

## Scope

Shared data structures, serialization, base58 encoding, hash functions, and
protocol constants for Phase 2. Pure functions only — no side effects, no I/O,
no imports from other DAGsocial packages.

All Phase 1 types are superseded. The Phase 1 implementation remains importable
under protocol version 1 but Phase 2 code imports this contract.

---

## Identity (`identity.ts`)

Carried forward from Phase 1, unchanged:

| Export | Signature | Description |
|--------|-----------|-------------|
| `KeyPair` | `{ publicKey: Uint8Array(32), secretKey: Uint8Array }` | Ed25519 keypair (public: 32 raw bytes, secret: PKCS8 DER) |
| `UserId` | `string` | `base58btc(blake2b512(publicKey))` — no truncation |
| `generateKeyPair()` | `() => KeyPair` | Node `crypto.generateKeyPairSync('ed25519')` |
| `getUserId(pub)` | `(Uint8Array) => UserId` | Deterministic, full 64-byte hash |

---

## Core Types (`post.ts`)

### Post

```
Post {
  content: string              // 1–MAX_CONTENT_BYTES UTF-8
  author: UserId
  parentRefs: PostId[]         // 0–MAX_PARENT_REFS
  challenge: Uint8Array(32)    // Random nonce from node (anti-precomputation)
  powNonce: number             // PoW solution against challenge
  protocolVersion: number      // 2
  timestamp: number            // Unix ms
  signature: Uint8Array(64)    // Ed25519 over signingHash(post)
}

PostId = blake2b512(content || author || parentRefs || challenge || powNonce || protocolVersion || timestamp)
         .subarray(0, 32).toString('hex')
```

### Profile posts

Special `type` field for posts that carry identity metadata:

```
ProfileRoot = Post & { type: "profile" }       // content="" , parentRefs=[]
BioPost     = Post & { type: "bio" }           // parentRefs=[profileRootId]
NamePost    = Post & { type: "display_name" }  // parentRefs=[profileRootId]
AvatarPost  = Post & { type: "avatar" }        // parentRefs=[profileRootId]
UsernameClaim = Post & { type: "username_claim"; claim: string }  // e.g. "@alice"
```

The `type` field is embedded in `content` as a JSON object. The post's
structural type is identified by a discriminator in content.

### Hashing functions

| Export | Signature | Description |
|--------|-----------|-------------|
| `signingHash(post)` | `(Post) => Uint8Array(32)` | `blake2b512(content \|\| author \|\| parentRefs \|\| challenge \|\| protocolVersion \|\| timestamp).subarray(0,32)` — what the author signs |
| `computePostId(post)` | `(Post) => PostId` | `blake2b512(content \|\| author \|\| parentRefs \|\| challenge \|\| powNonce \|\| protocolVersion \|\| timestamp).subarray(0,32).toString('hex')` |

`sigPowNonce` is intentionally excluded from `signingHash` — the author signs
before finding the PoW nonce. It is included in `computePostId` to ensure
uniqueness.

---

## UTXO Types (`utxo.ts`)

### BoxId

```
BoxId = string  // blake2b512(serializedBoxBytes).subarray(0,32).toString('hex')
```

All box types share a common envelope:

```
interface BoxBase {
  id: BoxId
  boxType: "karma" | "credit" | "like" | "invite" | "bond"
  value: number
  createdAtBlock: number
}
```

### KarmaBox

```
KarmaBox extends BoxBase {
  boxType: "karma"
  owner: PublicKey                // 32 raw bytes
  guard: "owner_signature"        // Only owner may spend
  proofSource: string             // PostId | StumpHash | InviteTxId

  // Karma-specific: last activity block for decay
  lastTouchBlock: number          // = createdAtBlock on creation
}
```

Karma boxes are non-tradeable. They can only be consumed by the owner to:
- Create invite boxes
- Create like boxes
- Create a new karma box for the same owner (balance change, resets decay clock)

### CreditBox

```
CreditBox extends BoxBase {
  boxType: "credit"
  owner: PublicKey
  guard: "owner_signature"
  proofSource: number              // Ordering block height that minted these credits
}
```

Credits are freely transferable between any accounts.

### LikeBox

```
LikeBox extends BoxBase {
  boxType: "like"
  value: 2                         // LIKE_COST — always 2
  likerId: UserId
  targetPostId: PostId
  // Locked until epoch tally. No owner guard — consumed by ordering block processor.
  guard: "epoch_tally"
}
```

### InviteBox

```
InviteBox extends BoxBase {
  boxType: "invite"
  value: number                    // N karma transferred
  secretHash: Uint8Array(32)       // H(s) — blake2b512(s).subarray(0,32)
  inviterId: UserId
  guard: "hash_preimage"           // H(s_preimage) == secretHash ∧ recipient pubkey not in ledger
  // Also: cancellable by inviter's signature (co-guard)
}
```

### BondBox

```
BondBox extends BoxBase {
  boxType: "bond"
  value: number                    // D karma deposited
  inviterId: UserId                // Owner — Alice
  inviteePublicKey?: PublicKey     // Set when invite is claimed (Bob's key)
  probationStartBlock?: number     // Set when invite is claimed
  probationEndBlock?: number       // probationStartBlock + INVITE_PROBATION_BLOCKS
  guard: "inviter_signature"       // Only inviter may reclaim (after conditions met)

  // Unlock conditions (evaluated at consumption time):
  // 1. invitee.karma >= INVITE_KARMA_THRESHOLD within probation → inviter reclaims
  // 2. invitee.karma < KARMA_POSTING_MINIMUM during probation → burned
  // 3. block >= probationEndBlock → inviter reclaims
}
```

### UtxoTransaction

```
UtxoTransaction {
  inputs: BoxId[]                  // Boxes consumed
  outputs: (KarmaBox | CreditBox | LikeBox | InviteBox | BondBox)[]  // Boxes created
  signatures: { [publicKey: string]: Uint8Array(64) }  // Ed25519 sigs authorizing each input
  protocolVersion: number          // 2
}

TxId = blake2b512(serializeTx(inputs || outputs || protocolVersion))
       .subarray(0, 32).toString('hex')
```

### Box identity

| Export | Signature | Description |
|--------|-----------|-------------|
| `computeBoxId(box)` | `(BoxBase) => BoxId` | `blake2b512(serializeBox(box)).subarray(0,32).toString('hex')` |

Box identity is deterministic — same box bytes = same ID. Box serialization
is canonical (sorted fields, fixed-length encoding).

---

## Stump Types (`stump.ts`)

```
PruneIntent {
  rootPostHash: PostId
  trigger: "author" | "drep" | "storage_prune"
  authorId: UserId
  signature: Uint8Array(64)        // Ed25519 from root author's key
}

Stump {
  rootPostHash: PostId
  subtreeMerkleRoot: Uint8Array(32)  // Merkle root over all pruned posts
  authorId: UserId
  pruneSignature: Uint8Array(64)     // From PruneIntent

  karmaDeltas: KarmaDelta[]
  replyCount: number
  upvoteCount: number

  trigger: "author" | "drep" | "storage_prune"
  protocolVersion: number            // PROTOCOL_VERSION (1, will be 2 when implemented)
  compactedAtBlockHeight: number
}

KarmaDelta {
  userId: UserId
  delta: number
}

StumpId = blake2b512(rootPostHash || compactedAtBlockHeight || authorId)
          .subarray(0, 32).toString('hex')
```

---

## Block Types (`block.ts`)

### Sub-block

```
SubBlock {
  subBlockId: string               // = post.postId (the post IS the sub-block)
  post: Post                       // The post (with PoW = sub-block proof)
  likeBoxes: LikeBox[]             // Pending likes riding as sidecars
  producerId: UserId               // = post.author
  protocolVersion: number          // 2
}

SubBlockId = computePostId(post)   // The sub-block is identified by its post
```

Sub-blocks are user-produced. A sub-block carries exactly one post plus any
pending like boxes queued since the last sub-block.

### Ordering block

```
OrderingBlock {
  height: number                   // Monotonically increasing, starting from 1
  hash: string                     // blake2b512(serializeBlock(...)).subarray(0,32).toString('hex')
  prevBlockHash: string            // Previous ordering block hash
  subBlockRefs: SubBlockId[]       // Sub-blocks anchored by this block
  likeBoxIds: BoxId[]              // Standalone likes (no sub-block to ride)
  utxoTxIds: TxId[]                // UTXO transactions in this block
  stumpIds: StumpId[]              // Stumps committed in this block
  validatorId: UserId              // Block producer
  validatorSignature: Uint8Array(64)  // Ed25519 over block hash
  epochTallyResults?: EpochTally   // Present if epoch transition triggered
  protocolVersion: number          // 2
  createdAt: number                // Unix ms
}

EpochTally {
  rewards: { [postId: string]: LikeReward }
}

LikeReward {
  targetPostId: PostId
  likeCount: number
  authorReward: number
  likerRefunds: { [likerId: string]: number }  // Net karma refund per liker
}
```

---

## Serialization (`serialization.ts`)

All wire format is CBOR via `cbor-x`. HTTP API is JSON. Signatures and public
keys are base64-encoded on wire (HTTP JSON); raw bytes in CBOR.

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

Carried forward from Phase 1, unchanged:

| Export | Signature | Description |
|--------|-----------|-------------|
| `base58Encode(buf)` | `(Uint8Array) => string` | Bitcoin-style base58 (alphabet: `123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`) |
| `base58Decode(str)` | `(string) => Uint8Array` | Throws on invalid characters |

---

## Protocol Constants (`constants.ts`)

### Version

```typescript
export const PROTOCOL_VERSION = 1;  // Incremented when Phase 2 is implemented
```

### Content limits (carried forward)

```typescript
export const MAX_CONTENT_BYTES = 300;
export const MAX_PARENT_REFS = 8;
```

### PoW

```typescript
export const POST_POW_TARGET_BITS = 20;    // Difficulty (higher = harder)
export const CHALLENGE_WINDOW_BLOCKS = 10;  // Blocks before challenge expires
```

### Karma

```typescript
export const KARMA_POSTING_MINIMUM = 1;      // Minimum karma to post
export const KARMA_DECAY_RATE = 0.0001;      // Fraction per block after grace
export const KARMA_DECAY_GRACE_BLOCKS = 100;  // Blocks before decay starts
export const KARMA_FLOOR = 0;                // Minimum retained (0 = no floor)
```

### Likes

```typescript
export const LIKE_COST = 2;               // Karma locked to cast a like
export const LIKE_THRESHOLD = 5;          // Absolute like count per multiplier step
export const LIKE_MAX_AUTHOR_REWARD = 10; // Max karma an author earns per post
export const LIKE_FREE_THRESHOLD = 10;    // 10x LIKE_THRESHOLD; beyond this, likes are free
```

### Epoch

```typescript
export const EPOCH_BLOCKS = 60;           // Like processing every N ordering blocks
```

**Like refund schedule** (per liker, computed at epoch):

| Total likes on post | Refund | Effect |
|---------------------|--------|--------|
| < 2× LIKE_THRESHOLD (10) | 0 | Locked like stays locked, rolls over to next epoch |
| ≥ 2× (10+ on locked, 50+ total) | 2 (full) | Like box consumed, 2 karma returned to liker |

Locked karma is never burned. It stays locked until enough likes accumulate.

- Likes 1–50 on a post: 2 karma locked in LikeBox (UTXO, `epoch_tally` guard).
  Refunded at epoch boundary per schedule above.
- Likes 51+: free — recorded as `dag_likes` row (no karma lock). Only gate:
  liker has karma > 0.
- One like per account per post. Enforced at service layer.
- Author reward unchanged: `min(floor(totalLikes / LIKE_THRESHOLD), LIKE_MAX_AUTHOR_REWARD)`.
  Total includes both locked and free likes.

### Invites

```typescript
export const MAX_PENDING_INVITES = 5;          // Max concurrent unclaimed invites per account
export const INVITE_MIN_KARMA = KARMA_POSTING_MINIMUM;
export const INVITE_BOND_KARMA = 10;           // Karma deposit locked during probation
export const INVITE_PROBATION_BLOCKS = 1000;   // Probation window in blocks
export const INVITE_KARMA_THRESHOLD = 20;      // Invitee karma target for early bond return
```

### Genesis

```typescript
// Genesis committee public keys (hex-encoded, 32 bytes each)
export const GENESIS_COMMITTEE_KEYS: string[] = [];  // TBD at genesis
export const GENESIS_KARMA_PER_MEMBER = 1000;
export const GENESIS_CREDITS_PER_MEMBER = 10000;
export const BOOTSTRAP_PERIOD_BLOCKS = 10000;  // Blocks before committee dissolution
```

### Validators

```typescript
export const ORDERING_BLOCK_REWARD_CREDITS = 100;
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
- Phase 1 exports remain available under protocol version 1 (separate entry
  point or re-export with deprecation)

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
