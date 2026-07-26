# NODE Interface Contract

**Component:** `@dagsocial/node`
**Protocol version:** 1
**Last updated:** 2026-07-24

## Scope

HTTP server exposing the DAGsocial API. Owns: PoW challenge service, post
verifier (Stage 2 stateful validation), sub-block assembly, UTXO engine,
like processing, invite lifecycle, ordering block creator, stump engine,
mining subsystem, unified mempool, and persistent storage (SQLite).

Depends on:
- `@dagsocial/types` — shared data structures and constants
- `@dagsocial/validation` — Stage 1 stateless checks (PoW, signatures,
  structural validity)
- `@dagsocial/net` — libp2p networking for sub-block, ordering block,
  and UTXO transaction gossip

---

## Unified Mempool

All state-changing operations flow through a single mempool. No operation
applies UTXO state immediately — every mutation is queued as a pool entry,
included in an ordering block, and applied atomically when the block is
finalized. See `MEMPOOL_INTERFACE.md` for the full contract.

**Key properties:**
- Single SQLite table `mempool` with type discriminator (`subblock` | `utxo_tx`)
- FIFO ordering by insertion (`ORDER BY rowid ASC`)
- TTL: 720 blocks (~12h at 60s block time)
- Batch linking: sub-blocks and their linked UTXO payloads share a `batch_id`
- Expired entries purged at block assembly time
- Confirmed entries removed after block finalization
- No size cap, no replacement semantics (no fees yet)

---

## HTTP API

Base URL: `http://{host}:{port}` (default: `localhost:3000`)
All responses are JSON. Binary fields (public keys, signatures, challenges)
are hex-encoded.

### Identity

| Method | Path | Request | Response (200) | Errors |
|--------|------|---------|----------------|--------|
| `POST` | `/identity` | `{}` | `{ userId: hex, publicKey: hex }` (200) | — |
| `POST` | `/identity/import` | `{ publicKey: hex }` | `{ userId: hex, publicKey: hex }` (200) | 400 if key not 32 bytes |
| `GET` | `/identity/:userId` | — | `{ userId: hex, publicKey: hex, createdAt }` | 404 |

**Invariant:** Secret key never in any response body. Identity creation here
does nothing on the ledger — an account only exists after its first UTXO box
appearance (via invite claim, genesis, or faucet).

`userId` on the wire is hex-encoded (64 hex chars). Internally `UserId` is
`Uint8Array` (32 raw bytes).

### Challenge (PoW)

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/challenge` | `{ userId: hex }` | `{ challenge: hex(32), targetBits, expiresAtBlock }` | 400 if userId unknown, 409 if challenge already outstanding |

One outstanding challenge per account. Requesting a new challenge before the
previous is submitted or expired returns 409. Challenge expires at
`currentBlock + CHALLENGE_WINDOW_BLOCKS`.

### Posts

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/posts` | Post object (JSON, hex fields) | `{ postId, status: "pending", expiresAtHeight }` (200) | 400 on validation failure |
| `GET` | `/posts/:id` | — | Post object (`id`, `status`, `likeCount`) or Stump object | 404 |
| `GET` | `/posts` | `?author=hex&limit=50&offset=0` | Post[] (`id`, `status`, `likeCount`, live only, no stumps) | — |

**Post submission flow (mempool-based):**

Sub-block assembly, lifecycle, and ordering block integration are defined in
`SUBBLOCK_INTERFACE.md`.

1. Decode hex fields (`author`, `challenge`, `signature`) to binary
2. Validate field presence, content length (1–300 bytes)
3. Run `verifyPost()` — includes challenge check, PoW, signature, parent refs,
   content limits, protocol version, karma sufficiency
4. Compute `postId = computePostId(post)` — server-authoritative
5. Store post (status = pending) with raw CBOR
6. Build karma-lock UTXO transaction:
   - Consume author's KarmaBox
   - Create new KarmaBox (value - lockAmount, `createdAtBlock` = currentHeight)
   - Create PostLockBox (value = lockAmount, `epoch_tally` guard)
   - Reuse post signature for the karma input
7. Consume challenge
8. Assemble sub-block: `{ subBlockId: postId, post, likeBoxes: [], producerId: author, protocolVersion }`
9. Insert both as a batch into mempool (same `batchId = postId`):
   - `insertMempoolSubBlock(subBlock, expiresAtHeight, batchId)`
   - `insertUtxoTx(karmaLockTx, batchId, expiresAtHeight)`
10. Broadcast sub-block and UTXO tx to peers (fire-and-forget)
11. Signal block creator via `onSubBlockReceived()`
12. Return `{ postId, status: "pending", expiresAtHeight }`

