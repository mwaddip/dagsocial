# NODE Interface Contract

**Component:** `@dagsocial/node`
**Protocol version:** 1
**Last updated:** 2026-08-01

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

## Values are BigInt (P0 — Spec B)

Box `value` and every credit/karma **amount** are `bigint` (8-decimal integer base
units of 10⁻⁸ credit; karma small bigints). Rationale + the type-level contract:
`TYPES_INTERFACE.md` "Value denomination (P0)". No float math anywhere in a consensus
value path. Node-side obligations:

- **Authoritative value guard (`< 2⁶⁴`).** `utxo-engine.checkOutputValues` (engine) and
  `assertValidBoxValue` (`routes/json-to-tx`, the HTTP→tx edge) enforce
  `typeof value === 'bigint' && value >= 0n && value < 2⁶⁴` — the **tight** bound.
  `@dagsocial/validation`'s coinbase check is the loose structural pre-filter; this is
  the tight apply-side twin — the two move together. The HTTP edge coerces the incoming
  JSON value (string or number) to `bigint` before it enters consensus.
- **All value arithmetic is `bigint`** — conservation sums, coinbase split, epoch
  rewards, decay, fees. `Math.max/min/floor` **throw** on bigint: use bigint operators
  and manual min/max; bigint `/` truncates toward zero (the intended floor).
- **JSON boundaries emit strings (client-visible).** JSON cannot carry a bigint
  (`JSON.stringify(5n)` throws). Every HTTP response field carrying a box `value` or a
  `total` is serialized as a **decimal string**; the demo UI parses them with `BigInt()`
  (its phase). Same for the SQLite `extra_data` `originalValue` (coerce before
  `JSON.stringify`) and any stdout log field carrying an amount.
- **`epoch-canonical.canonicalValue` gets a `bigint` branch** returning the canonical
  decimal (`value.toString()`). It forms the `'epoch'` Merkle leaf and the
  block-acceptance compare — **consensus**; the branch must be deterministic.
- **`block-creator.computeUtxoTxRoot` coinbase leaf** serializes `value` as
  `value.toString()` in its `JSON.stringify` preimage (bigint throws otherwise). This
  is the `utxoTxRoot` coinbase Merkle leaf — **consensus**; the *same* function is both
  producer (block build) and verifier (`block-apply` recompute), so the leaf bytes
  cannot diverge.
- **SQLite `.safeIntegers()`** on every `value`-column read and on `SUM(value)`
  (`getTotalKarma` / `getTotalCredits`) — without it better-sqlite3 returns a lossy
  `number` and loses precision above 2⁵³.
- **DB reset.** Box ids and the AVL `stateRoot` changed in the types phase — fresh
  chain / coordinated cutover, no in-place migration.
- **Demo UI (`public/index.html`).** Its hand-rolled CBOR encoder emits `value` as
  `0x1b`+uint64 and the remaining `number` fields as minimal-int (folding in the L-5
  `cborEncodeInt` cap fix — `createdAtBlock` crosses 65536), **byte-identical to
  `@dagsocial/types`** so client-built box ids match the node; it parses API
  `value`/`total` with `BigInt()`. A box-value mirror test (extending the M-1 post
  mirror) pins the byte-identity.

---

## Unified Mempool

All state-changing operations flow through a single mempool. No operation
applies UTXO state immediately — every mutation is queued as a pool entry,
included in an ordering block, and applied atomically when the block is
finalized. See `MEMPOOL_INTERFACE.md` for the full contract.

**Key properties:**
- Single SQLite table `mempool` with type discriminator (`subblock` | `utxo_tx` | `prune`)
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

`userId` on the wire is hex-encoded (64 hex chars). Internally `UserId` is
`Uint8Array` (32 raw bytes).

### Challenge (PoW)

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/challenge` | `{ userId: hex }` | `{ challenge: hex(32), targetBits, expiresAtBlock }` | 400 if userId invalid |

Challenge is upserted — requesting a new challenge replaces any existing one
(no 409 blocking). Challenge expires at `currentBlock + CHALLENGE_WINDOW_BLOCKS`.

### Posts

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/posts` | Post fields (hex) + `karmaLockTx` (JSON-serialized UtxoTransaction) | `{ postId, status: "pending", expiresAtHeight, txId }` (200) | 400 on validation failure |
| `GET` | `/posts/:id` | — | Post object (`id`, `status`, `likeCount`, `likers`) or Stump object | 404 |
| `GET` | `/posts/:id/thread` | — | `{ post, ancestors, descendants }` — full thread context | 404 |
| `GET` | `/posts` | `?author=hex&limit=50&offset=0` | Post[] (`id`, `status`, `likeCount`, `likers`, live only, no stumps) | — |

**Post submission flow (mempool-based):**

Sub-block assembly, lifecycle, and ordering block integration are defined in
`SUBBLOCK_INTERFACE.md`.

1. Decode hex fields (`author`, `challenge`, `signature`) to binary; parse `karmaLockTx`
2. Validate field presence, content length (1–300 bytes)
3. Run `verifyPost()` — includes challenge check, PoW, signature, parent refs,
   content limits, protocol version, karma sufficiency
4. Compute `postId = computePostId(post)` — server-authoritative
5. Store post (status = pending) with raw CBOR
6. Consume challenge
7. Assemble sub-block: `{ subBlockId: postId, post, likeBoxes: [], producerId: author, protocolVersion }`
8. Insert both as a batch into mempool (same `batchId = postId`):
   - `insertMempoolSubBlock(subBlock, expiresAtHeight, batchId)`
   - `insertUtxoTx(karmaLockTx, batchId, expiresAtHeight)`

The karma-lock UTXO transaction is built and signed **client-side** and sent as
`karmaLockTx` in the request body. The server validates it, does NOT build it.
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
| `POST` | `/likes` | `{ tx: UtxoTransaction }` — client-signed like tx | `{ status: "pending", txId, expiresAtHeight }` or `{ status: "free", likeId }` | 400 if post unknown or pruned, 400 if insufficient karma, 400 if already liked |
| `POST` | `/likes/remove` | `{ tx: UtxoTransaction }` — client-signed unlike tx | `{ status: "pending", txId, expiresAtHeight }` | 400 if post unknown or pruned, 404 if like not found |

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
| `POST` | `/invites` | `{ tx: UtxoTransaction }` — client-signed create tx | `{ status: "pending", txId, expiresAtHeight, secretHash: hex, inviteBoxId, bondBoxId }` | 400 if insufficient karma, 400 if exceeds `MAX_PENDING_INVITES` |
| `POST` | `/invites/commit` | `{ tx: UtxoTransaction }` — client-signed commit tx (step 1 of 2) | `{ status: "pending", txId, expiresAtHeight }` | 400 if hash mismatch, missing/invalid committed-invitee signature, or invalid bond state |
| `POST` | `/invites/claim` | `{ tx: UtxoTransaction }` — client-signed claim tx with preimage (step 2 of 2) | `{ status: "pending", txId, expiresAtHeight, userId, karmaBoxId }` | 400 if hash mismatch, 400 if publicKey already an account |
| `POST` | `/invites/cancel` | `{ tx: UtxoTransaction }` — client-signed cancel tx | `{ status: "pending", txId, expiresAtHeight }` | 400 if already claimed, 403 if not inviter |

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

**Commit flow** (step 1 of 2 — binds the invitee to the bond):

1. Verify `blake2b512(secret).subarray(0,32) === inviteBox.secretHash`
2. Build UTXO transaction: spend the uncommitted BondBox → committed BondBox
   (set `inviteePublicKey` to the invitee's key, plus `probationStartBlock` /
   `probationEndBlock`)
3. The `bond_dual` commit guard verifies a **valid Ed25519 signature from the
   committed invitee** — the output BondBox's `inviteePublicKey` (audit H-2).
   This runs in `checkGuards`/`validateTx`, so it holds on every path (local,
   gossip relay, reorg). Revealing `s` no longer authorizes a commit by itself,
   and a commit cannot bind a key the committer does not control.
4. Insert into mempool: `insertUtxoTx(tx, null, expiresAtHeight)`; return
   `{ status: "pending", txId, expiresAtHeight }`

> **Known-open (deferred).** The invite is a bearer instrument — `s` identifies
> the holder, not a pre-named invitee — so an observer who learns `s` can still
> commit under their *own* key. The guard authenticates the committer; it does
> not bind the invite to a specific invitee. Closing that front-run needs the
> invitee bound at invite creation (e.g. `secretHash = H(s ‖ inviteePubkey)`),
> deferred to the karma-econ emission-model design.

**Claim flow** (step 2 of 2 — requires the bond already committed):

1. Verify the BondBox is committed (`inviteePublicKey` is 32 bytes) — a reveal
   before commit is rejected
2. Verify `publicKey` is not already associated with an existing account
3. Build UTXO transaction: consume the InviteBox and the committed BondBox;
   create the invitee's KarmaBox (value N, `owner = publicKey`, which must equal
   the committed `inviteePublicKey`) — account now exists
4. `validateTx` verifies the `hash_preimage_with_bond` guard (preimage `s` +
   committed-bond cross-input) and the transitions
5. Insert into mempool: `insertUtxoTx(tx, null, expiresAtHeight)`; return
   `{ status: "pending", txId, expiresAtHeight }`

**Cancel flow:**

1. Verify invite is unclaimed
2. Verify signature matches inviter's key
3. Build UTXO transaction: consume InviteBox + BondBox, create new KarmaBox
   returning both values to inviter
4. Insert into mempool: `insertUtxoTx(tx, null, expiresAtHeight)`
5. Return `{ status: "pending", txId, expiresAtHeight }`

### Vouches

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| `POST` | `/vouches` | `castVouch` | Signed UTXO tx (KarmaBox to KarmaBox + VouchBox) |
| `DELETE` | `/vouches/:targetId` | `initiateUnvouch` | Signed UTXO tx (VouchBox to none) |
| `GET` | `/vouches?target=X` | `getVouchesForTarget` | List vouchers for identity |
| `GET` | `/vouches?voucher=X` | `getVouchesByVoucher` | List who identity vouches for |
| `GET` | `/vouches?voucher=X&cooldowns=1` | `getVouchCooldowns` | Active cooldowns |

