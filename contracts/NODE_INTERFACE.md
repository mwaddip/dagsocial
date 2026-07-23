# NODE Interface Contract

**Component:** `@dagsocial/node`
**Protocol version:** 2
**Last updated:** 2026-07-23

## Scope

HTTP server exposing the DAGsocial API. Owns: PoW challenge service, post
verifier (Stage 2 stateful validation), sub-block assembly, UTXO engine,
like processing, invite lifecycle, ordering block creator, stump engine,
and persistent storage (SQLite). Depends on:

- `@dagsocial/types` — shared data structures and constants
- `@dagsocial/validation` — Stage 1 stateless checks (PoW, signatures,
  structural validity)
- `@dagsocial/net` — libp2p networking for sub-block, ordering block,
  and UTXO transaction gossip

---

## HTTP API

Base URL: `http://{host}:{port}` (default: `localhost:3000`)
All responses are JSON. Binary fields (signatures, public keys, hashes) are
hex-encoded or base64-encoded per the types contract.

### Identity

| Method | Path | Request | Response (200/201) | Errors |
|--------|------|---------|-------------------|--------|
| `POST` | `/identity` | `{}` | `{ userId, publicKey }` (201) | — |
| `POST` | `/identity/import` | `{ publicKey: hex }` | `{ userId, publicKey }` (201 or 200 if exists) | 400 if key not 32 bytes |
| `GET` | `/identity/:userId` | — | `{ userId, publicKey, createdAt }` | 404 |

**Invariant:** Secret key never in any response body. Identity creation here
does nothing on the ledger — an account only exists after its first UTXO box
appearance (via invite claim or genesis).

### Challenge (PoW)

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/challenge` | `{ userId }` | `{ challenge: hex(32), targetBits, expiresAtBlock }` | 400 if userId unknown, 409 if challenge already outstanding |

One outstanding challenge per account. Requesting a new challenge before the
previous is submitted or expired returns 409. Challenge expires at
`currentBlock + CHALLENGE_WINDOW_BLOCKS`.

### Posts

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/posts` | Post object (JSON) | `{ id, status: "pending" }` (201) | 400 on validation failure, 409 if no active challenge |
| `GET` | `/posts/:id` | — | Post object (with `likeCount`) or Stump object | 404 |
| `GET` | `/posts` | `?author=&limit=50&offset=0` | Post[] (with `likeCount`, live only, no stumps) | — |

**Post submission flow:**
1. Validate all required fields present (`content`, `author`, `parentRefs`,
   `challenge`, `powNonce`, `protocolVersion`, `timestamp`, `signature`)
2. Verify challenge is active for this author (issued, not expired, matches value)
3. `verifyPost(post, currentBlockHeight)` — see Verifier contract.
   Checks karma: threads require `POST_LOCK_THREAD_COST` (5), replies require
   `POST_LOCK_REPLY_COST` (3).
4. Compute `id = computePostId(post)` — server-authoritative
5. Lock karma via UTXO transaction:
   - Consume author's existing KarmaBox
   - Create new KarmaBox with `value - lockAmount`
   - Create PostLockBox (`boxType: 'post_lock'`, `guard: 'epoch_tally'`)
6. Assemble sub-block: `{ post, likeBoxes: dequeuePendingLikes() }`
7. Store sub-block via store interface
8. Consume challenge (mark as used)
9. Signal ordering block creator
10. Return `{ id, status: "pending" }`

Parent refs may point to live posts or stumps. Both are valid — the DAG
traversal handles both transparently.