Parent refs may point to live posts or stumps. Both are valid — the DAG
traversal handles both transparently.

Unlike the old direct-apply model, state is NOT changed immediately. The post
and its karma lock are applied when an ordering block includes the batch.

### Likes

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/likes` | `{ targetPostId, likerId: hex, signature: hex }` | `{ status: "pending", txId, expiresAtHeight }` or `{ status: "free", likeId }` | 400 if post unknown or pruned, 400 if insufficient karma, 400 if already liked, 404 if liker unknown |
| `POST` | `/likes/remove` | `{ targetPostId, likerId: hex, signature: hex }` | `{ status: "pending", txId, expiresAtHeight }` | 400 if post unknown or pruned, 404 if like not found |

**Like flow (locked, likes 1–50 on post):**

1. Verify post exists and is live (not pruned)
2. Verify liker has karma box with sufficient value
3. Verify not already liked (checks both `dag_likes` and `utxo_boxes`)
4. Verify signature over domain message
5. Build UTXO transaction: consume karma box → new karma box + LikeBox (value 2)
6. Insert UTXO tx into mempool: `insertUtxoTx(tx, null, expiresAtHeight)`
7. Return `{ status: "pending", txId, expiresAtHeight }`

**Like flow (free, like 51+ on post):**

1. Same checks as locked, but no karma lock
2. Insert free like row into `dag_likes` directly (no mempool)
3. Return `{ status: "free", likeId }`

**Unlike flow:**

1. Verify post exists and is live
2. Check for locked like box → if found: consume like box, build UTXO tx
   refunding 2 karma (net +1 after 1 karma penalty), insert into mempool
3. If no locked like: check `dag_likes` for free like row → delete row,
   build UTXO tx deducting 1 karma penalty, insert into mempool
4. If neither: return 404
5. Return `{ status: "pending", txId, expiresAtHeight }`

**Unlike costs 1 karma** as a deterrent against gaming. Locked like boxes
refund the 2 locked karma on unlike (net +1). Free likes have no locked karma
(net −1).

**Like refund schedule** (computed at epoch boundary by ordering block processor):

| Total likes on post | Refund | Effect |
|---------------------|--------|--------|
| < 10 (2× LIKE_THRESHOLD) | 0 | Like stays locked, rolls over to next epoch |
| ≥ 10 | 2 (full) | Like box consumed, 2 karma returned to liker |

Locked karma is never burned. Likes beyond 50 are free — no lock, no refund.
They count toward the total for author rewards.

### Invites

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/invites` | `{ inviterId: hex, karmaAmount, bondAmount, signature: hex }` | `{ status: "pending", txId, expiresAtHeight, secretHash: hex, inviteBoxId, bondBoxId }` | 400 if insufficient karma, 400 if exceeds `MAX_PENDING_INVITES`, 404 if inviter unknown |
| `POST` | `/invites/claim` | `{ inviteBoxId, secret, publicKey: hex }` | `{ status: "pending", txId, expiresAtHeight }` | 400 if hash mismatch, 400 if publicKey already an account |
| `POST` | `/invites/cancel` | `{ inviteBoxId, inviterId: hex, signature: hex }` | `{ status: "pending", txId, expiresAtHeight }` | 400 if already claimed, 403 if not inviter |

**Create flow:**

1. Verify inviter has ≥ `karmaAmount + bondAmount` available karma
2. Verify inviter has < `MAX_PENDING_INVITES` outstanding unclaimed invites
3. Generate random secret `s`, compute `secretHash = blake2b512(s).subarray(0,32)`
4. Build UTXO transaction: consume karma box → new karma box (balance - N - D) +
   InviteBox (N, hash-locked) + BondBox (D, inviter-owned, with zeroed
   inviteePublicKey/probation fields)
5. Insert into mempool: `insertUtxoTx(tx, null, expiresAtHeight)`
6. Return `{ status: "pending", txId, expiresAtHeight, secretHash, inviteBoxId, bondBoxId }`
   — inviter communicates `s` to invitee out of band

**Claim flow:**

1. Verify `blake2b512(secret).subarray(0,32) === inviteBox.secretHash`
2. Verify `publicKey` is not already associated with an existing account
3. Build UTXO transaction:
   - Consume InviteBox
   - Create new KarmaBox for invitee (value N, owner = publicKey) — account now exists
   - Update BondBox: set `inviteePublicKey`, `probationStartBlock`, `probationEndBlock`
4. Insert into mempool: `insertUtxoTx(tx, null, expiresAtHeight)`
5. Return `{ status: "pending", txId, expiresAtHeight }`

**Cancel flow:**

