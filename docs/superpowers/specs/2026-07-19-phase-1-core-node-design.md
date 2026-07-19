# DAGsocial Phase 1 — Core Node Design

**Date:** 2026-07-19
**Status:** Approved
**Scope:** Local HTTP node with identity, two-phase PoW, DAG store, block creation, read API. No networking, no tokens, no governance.

## Stack

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Runtime | Node.js 18+ | Ecosystem depth, `js-libp2p` compatibility for Phase 2 |
| Language | TypeScript | Shared types across node and future web client |
| Signing | `crypto.sign` / `crypto.verify` (Ed25519, built-in) | Zero deps, available since Node 12 |
| Hashing | `crypto.createHash` (blake2b256, sha256, built-in) | Zero deps, available since Node 18 |
| PoW | blake2b hashcash (built-in) | Simplest thing that proves the two-phase protocol; swappable to Equihash later |
| HTTP | Express | Stable, boring, well-known |
| SQLite | `better-sqlite3` | Fastest Node binding, synchronous API |
| Serialization | `cbor-x` (CBOR) | Spec calls for CBOR; fast implementation |
| Testing | Vitest | Fast, native TypeScript, watch mode |
| Monorepo | pnpm workspaces | Strict dependency boundaries |
| Build | `tsup` | Fast, ESM + CJS + `.d.ts` output |

## Package Structure

```
dagsocial/
├── pnpm-workspace.yaml
├── package.json                  # root scripts, devDeps
├── tsconfig.base.json
├── packages/
│   ├── types/                    # @dagsocial/types
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── identity.ts       # KeyPair, UserId, generateKeyPair
│   │       ├── post.ts           # Post, SlotToken, Block
│   │       ├── serialization.ts  # CBOR encode/decode
│   │       └── index.ts
│   └── node/                     # @dagsocial/node
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── server.ts         # Express app
│           ├── routes/
│           │   ├── identity.ts   # POST /identity, GET /identity/:id
│           │   ├── slots.ts      # POST /slots/request, POST /slots/claim
│           │   └── posts.ts      # POST /posts, GET /posts/:id, GET /posts
│           ├── services/
│           │   ├── pow.ts        # blake2b solve() and verify()
│           │   ├── slots.ts      # Slot lifecycle management
│           │   └── verifier.ts   # Post validation pipeline
│           └── store/
│               ├── db.ts         # SQLite connection, migrations
│               ├── posts.ts      # Post CRUD, queries
│               ├── blocks.ts     # Block creation, queries
│               └── slots.ts      # Token persistence
```

## Data Model

### Identity

```typescript
interface KeyPair {
  publicKey: Uint8Array;   // 32 bytes
  secretKey: Uint8Array;   // 64 bytes (seed + pub)
}

type UserId = string;  // base58btc(blake2b256(publicKey))
```

Generated via `crypto.generateKeyPairSync('ed25519')`. The public key IS the identity. No usernames or display names in Phase 1.

### SlotToken

```typescript
interface SlotToken {
  userId: UserId;
  issuedAtBlock: number;    // block height when slot was issued
  expiresAtBlock: number;   // issuedAtBlock + slotWindow (default: 100 blocks)
  nonce: number;            // the nonce that satisfied PoW
  hash: string;             // blake2b256(userId || challenge || nonce), hex
}
```

Only one active slot per user. Requesting a new slot invalidates the old one.
Slot validity is measured in block height — not wall clock time.

### Post

```typescript
interface Post {
  id: string;               // blake2b256(raw CBOR bytes)
  content: string;          // plain text (no rich media in Phase 1)
  author: UserId;
  parentRefs: string[];     // 1-8 post IDs, must be confirmed posts
  slotToken: SlotToken;     // consumed slot token
  powNonce: number;         // Phase 2 PoW nonce
  timestamp: number;        // unix ms (claimed by author)
  signature: string;        // Ed25519 signature (base58btc)
  status: 'pending' | 'confirmed';
  blockHeight?: number;     // set when included in a block
}
```

### Block

```typescript
interface Block {
  height: number;
  hash: string;             // blake2b256(concatenated post IDs)
  postCount: number;
  posts: string[];          // ordered post IDs
  createdAt: number;        // unix ms
}
```

## Two-Phase PoW Protocol

Both phases use blake2b hashcash: find a nonce where `blake2b(input || nonce)` produces a hash with at least N leading zero bits.

### Phase 1: Slot Request (heavy)

1. Client calls `POST /slots/request` with `{ userId }`
2. Server returns `{ challenge: string, targetBits: number }`
   - `challenge` = `blake2b(userId || currentBlockHeight || randomSalt)`, hex-encoded
   - `targetBits` = configurable (default: 20)
3. Client finds nonce where `blake2b(challenge || nonce)` has ≥ targetBits leading zeros
4. Client calls `POST /slots/claim` with `{ userId, challenge, nonce }`
5. Server verifies, issues a `SlotToken` bound to userId
6. Token is valid for `slotWindow` blocks (default: 100)

### Phase 2: Post Submission (light)

1. Client constructs the post (content, author, parentRefs, slotToken, timestamp)
2. Client signs `blake2b(content || author || parents || slotHash || timestamp)` with secret key
3. Client finds powNonce where `blake2b(content || author || parents || slotHash || timestamp || nonce)` has ≥ submitTargetBits leading zeros (default: 8)
4. Client sends complete signed Post to `POST /posts`

### Server-side Verification Order

1. Signature valid for claimed author
2. Slot token exists, not expired, not consumed, belongs to author
3. Phase 2 PoW nonce valid
4. All parentRefs exist in DAG as confirmed posts
5. Insert post as pending, mark slot consumed