### Likes

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/likes` | `{ targetPostId, likerId, signature }` | `{ likeId, type: "locked" \| "free" }` (201) | 400 if post unknown or pruned, 400 if insufficient karma, 400 if already liked, 404 if liker unknown |
| `POST` | `/likes/remove` | `{ targetPostId, likerId, signature }` | `{ removed: true, netKarma }` (200) | 400 if post unknown or pruned, 404 if like not found |

**Like flow:** (unchanged)

**Unlike flow:**
1. Verify post exists and is live (not pruned)
2. Verify signature over `JSON.stringify({ targetPostId, likerId, action: "unlike" })`
3. Check for locked like box (utxo_boxes, box_type='like', matching, unspent)
   - If found: consume like box, refund 2 karma to liker, deduct 1 karma penalty. netKarma = +1.
4. If no locked like: check `dag_likes` for free like row
   - If found: delete row, deduct 1 karma penalty from liker. netKarma = −1.
5. If neither: return 404

Unlike costs 1 karma as a deterrent against gaming the like system.
Locked karma (2) is refunded on unlike, so the net is +1 for the liker.
Free likes have no locked karma, so the net is −1.

**Like refund schedule** (computed at epoch boundary by ordering block processor):

| Likes on post | Refund | Effect |
|---------------|--------|--------|
| < 10 | 0 | Like stays locked, rolls over to next epoch |
| ≥ 10 | 2 (full) | Like box consumed, 2 karma returned to liker |

Locked karma is never burned. Likes beyond 50 are free — no lock, no refund.
They count toward the total for author rewards.

### Invites

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/invites` | `{ inviterId, karmaAmount, bondAmount, signature }` | `{ inviteBoxId, bondBoxId, secretHash }` (201) | 400 if insufficient karma, 400 if exceeds `MAX_PENDING_INVITES`, 404 if inviter unknown |
| `POST` | `/invites/claim` | `{ inviteBoxId, secret, publicKey }` | `{ userId, karmaBoxId }` (201) | 400 if hash mismatch, 400 if publicKey already an account |
| `POST` | `/invites/cancel` | `{ inviteBoxId, inviterId, signature }` | `{ karmaBoxId }` (200) | 400 if already claimed, 403 if not inviter |

**Create flow:**
1. Verify inviter has ≥ `karmaAmount + bondAmount` available karma
2. Verify inviter has < `MAX_PENDING_INVITES` outstanding unclaimed invites
3. Generate random secret `s`, compute `secretHash = blake2b512(s).subarray(0,32)`
4. Construct UTXO transaction: consume inviter's karma box, create new karma
   box (balance - N - D) + invite box (N, hash-locked) + bond box (D, inviter-owned)
5. Return `{ inviteBoxId, bondBoxId, secretHash }` — inviter communicates `s`
   to invitee out of band

**Claim flow:**
1. Verify `blake2b512(secret).subarray(0,32) === inviteBox.secretHash`
2. Verify `publicKey` is not already associated with an existing account
3. Construct UTXO transaction: consume invite box, create new karma box for
   the invitee (value N, owner = publicKey) — account now exists
4. Update bond box: set `inviteePublicKey`, `probationStartBlock`,
   `probationEndBlock = currentBlock + INVITE_PROBATION_BLOCKS`
5. Return `{ userId, karmaBoxId }`

**Cancel flow:**
1. Verify invite is unclaimed
2. Verify signature matches inviter's key
3. Construct UTXO transaction: consume invite box + bond box, return both
   values to inviter's karma box
4. Return `{ karmaBoxId }`

### Pruning

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/posts/:id/prune` | `{ authorId, signature }` | `{ stumpId }` (201) | 400 if post is not root (has parent), 403 if not author, 404 |

**Prune flow:**
1. Verify post exists, is live, and `parentRefs` is empty (it's a root post)
2. Verify signature matches post author's key
3. Walk the reply subtree — collect all descendant posts
4. Walk associated UTXO state — collect all like boxes referencing posts in
   the subtree
5. Compute karma deltas from like boxes (deterministic, verifiable)
6. Compute subtree merkle root over all pruned posts
7. Construct stump, commit via ordering block
8. Mark all subtree posts as pruned (they become stumps)
9. Return `{ stumpId }`

### UTXO queries

| Method | Path | Response | Errors |
|--------|------|----------|--------|
| `GET` | `/karma/:userId` | `{ userId, balance, boxId, createdAtBlock }` | 404 |
| `GET` | `/credits/:userId` | `{ userId, balance, boxId }` | 404 |
| `GET` | `/invites/:userId` | `{ pending: InviteBox[], bonds: BondBox[] }` | 404 |

### Blocks

| Method | Path | Response | Errors |
|--------|------|----------|--------|
| `GET` | `/blocks/:height` | OrderingBlock object | 400 if NaN, 404 |
| `GET` | `/blocks/current` | `{ height, hash }` | — |

### Faucet (testnet only)

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/faucet` | `{ userId, amount }` | `{ userId, boxId, newBalance }` (201) | 400 if missing fields, 403 if not testnet, 404 if userId unknown |