1. Verify invite is unclaimed
2. Verify signature matches inviter's key
3. Build UTXO transaction: consume InviteBox + BondBox, create new KarmaBox
   returning both values to inviter
4. Insert into mempool: `insertUtxoTx(tx, null, expiresAtHeight)`
5. Return `{ status: "pending", txId, expiresAtHeight }`

### Pruning

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/posts/:id/prune` | `{ authorId: hex, signature: hex }` | `{ stumpId }` (201) | 400 if post is not root (has parent), 403 if not author, 404 |

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
| `GET` | `/karma/:userId` | `{ userId: hex, balance, boxId, createdAtBlock }` | 404 |
| `GET` | `/credits/:userId` | `{ userId: hex, balance, boxId }` | 404 |
| `GET` | `/invites/:userId` | `{ pending: InviteBox[], bonds: BondBox[] }` | 404 |

### Blocks

| Method | Path | Response | Errors |
|--------|------|----------|--------|
| `GET` | `/blocks/:height` | OrderingBlock object (JSON with hex fields) | 400 if NaN, 404 |
| `GET` | `/blocks/current` | `{ height, hash }` | — |

### Faucet (testnet only)

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/faucet` | `{ userId: hex, amount }` | `{ status: "pending", txId, expiresAtHeight }` | 400 if missing fields, 403 if not testnet, 404 if userId unknown |

Grants karma to an identity. Mints from nothing — not a transfer. Builds a
UTXO transaction creating a new karma box, inserts into mempool. Gated behind
`networkMode === "testnet"`.

### Mining

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `GET` | `/mining/block-template` | — | OrderingBlock template (powNonce=0, no signature) or 404 if not external mode | — |
| `POST` | `/mining/submit` | `{ powNonce: number, height: number }` | `{ accepted: true, hash }` or `{ accepted: false, reason }` | 400 |

External mining mode only. `GET /mining/block-template` returns the current
block template for external miners to solve. `POST /mining/submit` accepts a
mined nonce, verifies PoW, finalizes the block, and broadcasts.