### Configuration

```typescript
interface PoWConfig {
  slotTargetBits: number;       // default: 20
  submitTargetBits: number;     // default: 8
  slotWindowBlocks: number;     // default: 100
}
```

All adjustable via environment variables: `POW_SLOT_TARGET_BITS`, `POW_SUBMIT_TARGET_BITS`, `POW_SLOT_WINDOW_BLOCKS`.

## HTTP API

All responses are JSON. CBOR is the internal/wire format for Phase 2+ interop.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/identity` | Create new Ed25519 identity |
| `GET`  | `/identity/:userId` | Get identity details |
| `POST` | `/slots/request` | Request a PoW challenge |
| `POST` | `/slots/claim` | Submit PoW solution, get slot token |
| `POST` | `/posts` | Submit a signed post |
| `GET`  | `/posts/:id` | Get a specific post |
| `GET`  | `/posts` | Feed query (`?author=&limit=&offset=`) |
| `GET`  | `/blocks/:height` | Get block by height |
| `GET`  | `/status` | Node info (blockHeight, postCount, pendingPosts) |

## Storage Schema

All tables in a single SQLite file (`dagsocial.db`).

```sql
CREATE TABLE identities (
  user_id      TEXT PRIMARY KEY,
  public_key   BLOB NOT NULL,
  secret_key   BLOB NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE slots (
  user_id      TEXT NOT NULL,
  challenge    TEXT NOT NULL,
  nonce        INTEGER NOT NULL,
  token_hash   TEXT NOT NULL,
  issued_at    INTEGER NOT NULL,    -- block height
  expires_at   INTEGER NOT NULL,
  consumed     INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, token_hash)
);

CREATE TABLE posts (
  id           TEXT PRIMARY KEY,
  content      TEXT NOT NULL,
  author       TEXT NOT NULL REFERENCES identities(user_id),
  slot_hash    TEXT NOT NULL,
  pow_nonce    INTEGER NOT NULL,
  signature    TEXT NOT NULL,
  status       TEXT DEFAULT 'pending',
  block_height INTEGER,
  created_at   INTEGER NOT NULL,
  raw_cbor     BLOB NOT NULL
);

CREATE TABLE post_parents (
  post_id      TEXT NOT NULL REFERENCES posts(id),
  parent_id    TEXT NOT NULL REFERENCES posts(id),
  PRIMARY KEY (post_id, parent_id)
);

CREATE TABLE blocks (
  height       INTEGER PRIMARY KEY AUTOINCREMENT,
  hash         TEXT NOT NULL,
  post_count   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE block_posts (
  block_height INTEGER NOT NULL REFERENCES blocks(height),
  post_id      TEXT NOT NULL REFERENCES posts(id),
  position     INTEGER NOT NULL,
  PRIMARY KEY (block_height, post_id)
);

CREATE INDEX idx_posts_confirmed ON posts(block_height, created_at) WHERE status = 'confirmed';
CREATE INDEX idx_posts_author ON posts(author, created_at);
```

### Why `raw_cbor`

The original CBOR bytes are stored alongside parsed columns. This enables re-verification without trusting parsed data and schema migration by re-deriving from canonical bytes.

## Block Creation

In Phase 1, block creation runs in-process with a timer + counter:

- Trigger: every `BLOCK_INTERVAL_MS` (default: 30000) OR every `BLOCK_INTERVAL_POSTS` (default: 1) pending posts
- Takes up to `MAX_POSTS_PER_BLOCK` (default: 100) pending posts
- Confirms each, assigns `block_height`, inserts into `blocks` and `block_posts`

Phase 1 default of `BLOCK_INTERVAL_POSTS=1` means every post is its own block. This keeps the block structure in place while the DAG height ticks with every post. Increasing it later to batch posts changes only the interval, not the data model.

## Testing

### Unit Tests

- **pow.test.ts** — solve()/verify() correctness, target bits vs solve time linearity, determinism
- **verifier.test.ts** — signature check, slot expiry, slot consumption, PoW validity, parent ref existence
- **slots.test.ts** — challenge issuance, valid/invalid claim, expiry, re-request invalidation

### Integration Tests

- **api.test.ts** — full flow: identity → slot request → claim → post → confirm → feed read
- **store.test.ts** — CRUD operations, block creation, feed queries with limit/offset

Out of scope: concurrency testing, performance/load testing, `@dagsocial/types` (pure types, nothing to test).

## Out of Scope (Phase 2+)

- Networking / peer discovery (libp2p)
- Multi-validator consensus
- Karma scoring and decay
- Currency minting and token economy
- Governance (DReps, Constitutional Committee, validator voting)
- Invite system (stake, lock period, bonuses)
- Advertiser integration
- Dynamic PoW difficulty adjustment
- DAG pruning and archival
- Mobile apps
- Equihash PoW algorithm (swap from blake2b when ASIC-resistance matters)

## Design Decisions Captured

- **TypeScript over Rust** for Phase 1–2: shared types between node and web client, faster iteration
- **blake2b PoW over Equihash**: zero-dependency placeholder; swap when ASIC-resistance matters
- **Block height instead of wall clock** for slot expiry: DAG-native time, no clock sync required
- **Block concept from Phase 1** even though single post per block: data model forward-compatible with multi-validator block batching
- **Monorepo from start**: `@dagsocial/types` shared between node and future web client
- **Full test coverage from start**: unit + integration, vitest
- **Express over hono/built-in**: boring, stable, zero surprises
- **Node.js `crypto` built-in for Ed25519 and hashing**: zero dependencies, production-grade since Node 12/18