Grants karma to an identity. Mints from nothing — not a transfer. Creates a
new karma box or tops up an existing one. Gated behind `networkMode === "testnet"`.

### Status

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/status` | `{ blockHeight, postCount, pendingPosts, identityCount, totalKarma, totalCredits, networkMode }` |

### Static

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/` | Demo UI (`public/index.html`) |

---

## Verifier Contract

`verifyPost(post: Post, currentBlockHeight: number): { valid: boolean; error?: string }`

Verification order (fail-fast):

1. **Challenge** — must be active for `post.author`, not expired, matches
   `post.challenge`. `expiresAtBlock ≥ currentBlockHeight`.
2. **PoW** — `verifyPoW(powInput, post.powNonce, POST_POW_TARGET_BITS)` where
   `powInput = content || author || parentRefs || challenge || protocolVersion || timestamp`
3. **Signature** — `crypto.verify(null, signingHash(post), pubKeyObj, sigBuf)`
   with raw Ed25519
4. **Parent refs** — each `parentId` must exist as a confirmed post or stump
   (skip for genesis/empty parents)
5. **Content limit** — reject if `content.length > MAX_CONTENT_BYTES` (300) or
   empty
6. **Protocol version** — reject if unsupported
7. **Karma** — author must have a karma box with sufficient value:
   - Threads (no parentRefs): ≥ `POST_LOCK_THREAD_COST` (5)
   - Replies (has parentRefs): ≥ `POST_LOCK_REPLY_COST` (3)
   (prevents posting from nonexistent or zero-karma accounts)

### verifyPostForRelay

`verifyPostForRelay(deps, post: Post, currentBlockHeight: number): { valid: boolean; error?: string }`

Stage 2 validation for gossiped posts (received via libp2p). Same checks as
`verifyPost` except the challenge check — the challenge was node-local to the
origin node. Re-verifies: content limits, parent refs count, protocol version,
PoW (stateless, re-verified), signature (stateless, re-verified), karma
sufficiency, and parent ref existence.

The Stage 1 stateless checks (structure, PoW, signature) are run by the net
package via `@dagsocial/validation` before this function is called. Stage 2
adds the stateful DB-dependent checks.

---

## UTXO Engine Contract

The UTXO engine manages box lifecycle, transaction validation, karma decay,
and conservation rules. It is a subsystem of the node — not a separate process.

### Transaction validation

`validateAndApplyTx(tx: UtxoTransaction, currentBlockHeight: number): { valid: boolean; error?: string }`

1. **Stateless validation:**
   - All input box IDs exist and are unspent
   - Total value in = total value out (except mint/burn ops)
   - Every consumed box's guard condition is satisfied by the provided signature
   - No duplicate input box IDs
   - Box type transitions are legal (see below)

2. **Stateful validation:**
   - Karma decay applied at consumption time (see below)
   - Conservation: mint only via like rewards (ordering block processor) or
     genesis; burn only via bond forfeiture
   - Karma box → invite/like/new-karma transitions only (no transfer to
     other owner)

3. **Apply:** mark consumed boxes as spent, insert created boxes as unspent,
   update account indexes.

### Legal box transitions

| Consumed | Created | Condition |
|----------|---------|-----------|
| KarmaBox | KarmaBox + InviteBox + BondBox | Owner same, value conserved |
| KarmaBox | KarmaBox + LikeBox | Owner same, value conserved |
| KarmaBox | KarmaBox | Owner same, balance changes (earn/decay) |
| InviteBox | KarmaBox | Hash preimage match OR inviter sig (cancel) |
| BondBox | KarmaBox (to inviter) | Unlock condition met |
| BondBox | — (burn) | Invitee karma < minimum during probation |
| CreditBox | CreditBox(+CreditBox) | Any owner, value conserved |
| LikeBox | — (tallied) | Epoch tally consumption (ordering block only) |