### Status

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/status` | `{ blockHeight, postCount, identityCount, totalKarma, totalCredits, networkMode, miningMode }` |

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
   (skip for empty parents)
5. **Content limit** — reject if `content.length > MAX_CONTENT_BYTES` (300) or empty
6. **Protocol version** — reject if unsupported
7. **Karma** — author must have a karma box with sufficient value:
   - Threads (no parentRefs): ≥ `POST_LOCK_THREAD_COST` (5)
   - Replies (has parentRefs): ≥ `POST_LOCK_REPLY_COST` (3)

### verifyPostForRelay

`verifyPostForRelay(deps, post: Post, currentBlockHeight: number): { valid: boolean; error?: string }`

Stage 2 validation for gossiped posts (received via libp2p). Same checks as
`verifyPost` except the challenge check — the challenge was node-local to the
origin node. Re-verifies: content limits, parent refs count, protocol version,
PoW (stateless, re-verified), signature (stateless, re-verified), karma
sufficiency, and parent ref existence.

---

## UTXO Engine Contract

The UTXO engine manages box lifecycle, transaction validation, and
conservation rules. Karma decay is handled separately by the periodic
decay engine at block application time. The engine is split into three
functions:

### validateTx

```
validateTx(deps, tx: UtxoTransaction, currentBlockHeight: number): UtxoResult
```

Full read-only validation. Performs all checks without modifying state:

1. No duplicate input box IDs
2. All input boxes exist and are unspent
3. All inputs have the same boxType
4. Face-value conservation (non-karma types; karma conservation is handled
   by the periodic decay engine)
5. Guard satisfaction (signatures verified against tx hash)
6. Legal box transitions (per the transition table below)

Returns `{ valid, error?, computedOutputs?, txId? }`. On success, `computedOutputs`
contains boxes with pre-computed IDs (for use by `applyTx`), and `txId` is the
deterministic transaction ID.

**Used at pool entry** for ideal validation (though currently gated by signing
mismatch — see Known Gaps in SESSION_CONTEXT.md).

### revalidateTxInContext

```
revalidateTxInContext(deps, tx: UtxoTransaction, currentBlockHeight: number): UtxoResult
```

Lightweight re-validation at block application time. Skips expensive checks
(signatures, transitions) and only verifies:

- Input liveness — are inputs still unspent?
- Karma decay is handled by the periodic decay engine (applied separately
  during block application, not at individual transaction revalidation)

**Used during block finalization** when applying UTXO transactions from the
mempool. Signatures and transitions were already verified (either at pool
entry or at relay receipt). Only height-dependent liveness needs re-checking.

### applyTx

```
applyTx(deps, tx: UtxoTransaction, outputsWithIds: AnyBox[], currentBlockHeight: number): void
```

Write-only. Consumes all input boxes and inserts all output boxes inside a
SQLite transaction. Performs no validation — call `validateTx` or
`revalidateTxInContext` first.

### validateAndApplyTx (convenience)

```
validateAndApplyTx(deps, tx: UtxoTransaction, currentBlockHeight: number): UtxoResult
```

Delegates to `validateTx` + `applyTx`. Preserved for backward compatibility.
New code should prefer the split functions.

### Legal box transitions

| Consumed | Created | Condition |
|----------|---------|-----------|
| KarmaBox | KarmaBox | Same owner, balance change (earn/spend) |
| KarmaBox | KarmaBox + LikeBox | Same owner, value conserved |
| KarmaBox | KarmaBox + PostLockBox | Same owner, value conserved |
| KarmaBox | KarmaBox + InviteBox + BondBox | Same owner, value conserved |
| InviteBox | KarmaBox | Hash preimage match OR inviter sig (cancel) — handled at service layer |
| BondBox | KarmaBox (to inviter) | Unlock condition met |
| BondBox | — (burn) | Invitee karma < minimum during probation |
| CreditBox | CreditBox(+CreditBox) | Any owner, value conserved |
| LikeBox | — (tallied) | Epoch tally consumption (ordering block only) |
| PostLockBox | PostLockBox(+KarmaBox) | Epoch processing only (partial/full unlock) |

### Karma decay (periodic burn)

Karma decay is applied at block application time via `applyKarmaDecay()`,
not at individual transaction consumption time. See `decay.ts` and the
Architecture document for the full model. Key properties:

- **Staleness:** An identity must have no normal-activity karma box within
  `KARMA_STALE_THRESHOLD_BLOCKS` to be eligible
- **Burn rate:** `KARMA_DECAY_AMOUNT` karma per `KARMA_DECAY_INTERVAL_BLOCKS`
- **Floor:** Never reduces below `KARMA_MINIMUM`
- **Provenance:** Decay-created boxes carry `decayBurn: true` so subsequent
  decay cycles continue burning. Normal activity boxes reset the clock.
- **Rollback:** Journaled and reversed during fork resolution.

---

## Ordering Block Creator Contract

`startBlockCreator()` / `stopBlockCreator()` / `onSubBlockReceived()` /
`createOrderingBlock()` / `submitMinedBlock(powNonce, height)`

### Triggers

- **Timer-driven:** every `ORDERING_BLOCK_INTERVAL_MS` (default 60s)
- **Sub-block-count-driven:** when pending sub-blocks ≥
  `ORDERING_BLOCK_MIN_SUB_BLOCKS` (default 1)

### Block creation (mempool-based)

1. Purge expired mempool entries (`purgeExpired(currentHeight)`)
2. Get pending entries from mempool (`getPendingEntries(limit)`)
3. Separate sub-blocks from standalone UTXO transactions (`batch_id IS NULL`)
4. Decode sub-blocks from CBOR
5. Resolve batch entries — UTXO payloads linked to sub-blocks via `batch_id`
6. Attach standalone likes to matching sub-blocks by `targetPostId`
7. Remaining standalone UTXO entries → `utxoTxIds`
8. Batch-linked UTXO entries → `utxoTxIds`
9. Collect standalone unprocessed locked like boxes
10. Deduplicate likes (a like box in both a sub-block and standalone pool
    is included only once via the sub-block)
11. Check epoch boundary — if `currentHeight > 0 && currentHeight % epochBlocks === 0`,
    run epoch tally
12. Always produce a block — miners need coinbase rewards even when there
    is no user work.  Empty blocks carry credit emission and epoch tallies.
13. Track confirmed mempool rowids for cleanup
14. Build coinbase outputs (credit emission with Ergo-style decay,
    treasury split if configured)
15. Adjust difficulty at epoch boundaries (credit epochs, not like epochs)
16. Build block template (powNonce=0, empty signature)
17. **Internal mode:** mine PoW, sign body hash, compute final hash, finalize
18. **External mode:** store template for `GET /mining/block-template`,
    return null (block finalized when miner submits via `submitMinedBlock`)

### Block finalization

1. Store block in `block_ordering` table
2. Apply coinbase — mint credits for each output
3. Broadcast ordering block to peers
4. Confirm sub-blocks and their posts (`confirmPost`)
5. Apply UTXO transactions — for each confirmed UTXO tx, re-validate
   in context (`revalidateTxInContext`) then apply (`applyTx`).
   Idempotent: skips boxes already inserted or spent (survives gossip
   loopback where the same tx arrives via both local mining and relay).
6. Remove confirmed entries from mempool (`removeEntry` for each confirmed rowid)
7. Reset pending counter and template

### Mining modes

| Mode | Block creator | Block finalization | Template endpoint |
|------|--------------|-------------------|-------------------|
| `internal` (default) | Timer + trigger | PoW solved internally | N/A |
| `external` | Timer + trigger | Via `submitMinedBlock` | `GET /mining/block-template` |

In external mode, the block creator builds a template with `powNonce=0` and
stores it. External miners poll the template endpoint, solve PoW, and submit
via `POST /mining/submit`. The node verifies PoW, signs, and finalizes.

### Coinbase emission (Ergo-style linear decay)

```
if height <= CREDIT_FIXED_RATE_BLOCKS (1,051,200):
    reward = CREDIT_INITIAL_REWARD (100)