**Single active vouch (L-4):** each identity may vouch for at most one target
at a time (ARCHITECTURE invariant). `castVouch` rejects when the voucher has
ANY active VouchBox — not merely one for the same target — or any pending
vouch transaction in the mempool (`hasPendingVouch`). The pair-scoped
cooldown check (no re-vouch of the same target during its cooldown) is
unchanged.

**Route error policy (L-12):** services signal intentional, client-safe
rejections with a typed client-error class; route handlers return its message
with the mapped status (400/404/409). Any other thrown error returns a
**generic** body (`{ error: "Internal error" }`, 500) and is logged
server-side with full detail — `err.message` from unexpected errors never
reaches a response. `MempoolFullError` maps to 503 with a generic
"mempool full" body. Applies to all tx-submitting routes (posts, likes,
invites, vouches, credits, faucet, prune).

### Pruning

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/posts/:id/prune` | `{ rootPostHash: hex, authorId: hex, subtreeMerkleRoot: hex, subtreePostIds: hex[], signature: hex(128), trigger?: "author"\|"storage_prune" }` | `{ status: "deleted", entryId: hex, postId: hex, replyCount: number }` (201) | 400 if post is not root (has parent), 403 if not author, 404 |

**Prune flow:**

1. Client walks reply subtree locally, builds Merkle root over postIds,
   signs `blake2b512(rootPostHash || subtreeMerkleRoot).subarray(0,32)`
   with Ed25519 key
2. Node verifies: post exists and is live, author matches, signature valid,
   subtreePostIds match actual reply tree, Merkle root matches postId list
3. Node builds PruneEntry, enqueues in mempool, broadcasts simplified Stump
   to peers
4. At block application: verify authorship binding (`entry.authorId` equals
   the `block_topology`-recorded author of `rootPostHash`; reject the block if
   no topology row exists — an unconfirmed root is not prunable), verify
   signature, verify topology via block_topology CTE, verify Merkle root,
   settle UTXO deterministically (consume PostLockBoxes and LikeBoxes, mint
   refund karma), prune DAG content

### UTXO queries

| Method | Path | Response | Errors |
|--------|------|----------|--------|
| `GET` | `/karma/:userId` | `{ userId: hex, total, boxes: [{ boxId, value }] }` | — |
| `GET` | `/credits/:userId` | `{ userId: hex, total, boxes: [{ boxId, value, lockedUntilBlock? }] }` | — |
| `GET` | `/invites/:userId` | `{ pending: InviteBox[], bonds: BondBox[] }` | — |

Multi-box UTXO model — identities can hold multiple karma/credit boxes.
`total` is the sum across all boxes. **`value` and `total` are decimal strings** in
the JSON (box values are `bigint`; JSON cannot carry one) — clients parse them with
`BigInt(...)`. Applies to every response carrying a `value`/`total` (`/karma`,
`/credits`, `/status` totals, mining template, etc.). See "Values are BigInt (P0)".

### Credits (testnet)

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/credits/transfer` | `{ from: hex, to: hex, amount, signature: base64, expectedHeight }` | `{ sent, change?, txId }` | 400 if insufficient |
| `POST` | `/credits/faucet` | `{ to: hex }` | `{ amount, txId }` | 403 if not testnet, 409 if already funded |

### Blocks

| Method | Path | Response | Errors |
|--------|------|----------|--------|
| `GET` | `/blocks/:height` | OrderingBlock object (JSON with hex fields) | 400 if NaN, 404 |
| `GET` | `/blocks/current` | `{ height, hash }` | — |

### Faucet (testnet only)

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/faucet` | `{ userId: hex }` | `{ status: "pending", txId, expiresAtHeight }` | 400 if missing fields, 403 if not testnet, 409 if already funded |

Grants 100 karma to an identity, **once per identity, ever** (idempotent). Mints
from the system keypair — not a transfer. Builds a UTXO transaction creating a
new karma box and inserts it into the mempool. Gated behind
`networkMode === "testnet"`.

**Idempotency (required):** a given `userId` may be funded at most once, ever. A repeat
request is rejected (409). Enforced by a durable per-`(userId, asset)` grant ledger
(`faucet_grants`) written in the **same transaction** as the mempool insert, so two
same-block calls cannot both succeed. Backed by a settled faucet-origin karma-box check
(`proof_source = 'faucet'`, ignoring spent — covers grants issued before the ledger and
prevents spend-then-redraw) and a mempool scan (covers grants relayed by gossip). Credits
rely on the ledger + mempool scan only, since a settled credit box carries no faucet marker.
The same one-grant rule applies to `POST /credits/faucet`.

### Mining

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `GET` | `/mining/template` | `?miner=hex(32)` optional payout override | Template (nested header + body sections + `powPreimage`) — see `MINING_INTERFACE.md` | 400, 401, 404 |
| `POST` | `/mining/submit` | `{ powNonce: number, height: number }` | `{ blockHash, height }` (201) | 400, 401, 422 |

Mounted **only** when `NODE_ROLE=miner` **and** `MINING_MODE=external`
(internal mining is in-process and exposes no mining HTTP surface). External
mode requires a configured non-empty `MINING_SECRET` — startup fails
otherwise; there is no unauthenticated passthrough. Every request needs
`Authorization: Bearer <MINING_SECRET>` (constant-time comparison), and the
`?miner=` coinbase payout override sits behind that auth (audit M-7). Full
endpoint semantics in `MINING_INTERFACE.md`.
### Status

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/status` | `{ networkMode, blockHeight, postCount, pendingPosts, totalKarma, totalCredits }` |