### Karma decay at consumption

```
age = currentBlockHeight - box.createdAtBlock
graceAge = max(0, age - KARMA_DECAY_GRACE_BLOCKS)
decay = floor(box.value * KARMA_DECAY_RATE * graceAge)
effectiveValue = max(box.value - decay, KARMA_FLOOR)
```

Decay is computed at the time a karma box is consumed. The created box(es)
use `effectiveValue` as the source. Decayed karma is destroyed (net deflation).

---

## Ordering Block Creator Contract

`startBlockCreator()` / `stopBlockCreator()` / `onSubBlockReceived()`

- **Timer-driven:** every `ORDERING_BLOCK_INTERVAL_MS` (default 60s), attempt
  to create an ordering block
- **Sub-block-count-driven:** when pending sub-blocks ≥
  `ORDERING_BLOCK_MIN_SUB_BLOCKS` (default 1), create immediately
- Block creation:
  1. Collect all pending sub-blocks since last ordering block
  2. Collect standalone like boxes (no sub-block to ride)
  3. Deduplicate likes (a like box appearing in both a sub-block and the
     standalone pool is included only once)
  4. Collect pending UTXO transactions (invites, claims, cancellations,
     credit transfers)
  5. Collect pending stumps
  6. If `currentHeight % EPOCH_BLOCKS === 0`: run epoch tally (process all
     locked like boxes + free likes, compute author rewards + liker refunds)
  7. Assign block height, compute block hash
  8. Sign with validator's key
  9. Store block, update all sub-block/UTXO/stump statuses to confirmed
  10. Return block or null if nothing to confirm

| Config parameter | Default | Description |
|-----------------|---------|-------------|
| `ORDERING_BLOCK_INTERVAL_MS` | `60000` | Max time between ordering blocks |
| `ORDERING_BLOCK_MIN_SUB_BLOCKS` | `1` | Sub-blocks to trigger immediate block |
| `MAX_SUB_BLOCKS_PER_BLOCK` | `1000` | Max sub-blocks per ordering block |

### Epoch tally

Triggered every `EPOCH_BLOCKS` ordering blocks (not every block). Processes all
unprocessed locked like boxes and free like rows.

1. Collect all unprocessed locked like boxes from `utxo_boxes`
   (box_type = 'like', spent_at_block IS NULL)
2. Collect all unprocessed free like rows from `dag_likes`
   (processed = 0)
3. Group by `targetPostId` — total like count = locked + free
4. For each target post:
   - `totalLikes` = locked count + free count
   - Compute author reward: `min(floor(totalLikes / LIKE_THRESHOLD), LIKE_MAX_AUTHOR_REWARD)`
   - For each **locked** like box:
     - If `totalLikes >= 2 * LIKE_THRESHOLD` (10): refund 2 karma to liker's karma box, consume like box
     - If `totalLikes < 2 * LIKE_THRESHOLD`: leave like box locked — rolls over to next epoch
     - Locked karma is never burned
   - Author reward: mint karma to post author's karma box
5. For each **free** like row: mark as processed (no karma movement)
6. Mark all **consumed** like boxes as spent (spent_at_block set). Like boxes that
   didn't meet the threshold remain unspent and are processed in the next epoch.
7. Record `EpochTally` in the ordering block

Likes beyond `LIKE_FREE_THRESHOLD * LIKE_THRESHOLD` (50) are free — no lock,
no refund. They count toward `totalLikes` for author reward purposes only.

---

## Store Interface

Storage backends implement this interface. SQLite is the Phase 2 backend.
Fresh schema — no Phase 1 migration.

Table prefixes: `dag_*`, `utxo_*`, `sub_*`, `block_*`

### Database lifecycle