else:
    epochs = floor((height - CREDIT_FIXED_RATE_BLOCKS - 1) / CREDIT_EPOCH_BLOCKS) + 1
    reward = max(CREDIT_INITIAL_REWARD - epochs * CREDIT_REWARD_REDUCTION, CREDIT_TAIL_REWARD)
```

Coinbase outputs are locked for `CREDIT_MINER_REWARD_DELAY` (720) blocks.
If `treasuryPubKey` is configured, `CREDIT_TREASURY_PCT` (10%) goes to treasury.

### Difficulty adjustment

At each credit epoch boundary (`height % CREDIT_EPOCH_BLOCKS === 0`):

```
ratio = actualDuration / expectedDuration
newTarget = round(currentTarget * ratio)
finalTarget = clamp(newTarget, currentTarget * 0.5, currentTarget * 1.5)
finalTarget = max(finalTarget, ORDERING_BLOCK_POW_TARGET_FLOOR (4))
```

Window is tracked from the first block of the current epoch.

### Epoch tally (like processing)

Runs every `EPOCH_BLOCKS` (60) ordering blocks. Processes locked like boxes,
free like rows, and post lock boxes:

1. Collect all unprocessed locked like boxes + unprocessed free like rows
2. Group by `targetPostId`
3. For each target post:
   - Compute `totalLikeCount = locked + free`
   - Author reward: `min(floor(totalLikes / LIKE_THRESHOLD), LIKE_MAX_AUTHOR_REWARD)`
   - For locked likes: if `totalLikes >= 2 * LIKE_THRESHOLD` (10), refund 2 karma
     to liker, consume like box. Otherwise leave locked — rolls over.
   - For free likes: mark as processed (no karma movement)
4. Process post lock boxes:
   - For each unspent PostLockBox, compute `shouldUnlock = floor(totalLikes / POST_LOCK_UNLOCK_PER_LIKES)`
   - `toUnlock = min(currentValue, shouldUnlock - alreadyUnlocked)`
   - If `toUnlock > 0`: consume old PostLockBox, create reduced one, mint unlocked
     karma back to author
5. Record `EpochTally` in the ordering block
6. Mark consumed like boxes and free likes as processed

---

## Store Interface

Storage backends implement this interface. SQLite is the backend.
Fresh schema — no Phase 1 migration.

### Database lifecycle

| Function | Signature | Description |
|----------|-----------|-------------|
| `initDb(path)` | `(string) => void` | Initialize backend, run migrations, enable WAL |
| `getDb()` | `() => Database` | Return better-sqlite3 handle, throw if not initialized |
| `closeDb()` | `() => void` | Graceful shutdown |

### Identity

| Function | Signature |
|----------|-----------|
| `insertIdentity(userId, keyPair)` | `(UserId, KeyPair) => void` |
| `getIdentity(userId)` | `(UserId) => { userId, publicKey, createdAt } \| null` |

### Challenges

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
| `getFreeLike(targetPostId, likerId)` | `(PostId, UserId) => FreeLike \| null` |
| `deleteFreeLike(likeId)` | `(string) => void` |
| `getUnprocessedFreeLikes()` | `() => FreeLike[]` |
| `markFreeLikesProcessed(likeIds)` | `(string[]) => void` |

### UTXO

| Function | Signature |
|----------|-----------|
| `getBox(boxId)` | `(string) => AnyBox \| null` |
| `getUnspentBoxes(owner)` | `(Uint8Array) => AnyBox[]` |
| `getKarmaBox(owner)` | `(Uint8Array) => KarmaBox \| null` — unspent karma box for account |
| `getCreditBox(owner)` | `(Uint8Array) => CreditBox \| null` — unspent credit box for account |
| `getPendingInvites(inviterId)` | `(UserId) => InviteBox[]` — unclaimed, unexpired |
| `getPendingInviteCount(inviterId)` | `(UserId) => number` |
| `getBondBoxes(inviterId)` | `(UserId) => BondBox[]` — active bonds |
| `getUnspentLikeForLiker(targetPostId, likerId)` | `(PostId, UserId) => LikeBox \| null` |
| `getLockedLikeBoxes(postId)` | `(PostId) => LikeBox[]` — all locked like boxes for a post |
| `getUnprocessedLockedLikeBoxes()` | `() => LikeBox[]` — pending epoch tally |
| `getUnspentPostLockBoxes()` | `() => PostLockBox[]` |
| `getPostTotalLikes(postId)` | `(PostId) => number` — locked + free |
| `insertBox(box)` | `(AnyBox) => void` |
| `consumeBox(boxId, consumedAtBlock)` | `(string, number) => void` — mark as spent |
| `markLikeBoxesTallied(boxIds)` | `(string[]) => void` — after epoch processing |

### Mempool

| Function | Signature | Description |
|----------|-----------|-------------|
| `insertMempoolSubBlock(sb, expiresAtHeight, batchId?)` | `(SubBlock, number, string?) => number` | Queue sub-block, returns rowid |
| `insertUtxoTx(tx, batchId, expiresAtHeight)` | `(UtxoTransaction, string?, number) => number` | Queue UTXO tx, returns rowid |
| `getPendingEntries(limit)` | `(number) => PoolEntry[]` | FIFO-ordered pending entries |
| `purgeExpired(currentHeight)` | `(number) => number` | Remove entries past expiry, returns count |
| `removeEntry(rowid)` | `(number) => void` | Remove confirmed entry by rowid |
| `removeBatch(batchId)` | `(string) => void` | Remove all entries in a batch |

`PoolEntry`:
```
{
  rowid: number
  entryType: "subblock" | "utxo_tx"
  subblockCbor: Uint8Array | null
  utxoTxCbor: Uint8Array | null
  batchId: string | null
  expiresAtHeight: number
  createdAt: string
}
```

See `MEMPOOL_INTERFACE.md` for the full mempool contract.

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

### dag_meta Table

A key-value metadata table stored alongside post data. Used for schema
versioning, migration sentinels, watermarks, and operational state.

**Schema:**
```sql
CREATE TABLE dag_meta (
    key   TEXT PRIMARY KEY,
    value BLOB NOT NULL
);
```

**Required keys and their invariants:**

| Key | Value encoding | Invariant |
|-----|---------------|-----------|
| `schema_version` | u32 LE | Must equal the version compiled into the binary at startup. Higher = refuse with diagnostic. Lower = run idempotent migrations. |
| `dag_tip_hash` | 32 bytes | Updated atomically with every canonical DAG advance. |
| `last_validated_sequence` | u32 LE | Must never exceed the DAG tip. Reset to fork point on reorg. |
| `last_indexed_sequence` | u32 LE | `last_validated_sequence <= last_indexed_sequence <= dag_tip_height`. External queries serve only up to `last_validated_sequence`. |

**Startup contract:**
1. Read `schema_version`. If missing, write current version.
2. If stored > expected: exit with diagnostic `"Database schema version is X but this build expects Y. Downgrade is not supported."`
3. If stored < expected: run idempotent migrations in order, each guarded by a sentinel key in dag_meta.
4. Read `dag_tip_hash` and watermarks to rebuild in-memory DAG view.

### PostStore Interface

The store layer is backend-agnostic. All storage access goes through the
`PostStore` interface. The SQLite implementation is the default; PostgreSQL
is a deferred alternative.

**Design principle:** The store sees opaque `(typeId, id, sequence, data)`
tuples. It does NOT parse post content, verify signatures, or validate the
DAG structure. Domain semantics live in the service layer above.

```typescript
interface PostStore {
  putBatch(entries: StoreEntry[]): Promise<void>;
  put(entry: StoreEntry): Promise<void>;
  get(typeId: number, id: Uint8Array): Promise<Uint8Array | null>;
  has(typeId: number, id: Uint8Array): Promise<boolean>;
  bestPostAt(sequence: number): Promise<Uint8Array | null>;
  canonicalBranchEntries(): Promise<Array<{ sequence: number; postId: Uint8Array }>>;
  metaGet(key: string): Promise<Uint8Array | null>;
  metaPut(key: string, value: Uint8Array): Promise<void>;
  listPeers(): Promise<PeerRecord[]>;
  putPeer(peer: PeerRecord): Promise<void>;
  deletePeer(peerId: string): Promise<void>;
  pruneBelowHorizon(horizon: number, typeIds: number[]): Promise<void>;
  minSequencePresent(typeId: number): Promise<number>;
  schemaVersion(): Promise<number>;
  close(): Promise<void>;
}