### Link previews

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/preview/:id` | OG-tagged HTML page with JS redirect to the demo UI |

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
PoW (stateless, re-verified), signature (stateless, re-verified), and parent
ref existence. Karma is NOT checked on relay — the block producer (miner)
already verified economic rules before creating the sub-block.

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
4. Value conservation: `sum(input values) == sum(output values)` for **every** box
   type. The exceptions are the two deliberate **zero-output burns** that move value
   out of the UTXO set by design: a **BondBox burn** (bond forfeited on probation
   failure) and a **VouchBox burn** (unvouch — the staked karma is escrowed off-UTXO
   in `vouch_cooldowns` and re-minted to the voucher at maturity). All other user
   transactions — including karma, like, and vouch *cast* — conserve value; karma/
   credit mint and burn happen only in block-application paths (like rewards, decay,
   coinbase, bond forfeiture), never inside a user transaction. Box `value` fields
   must be non-negative `bigint` base units `< 2⁶⁴` (enforced at the JSON→tx boundary
   via `assertValidBoxValue` and in the engine via `checkOutputValues` — a negative
   value could otherwise balance the sums while minting into a sibling box).
   Conservation sums are `bigint` (P0 — see "Values are BigInt")
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

Lightweight liveness-only re-check (are inputs still unspent?). **Not sufficient
for block application on its own** — a permissionless block producer can embed a
tx that never passed pool entry or relay validation, so signatures, guards,
transitions, and conservation must NOT be assumed. Block finalization fully
re-validates every embedded tx with `validateTx` (see Block finalization step 5).
`revalidateTxInContext` remains available for the mempool's own staleness pruning,
where the tx was already validated on entry — never as the sole gate on applying
an untrusted, block-embedded tx.

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

**The clock moves to committed state (Spec G).** `isIdentityStale` and
`owedPeriods` read box `createdAtBlock` today. Boxes stop carrying a height, so
the clock becomes the `IdentityRecord` (Store Interface → Identity Records):

```
stale       = (height − lastActivityBlock) >= staleThresholdBlocks
owedPeriods = floor( (height − max(lastActivityBlock, lastDecayBlock)) / interval )
```

⚠ **The comparison is `>=`, not `>`.** This contract and Spec G §3.4 both said
`>`, and both were wrong by one block. `isIdentityStale` treats a box as recent
when `createdAtBlock > currentHeight − threshold`, so an identity is stale
exactly when *no* box satisfies that — i.e. when
`currentHeight − lastActivityBlock >= threshold`. `>` would delay every
identity's first decay by one block, which is a behaviour change D10 forbids.
Found by the phase D session against the code.

**Staleness is unchanged.** Today's test is "no unspent non-decay-burn karma box
newer than the threshold", and a non-decay karma box is created exactly when the
owner is touched, so `lastActivityBlock` is the max over those heights and the
predicate is the same.

**`owedPeriods` changes, deliberately — one accepted exception to D10.** The old
code measures from the **oldest** non-decay box (falling back to the youngest
when all are decay-burn). The record measures from the **most recent** activity.

Spec G §3.4 claimed these were equivalent, on the premise that forced
consolidation means one karma box per owner so oldest == newest. **That premise
is false:** `faucet-service.ts` creates karma boxes directly, bypassing
`mintKarma`'s consolidation, so two unspent non-decay karma boxes at different
heights is reachable — and the two formulas then disagree. Measured on the phase
D fixture: a burn of 45 under the old rule, 30 under the new.

The new behaviour is the intended one — "time since you were last active" is
what a decay clock means, and measuring from the oldest surviving box is an
artifact of reading box ages rather than a clock. **User-accepted 2026-08-05**,
taken deliberately pre-network rather than discovered later. Pinned by
`test/fixtures/decay-divergence.json`.

Everything else in this unit stays behaviour-identical; any *other* difference is
a bug, not a design change. The decay *trigger* change (bonded posts) belongs to
the karma-economics track.

**Phase D owns this switch**, along with populating the record —
`lastActivityBlock` on non-decay karma creation, `lastDecayBlock` when decay
fires — and a golden-output equivalence harness captured from the current
implementation *before* the change.

---

## Box Identity and Mint Provenance (Spec G)

Every box id derives from its creating transaction
(`TYPES_INTERFACE.md` → BoxId). Boxes created by **block application** rather
than by a user transaction — coinbase, karma mints, decay, epoch post-locks,
genesis — have no transaction, so each mint *event* derives a synthetic one:

```
mintTxId = blake2b512( MINT_ID_DOMAIN ‖ u32BE(height) ‖ reason ‖ subject )[0:32]
boxId    = blake2b512( BOX_ID_DOMAIN ‖ canonicalBoxBytes(candidate) ‖ utf8(mintTxId) ‖ u32BE(index) )[0:32]
```

Box derivation is then identical to the user-transaction path — one derivation,
not two.

### The subject encoding rule

> **Every per-reason `subject` encoding MUST be fixed-length or
> self-delimiting.** `subject` carries no length prefix, so within a single
> reason two different subjects could otherwise concatenate to identical bytes
> and collide. *Across* reasons uniqueness holds unconditionally — no
> `MintReason` is a prefix of another (verified and test-pinned in types) — but
> that says nothing about within-reason collisions. `@dagsocial/types` cannot
> enforce this: it takes `subject: Uint8Array` and the caller owns the bytes.
> **This contract is the other half of that guarantee.**

Two byte-form rules, both inherited from `TYPES_INTERFACE.md` → Pinned byte
forms, so a mirror implementation derives the same ids:

- a value typed as a **hex string** (`PostId`, `TxId`) enters as the UTF-8 bytes
  of its hex text, never as decoded bytes;
- a value typed as **`Uint8Array`** (`UserId`, pubkeys) enters as its raw bytes.

### Reason and subject table

| `reason` | Subject | Encoding | Bytes | Site |
|----------|---------|----------|-------|------|
| `coinbase` | coinbase output index | `u32BE(i)` | 4 | `applyMutationPhase` → `mintCredits`, per coinbase output |
| `vouch-settle` | `(voucherId, targetId)` | raw ‖ raw | 64 | `processVouchCooldowns` → `mintKarma` |
| `author-reward` | `targetPostId` | `utf8(hex)` | 64 | epoch tally → `mintKarma(post.author, …)` |
| `liker-refund` | `(targetPostId, likerId)` | `utf8(hex)` ‖ raw | 96 | epoch tally → `mintKarma(liker, refund)` |
| `postlock-unlock` | `targetPostId` | `utf8(hex)` | 64 | epoch tally → `mintKarma(post.author, postLockKarmaUnlocked)` |
| `postlock-remainder` | `targetPostId` | `utf8(hex)` | 64 | `block-creator.ts` epoch tally, remainder `PostLockBox` |
| `decay` | `owner` | raw | 32 | `applyKarmaDecay` |
| `genesis` | which genesis box | `u32BE(k)`: `0` = system karma, `1` = faucet credits | 4 | `ensureSystemKarmaBox` / `ensureFaucetCreditBox` |

Every encoding above is **fixed-length**, so the rule holds by construction
rather than by inspection.

⚠ **`genesis` deliberately does not use the ASCII tags `system-karma` /
`faucet-credits`** that Spec G §3.2 sketched. Those are variable-length and
neither self-delimiting nor fixed — they are merely *prefix-free*, which happens
to be sufficient for this pair but is not a property the rule can check per
encoding. A `u32BE` selector satisfies the rule outright. Adding a third genesis
box then costs one integer, not a re-examination of prefix-freeness.

`reason` is the discriminant that separates `author-reward` from
`postlock-unlock`, which otherwise mint to the same author, for the same post,
at the same height.

### `index` is always 0 for mints

Each mint event emits exactly one box, so its `index` is `0`. Multi-output
coinbase is **N events, not one N-output transaction**: each output gets its own
`subject` and its own synthetic txId. That reflects what the code does — each
`mintCredits` call merges a *different* set of pre-existing boxes, so the outputs
share no input set and are not one transaction in any meaningful sense. The
`index` field exists so mint and transaction derivation share one code path.

### Which producers attach provenance, and which deliberately do not

A box gets provenance **where it is stored**, not where it is first constructed.

- **Mint sites** derive a synthetic txId from their `MintContext` and use
  `index` 0.
- **The apply path** materialises transaction outputs through the single
  `materializeOutput(box, txId, index)` rule — both the mempool path
  (`validateTx`) and the block-embedded path go through it, so there is one
  materialisation rule rather than two chances to place the keys differently.
- **Transaction builders that insert boxes** (`invites.ts`, `credits.ts`)
  materialise through the same helper, because their predicted ids are acted on
  by clients.
- **Builders that only hand a transaction to the mempool** — `faucet-service.ts`
  and `routes/utxo.ts` — attach **nothing**. They insert no box and return no
  predicted id; their outputs' `id` fields are vestigial, and phase G turns
  `UtxoTransaction.outputs` into `BoxCandidate[]`, which carries *less*. Their
  boxes get provenance when block application materialises them. Attaching there
  would ride the wire for no consumer, have to be undone at phase G, and widen
  the attacker-controlled-key surface (1c) to paths that currently have none.

`u32BE` is **module-private in `@dagsocial/types`**, so `mint-provenance.ts`
mirrors it, sentinel behaviour included. A silent divergence would move mint
txIds with nothing to catch it, and this contract's own subject table mandates
the encoding — **types should export it** (phase G, with the other types work).
The demo UI mirror must reproduce the sentinel too, and must not throw.

### The demo UI mirror carries the same strip defect (phase E)

`public/index.html`'s client-side `computeBoxId` does `const { id, ...rest } = box`
— the **id-only strip** that phase C0 removed from `@dagsocial/types`. Both of
its call sites hash **client-built** boxes carrying no provenance (the predicted
`inviteBoxId`, and the cached LikeBox id for unlike), so server and client agree
today and phase C does not change that.

It is a latent trap rather than a live defect: the first time the UI hashes a
**server-returned** box — which carries `txId`/`index` from phase C on — it
would hash provenance into a legacy id and silently disagree with the node.
Since both flows depend on the client *predicting* an id the node will later
agree with, that disagreement would surface as a dangling `bond.inviteBoxId` or
an unspendable LikeBox, not as a visible error.

**Phase E obligation**, alongside teaching the mirror the domain tag,
`utf8(txId)` and `u32BE(index)`: fix the strip rule in the same pass. *(Found by
the phase C0 session, which correctly did not touch it — `public/index.html` is
the node package's file.)*

### Phase G checklist — everything the tightening phase owes

Obligations have accumulated across phases B–D and are stated where they were
found, which is right for context and wrong for not missing any. Consolidated:

**Format tightening (the phase's own work)**

1. `computeBoxId` switches to the provenance derivation; `TX_ID_DOMAIN` is
   applied to `computeTxId`. Both move every id — this is the one phase where
   that is allowed, and every id-asserting test updates together.
2. `txId`/`index` become **required** on `BoxBase`; `UtxoTransaction.outputs`
   becomes `BoxCandidate[]`.
3. `createdAtBlock` and `lastTouchBlock` are deleted from the box protocol. The
   `created_at_block` **column** stays (store-only, never a consensus input).
4. `utxo_boxes.tx_id` / `output_index` become `NOT NULL`.

**Correctness debts that only become enforceable here**

5. **Canonical key ordering in both encoders** (→ "1b"). Lexicographic key sort
   is the simplest total rule. This subsumes the `post_lock` producer-vs-
   `rowToBox` field-order violation, which must **not** be fixed by reordering
   that one site, and it retires the attacker-key-position hazard (→ "1c").
6. **Attach-provenance-before-deriving-the-id** becomes testable (phase C report
   §5.1). Today `canonicalBoxBytes` strips provenance, so both orders are
   byte-identical and the discipline is unenforced.
7. **The journal-height rule becomes forced** (phase D). `insertBox` must take
   the height from the open journal, not from `box.createdAtBlock` — currently
   indistinguishable, because every production karma producer sets
   `createdAtBlock` to the block height anyway. Deleting the field is what
   proves it.

**Blockers — these make phase G *fail* if not done first**

8. **`settlePruneUtxo` has no mint reason.** Its two `mintKarma` sites pass
   `null`, which is harmless only while the columns are nullable. Item 4 turns
   it into a hard failure. Needs new `MintReason` member(s) in types plus the
   subject encoding, and the subject must carry the prune entry's identity —
   `settlePruneUtxo` runs *per entry*, so two entries in one block can otherwise
   collide on `(height, reason, subject)`.
9. **`u32BE` should be exported from `@dagsocial/types`.** `mint-provenance.ts`
   currently mirrors it, sentinel included; a silent divergence would move mint
   txIds with nothing to catch it.

Items 6 and 7 share a shape worth noting: a rule that is *correct* but
*unenforceable* while the legacy field still exists. Neither is a defect today;
both are why phase G is the phase that closes the design rather than merely
tidying it.

### Discriminants are semantic, never positional

A mint's identity MUST NOT derive from its position in the journal, the block,
or any iteration order. Position-derived identity would put ordering back into
*identity* — strictly worse than the M-12 ordering bug P2 closed for the AVL
feed, because there the fix was a sort at one boundary, whereas an
order-dependent id is baked into committed state and unrecoverable.

**Adding a mint reason** therefore requires three things in one unit: the ASCII
tag added to `MintReason` in types, a fixed-length or self-delimiting subject
encoding added to the table above, and an argument at the call site that
`(height, reason, subject)` cannot repeat.

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
15b. Compute `stateRoot` — the **post-block** digest (see "Post-block
    stateRoot" below). Never the creator's current (pre-block) digest.
16. Build block template (powNonce=0, empty signature)
17. **Internal mode:** mine PoW, sign the header hash (`blockHash(header)`), finalize
18. **External mode:** store template for `GET /mining/template`,
    return null (block finalized when miner submits via `submitMinedBlock`)

### Block finalization

1. Store block in `block_ordering` table
2. Apply coinbase — mint credits for each output
3. Broadcast ordering block to peers
4. Confirm sub-blocks and their posts (`confirmPost`)
5. Apply UTXO transactions — for each embedded UTXO tx, once its inputs are all
   present, **fully re-validate with `validateTx`** (signatures, guards,
   transitions, conservation — not just liveness), then apply (`applyTx`). A block
   producer is untrusted (permissionless PoW), so nothing is assumed verified. **If
   a tx whose inputs are present fails validation, the entire block is rejected**
   and nothing is applied — a valid block must not contain an invalid tx. This runs
   on every apply path (local finalization, gossip receipt, reorg). The multi-pass
   handling of input *presence* is unchanged: a tx whose inputs are not yet present
   is deferred and retried (intra-block dependency). Idempotent: skips boxes already
   inserted or spent (survives gossip loopback).
6. Remove confirmed entries from mempool (`removeEntry` for each confirmed rowid)
7. Reset pending counter and template

### Mining modes

| Mode | Block creator | Block finalization | Template endpoint |
|------|--------------|-------------------|-------------------|
| `internal` (default) | Timer + trigger | PoW solved internally | N/A (routes unmounted) |
| `external` | Timer + trigger | Via `submitMinedBlock` | `GET /mining/template` (bearer-authed) |

In external mode, the block creator builds a template with `powNonce=0` and
stores it. External miners poll the template endpoint, solve PoW, and submit
via `POST /mining/submit`. The node verifies PoW, signs, and finalizes.

### Post-block stateRoot (H-6)

`header.stateRoot` commits to the UTXO state **after** this block is applied
(ARCHITECTURE → AVL+ State Root). PoW covers the header, so the producer must
know that digest **before** mining — it cannot be filled in afterwards.

**It is obtained by running this block's own body through the same code the
apply path runs**, never by a second implementation of the state transition:

1. Snapshot the prover digest.
2. In a SQLite transaction that is always rolled back, run the block's
   **mutation phase** (see "Apply funnel: validation and mutation phases")
   at the block's height, then derive the prover feed from the resulting
   journal and compute the digest exactly as apply does.
3. Roll the transaction back and restore the prover to the snapshot
   (`prover.rollback`) — SQLite rollback does not reach the prover's
   in-memory state.
4. Use the computed digest as `header.stateRoot`, then mine.

The speculative run passes **no `DagService`** (its canonical-branch updates
are in-memory and would survive the rollback; they touch no UTXO box, so the
digest is unaffected), and performs no block storage, no `clearTemplate`, no
journal persistence, and no prover checkpoint.

A producer with no prover initialized writes `EMPTY_STATE_ROOT`. Production
nodes always initialize one at startup, so this is a test-only path — but a
node running with `VERIFY_STATE_ROOT` enabled will reject such a block, which
is correct.

**External mining.** The template's `stateRoot` is computed at template-build
time and the block is submitted later. This stays sound because any competing
block that applies at the same height calls `clearTemplate()`, so a template
whose pre-state has moved can no longer be submitted. `submitMinedBlock`
therefore depends on template invalidation for **state-root** correctness, not
merely for height correctness.

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

### Difficulty schedule

`powTargetBits` is a deterministic function of block height — Phase 1 is a
fixed target (`expectedTarget(height) = ORDERING_BLOCK_POW_TARGET_BITS`),
enforced at apply on every path: a block whose header target differs from the
schedule is rejected. There is **no wall-clock retargeting** — the previous
duration-ratio adjustment was removed because it made the target a function of
local wall time (audit M-2). Normative spec: `MINING_INTERFACE.md`
("Difficulty Schedule").

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
| `getPostRaw(id)` | `(string) => Uint8Array \| null` — raw CBOR for hash verification |
| `queryPosts({ author?, limit, offset })` | `(QueryOpts) => Post[]` — live only, newest first |
| `getPendingPosts(limit)` | `(number) => Post[]` — oldest first |
| `confirmPost(postId, blockHeight)` | `(string, number) => void` |
| `unconfirmPost(subBlockId)` | `(string) => void` — for fork rollbacks |
| `getParentRefs(postId)` | `(string) => PostId[]` |
| `getAncestors(postId)` | `(string) => Post[]` — walk up parent chain, genesis → parent |
| `getSubtree(postId)` | `(string) => Post[]` — all descendants (recursive CTE) |
| `pruneSubtree(rootPostId)` | `(string) => void` — mark subtree as pruned |
| `insertPostPlaceholder(postId, parentRefs)` | `(string, string[]) => void` — for block-synced posts |

### Likes (DAG)

| Function | Signature |
|----------|-----------|
| `insertLike(targetPostId, likerId)` | `(PostId, UserId) => string` — free like, returns likeId |
| `hasLiked(targetPostId, likerId)` | `(PostId, UserId) => boolean` — checks both dag_likes and utxo_boxes |
| `getLikeCount(postId)` | `(PostId) => { locked: number, free: number }` |
| `getUnprocessedFreeLikes()` | `() => FreeLike[]` |
| `markFreeLikesProcessed(likeIds)` | `(string[]) => void` — records processed ids while a block journal is open |
| `markFreeLikesUnprocessed(likeIds)` | `(string[]) => void` — fork-rollback inverse (never records) |

### UTXO

| Function | Signature |
|----------|-----------|
| `getBox(boxId)` | `(string) => AnyBox \| null` |
| `getUnspentBoxes()` | `() => AnyBox[]` — all unspent boxes (for AVL bootstrapping) |
| `getKarmaBox(owner)` | `(Uint8Array) => KarmaBox \| null` — single box (backward compat) |
| `getKarmaBoxes(owner)` | `(Uint8Array) => KarmaBox[]` — multi-box listing (full boxes, keyed on `id` — the contract previously said `{ boxId, value }[]`, which was never the implementation) |
| `getCreditBox(owner)` | `(Uint8Array) => CreditBox \| null` — single box |
| `getCreditBoxes(owner)` | `(Uint8Array) => CreditBox[]` — multi-box, `ORDER BY value DESC` (the contract previously said `{ boxId, value, lockedUntilBlock? }[]`, which was never the implementation) |
| `getUnlockedCreditBoxes(owner, blockHeight)` | `(Uint8Array, number) => CreditBox[]` |
| `getPendingInvites(inviterId)` | `(UserId) => InviteBox[]` — unclaimed, unexpired |
| `getPendingInviteCount(inviterId)` | `(UserId) => number` |
| `getBondBoxes(inviterId)` | `(UserId) => BondBox[]` — active bonds |
| `getLikersForPost(postId)` | `(string) => string[]` — hex user IDs who liked |
| `getLockedLikeBoxes(postId)` | `(PostId) => LikeBox[]` — all locked like boxes for a post |
| `getUnspentLikeBoxes(targetPostId)` | `(PostId) => LikeBox[]` — unspent LikeBoxes for a post (prune settlement) |
| `getUnprocessedLockedLikeBoxes()` | `() => LikeBox[]` — pending epoch tally |
| `getUnspentPostLockBoxes()` | `() => PostLockBox[]` |
| `getPostLockBox(targetPostId)` | `(string) => PostLockBox \| null` |
| `getPostTotalLikes(postId)` | `(PostId) => number` — locked + free |
| `insertBox(box)` | `(AnyBox) => void` — writes the provenance columns; records `{kind:'box', op:'insert', boxId, box}` while a block journal is open |
| `consumeBox(boxId, consumedAtBlock)` | `(string, number) => void` — mark as spent; records `{kind:'box', op:'remove', boxId}` while a block journal is open |
| `unconsumeBox(boxId)` | `(string) => void` — un-mark spent (fork-rollback inverse; never records) |
| `deleteBox(boxId)` | `(string) => void` — (fork-rollback inverse; never records) |
| `markLikeBoxesTallied(boxIds)` | `(string[]) => void` — after epoch processing (sentinel spend `-1`); records `{kind:'box', op:'remove', boxId}` per box while a block journal is open |

#### Box provenance columns (Spec G phase B)

`utxo_boxes` carries each box's creating-transaction provenance, because
`BoxBase` does (`TYPES_INTERFACE.md` → BoxId):

| Column | Type | Meaning |
|--------|------|---------|
| `tx_id` | `TEXT` | Creating transaction — real, or synthetic (→ "Box Identity and Mint Provenance") |
| `output_index` | `INTEGER` | u32 position within that transaction's outputs |

`rowToBox` restores both onto every box it reconstructs; `insertBox` writes
them. `id TEXT PRIMARY KEY` stays and **becomes sound at phase G**: two
byte-identical boxes in one block currently collide on it (a plain `INSERT`
throws and the totality catch rejects the whole block), which provenance-derived
ids make structurally impossible. Do not paper over the window with
`INSERT OR REPLACE` — that would silently drop a box.

`UNIQUE(tx_id, output_index)` is required. A `(txId, index)` pair names exactly
one box by construction, so no valid block can trip it; the constraint turns a
derivation bug into a loud failure rather than silent state corruption.

**Migration window (phases B–F):** both columns are nullable, and the unique
index tolerates that because SQLite treats NULLs as distinct — producers do not
set provenance until phase C. **Phase G makes them `NOT NULL`.**

#### `created_at_block` is a store column, never a consensus input

`createdAtBlock` left the box protocol (Spec G D3): it was the only
apply-mutated field, and that is what made box ids dishonest (M-11). The
**column** survives, written at apply from the *settled* height, and is
therefore honest by construction.

> ⚠ **Consensus code MUST NEVER read `created_at_block`.** It is not committed
> in the `stateRoot`, so a node bootstrapping from an AVL snapshot cannot
> reconstruct it. A consensus read would be an undetectable divergence surface:
> two nodes agreeing on every committed byte could still disagree. No assertion
> can enforce this — it is a contract and code-review rule.

Legitimate readers are `getUnspentBoxes` ordering and display.
**`getUnspentBoxes` feeding `bootstrapAvlProver` is not a counterexample:** the
bootstrap sorts by boxId at the prover boundary (M-12), so the SQL order never
reaches the tree. That sort is what makes this column safe to keep.

Consensus reads its heights elsewhere — locks from `lockedUntilBlock`, bond
probation from `probationStartBlock`/`probationEndBlock`, the decay clock from
the identity record below. During the migration window `createdAtBlock` is
still a *box field* (`TYPES_INTERFACE.md` → Migration window) and `decay.ts`
still reads it, so the column does reach consensus transitively until phase D
moves the clock. Closing that is exactly what phase D is for; phase G then
deletes the field and leaves the column with no consensus reader at all.

### Identity Records (Spec G phase B)

The second committed entity alongside boxes: the per-identity decay clock.
Once boxes carry no height, `decay.ts` has nothing to read from them, so the
clock has to live in committed state (Spec G D4).

```
IdentityRecord {
  lastActivityBlock: number   // u32 — bumped when a non-decay karma box is created for the owner
  lastDecayBlock: number      // u32 — bumped when decay fires
}
```

**AVL key** — `blake2b512( IDENTITY_KEY_DOMAIN ‖ identityId )[0:32]`, **never
the raw `identityId`.** Records and boxes share one 32-byte AVL keyspace, and
an `identityId` is 32 *attacker-chosen* bytes (a public key): used raw, someone
could grind a keypair whose pubkey equals a live box id and collide the two
entity kinds in the tree. Hashing under a domain tag makes that infeasible and
is what makes the two kinds provably disjoint.

**Table:** `identity_records (identity_id BLOB PRIMARY KEY, last_activity_block
INTEGER NOT NULL, last_decay_block INTEGER NOT NULL)`. The SQL table keys on
the raw 32 bytes; the AVL key is derived. Both are total functions of the
identity, so the two representations cannot drift.

| Function | Signature |
|----------|-----------|
| `getIdentityRecord(identityId)` | `(UserId) => IdentityRecord \| null` |
| `putIdentityRecord(identityId, record)` | `(UserId, IdentityRecord) => void` — upsert; while a block journal is open, captures the row it replaces and records `{kind:'record', key, record, replaced?}` |
| `deleteIdentityRecord(identityId)` | `(UserId) => void` — fork-rollback inverse only; never records |

**Lifecycle:** created on first karma receipt, **never deleted** in normal
operation — only by rollback. Deleting at zero balance would keep the tree
smaller but would require revert to resurrect records with their exact prior
values; unbounded-but-simple is the deliberate choice at this stage.

**Key type is `UserId`. There is no separate identity type, and there should not
be one.** Spec G D5 originally called for a branded `IdentityId` alias over the
same 32 Ed25519 public-key bytes, on the reasoning that it would make future key
rotation a one-definition change rather than a re-keying of committed state.
That does not hold: box `owner`, `likerId`, `inviterId` and `voucherId` are the
same pubkey and all typed `UserId`, so if rotation ever lands, box *ownership*
has to move to the stable identity as well — otherwise karma stays owned by a
retired key. The two types would move together, not diverge, and the seam cannot
be exercised on the decay record alone. Branding buys safety only between things
that are structurally identical but semantically different; these are
semantically the same thing, so it buys nothing and costs a cast at every
boundary. **D5 is withdrawn** (spec corrected 2026-08-05).

`IDENTITY_KEY_DOMAIN` is unaffected — it separates the record's AVL key from the
box keyspace, which is a distinct concern from how the bytes are typed.

**Phase B builds this entity and does not populate it.** No producer calls
`putIdentityRecord` until phase D, and `decay.ts` keeps reading box heights
until then. A phase-B tree contains zero records — which is why the proof
endpoint's obligation (AVL+ State Root → "Two entity kinds") falls to phase D.

#### Populating the record (phase D)

- **`lastActivityBlock`** — bumped at the **store choke point**, `insertBox`,
  when the inserted box is a karma box with `decayBurn !== true`. That is
  exactly today's staleness predicate ("no unspent non-decay karma box newer
  than the threshold"), so the swap is behaviour-preserving by construction
  rather than by re-derivation.
- **`lastDecayBlock`** — bumped when decay fires for that owner.

**The height comes from the open journal, not from the box.** `insertBox` takes
no height, and `createdAtBlock` is the field Spec G is removing — reading it
would reintroduce the dependency phase D exists to delete, and would break
outright at phase G. The open journal already carries the block's height
(`beginBlockJournal(height)`), and that *is* the settled height. A narrow
accessor for it is the right seam; the record is only meaningful during block
application anyway, which is exactly when a journal is open.

With no journal open (bootstrap, non-block paths) `insertBox` records nothing,
consistent with every other choke-point hook.

**Genesis is the one box created with no journal open.** `ensureSystemKarmaBox`
runs at startup, so the system identity gets no record from the choke point. It
must be given one explicitly at `genesisHeight`, **not** left to a
default-to-zero: `genesisHeight` is `1` (`currentHeight > 0 ? currentHeight : 1`),
and a `{0, 0}` default makes the system identity go stale exactly one block
earlier than the old code did. With `threshold = 100`, the old predicate goes
stale at height 101 (`1 > 101 − 100` is false); `lastActivityBlock = 0` goes
stale at 100.

**`bootstrapAvlProver` MUST feed identity records, not only boxes.** It
currently walks `getUnspentBoxes` alone. Records reach the tree through the
journal during block application, so from phase D onward a node that restarts
with empty AVL storage would rebuild a tree containing **no records at all** and
compute a different `stateRoot` than one that stayed up — the same
restart-triggered fork class as 1a and 1c, introduced by populating the record.
Records are fed in the same canonical order as boxes (lexicographic by hex key).
A bootstrapped tree and a live tree must agree once records exist, and that
needs a test.

### Vouch Cooldowns

| Function | Signature |
|----------|-----------|
| `insertVouchCooldown(voucherId, targetId, releaseAtBlock, karmaAmount)` | `(UserId, UserId, number, bigint) => void` — `INSERT OR REPLACE`; while a block journal is open, records the insertion side-record, capturing any row it replaces |
| `getMaturedVouchCooldowns(currentHeight)` | `(number) => Cooldown[]` |
| `deleteVouchCooldown(voucherId, targetId)` | `(UserId, UserId) => void` — while a block journal is open, captures the row before deleting and records the deletion side-record (H-7 inverse); deleting a nonexistent row records nothing (the inverse of a no-op is a no-op); unrecorded when called from fork rollback (no journal open) |

### Block Topology

| Function | Signature |
|----------|-----------|
| `insertBlockTopology(postId, parentRefs, author, blockHeight)` | `(string, string[], string, number) => void` |
| `getSubtreeTopology(rootPostId)` | `(string) => Set<string>` |
| `getTopologyAuthor(postId)` | `(string) => string \| null` |
| `rollbackBlockTopology(blockHeight)` | `(number) => void` |

`block_topology` rows record `(post_id, parent_refs, author, block_height)` —
all sourced from the confirming block's `SubBlockEntry` (consensus data, never
from local DAG content). `author` is the entry's consensus-carried authorship
claim (audit H-3); `getTopologyAuthor` returns `null` for posts no applied
block has confirmed. Idempotent insert (first block to confirm a postId wins);
`rollbackBlockTopology` removes a reverted height's rows wholesale.

### Mempool

| Function | Signature | Description |
|----------|-----------|-------------|
| `insertMempoolSubBlock(sb, expiresAtHeight, batchId?)` | `(SubBlock, number, string?) => number` | Queue sub-block, returns rowid |
| `insertUtxoTx(tx, batchId, expiresAtHeight)` | `(UtxoTransaction, string?, number) => number` | Queue UTXO tx, returns rowid |
| `insertMempoolPrune(entry, expiresAtHeight)` | `(PruneEntry, number) => number` | Queue prune entry, returns rowid |
| `drainMempoolPrunes(limit)` | `(number) => PruneEntry[]` | Decode and return prune entries in FIFO order |
| `removeMempoolPrunes(entryIds)` | `(string[]) => void` | Remove confirmed prune entries by rowid |
| `getPendingEntries(limit)` | `(number) => PoolEntry[]` | FIFO-ordered pending entries |
| `purgeExpired(currentHeight)` | `(number) => number` | Remove entries past expiry, returns count |
| `hasPendingLike(targetPostId, likerId)` | `(string, string) => boolean` | SQL EXISTS over gate metadata — unbounded (M-8) |
| `countPendingInvites(inviterId)` | `(string) => number` | SQL COUNT over gate metadata — unbounded (M-8) |
| `hasPendingVouch(voucherId)` | `(string) => boolean` | SQL EXISTS over gate metadata (L-4) |
| `removeSubBlockEntries(postIds)` | `(string[]) => number` | Delete confirmed sub-block entries by id — replaces the fetch-and-find loop |
| `removeEntry(rowid)` | `(number) => void` | Remove confirmed entry by rowid |

All insert functions throw a typed `MempoolFullError` at `MAX_MEMPOOL_ENTRIES`
(default 10000). Three callers, three behaviors: routes map it to 503; gossip
relay handlers drop the entry and log; **reorg re-insertion**
(`services/fork-resolution.ts`, returning reverted txs/sub-blocks/prunes to the
pool) also drops-and-logs — it runs inside the chain-switch SQLite transaction,
so an escaping error would roll back the reorg and strand the node on the
lighter chain, turning mempool pressure into a consensus-liveness failure.
Full semantics in `MEMPOOL_INTERFACE.md`.

`PoolEntry`:
```
{
  rowid: number
  entryType: "subblock" | "utxo_tx" | "prune"
  subblockId: string | null
  utxoTxJson: string | null
  pruneEntryJson: string | null
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
| `deleteOrderingBlock(height)` | `(number) => void` — for fork rollback |

### Block Journal

The journal is the single source of truth for undoing a block and for feeding
the AVL prover (ARCHITECTURE → "Block application journal"). One CBOR-encoded
row per applied block, purged below `height − MAX_REORG_DEPTH` (20).

**Types are node-owned** (`src/store/journal.ts`). The former
`@dagsocial/types` journal exports — `BlockJournal`, `KarmaMint`,
`AppliedUtxoTx`, `DecayJournalEntry` — are removed from types; node was their
only consumer. (`applyKarmaDecay`'s return type moves into the node package
with it.)

```
BoxMutation {
  kind: 'box'
  op: 'insert' | 'remove'
  boxId: string                    // hex
  box?: AnyBox                     // full box — present iff op === 'insert'
}

RecordMutation {                   // Spec G phase B — identity records
  kind: 'record'
  key: string                      // hex — H(IDENTITY_KEY_DOMAIN ‖ identityId), the AVL key
  identityId: UserId               // the raw 32 bytes, so rollback can address the SQL row
  record: IdentityRecord           // the value written
  replaced?: IdentityRecord        // prior value — absent iff the key did not exist
}

JournalMutation = BoxMutation | RecordMutation

BlockJournal {
  blockHeight: number
  mutations: JournalMutation[]     // ordered, application order — state rollback + AVL feed
  confirmedSubBlockIds: string[]   // inverse: unconfirmPost; also mempool re-insertion
  appliedUtxoTxs: Array<{ txId: string, txCbor: Uint8Array }>   // mempool re-insertion only
  processedFreeLikeIds: string[]   // inverse: markFreeLikesUnprocessed
  vouchCooldownInsertions: Array<{ voucherId: UserId, targetId: UserId,
    replaced?: { releaseAtBlock: number, karmaAmount: bigint } }>
                                   // inverse: deleteVouchCooldown, then restore `replaced` if present
                                   // (insertVouchCooldown is INSERT OR REPLACE — exact inverse
                                   //  must restore a row it overwrote)
  vouchCooldownDeletions: Array<{ voucherId: UserId, targetId: UserId,
    releaseAtBlock: number, karmaAmount: bigint }>
                                   // inverse: insertVouchCooldown (restores the escrow row — H-7)
}
```

**One log, not parallel arrays (Spec G phase B).** `mutations` is a
discriminated union over **every committed entity**, not a box-only log with
sibling arrays. That is deliberate and load-bearing: a committed entity that
never reaches the prover feed is silently absent from the `stateRoot`, and
**no test can catch that** — the producer and the verifier omit it identically,
so they agree on a digest over incomplete state. Making the feed derivation
switch on `kind` turns "a new entity kind was added and nobody updated the
prover feed" into a TypeScript exhaustiveness error. That compile-time check is
the enforcement mechanism; do not replace it with a parallel
`recordMutations: RecordMutation[]` array, which reinstates exactly the
drift-by-omission shape P1 removed.

The typed side-records below (`confirmedSubBlockIds`, `vouchCooldown*`, …) stay
separate arrays because they are **not** in the `stateRoot` — they are node-local
bookkeeping with an exact inverse. `kind: 'record'` is the first entry that is
both journaled *and* committed, and that is the whole distinction.

**Recording (choke point).** `beginBlockJournal(height)` opens the journal at
the top of block application. While open, the store mutation primitives record
automatically: `insertBox` appends `{kind:'box', op:'insert', boxId, box}`;
`consumeBox` and `markLikeBoxesTallied` append `{kind:'box', op:'remove',
boxId}`; `putIdentityRecord` appends `{kind:'record', …}`, capturing the row it
replaces; `markFreeLikesProcessed`, `insertVouchCooldown`, and
`deleteVouchCooldown` append their side-records, capturing the affected row(s)
before writing. Services and call sites MUST NOT maintain parallel mutation
bookkeeping — record-once at the choke point is the drift fix (C-5, H-5, H-7,
and the merge-consume value-loss: the boxes `mintKarma`/`mintCredits` consume
internally are now journaled by construction). With no journal open, every
primitive behaves as before and records nothing (bootstrap and non-block
paths). The rollback inverses — `deleteBox`, `unconsumeBox`,
`deleteIdentityRecord`, `markFreeLikesUnprocessed` — never record.
`beginBlockJournal` while a journal is open throws (the apply funnel's totality
catch turns that into a block rejection).

| Function | Signature |
|----------|-----------|
| `beginBlockJournal(height)` | `(number) => void` — throws if a journal is already open |
| `finishBlockJournal()` | `() => BlockJournal` — returns and closes the open journal; throws if none is open |
| `abortBlockJournal()` | `() => void` — discards the open journal (no-op when none) |
| `insertBlockJournal(journal)` | `(BlockJournal) => void` |
| `getBlockJournal(height)` | `(number) => BlockJournal \| null` |
| `deleteBlockJournal(height)` | `(number) => void` |
| `purgeOldJournals(belowHeight)` | `(number) => void` |

**Rollback (`revertBlock`).** Refuses to run while a block journal is open.
Replays `mutations` in reverse order — `box`/`insert` → `deleteBox(boxId)`,
`box`/`remove` → `unconsumeBox(boxId)`, `record` → `putIdentityRecord` with
`replaced` when present, otherwise `deleteIdentityRecord` — then the
side-record inverses, then
`rollbackBlockTopology`, block + journal deletion, **and the height's AVL
version rows** (`SqliteAvlStorage.deleteVersionAtHeight`). The version rows
are per-block derived state exactly like the block and journal rows: left
behind, `versionAtOrBeforeHeight` resolves rolled-back state (proof endpoint
included), and re-applying a block at the height — a reorg back to a
previously-reverted chain — re-inserts the same content-addressed version
and trips its PRIMARY KEY, permanently rejecting the block.
Apply-then-revert MUST restore the exact pre-block UTXO set and AVL digest
for every mutation class: coinbase (including pre-existing credit boxes
merged in), epoch mints (including pre-existing karma merged in), like-tally,
post-lock swap, decay, vouch-cooldown mint (escrow row restored), prune
settlement, user txs, and **identity records**. Reorg re-insertion reads
`appliedUtxoTxs` (txCbor) and `confirmedSubBlockIds` as before.

Reverse order is what makes a record written **more than once in one block**
revert correctly (activity bump then decay, at the same height): each inverse
undoes one write, and the last one replayed is the *first* write's `replaced` —
the true pre-block value. Do not "optimise" this into a per-key single restore
that keeps the last `replaced`; that restores an intra-block intermediate.

**Breaking:** this shape replaces the former dual representation
(`consumedBoxIds`/`createdBoxIds` alongside typed arrays). Fresh DB required
(already mandated by P0's box-value change).

### Stumps

| Function | Signature |
|----------|-----------|
| `insertStump(stump)` | `(Stump) => void` — simplified Stump (rootPostHash, authorId, replyCount, upvoteCount, trigger, protocolVersion, compactedAtBlockHeight) |
| `getStump(stumpId)` | `(string) => Stump \| null` |

### AVL+ State Root

The `packages/node/src/state/` module provides an authenticated dictionary over
**committed state** using AVL+ trees — the UTXO set, and from Spec G phase B
also identity records (see "Two entity kinds" below).

- **avl-storage:** Persistent AVL+ tree, stateRoot computed at each block
  application and included in block headers
- **avl-prover:** Generates inclusion/exclusion proofs for any key
- **avl-endpoint:** `GET /api/v1/proof/:boxId?atHeight=N` — serves proofs to
  light clients
- **Config:** `VERIFY_STATE_ROOT` (validate on apply, **default on** — set
  `VERIFY_STATE_ROOT=false` to disable) and `MAX_PROOF_HISTORY` (prune old
  proof versions)
- **Verification:** apply computes the post-mutation digest and rejects the
  block unless it equals `header.stateRoot`. Both sides are post-block (H-6),
  both feeds are canonically ordered (M-12), and the mutation set is
  journal-derived (P1) — so a mismatch means genuine state divergence, not a
  representation difference. A rejected block leaves the prover restored by
  the funnel's single rollback point
- **Journal-fed:** the per-block mutation set is derived from
  `BlockJournal.mutations` — intra-block insert+remove pairs for the same
  boxId net out; inserted box bytes come from the journal's `box` payload,
  never a store re-fetch (`getBox` returns null for created-then-consumed
  boxes and silently dropped them). The derivation switches on `kind` and
  **must be exhaustive** — see "One log, not parallel arrays" above
- **Canonically ordered (M-12):** `applyBlockMutations` sorts internally —
  all removes, then all inserts, then all record puts, each lexicographically
  by hex key — so every caller inherits the canonical order; callers MUST NOT
  rely on their input order reaching the prover. `bootstrapAvlProver` sorts
  the unspent set by boxId the same way. Same mutation set in any input order
  → same digest. ⚠ **That equivalence is unconditional for boxes but holds for
  records only across *distinct* keys** — see "Where record collapsing happens"
  below. Repeated writes to one record key are order-dependent, and sorting
  cannot recover which was last
- **Rejection-safe:** the apply funnel snapshots the prover digest before any
  mutation and rolls the prover back on **every** rejection path — explicit
  rejection, stateRoot mismatch, and the totality catch (closes the open
  f4a683f remnant)
- **Reorg-abort-safe:** `reorg()` snapshots the prover digest before reverting
  anything; if applying the new chain fails mid-way, the reorg transaction
  rolls the DB (including AVL storage rows) back wholesale, and the reorg's
  catch restores the in-memory prover to the pre-reorg digest — the per-block
  funnel restore only covers the failing block, not the applied prefix

#### Two entity kinds (Spec G phase B)

The tree holds **boxes** (key = `boxId`) and **identity records**
(key = `H(IDENTITY_KEY_DOMAIN ‖ identityId)`; see Store Interface → Identity
Records). Three things follow, and all three are consensus-critical.

**1. The value bytes must be self-describing.** `state/serialize-box.ts`
already prefixes a one-byte discriminator (box-type tags `0x01`–`0x07`); the
identity record takes a tag **outside that range** — `0x80`, high bit set, so
"box" and "not a box" is a single bit test and the box-type space stays open.
`deserializeBox` MUST reject a non-box tag rather than mis-decode it, and a
kind-dispatching decoder is what any value-reading caller uses.

**1a. The AVL value carries provenance, and an absent key is not an
`undefined` key.** `serializeBox` strips only `id` and `boxType` — `txId` and
`index` stay in the value, and must, because "a box id is a total function of
the stored box" is only *checkable from a proof* if the proof's value carries
everything the derivation consumes. The AVL key already commits to them; the
redundancy is what lets a light client verify honesty rather than trust it.

> ⚠ That makes the box object's **exact key set** consensus-critical, and
> cbor-x distinguishes an absent key from a present-but-`undefined` one. A key
> set to `undefined` encodes as `f7` *and* increments the fixed two-byte map
> header — measured: `{value, guard}` → `b90002…`, the same object plus
> `txId: undefined, index: undefined` → `b90004…f7…f7`. So a box reconstructed
> by `rowToBox` with explicit `undefined` provenance serializes to different
> bytes than the same box built by a producer without those keys, and a node
> that **restarts** and re-bootstraps its prover from `getUnspentBoxes` would
> compute a different `stateRoot` than one that stayed up. A restart-triggered
> consensus fork, from nothing but an object shape.
>
> **Provenance keys are therefore assigned conditionally, never as explicit
> `undefined`** — the discipline `rowToBox` already applies to `decayBurn` and
> `lockedUntilBlock`. Box **ids** are not exposed to *this* hazard:
> `canonicalBoxBytes` destructures `id`/`txId`/`index` away, so it is total
> over both shapes. Only the AVL value is.

**1b. Key ORDER is consensus-visible too — and is currently violated.** Found
by the phase B1 session, verified and extended by main. Neither encoder
canonicalises map key order: cbor-x emits keys in JS insertion order, so
`{value, guard, owner}` and `{owner, value, guard}` produce different bytes.
This is **wider than 1a** — it reaches `canonicalBoxBytes`, and therefore box
**ids**, not only the AVL value. The contract already warns that
`canonicalBoxBytes` is not RFC 8949 canonical CBOR; key order is the other half
of what that non-canonicality costs.

The implicit convention is that `rowToBox` mirrors each producer's field order.
It holds for karma, credit, like, invite and bond — checked, including the demo
UI, which builds client-side box types in `rowToBox`'s order. **It does not hold
for `post_lock`:**

| Source | Order after `serializeBox` strips `id`/`boxType` |
|--------|--------------------------------------------------|
| `block-creator.ts` remainder box | `value, originalValue, createdAtBlock, owner, targetPostId, guard` |
| `rowToBox` / demo UI | `value, createdAtBlock, originalValue, owner, targetPostId, guard` |

Measured: identical length, different bytes (`…6d6f726967696e616c56616c7565…` vs
`…6e637265617465644174426c6f636b…`). Two consequences:

- **Latent fork.** A partial post-lock unlock inserts the remainder box in
  producer order; `bootstrapAvlProver` later re-serialises it in `rowToBox`
  order. Bootstrap only runs when AVL storage is empty while the UTXO set is
  populated — which is exactly the documented "wipe the AVL SQLite store"
  deploy step. Wiping the store *without* also wiping the chain silently
  changes the `stateRoot`. Currently unreachable only because the deploy gate
  mandates both.
- **It breaks Spec G's central promise.** `stored.id === computeBoxId(stored)`
  is supposed to become structural at phase G. Under order sensitivity it does
  not: re-deriving an id from a `rowToBox`-reconstructed `post_lock` yields a
  different id than the producer computed. Provenance does not fix this — only
  a canonical field order does.

> **Resolution: canonical key ordering is a phase G obligation.** Both encoders
> must impose an order rather than inherit the caller's — lexicographic key sort
> is the simplest total rule. Phase G is already the one phase where ids
> legitimately move and every id-asserting test updates together, so folding it
> in costs no extra churn; doing it earlier moves ids twice. Until then,
> **producers and `rowToBox` MUST agree on field order**, and `post_lock` is a
> known outstanding violation — do not "fix" it by reordering one site, which
> treats the instance and leaves the class.

**1c. Key order is attacker-controlled on transaction outputs.** Found by the
phase C3 session, and it is 1b's hazard weaponised rather than accidental.

A transaction's outputs arrive as **client-supplied CBOR**, and `computeTxId`
hashes them through `canonicalBoxBytes`, which strips `id`/`txId`/`index`. A
client may therefore plant `txId` and `index` keys *at arbitrary positions* in
an output's map **without changing the txId it signs** — the signature does not
constrain what the signature does not cover.

If the node then materialised that output by assigning provenance **in place**,
the keys would keep the attacker's chosen positions, while `rowToBox` appends
them last. Different key order, different AVL value bytes, and therefore a
**restart-triggered `stateRoot` fork that an attacker chooses when to trigger**,
for the cost of reordering two keys in a transaction they were sending anyway.

> **Every box materialised from decoded CBOR MUST have provenance stripped and
> re-appended, never overwritten in place.** `materializeOutput` is the single
> materialisation rule for transaction outputs and both the UTXO engine and the
> apply path go through it — two rules would be two chances to get the position
> wrong.

Phase G's canonical key ordering subsumes this: once the encoder imposes an
order, an attacker's key positions cannot survive into the value at all. Until
then, strip-then-append is the guard, and it is the reason `materializeOutput`
exists as a shared function rather than an inlined assignment.

**2. The proof endpoint must not throw on a record.** `GET /api/v1/proof/:boxId`
decodes whatever value the key resolves to with `deserializeBoxWithId`; a
record-shaped value would throw. Keys are indistinguishable from outside — both
kinds are 32 bytes of hash output — so a client *can* ask for one. **This is a
phase D obligation, not phase B:** nothing populates records until phase D, so
the tree provably contains none before it, and phase B has no reachable defect.
Phase D MUST land the endpoint fix in the same unit that populates records.

**3. Disjointness must be re-argued, not inherited.** The comment in
`avl-prover.ts` justifying the remove-group/insert-group split argues from
"box ids commit to `createdAtBlock`" — a premise Spec G **deletes**. Rewrite it.
The property survives and strengthens:

- *Removes vs inserts.* A key in the remove group was in the tree before this
  block; a key in the insert group is created by it. Under provenance-derived
  ids a box id is a function of `(candidate, txId, index)`, so two boxes share
  an id only if they share all three — i.e. the same transaction applied at two
  heights. A real tx cannot be: its inputs are consumed on first application.
  **That step depends on every user tx having at least one input**, which the
  UTXO engine enforces by rejecting empty-input txs; a zero-input user tx would
  be replayable and would break this argument, so that rejection is load-bearing
  for identity, not just for value. A synthetic mint tx cannot be either:
  `mintTxId` commits to the height. Intra-block insert+remove pairs for one id
  were already netted out upstream. So the two groups are disjoint, and the
  split can never reorder ops on a single key. This is *stronger* than the old
  argument, which only ruled out same-block recurrence.
- *Boxes vs records.* Disjoint by domain separation, not by luck — box ids and
  record keys are hashes under different domain tags. This is why the record
  key is hashed rather than the raw 32-byte pubkey, which an attacker chooses.

**Record ops use `InsertOrUpdate`.** A record put is a create on first write and
an update afterwards, and the feed does not know which — `InsertOrUpdate`
collapses that distinction so the prover feed needs no existence lookup. Two
puts to the same key in one block collapse to the **last** value (last write
wins, identical final tree); the journal keeps both entries because rollback
needs the first one's `replaced`. Netting is per-kind: boxes cancel
insert+remove pairs, records keep the last write — do not share one code path.

**Where record collapsing happens, and why it is not arbitrary.** The collapse
belongs to **`proverFeedFromJournal`**, not to `applyBlockMutations`. Box
mutations commute: cancel the insert+remove pairs in any order and the surviving
set is the same, which is why `applyBlockMutations` can own box canonicalisation
by sorting. **Record puts do not commute** — two writes to one key differ in
*which came last*, and that is carried by journal application order alone. Once
`applyBlockMutations` sorts by hex key, that information is gone; a sort cannot
recover it, and any behaviour that appeared to work would be relying on sort
stability. So the collapse must happen while journal order is still
authoritative, and `applyBlockMutations` receives **at most one entry per record
key**. The natural reading — "`applyBlockMutations` owns canonical ordering,
therefore it owns this too" — is wrong, and wrong in a way that produces a
silently order-dependent digest. *(Gap found by the phase B session; pinned
here because the contract previously stated both rules without saying which
function owns the collapse.)*

`applyBlockMutations`' `recordPuts` parameter is **optional and defaults to
empty**, so the many existing three-argument call sites keep working. That
default is a convenience for tests only: **every production caller MUST pass the
feed derivation's own `recordPuts`**, never omit it and never assemble one by
hand. Omitting it silently drops records from the digest, and if one of the two
callers omitted it, the producer and the verifier would disagree — the exact
failure H-6 exists to prevent.

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
`PostStore` interface. The SQLite implementation (`SqlitePostStore`) is the
default.

**Design principle:** The store sees opaque `(typeId, id, sequence, data)`
tuples. It does NOT parse post content, verify signatures, or validate the
DAG structure. Domain semantics live in the service layer above.

```typescript
interface PostStore {
  putBatch(entries: StoreEntry[]): void;
  put(entry: StoreEntry): void;
  get(typeId: number, id: Uint8Array): Uint8Array | null;
  has(typeId: number, id: Uint8Array): boolean;
  bestPostAt(sequence: number): Uint8Array | null;
  canonicalBranchEntries(): Array<{ sequence: number; postId: Uint8Array }>;
  metaGet(key: string): Uint8Array | null;
  metaPut(key: string, value: Uint8Array): void;
  listPeers(): PeerRecord[];
  putPeer(peer: PeerRecord): void;
  deletePeer(peerId: string): void;
  pruneBelowHorizon(horizon: number, typeIds: number[]): void;
  minSequencePresent(typeId: number): number;
  schemaVersion(): number;
  close(): void;
}

interface StoreEntry {
  typeId: number;
  id: Uint8Array;       // 32-byte blake2b hash
  sequence: number;      // caller-provided; store never derives it
  data: Uint8Array;      // opaque serialized bytes
}

interface PeerRecord {
  peerId: string;
  lastSeenMs: number;
  addresses: string[];
  features: Uint8Array;
}
```

**Invariants:**
- `putBatch` is atomic — all entries commit or none do.
- `put` is idempotent — duplicate `(typeId, id)` with same data is a no-op.
- `bestPostAt(n)` returns null, not an error, for non-existent sequences.
- `canonicalBranchEntries()` reads sequentially, not via N point lookups.
- `pruneBelowHorizon` never touches structural types (post metadata, DAG
  edges, scores).
- All methods are synchronous — SQLite is the backing store.

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
| `feed-service.ts` | Query posts, paginate, assemble feed/thread views | Post creation |
| `dag-service.ts` | DAG fork resolution, canonical branch, reorg | Post creation, block assembly |
| `verifier.ts` | Post verification (sig, PoW, DAG linkage, content) | Network relay |
| `credits.ts` | Credit transfer validation and execution | UTXO engine internals |
| `invites.ts` | Invite lifecycle (create, commit, claim, cancel) | Bond box internals |
| `faucet-service.ts` | Faucet allocation from system keypair | Credit system design |
| `block-creator.ts` | Block creation, mining, template assembly | Post validation |
| `block-apply.ts` | Block application, UTXO settlement, epoch tally | Block creation |
| `utxo-engine.ts` | UTXO transaction validation and application | Block structure |
| `stump-engine.ts` | Verifiable prune execution | DAG content |
| `content-sweep.ts` | Placeholder and missing-stump resolution | Post creation |
| `fork-resolution.ts` | Chain fork detection and reorg | Block creation |

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
| `PUBLIC_URL` | `/` | Base path where the demo UI is served (e.g. `/testnet/`) |
| `VERIFY_STATE_ROOT` | `true` | Verify `header.stateRoot` at block apply (Spec B P3). Set `false` to disable |
| `MAX_PROOF_HISTORY` | `1440` | AVL versions retained for proof serving |

---

## Net Integration

The node creates a `NetNode` from `@dagsocial/net` during startup and registers
Stage 2 handlers for inbound gossip messages. Startup order:

```
1. initDb()
2. Create NetNode with config + validators
3. Register Stage 2 handlers (onSubBlock, onOrderingBlock, onTx, onStump)
4. Register sync handlers (setBlocksHandler, setHeadersHandler) BEFORE net.start()
5. await net.start()          // connect to bootstrap, subscribe to topics
6. startHttpServer()          // begin accepting API requests
7. startBlockCreator()         // begin producing ordering blocks
```

Net starts before HTTP — the network layer is ready before the API accepts
requests. If bootstrap peers are unreachable, the node still starts (gossip
will connect as peers become available). Sync handlers must be registered
before `net.start()` — otherwise the initial sync burst is silently dropped.

Route handlers call `net.broadcastSubBlock()`, `net.broadcastTx()`, and
`net.broadcastOrderingBlock()` after local processing to propagate new objects
to peers. Broadcast calls are fire-and-forget — failures are logged but do
not fail the API request.

### Relay handlers (mempool-based)

- **`onSubBlock(sb)`**: validates (read-only, `verifyPostForRelay`) → inserts post,
  creates mempool sub-block entry, re-broadcasts to other peers
- **`onTx(tx)`**: validates (read-only, `validateTx`) → inserts into mempool via
  `insertUtxoTx`
- **`onStump(stump)`**: stores stump if not already present
- **`onOrderingBlock(block)`**: structure / chain-link / PoW pre-filters → fork
  detection & resolution → `applyOrderingBlock` → confirms posts → removes
  confirmed entries from mempool. The authoritative consensus checks — including
  **validator-signature verification (H-1)** — are enforced *inside*
  `applyOrderingBlock` (see "Ordering block apply-time authorization" below), so
  the sync and reorg paths, which never pass through this gossip callback, are
  covered by the same gate.

### Ordering block apply-time authorization

`applyOrderingBlock` is the single funnel every apply path — gossip receipt,
pull-sync, and reorg — passes through, so consensus authorization is enforced
there rather than at any one entry point.

**Structure validation in the apply funnel.** Before any field of the block is
read, `applyOrderingBlock` rejects the block unless
`verifyOrderingBlockStructure(block)` (from `@dagsocial/validation`) returns
valid. Previously this ran *only* in the gossip topic validator
(`net/src/gossip.ts`), so the pull-sync path — which decodes CBOR and calls the
apply handler directly — reached consensus code with fields of arbitrary type.
Enforcing it in the funnel makes the guarantee path-independent, and is the
same relocation already applied to the PoW target (M-2), coinbase maturity
(M-3), and the validator signature (H-1).

**Apply funnel: validation and mutation phases.** `applyBlockBody` is split so
the state transition can be run without the header being final — that is what
lets the block creator compute a post-block `stateRoot` through this same code
instead of a parallel implementation (H-6). The split is structural, not a
mode flag: there is no "skip the checks" parameter on the apply path.

| Phase | Contents | Runs in speculative computation? |
|-------|----------|----------------------------------|
| **Validation** | chain-link, protocol version, PoW target + PoW, validator signature, Merkle roots, coinbase value + maturity, epoch-tally agreement, block storage, `clearTemplate` | No — the header does not exist yet |
| **Mutation** | coinbase mint, sub-block confirmation, DAG scores, topology, prune verification + settlement, epoch tally application, embedded UTXO txs, decay, vouch cooldowns | Yes — verbatim, at an explicitly passed height |
| **Commit** | AVL feed + `stateRoot` verification + checkpoint, journal persistence | No — the speculative run reads the digest and rolls back |

The mutation phase takes its height as an argument rather than reading
`header.height`, and rejects a block for body-level reasons (prune
verification, embedded-tx re-validation) on both paths identically. Any check
that depends on the finalized header belongs in the validation phase.

**The funnel is total.** `applyOrderingBlock` MUST NOT propagate an exception
for any input. A block that causes an unexpected throw is a block the node
rejects: the surrounding transaction rolls back, the open block journal is
discarded, the AVL prover is restored to its pre-block digest (the funnel
snapshots the digest before the body runs — SQLite rollback does not reach
the prover's in-memory state), and the function returns `false`, exactly as
for an explicit rejection, with the error logged server-side. This is the
ARCHITECTURE invariant "no method panics on untrusted input" applied at the
consensus boundary, and it is load-bearing rather than
defensive: the gossip callback is `async` and its promise is discarded by the
net layer, so a propagated throw becomes an unhandled rejection, which
terminates the process on Node ≥ 15. Because a rejected block is never stored,
a crashing block is re-fetched on restart and crashes again — a single
cheaply-mined block would otherwise be a permanent, self-reapplying kill for
every node that receives it. Structure validation closes the known instance;
totality bounds every future one.

**Validator signature (H-1).** Before applying any state, the block is rejected
unless `verifyValidatorSignature(block.header, block.validatorSignature)` (from
`@dagsocial/validation`) returns `true`. This binds block-production attribution
(coinbase-output ownership, genesis credit distribution) to the holder of
`validatorId`'s private key: solving the PoW no longer lets a producer forge a
block under another validator's identity. The check is pure and deterministic —
it recomputes `blockHash(block.header)` and verifies the raw Ed25519 signature
against `block.header.validatorId` — so every node reaches the same verdict. It
sits alongside the height-scheduled PoW-target and coinbase-maturity checks
already enforced in this funnel, and precedes any mutation so a bad-signature
block rolls back to a no-op.

**Sub-block entry integrity + prune authorship (H-3).** `SubBlockEntry` carries
a consensus-recorded `author` (see `TYPES_INTERFACE.md`), committed under
`subBlockRoot`. The `'subblock'` Merkle leaf serializes
`{ postId, parentRefs, author }` (JSON, exactly this key order). Enforcement has
three legs, all inside the `applyOrderingBlock` funnel:

1. **Producer honesty (fill).** The block creator fills `entry.author` from the
   resolved sub-block's post — never from a client-supplied claim.
2. **Entry-vs-post verification (confirm-time).** For every sub-block entry
   whose post is locally present with real content (not a placeholder), the
   block is REJECTED unless `entry.author === post.author` **and**
   `entry.parentRefs` equals `post.parentRefs` as an exact ordered sequence.
   Both are `postId`-preimage fields, so any content-holding node can verify
   the claim; content-holding honest nodes thereby keep lying entries out of
   the canonical chain. A node lacking the content accepts the entry as
   claimed and inherits this guarantee through PoW weight — the same trust
   model as every other content-dependent check. (Unchecked `parentRefs`
   would let a producer graft a victim's post under their own root and prune
   it "as author" — the parentRefs equality closes that route.)
3. **Prune authorship binding (prune-time).** Before the prune entry's
   postId-set and Merkle checks, the block is REJECTED unless
   `getTopologyAuthor(entry.rootPostHash)` returns a non-null author equal to
   `entry.authorId`. The lookup reads only consensus-recorded data, so the
   verdict is identical on every node — including one that synced from
   ordering blocks alone and holds no DAG content. A root no applied block has
   confirmed has no topology author and is therefore not prunable (this also
   forecloses the empty-subtree/unconfirmed-root edge). `PruneEntry.authorId`
   is retained in the wire format and required to equal the topology author;
   the author signature check then proceeds against it as before.

Topology rows are written from the (verified) entry: `insertBlockTopology(
entry.postId, entry.parentRefs, entry.author, height)`. Placeholder posts keep
a zeroed `author` column in `dag_posts` — `block_topology.author` is the
consensus authority for prune authorization, never `dag_posts.author`.

### Sync handlers (pull-path)

- **`setBlocksHandler(cb)`**: called by sync machine to apply blocks during sync
- **`setHeadersHandler(getBlock)`**: serves block headers for fork resolution
- **`setSyncHandler(cb)`**: serves sub-blocks for content-sweep (placeholder fill)
- **`setPostsHandler(cb)`**: serves posts by ID for peer requests
- **`setStumpsHandler(cb)`**: serves stumps by ID for peer requests

Additional hooks: `onSyncComplete(cb)` and `onPeerActive(cb)` trigger
content sweep for placeholder and missing-stump resolution.

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
- Every mutation of a **committed entity** during block application — boxes and
  identity records alike — is recorded exactly once, at the store choke point,
  in the block journal; rollback replays inverses in reverse order; the AVL
  feed derives from the same journal (record-once, Spec B P1; Spec G phase B).
- **Consensus code never reads the `created_at_block` column.** It is not in
  the `stateRoot`, so a node bootstrapping from an AVL snapshot cannot
  reconstruct it. Unenforceable by test — contract and review only.
- A box id is a total function of the stored box: `stored.id ===
  computeBoxId(stored)` for every box in the UTXO set (Spec G; holds from
  phase G, when the derivation switches).