| Function | Signature | Description |
|----------|-----------|-------------|
| `initDb(path)` | `(string) => void` | Initialize backend, run migrations, enable WAL |
| `getDb()` | `() => BackendHandle` | Return backend handle, throw if not initialized |
| `closeDb()` | `() => void` | Graceful shutdown |

### Identity (carried forward)

| Function | Signature |
|----------|-----------|
| `insertIdentity(userId, keyPair)` | `(UserId, KeyPair) => void` |
| `getIdentity(userId)` | `(UserId) => { userId, publicKey, createdAt } \| null` |

### Challenges (new)

| Function | Signature |
|----------|-----------|
| `createChallenge(userId, challenge, expiresAtBlock)` | `(UserId, bytes, number) => void` |
| `getActiveChallenge(userId)` | `(UserId) => { challenge, expiresAtBlock } \| null` |
| `consumeChallenge(userId, challenge)` | `(UserId, bytes) => void` |

### Posts DAG

| Function | Signature |
|----------|-----------|
| `insertPost(post, rawCbor)` | `(Post, Buffer) => void` — status = pending |
| `getPost(id)` | `(string) => Post \| Stump \| null` |
| `queryPosts({ author?, limit, offset })` | `(QueryOpts) => Post[]` — live only, newest first |
| `getPendingPosts(limit)` | `(number) => Post[]` — oldest first |
| `confirmPost(postId, blockHeight)` | `(string, number) => void` |
| `getParentRefs(postId)` | `(string) => PostId[]` |
| `getSubtree(postId)` | `(string) => Post[]` — all descendants (recursive walk) |
| `pruneSubtree(rootPostId, stump)` | `(string, Stump) => void` — mark subtree as pruned, insert stump |

### Likes (DAG)

| Function | Signature |
|----------|-----------|
| `insertLike(targetPostId, likerId)` | `(PostId, UserId) => string` — free like, returns likeId |
| `hasLiked(targetPostId, likerId)` | `(PostId, UserId) => boolean` — checks both dag_likes and utxo_boxes |
| `getLikeCount(postId)` | `(PostId) => { locked: number, free: number }` |
| `getUnprocessedFreeLikes()` | `() => FreeLike[]` — unprocessed dag_likes rows |
| `markFreeLikesProcessed(likeIds)` | `(string[]) => void` — after epoch processing |

### UTXO

| Function | Signature |
|----------|-----------|
| `getBox(boxId)` | `(string) => BoxBase \| null` |
| `getUnspentBoxes(owner)` | `(PublicKey) => BoxBase[]` |
| `getKarmaBox(owner)` | `(PublicKey) => KarmaBox \| null` — unspent karma box for account |
| `getCreditBox(owner)` | `(PublicKey) => CreditBox \| null` — unspent credit box for account |
| `getPendingInvites(inviterId)` | `(UserId) => InviteBox[]` — unclaimed, unexpired |
| `getPendingInviteCount(inviterId)` | `(UserId) => number` |
| `getBondBoxes(inviterId)` | `(UserId) => BondBox[]` — active bonds |
| `getLockedLikeBoxes(postId)` | `(PostId) => LikeBox[]` — all locked like boxes for a post |
| `getUnprocessedLockedLikeBoxes()` | `() => LikeBox[]` — pending epoch tally |
| `insertBox(box)` | `(BoxBase) => void` |
| `consumeBox(boxId, consumedAtBlock)` | `(string, number) => void` — mark as spent |
| `markLikeBoxesTallied(boxIds)` | `(string[]) => void` — after epoch processing |

### Sub-blocks

| Function | Signature |
|----------|-----------|
| `insertSubBlock(subBlock)` | `(SubBlock) => void` |
| `getPendingSubBlocks(limit)` | `(number) => SubBlock[]` — oldest first, unconfirmed |
| `confirmSubBlock(subBlockId, blockHeight)` | `(string, number) => void` |

### Ordering blocks

| Function | Signature |
|----------|-----------|
| `createOrderingBlock(block)` | `(OrderingBlock) => void` |
| `getOrderingBlock(height)` | `(number) => OrderingBlock \| null` |
| `getCurrentHeight()` | `() => number` |

### Stumps