interface StoreEntry {
  typeId: number;
  id: Uint8Array;       // 32-byte blake2b hash
  sequence: number;      // caller-provided; store never derives it
  data: Uint8Array;      // opaque serialized bytes
}
```

**Invariants:**
- `putBatch` is atomic — all entries commit or none do.
- `put` is idempotent — duplicate `(typeId, id)` with same data is a no-op.
- `bestPostAt(n)` returns null, not an error, for non-existent sequences.
- `canonicalBranchEntries()` reads sequentially, not via N point lookups.
- `pruneBelowHorizon` never touches structural types (post metadata, DAG
  edges, scores).

---

## Service Layer Architecture

Express route handlers are thin facades with zero business logic. Every
handler: validates input shape → delegates to a service → serializes the
result. An `if` that makes a domain decision belongs in the service, not
the handler.

**Service modules and their responsibilities:**

| Service | Responsibility | Does NOT own |
|---------|---------------|--------------|
| `post-service.ts` | Create, verify (sig, PoW, DAG linkage, content), store | Networking, block assembly |
| `feed-service.ts` | Query canonical DAG, paginate, assemble feed views | Post creation, auth |
| `identity-service.ts` | Key management, identity verification | Post storage, networking |
| `credit-service.ts` | Credit transfer validation and execution | UTXO engine internals |
| `invite-service.ts` | Invite lifecycle (create, commit, redeem, cancel) | Bond box internals |
| `faucet-service.ts` | Faucet allocation with rate limiting | Credit system design |
| `block-service.ts` | Block creation, validation, application | Post validation, DAG structure |

**Validation pipeline (phased, increasing cost):**
1. Signature verification (cheap — Ed25519 verify)
2. PoW verification (cheap — blake2b + difficulty check)
3. DAG linkage / parent-hash integrity (moderate)
4. Content type/size/schema validation (variable, may be I/O-bound)

A post failing Phase N is rejected before Phase N+1 runs.

**Validation watermarks:**
- `post_indexed_height` — bytes stored, hash verified, DAG-linked
- `post_validated_height` — full content checks passed, safe for queries

Invariant: `post_validated_height <= post_indexed_height <= dag_tip_height`.
External queries serve only up to `post_validated_height`.

---

## Canonical DAG (Best DAG as a View)

**Design principle:** All posts from all branches are stored permanently.
The canonical DAG is a view derived from cumulative PoW. Switching branches
is a view update — posts are never deleted.

**Tables:**
```sql
CREATE TABLE canonical_branch (
    depth    INTEGER PRIMARY KEY,
    post_id  TEXT NOT NULL
);

