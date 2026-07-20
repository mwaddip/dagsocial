# NODE Interface Contract

**Component:** `@dagsocial/node`
**Status:** Implemented (Phase 1)
**Protocol version:** 1

## Scope

HTTP server exposing the DAGsocial API. Owns: PoW service, post verifier, slot lifecycle, block creator, demo UI, and persistent storage. Depends on `@dagsocial/types` for all shared structures and constants.

## HTTP API

Base URL: `http://{host}:{port}` (default: `localhost:3000`)
All responses are JSON. Request/response schemas reference types from `@dagsocial/types`.

### Identity

| Method | Path | Request | Response (200/201) | Errors |
|--------|------|---------|-------------------|--------|
| `POST` | `/identity` | `{}` | `{ userId, publicKey }` (201) | — |
| `POST` | `/identity/import` | `{ publicKey: hex }` | `{ userId, publicKey }` (201 or 200 if exists) | 400 if key not 32 bytes |
| `GET` | `/identity/:userId` | — | `{ userId, publicKey, createdAt }` | 404 |

**Invariant:** Secret key never appears in any response body.

### Slots

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/slots/request` | `{ userId }` | `{ challenge, targetBits }` | 400 if missing `userId` |
| `POST` | `/slots/claim` | `{ userId, challenge, nonce }` | `{ token: SlotToken }` | 400 if invalid/expired PoW |

**Invariant:** One active slot per user. Requesting a new slot invalidates the previous one. Slot validity is in block height: expires at `issuedAtBlock + slotWindowBlocks`. Slot claims verify PoW at `config.pow.slotTargetBits`.

### Posts

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/posts` | Post object (JSON) | `{ id, status: "pending" }` (201) | 400 on validation failure |
| `GET` | `/posts/:id` | — | Post object | 404 |
| `GET` | `/posts` | `?author=&limit=50&offset=0` | Post[] (confirmed only) | — |

**Post submission flow:**
1. Validate all required fields present (content, author, slotHash, powNonce, protocolVersion, timestamp, signature)
2. `verifyPost(post, currentBlockHeight)` — see Verifier contract below
3. Compute `id = computePostId(post)` — server-authoritative
4. Store post as pending (`raw_cbor` = CBOR-encoded full post)
5. Consume slot token
6. Signal block creator
7. Return `{ id, status: "pending" }`

**Content limit:** `content.length` must be 1–300 UTF-8 bytes. Reject with 400 otherwise.

**Protocol version:** Reject posts with unsupported `protocolVersion`.

### Blocks

| Method | Path | Response | Errors |
|--------|------|----------|--------|
| `GET` | `/blocks/:height` | Block object | 400 if NaN, 404 |

### Status

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/status` | `{ blockHeight, postCount, pendingPosts, identityCount }` |

### Static

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/` | Demo UI (`public/index.html`) |

## Verifier Contract

`verifyPost(post: Post, currentBlockHeight: number): { valid: boolean; error?: string }`

Verification order (fail-fast):
1. **Slot token** — must exist in store, belong to `post.author`, not consumed, `expiresAtBlock ≥ currentBlockHeight`
2. **Phase 2 PoW** — `verifyPoW(powInput, post.powNonce, submitTargetBits)` where `powInput = content || author || parents || slotHash || timestamp`
3. **Signature** — `crypto.verify(null, signingHash(post), pubKeyObj, sigBuf)` with raw Ed25519
4. **Parent refs** — each `parentId` must exist as a confirmed post (skip for genesis/empty parents)
5. **Content limit** — reject if content > `MAX_CONTENT_BYTES` (300)
6. **Protocol version** — reject if unsupported

## Block Creator Contract

`startBlockCreator()` / `stopBlockCreator()` / `onPostReceived()`

- **Timer-driven:** every `BLOCK_INTERVAL_MS` (default 30s), attempt to create a block from pending posts
- **Post-count-driven:** when `pendingPosts ≥ BLOCK_INTERVAL_POSTS` (default 1), create block immediately
- Block creation takes up to `MAX_POSTS_PER_BLOCK` (default 100) pending posts, confirms each, assigns `block_height`, writes `blocks` + `block_posts` rows
- Returns `null` if no pending posts
- `onPostReceived()` is called by the posts route after inserting a pending post

## Store Interface

Storage backends implement this interface. SQLite is the Phase 1 backend.

### Database lifecycle
| Function | Signature | Description |
|----------|-----------|-------------|
| `initDb(path)` | `(string) => void` | Initialize backend, run migrations, enable WAL (if applicable) |
| `getDb()` | `() => BackendHandle` | Return backend handle, throw if not initialized |
| `closeDb()` | `() => void` | Graceful shutdown |

### Identities
| Function | Signature |
|----------|-----------|
| `insertIdentity(userId, keyPair)` | `(UserId, KeyPair) => void` |
| `getIdentity(userId)` | `(UserId) => { userId, publicKey, createdAt } \| null` |

### Slots
| Function | Signature |
|----------|-----------|
| `insertSlot(token, challenge)` | `(SlotToken, string) => void` |
| `getValidSlot(userId, tokenHash)` | `(UserId, string) => SlotToken \| null` |
| `consumeSlot(userId, tokenHash)` | `(UserId, string) => void` |

### Posts
| Function | Signature |
|----------|-----------|
| `insertPendingPost(post, rawCbor)` | `(Post, Buffer) => void` |
| `getPost(id)` | `(string) => Post \| null` |
| `queryPosts({ author?, limit, offset })` | `(QueryOpts) => Post[]` — confirmed only, newest first |
| `getPendingPosts(limit)` | `(number) => Post[]` — oldest first |
| `confirmPost(postId, blockHeight)` | `(string, number) => void` |
| `getParentRefs(postId)` | `(string) => string[]` |

### Blocks
| Function | Signature |
|----------|-----------|
| `createBlock()` | `() => Block \| null` |
| `getBlock(height)` | `(number) => Block \| null` |
| `getCurrentHeight()` | `() => number` |

## Configuration

All config via environment variables with defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `DB_PATH` | `dagsocial.db` | SQLite database path |
| `POW_SLOT_TARGET_BITS` | `20` | Phase 1 PoW difficulty |
| `POW_SUBMIT_TARGET_BITS` | `8` | Phase 2 PoW difficulty |
| `POW_SLOT_WINDOW_BLOCKS` | `100` | Slot validity in blocks |
| `BLOCK_INTERVAL_MS` | `30000` | Max time between blocks |
| `BLOCK_INTERVAL_POSTS` | `1` | Posts per block trigger |
| `MAX_POSTS_PER_BLOCK` | `100` | Max posts per block |

## Preconditions
- Node.js ≥ 22
- `@dagsocial/types` package built and importable
- `better-sqlite3` native bindings built (Phase 1 backend)
- Write access to `DB_PATH` directory
- Port available at `PORT`

## Postconditions
- HTTP server listening on `:PORT`
- Database file created with full schema at `DB_PATH`
- Block creator running (timer + counter)
- Demo UI served at `/`
- All HTTP endpoints respond per this contract

## Invariants
- Secret keys never in API responses — `GET /identity/:userId` selects only `user_id, public_key, created_at`
- `raw_cbor` is the canonical authority for post content; parsed columns are derivative
- `post.id` is computed server-side via `computePostId()` — client-submitted IDs are ignored
- Content length limit enforced at the API boundary (before storage)
- Protocol version checked at verification; unsupported versions rejected
- Consumers call the Store interface, never the backend directly
- `protocolVersion` present on all new posts and blocks