| Function | Signature |
|----------|-----------|
| `insertStump(stump)` | `(Stump) => void` |
| `getStump(stumpId)` | `(string) => Stump \| null` |

---

## Configuration

All config via environment variables with defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `DB_PATH` | `dagsocial.db` | SQLite database path |
| `NODE_ROLE` | `server` | Role: `server` (applies peer blocks) or `miner` (produces blocks) |
| `POST_POW_TARGET_BITS` | `20` | Post PoW difficulty |
| `CHALLENGE_WINDOW_BLOCKS` | `10` | Challenge expiry in blocks |
| `ORDERING_BLOCK_INTERVAL_MS` | `60000` | Max time between ordering blocks |
| `ORDERING_BLOCK_MIN_SUB_BLOCKS` | `1` | Sub-blocks to trigger immediate block |
| `MAX_SUB_BLOCKS_PER_BLOCK` | `1000` | Max sub-blocks per ordering block |
| `EPOCH_BLOCKS` | `60` | Like processing every N ordering blocks |
| `NETWORK_MODE` | `testnet` | Network mode — `testnet` enables debug endpoints (faucet) |
| `BOOTSTRAP_PEERS` | `[]` | Comma-separated libp2p multiaddrs |
| `LISTEN_ADDRS` | `/ip4/0.0.0.0/tcp/0` | libp2p listen addresses |
| `MAX_PEERS` | `50` | Max connected libp2p peers |

All protocol parameters from `@dagsocial/types` are also overridable via env
vars for testing and governance simulation.

---

## Net Integration

The node creates a `NetNode` from `@dagsocial/net` during startup and registers
Stage 2 handlers for inbound gossip messages. Startup order:

```
1. initDb()
2. Create NetNode with config + validators
3. Register Stage 2 handlers (onSubBlock, onOrderingBlock, onTx)
4. await net.start()          // connect to bootstrap, subscribe to topics
5. startHttpServer()          // begin accepting API requests
6. startBlockCreator()        // begin producing ordering blocks
```

Net starts before HTTP — the network layer is ready before the API accepts
requests. If bootstrap peers are unreachable, the node still starts (gossip
will connect as peers become available).

Route handlers call `net.broadcastSubBlock()`, `net.broadcastTx()`, and
`net.broadcastOrderingBlock()` after local processing to propagate new objects
to peers. Broadcast calls are fire-and-forget — failures are logged but do
not fail the API request.

### Node roles

| Role | Block creator | Applies peer blocks | Description |
|------|--------------|-------------------|-------------|
| `server` (default) | Off | Yes | Serves API, validates and applies inbound ordering blocks from gossip |
| `miner` | On (timer + trigger) | No | Produces ordering blocks, ignores peer blocks |

---

## Preconditions
- Node.js ≥ 22
- `@dagsocial/types` and `@dagsocial/validation` packages built and importable
- `@dagsocial/net` package built and importable
- `better-sqlite3` native bindings built
- Write access to `DB_PATH` directory
- Port available at `PORT` and libp2p listen address available

## Postconditions
- HTTP server listening on `:PORT`
- Fresh SQLite database created at `DB_PATH` with full Phase 2 schema
- libp2p NetNode running with configured transports and subscribed to gossip
  topics
- Connected to bootstrap peers and meshed on all subscribed topics
- Ordering block creator running (timer + sub-block-count trigger)
- Sub-blocks, ordering blocks, and UTXO transactions broadcast to peers
  after local creation
- UTXO engine initialized
- Demo UI served at `/`

## Invariants
- Secret keys never in API responses
- `raw_cbor` is the canonical authority for post content; parsed columns are derivative
- `post.id` is computed server-side — client-submitted IDs are ignored
- Content length limit enforced at API boundary
- Protocol version checked at verification
- Consumers call the Store interface, never the backend directly
- UTXO transactions are atomic — all boxes consumed/created in one commit
- Karma decay applied at box consumption time
- Sub-block identity IS post identity — they cannot diverge
- Like deduplication happens at ordering block creation time
- Challenge one-per-account: creating a new challenge consumes the old one