CREATE TABLE post_scores (
    post_id           TEXT PRIMARY KEY,
    cumulative_score  INTEGER NOT NULL
);
```

**Fork-choice rule:** Strictly greater cumulative score wins. Equal score
= no reorg (first-seen wins on ties). No timestamps or content hashes
in fork resolution.

**Atomic reorg:** Switching canonical branches updates both the in-memory
DAG view and the `canonical_branch` table in a single transaction. If the
store transaction fails, the in-memory view is rolled back.

**Reorg floor:** If the node started from a snapshot at depth D, reorgs to
depths < D are rejected (`dag_meta` stores the floor depth).

**Reorg event:** Emit `dag_reorg` with `fork_point`, `demoted` count,
`old_tip`, and `new_tip`.

---

## Admin Listener

A second Express server on `127.0.0.1:ADMIN_PORT` (default 3001). Never
binds to a non-loopback address — a non-loopback bind logs a WARN at
startup.

**Endpoints:**

`GET /health` — in-memory metrics only. Never queries the database.
Always returns 200. Response shape:
```json
{
  "status": "ok",
  "dag_tip_height": 12345,
  "validated_height": 12344,
  "indexed_height": 12345,
  "peers_connected": 8,
  "last_post_received_ms_ago": 234,
  "syncing": false,
  "uptime_seconds": 84200,
  "apiVersion": "1.0",
  "journalEventsVersion": "1.0"
}
```

`GET /stats` — cumulative counters with `since` (process start):
```json
{
  "since": 1751400000,
  "statsVersion": "1.0",
  "counters": {
    "posts_created_total": 5432,
    "posts_validated_total": 5430,
    "pow_verifications_total": 6100,
    "pow_verification_failures_total": 2,
    "peer_messages_in_total": 89000,
    "peer_messages_out_total": 92000,
    "peer_bytes_in_total": 125000000,
    "peer_bytes_out_total": 131000000,
    "http_requests_total": 12000,
    "unknown_message_types_total": 0
  }
}
```

---

## Configuration

All config via environment variables with defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `DB_PATH` | `dagsocial.db` | SQLite database path |
| `NETWORK_MODE` | `testnet` | Network mode — `testnet` enables debug endpoints (faucet) |
| `NODE_ROLE` | `server` | Role: `server` (applies peer blocks, no mining) or `miner` (produces blocks) |
| `POST_POW_TARGET_BITS` | `20` | Post PoW difficulty |
| `CHALLENGE_WINDOW_BLOCKS` | `10` | Challenge expiry in blocks |
| `ORDERING_BLOCK_INTERVAL_MS` | `60000` | Max time between ordering blocks |
| `ORDERING_BLOCK_MIN_SUB_BLOCKS` | `1` | Sub-blocks to trigger immediate block |
| `MAX_SUB_BLOCKS_PER_BLOCK` | `1000` | Max sub-blocks per ordering block |
| `EPOCH_BLOCKS` | `60` | Like processing every N ordering blocks |
| `MINING_MODE` | `internal` | `internal` (node mines) or `external` (template endpoint) |
| `ORDERING_BLOCK_POW_TARGET_BITS` | `12` | Initial ordering block PoW difficulty |
| `CREDIT_INITIAL_REWARD` | `100` | Credits per block reward |
| `CREDIT_TREASURY_PCT` | `10` | Percent of block reward to treasury |
| `TREASURY_PUBKEY` | `""` | Hex-encoded 32-byte treasury key (empty = no treasury) |
| `BOOTSTRAP_PEERS` | `[]` | Comma-separated libp2p multiaddrs |
| `LISTEN_ADDRS` | `/ip4/0.0.0.0/tcp/0` | libp2p listen addresses |
| `MAX_PEERS` | `50` | Max connected libp2p peers |

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
6. startBlockCreator()         // begin producing ordering blocks
```

Net starts before HTTP — the network layer is ready before the API accepts
requests. If bootstrap peers are unreachable, the node still starts (gossip
will connect as peers become available).

Route handlers call `net.broadcastSubBlock()`, `net.broadcastTx()`, and
`net.broadcastOrderingBlock()` after local processing to propagate new objects
to peers. Broadcast calls are fire-and-forget — failures are logged but do
not fail the API request.

### Relay handlers (mempool-based)

- **`onSubBlock(sb)`**: validates (read-only) → inserts into mempool via
  `insertMempoolSubBlock`
- **`onTx(tx)`**: validates (read-only, `validateTx`) → inserts into mempool
  via `insertUtxoTx`
- **`onOrderingBlock(block)`**: full validation (structure, chain-link, PoW,
  signature) → if valid, processes `utxoTxIds` with `revalidateTxInContext`
  → `applyTx` → confirms posts → removes confirmed entries from mempool

Unlike the old model where relay handlers applied state immediately, all
state changes now flow through the mempool and are applied atomically when
the ordering block is applied.

---

## Preconditions
- Node.js ≥ 22
- `@dagsocial/types`, `@dagsocial/validation`, and `@dagsocial/net` packages
  built and importable
- `better-sqlite3` native bindings built
- Write access to `DB_PATH` directory
- Port available at `PORT` and libp2p listen address available

## Postconditions
- HTTP server listening on `:PORT`
- Fresh SQLite database created at `DB_PATH` with full schema including
  `mempool` table
- libp2p NetNode running with configured transports and subscribed to gossip
  topics
- Connected to bootstrap peers and meshed on all subscribed topics
- Ordering block creator running (timer + sub-block-count trigger, internal
  or external mining)
- Sub-blocks, ordering blocks, and UTXO transactions broadcast to peers
  after local creation
- UTXO engine initialized with split validate/revalidate/apply API
- Demo UI served at `/`

## Invariants
- Secret keys never in API responses
- `raw_cbor` is the canonical authority for post content; parsed columns are
  derivative
- `post.id` is computed server-side — client-submitted IDs are ignored
- Content length limit enforced at API boundary
- Protocol version checked at verification
- Consumers call the Store interface, never the backend directly
- UTXO transactions are atomic — all boxes consumed/created in one commit
- Karma decay applied periodically at block application time
- Sub-block identity IS post identity — they cannot diverge
- Like deduplication happens at ordering block creation time
- Challenge one-per-account: creating a new challenge consumes the old one
- All state mutations flow through mempool → ordering block inclusion →
  block application. Zero direct `consumeBox`/`insertBox` calls in HTTP routes.
- Mutating routes return `{ status: "pending", txId, expiresAtHeight }` —
  state is not applied until the enclosing ordering block is finalized.
