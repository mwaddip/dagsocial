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
- **All value arithmetic is `bigint`** — conservation sums, coinbase split, like
  settlement and carry, decay, fees. `Math.max/min/floor` **throw** on bigint: use
  bigint operators and manual min/max; bigint `/` truncates toward zero (the intended
  floor).
- **JSON boundaries emit strings (client-visible).** JSON cannot carry a bigint
  (`JSON.stringify(5n)` throws). Every HTTP response field carrying a box `value` or a
  `total` is serialized as a **decimal string**; the demo UI parses them with `BigInt()`
  (its phase). Same for the SQLite `extra_data` `originalValue` (coerce before
  `JSON.stringify`) and any stdout log field carrying an amount.
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
- No replacement semantics (no fees yet)
  > ⚠ **"No size cap" was wrong and has been removed.** A cap exists, is documented in
  > detail in `MEMPOOL_INTERFACE.md`, and is **enforced at all three insert sites**
  > (`MAX_MEMPOOL_ENTRIES`, default `10000`). `MEMPOOL_INTERFACE.md` is authoritative for
  > mempool behaviour; this section is a summary and must not restate its rules. Two
  > documents disagreeing about whether a bound exists is worse than either being wrong
  > alone — a reader here would size a DoS assumption on a cap that is actually present.

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
| `GET` | `/posts/:id` | — | `PostJson` (`id`, `status`, `likeCount`, `likers`) or `StumpJson` (below) | 404 |
| `GET` | `/posts/:id/thread` | — | `{ post, ancestors, descendants }` — full thread context; `post` is `PostJson` or `StumpJson` | 404 |
| `GET` | `/posts` | `?author=hex&limit=50&offset=0` | PostJson[] (`id`, `status`, `likeCount`, `likers`, live only, no stumps) | — |

**Stump JSON shape (decided 2026-08-08).** A pruned root stays a 200 on
`GET /posts/:id` — a stump is real, renderable tombstone data, not an absence.
The response is a distinct `StumpJson`, discriminated by an explicit `kind`
field rather than by which keys happen to be missing:

```
StumpJson = {
  kind: 'stump',
  id: rootPostHash,          // the pruned root's post id (64-hex)
  author: hex(authorId),     // 32-byte Ed25519 key as hex — PostJson.author's convention
  replyCount: number,
  upvoteCount: number,
  trigger: 'author' | 'storage_prune',
  protocolVersion: number,
  compactedAtBlockHeight: number
}
```

`PostJson` carries no `kind` field; clients discriminate on its presence.
`GET /posts/:id/thread` on a stump returns
`{ post: StumpJson, ancestors: [], descendants: [] }`. The feed listing
(`GET /posts`) remains live-posts-only — no stumps, unchanged.

> ⚠ **AHEAD OF CODE — rides the tx-envelope bundle.** Today the raw `Stump`
> object is returned as-is: `res.json` serializes `authorId` (a `Uint8Array`)
> index-keyed (`{"0":…,"1":…}`), and `getThread` casts the raw stump to
> `PostJson`. `FeedServiceDeps.getPost` is typed `unknown | null` while the
> store's `getPost` is `Post | Stump | null` — the bundle types the dep to the
> store's signature so the stump arm is compiler-checked (the NX
> compiler-as-mutation-detector pattern), and adds a `stumpToJson`.

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
7. Assemble sub-block: `{ subBlockId: postId, post, producerId: author, protocolVersion }` (no sidecar field — P2-D)
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
| `POST` | `/likes` | `{ tx: UtxoTransaction }` — client-signed like tx (`likeTarget` set) | `{ status: "pending", txId, expiresAtHeight }` | 400 if `likeTarget` missing/malformed, post unknown or pruned, insufficient karma, already liked, or tx invalid |

**There is no `/likes/remove`** (unlike is not a feature), no free tier, and no refund
schedule. One like per `(liker, post)`, forever, costing exactly `LIKE_KARMA_COST`.

**Like flow:**

1. Extract `likeTarget` from the tx; reject if absent or not 64-hex
2. Verify the target post exists and is live (not pruned)
3. Verify not already liked: like-record `(liker, targetPostId)` absent AND
   `hasPendingLike` over the mempool gate metadata
4. `validateTx` — the engine enforces the biconditional like shape (karma inputs one
   owner, exactly one karma output same owner, deficit exactly `LIKE_KARMA_COST`)
5. Insert into mempool: `insertUtxoTx(tx, null, expiresAtHeight)` (gate metadata
   `like_target`/`like_liker` from `likeTarget` + the signer)
6. Return `{ status: "pending", txId, expiresAtHeight }`

The gateway checks are courtesy; **the consensus checks run again at apply** (see UTXO
engine → like transition, and Block application → per-block like settlement). The liker is
the karma inputs' owner — no separate liker field exists anywhere.

**A like tx carries exactly one signature — the liker's** (decided in N1, ratified
2026-08-08). `castLike` rejects multi-signature like txs with a legible 400, and the
mempool gate derives `like_liker` as NULL from any signature map without exactly one key.
Rationale: a first-key-wins derivation would let a valid tx carrying a spare signature pin
an arbitrary `(liker, target)` pair in the gate and block that pair's real like — a
gateway DoS for the price of one extra signature.

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
**also a consensus rule as of P2-B phase 2** — the service check is now the
mempool-side mirror of the apply-time gate, not the only enforcement (see
"Vouch transition rules"). The single-active-vouch and pending-vouch checks
above remain service-layer policy.

> ⚠ **NOT IMPLEMENTED (recorded 2026-08-08) — the demo UI's vouch controls do
> not construct transactions.** Both mutating routes require a client-signed
> `tx` (P2-B phase 2), but the UI's vouch button still POSTs
> `{userId, targetId}` and the unvouch button DELETEs with `{userId}` — both
> die at the routes' `tx required` 400 before `jsonToTx` runs. The UI was
> never migrated when vouches became transactions; it has `signTxId` builders
> for karma-lock, like, transfer, and invite commit/reveal, but none for
> vouch/unvouch. Invisible to the suite: vouch coverage is service-level only
> (raw `Uint8Array` objects) — the JSON edge has zero route tests. **Restoring
> the UI flow is its own recorded follow-up phase (user decision 2026-08-08);
> the tx-envelope bundle restores the JSON edge underneath it and stops
> there.**

**The JSON edge (rides the tx-envelope bundle):** `jsonToTx`'s
`BINARY_BOX_FIELDS` lacks `voucherId`/`targetId`, so even a correctly built
vouch-cast tx arrives with those two fields as hex *strings* and dies at the
step-4 schema (`bytes32`) — the cast is inexpressible over HTTP JSON. The
bundle adds both entries (sender+receiver: the UI's `canonicalBoxBytes`
mirror already lists them) plus route tests through the JSON edge for cast
and unvouch. `GET /vouches?voucher=X` gains a `boxId` per entry — the future
unvouch builder must name the VouchBox it spends, and no read surface exposes
box ids today.

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
3. Node builds PruneEntry, enqueues in mempool. Nothing is broadcast at
   this point — the prune propagates inside the ordering block that carries
   it, and each node derives its own stump at settlement (see below)
4. At block application: verify authorship binding (`entry.authorId` equals
   the `block_topology`-recorded author of `rootPostHash`; reject the block if
   no topology row exists — an unconfirmed root is not prunable), verify
   signature, verify topology via block_topology CTE, verify Merkle root,
   settle UTXO deterministically (consume the subtree's PostLockBoxes, mint
   `prune-refund-author` karma, and delete the subtree's like-records —
   journalled, so a reverted prune restores them; P2-D), insert the Stump
   derived from the verified entry
   (**unconditional** — a node holding no DAG content records the same
   stump), then prune DAG content when present

**Stumps are derived state.** A `dag_stumps` row is a local projection of a
PruneEntry inside an applied ordering block — never information in its own
right. `insertStump` has exactly one caller: prune settlement in block
application. No network input writes the table. Inbound stump gossip is not
consumed, and no stump pull protocol exists: a gossiped stump is unverifiable
by construction (it carries neither the author signature nor
`subtreePostIds`, so a receiver has nothing to check it against), while the
table it would write is trusted by both the read API (`getPost` resolves
stumps) and the relay verifier (parent-existence, step 8) — which is why
nothing unverified may reach it (audit F-api-20, and the sweep-response
variant found alongside it: a peer answering a stump pull could return
entries that were never requested, each stored and its prune replayed
against live content).

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
| `POST` | `/credits/transfer` | `{ tx: UtxoTransaction }` — client-built, client-signed | `{ status: "pending", txId, expiresAtHeight }` | 400 on invalid tx or signature |
| `POST` | `/credits/faucet` | `{ to: hex }` | `{ amount, txId }` | 403 if not testnet, 409 if already funded |

**A credit transfer is a transaction, and it settles when it is mined**
(P2-B phase 3). The client builds and signs it; the node decodes it with
`jsonToTx`, validates it with `validateTx`, pools it with `insertUtxoTx` and
relays it with `net.broadcastTx` — the same path invites, vouches and likes
already take. Credits move at block application on every node, not when the
HTTP call returns.

This replaced a handler that took `{ from, to, amount, signature }` and
**rebuilt the transaction server-side**, which was wrong twice over:

- **It bypassed consensus entirely** (audit F-consensus-7). `sendCredits`
  called `consumeBox`/`insertBox` directly with no block and no open journal,
  so the transfer entered no block, produced no journal entries, and never
  reached the AVL feed. The node's digest kept matching its peers while its
  box table did not, and the divergence surfaced at the next restart — when
  the prover re-bootstraps from `getUnspentBoxes()` and every later block
  fails its `stateRoot` check. A permanent self-fork with a cause hours old.
- **It duplicated transaction construction.** The demo UI already built the
  complete transaction and signed its id, then discarded it and sent the
  parts; the node rebuilt it. Box-selection order, output shape and field
  order had to agree byte-for-byte across two implementations or the
  signature stopped verifying, and nothing tested that. The client-built
  form deletes the second implementation rather than documenting it.

`expectedHeight` is gone. Since Spec G no output carries a height, so the
transaction and its id are height-independent and the parameter pinned
nothing.

### Blocks

| Method | Path | Response | Errors |
|--------|------|----------|--------|
| `GET` | `/blocks/:height` | OrderingBlock object (JSON with hex fields) | 400 if NaN, 404 |
| `GET` | `/blocks/current` | `{ height, hash }` | — |

### Faucet (faucet-bearing networks only)

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/faucet` | `{ userId: hex }` | `{ status: "pending", txId, expiresAtHeight }` | 400 if missing fields, 403 on a network without a faucet, 409 if already funded |

Grants 100 karma to an identity, **once per identity, ever** (idempotent). Mints
from the system keypair — not a transfer. Builds a UTXO transaction creating a
new karma box and inserts it into the mempool. Gated at **mount** time on
`isFaucetNetwork(config.networkType)`, where `config` is the `Config` passed to
`createApp(config)` — injected, not the module singleton, which is why this gate is testable
and the `/credits/faucet` handler guard currently is not. `isFaucetNetwork` lives in `config.ts`
and is an **allow-list**, currently `testnet` and `devnet`.

**The allow-list is normative, and the reasoning matters more than the current membership.**
It fails closed: a network added later mints nothing until someone names it. The property
being defended is *never mint karma from nothing on a network where it has value*, and
forgetting to update an allow-list is safe while forgetting to update a deny-list is not.
A deny-list (`!== 'mainnet'`) hands every future network a faucet by default.

This is the third place in this design that chooses fail-closed over convenient-default, on
identical reasoning: `profileFor` throws rather than defaulting, `NetConfig` requires `magic`
rather than defaulting it, and the faucet enumerates rather than excluding.

⚠ **All three gates move together, always** — the provisioning gate (`index.ts`), the mount
gate (`server.ts`) and the handler guard (`routes/utxo.ts`). A subset is worse than none:
mount without provisioning gives a faucet with nothing to mint from; provision without
mounting leaves unreachable system state. They call one shared predicate so they cannot
drift; the handler guard applies it as a **reject** condition, so a grep for the enabling
expression finds only two of the three.

**The handler guard reads injected config, never the module singleton.** `UtxoDeps` carries

```typescript
readonly networkType: NetworkType;
```

and the guard is `isFaucetNetwork(deps.networkType)`. A plain readonly field rather than an
accessor is deliberate: unlike `getCurrentHeight()`, the network cannot change after startup, and
a field says so. `server.ts` passes `config.networkType` at the single production construction
site; tests pass whichever network the case is about.

This is not a testability nicety. A module-singleton read is the **config-at-a-distance** pattern
`ARCHITECTURE §Network Identity` exists to remove — the same shape that let `NETWORK_MODE` reach
nothing while ten call sites silently defaulted to mainnet. The faucet is the one place P2-A did
not reach, and a gate that mints value from nothing is a poor place to keep the last instance.

> **Coverage, measured 2026-08-07.** Two of the three gates are covered. The **mount** gate has
> three tests (`server.test.ts`, via the injectable `createApp`). The **handler** guard has three
> (`routes/utxo.test.ts`) and gained them with the injection above — before it, mutating that
> guard left the entire suite green, which is what made the singleton read a correctness problem
> rather than a style one. The **provisioning** gate runs as an import side effect of the
> entrypoint and stays statically untestable; only the parked e2e harness, which spawns a real
> process, can reach it. It is named here so its absence is not mistaken for an oversight.
>
> The handler's three tests pin three separate properties, each killed by a different mutation:
> **mainnet is rejected** (dies if the guard always allows), **the guard reads `deps.networkType`**
> (dies if the argument is hardcoded, even to an allowed network), and **the allow-list has two
> members** (dies if it narrows to `testnet` alone). A `testnet`-only test would have proved none
> of them, since `testnet` is also the fixture default.

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
| `GET` | `/status` | `{ networkType, blockHeight, postCount, pendingPosts, totalKarma, totalCredits }` |

> ✅ **`networkMode` → `networkType` landed in P2-A phase 4**, in the same commit as the demo
> UI change because renaming a response field is a breaking API change. `totalKarma` and
> `totalCredits` are **decimal strings**, not numbers — they are `bigint` server-side and
> JSON has no such type. The parked e2e harness's `waitForReady` picks up the new name when
> it is rewritten (`test/e2e/README.md`).
>
> ✅ **`identityCount` is gone, 2026-08-07.** The demo UI used to render `s.identityCount` in
> its status bar — a field this endpoint has never emitted — so a live node showed
> "Identities: **undefined**". Its only producer was `src/routes/status.ts`, a router that was
> **exported and never mounted**, querying three tables that do not exist (`blocks`, `posts`,
> `identities`). Both the UI row and that file were deleted. `/status` did **not** gain the
> field: there is no identity table by design. The residue came from an abandoned design in
> which the node generated keypairs server-side, which is also why the dead router expected an
> `identities` table.

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
4. Output shape: every output is a non-null object matching the closed
   per-boxType schema — exact key set, the boxType's one canonical `guard`,
   and every field's runtime type (see "Output shape" below). This is the
   **first step that reads `tx.outputs`**: steps 5–7 operate on outputs whose
   structure and field types are already pinned, and may dereference output
   fields freely. (Step position changed by the field-type pin — the check
   ran as step 7 until then; see the placement note in "Output shape".)
5. Value conservation: `sum(input values) == sum(output values)` for **every** box
   type. The single exception is the deliberate **zero-output VouchBox spend**
   (unvouch — the staked karma is escrowed off-UTXO in `vouch_cooldowns` and
   re-minted to the voucher at maturity; an escrow round-trip, not a burn).
   There is **no BondBox exception**: bond forfeiture is not implemented and no
   legal transition destroys a bond (see "Bond transition rules" below) — the
   karma-econ vesting design owns forfeiture, and will define its burn path when
   it lands. All other user transactions — including karma, like, and vouch
   *cast* — conserve value; karma/credit mint and burn happen only in
   block-application paths (like rewards, decay, coinbase), never inside a user
   transaction. The `value` **type** bound (non-negative `bigint` base units
   `< 2⁶⁴` — a negative value could otherwise balance the sums while minting
   into a sibling box) is pinned by step 4's schema; conservation owns the
   **sums**. `assertValidBoxValue` remains at the JSON→tx boundary as the
   HTTP-edge early reject of the same rule — an ergonomics twin, not the
   consensus gate. Conservation sums are `bigint` (P0 — see "Values are BigInt")
6. Guard satisfaction (signatures verified against tx hash)
7. Legal box transitions (per the transition table below)

Returns `{ valid, error?, computedOutputs?, txId? }`. On success, `computedOutputs`
contains boxes with pre-computed IDs (for use by `applyTx`), and `txId` is the
deterministic transaction ID.

**Used at pool entry** for ideal validation (though currently gated by signing
mismatch — see Known Gaps in SESSION_CONTEXT.md).

### Output shape — the closed per-boxType schema (guard-shape pin + field-type pin)

Transaction outputs are attacker-controlled structure (HTTP JSON through
`jsonToTx`, gossip and block-embedded CBOR), and two of their bytes-level
consumers hash **whatever keys the object carries**: `canonicalBoxBytes` (the id
preimage) strips only `id`/`txId`/`index`, and `serializeBox` (the AVL leaf, so
the `stateRoot`) strips only `id`/`boxType`. Nothing between ingress and those
encoders constrained the shape: transition rules filter on `boxType`,
`checkOutputValues` reads `value`, and `guard` — a field that is a pure function
of `boxType`, carrying zero information — passed through verbatim.

`validateTx` therefore rejects any output that does not match the **closed
schema for its `boxType`**:

- **Key set is exact.** Required fields present, no key outside the declared
  set (`TYPES_INTERFACE` box definitions are authoritative; declared-optional
  fields — `KarmaBox.decayBurn`, `CreditBox.lockedUntilBlock` — may be present
  or absent, nothing else may vary). A key the schema does not name is a
  reject, not a strip: a stripped key would change the bytes the client signed.
- **`guard` equals the boxType's canonical guard.** `karma`/`credit`/`vouch` →
  `owner_signature`, `invite` → `hash_preimage_with_bond`, `bond` →
  `bond_dual`, `post_lock` → `block_apply` — the same constants `rowToBox`
  fabricates on read. One table, engine-owned; `rowToBox` and the check must
  never disagree.
- **Field types are pinned** (field-type pin). Every present field's runtime
  type matches its `TYPES_INTERFACE` box definition:
  - `bigint`, `0 ≤ v < 2⁶⁴`: `value` (every boxType) **and `originalValue`
    (post_lock — the read-poison field)**. The bound is absorbed from
    `checkOutputValues`, which retired with this pin (one owner per rule;
    `json-to-tx`'s `assertValidBoxValue` stays as the HTTP-edge twin).
  - 32-byte `Uint8Array`: `owner` (karma, credit, post_lock), `secretHash`
    (invite), `inviterId` (invite, bond), `voucherId`, `targetId` (vouch).
  - `inviteePublicKey` (bond): `Uint8Array` of length 0 **or** 32. Which of
    the two a given transition demands (uncommitted vs committed) stays a
    transition-arm rule — the schema pins the type, not the state.
  - Non-negative safe integer, and never `-0`: `inviteOutputIndex` (bond,
    additionally `≤ 0xFFFFFFFF` — it is a u32 output position),
    `probationStartBlock`, `probationEndBlock` (bond), `lockedUntilBlock`
    (credit, when present). `-0` is called out because it is JSON- and
    CBOR-reachable and breaks byte round-trips: cbor-x encodes it as a float
    where the store's JSON round-trip returns integer `0`.
  - `proofSource` (credit): a block height **or `-1`, the transfer sentinel**
    — the closed live value set (`heightOrTransfer`). The pin's first draft
    said "a block height" alone; the implementing unit found every user-path
    credit transfer and faucet grant stamps `-1` (`routes/utxo.ts` documents
    the convention), and enforcing non-negativity broke 13 honest-path tests
    — the invariance pin outranks a drafted bullet. Recorded in
    `TYPES_INTERFACE` §CreditBox; the sentinel retires with P2-C row C8
    (`proofSource` leaves the consensus bytes).
  - `string`: `proofSource` (karma), `targetPostId` (post_lock). Type only —
    format/length pins (hex-64 ids, byte caps) are a recorded rider, not
    this pin.
  - `boolean`: `decayBurn` (karma, when present).
- **Unknown `boxType` is a reject — and the schema lookup is an own-property
  lookup** (`Object.hasOwn` or equivalent), never a bare index into the
  table: `boxType: 'constructor'` must land in the unknown-boxType reject,
  not retrieve `Object.prototype.constructor` and throw downstream. A
  non-object or `null`/absent-`boxType` output entry rejects through the
  same arm. With the check at step 4 this arm is **reachable** and is the
  primary gate — the transition arms' own unknown-type rejections
  (karma/credit totality counts, `outputs.length` pins), which made it
  unreachable while the check ran at step 7, are now the defense-in-depth
  layer behind it.

**Why this is a consensus rule and not input hygiene:** an accepted lying guard
(or stray key) produces a stored box whose committed bytes — id preimage and
AVL leaf both — disagree with every later reconstruction of it, because
`rowToBox` rebuilds from the typed row (fabricated canonical guard, no stray
keys). The store and the tree then permanently disagree about the box's bytes.
That is the unpinned-field class (P2-B found six instances, F1 a seventh, this
is #8), and the divergence surface under journal replay and any future
snapshot sync. Ergo closes the whole class structurally — its wire format is a
closed positional schema with no maps, so a stray field is unrepresentable and
the guard *is* content (the ErgoTree itself: hashed = stored = enforced); its
Rust implementation additionally recomputes every box id from re-serialized
bytes at each deserialization boundary and hard-errors on mismatch. This check
is the same move at our one open edge.

Placement: `validateTx`, so pool entry, gossip relay, and block finalization
(which re-validates every embedded tx — step 5) all inherit it from the single
site. A JSON-edge-only check would leave the CBOR paths open.

**Within `validateTx` the check runs at step 4** — before conservation,
guards, and transitions, as the first consumer of `tx.outputs` (changed by the
field-type pin; the guard-shape pin had placed it at step 7 to preserve
arm-specific errors). Steps 5–7 dereference output fields under a schema
guarantee instead of defending per-site: the alternative — per-arm guards
before every `Buffer.from(karmaOut.owner)`-shaped read — scatters the totality
obligation across every current and future transition arm, which is precisely
the pattern by which the unpinned-field class keeps producing (an arm added
later forgets its guard). One gate, ahead of all semantic rules, is Ergo's
serializer-is-validator shape: parse-time strictness first, semantics after.
Consequence of the move: rejections that previously surfaced arm-specific
errors on *malformed* outputs now surface shape errors; the accepted set for
well-typed outputs is unchanged (the invariance pin — every id- and
root-asserting test passes unmodified).

**Totality.** With the schema at step 4, `validateTx` returns
`{valid: false}` and never throws for **any** contents of `tx.outputs` —
arbitrary decoded CBOR/JSON values, missing fields, wrong types, `null`
entries, unknown or prototype-colliding `boxType`s — provided the tx envelope
itself is structurally well-formed. Four live failure classes on the pre-pin
tree collapse into clean rejections:

1. **Validate-time throws** — transition arms dereference output fields
   (`Buffer.from(karmaOut.owner)` and seven sibling sites across the cancel,
   reveal, karma, vouch, creation, commit, and settlement arms), so a missing
   or non-buffer field TypeErrors out of `validateTx` (HTTP 500; the block
   funnel's totality catch converts to a block rejection).
2. **Apply-time throws** — fields no arm reads reach `insertBox`, which
   `Buffer.from`s them mid-block-apply (e.g. a numeric `post_lock.owner`).
3. **Read-time throws** — a stored lie poisons the row: `rowToBox` does
   `BigInt(e.originalValue)`, so `originalValue: "x"` crashes **every later
   read of that box**. Measured on the pre-pin tree: the poison block APPLIED
   through the real funnel, and the first like-settlement or prune touching
   the target post then threw mid-apply — caught by the funnel (block
   rejected, node survives), but every node stored the same poison, so the
   post becomes unlikeable and unprunable network-wide, a permanent per-post
   landmine. Restart recovers the process (the startup box scan died with
   P2-B phase 4) but never the row.
4. **Committed-byte lies** — a mistyped field enters the id preimage and the
   AVL leaf but round-trips differently through the store's JSON `extra_data`
   (a string `owner` becomes a char-array becomes zero-bytes;
   `-0` becomes `0`), breaking `computeBoxId(rowToBox(row)) === row.id`.

**Scheduled follow-up (P2-C bundle):** `guard` leaves the consensus bytes
entirely — a redundant field has no place in an id preimage. That is a format
break (every box id moves), so it rides the bundle; when it lands, the guard
half of this check retires and the key-set half keeps the schema closed.

### Transaction envelope shape (`checkTxEnvelope`)

> ⚠ **AHEAD OF CODE — contracted for the tx-envelope bundle; the gate does not
> exist yet.** Until it lands, the totality claim above is scoped to
> `tx.outputs`; the envelope itself still throws, re-derived 2026-08-08:
> `inputs: null` at step 1 (`tx.inputs.length`); a missing/`null` `signatures`
> map in `checkGuards` (`tx.signatures[hexKey]`); `outputs: null` inside
> `checkOutputShape` itself (`.length`), while a non-array `outputs` *object*
> slips past it to conservation's `.reduce`; `likeTarget: null` passes
> conservation's `!== undefined` presence test and then throws at
> `h.update(null)` inside `computeTxId` — which `checkGuards` calls on its
> FIRST line, so the whole envelope reaches the hasher at step 6; non-`Uint8Array`
> `preimages` values throw there the same way. And `tx.protocolVersion` is not
> validated anywhere — only the block header's is — so a tx with
> `protocolVersion: "x"` validates, pools, and applies end-to-end with the
> string `String()`-coerced into its id preimage.

`checkTxEnvelope(tx: unknown): UtxoResult` — **exported** from the engine.
**Total**: returns `{valid: false}` and never throws for any decoded-CBOR
value (error strings quote input via the total `describeValue`, never bare
`String(v)`). The envelope's key set is **closed** — an unknown key rejects.
`computeTxId` hashes only the known fields, so an extra envelope key would
otherwise be free malleability: two distinct CBOR byte strings carrying the
same txId.

The checks:

1. `tx` is a plain non-null, non-array object.
2. **Closed key set**: `inputs`, `outputs`, `signatures`, `protocolVersion`,
   optionally `preimages` and `likeTarget`. Any other key rejects. A present
   key with value `undefined` rejects (mirrors the output schema's
   present-undefined rule — CBOR encodes `undefined`, and `computeTxId`'s
   presence test is `!== undefined`, so a present-`undefined` `likeTarget`
   would hash as absent; the gate refuses the ambiguity).
3. `inputs`: an array; every entry a 64-char lowercase-hex string (the closed
   live set — `computeBoxId` emits nothing else). Emptiness remains step 1's
   rule ("at least one input"), not the gate's.
4. `outputs`: an array. Entries are NOT typed here — that is step 4's closed
   per-boxType schema. The gate only guarantees the iteration/reduce sites
   are total.
5. `signatures`: a plain object; every key a 64-char lowercase-hex string
   (an Ed25519 public key), every value a `Uint8Array` of length 64. An
   empty map is legal — the uncommitted-bond cancel path is guard-satisfied
   by preimage alone. Extra well-formed keys are shape-legal (guards only
   look up, nothing iterates; the like path's exactly-one-signature rule is
   `castLike`/gate-metadata policy, unchanged).
6. `preimages`: absent, or a plain **non-empty** object with 64-char
   lowercase-hex keys and `Uint8Array` values. Present-but-empty rejects:
   `computeTxId` guards on truthiness then iterates, so `{}` contributes
   nothing to the hash — `preimages: {}` and absence would be two CBOR
   encodings of one txId (the malleability rule 2 exists to kill), and
   `jsonToTx` already normalizes `{}` to absent on the HTTP edge. No length
   bound on values — the bytes are already in memory post-decode, and secret
   length was never a consensus rule.
7. `protocolVersion`: an integer strictly equal to `PROTOCOL_VERSION`
   (decided 2026-08-08). Same strict-equality posture as posts and block
   headers — no version-keyed dispatch exists (repo-root warning), and this
   gate does not pretend otherwise. Rider: `jsonToTx`'s `?? 1` default
   becomes `?? PROTOCOL_VERSION`, so the HTTP edge cannot mint
   stale-version txs after a future bump.
8. `likeTarget`: absent, or a 64-char lowercase-hex string.

**Call sites (all of them, or the guarantee is path-dependent):**

- `validateTx` **step 0** — ahead of every other read of `tx`.
- The block funnel, immediately after `decodeTx` (`block-apply.ts`) — the
  funnel computes `computeTxId(tx)` for its id-equality check BEFORE
  `validateTx` runs, and only `decodeTx` sits inside its local try today: a
  malformed envelope currently rejects the WHOLE block via the outer totality
  catch (misleading "unexpected failure" log). With the gate the tx is
  **skipped** (`continue`), matching its siblings in the same loop — decode
  failure and id mismatch both skip the tx and apply the block without it,
  deterministically on every node. (Whole-block rejection was the
  throw-path's accident, not a decided rule; skip is the loop's decided
  idiom. Honest producers cannot embed one — their pool never admits it.)
- HTTP keeps `jsonToTx`'s friendlier per-field `ClientError` 400s; the gate
  backstops the two fields that today pass through on bare type assertions
  (`inputs`, `protocolVersion`) — the field-type pin's "HTTP ingress is
  shielded" claim was overstated.

Gossip needs no separate call: its intake reaches `validateTx`. (Today a
malformed gossiped tx throws into `gossip.ts`'s topic-dispatch catch and is
silently swallowed under a comment attributing it to decode failure; with the
gate it becomes a logged rejection like any other.) `fork-resolution`'s
mempool reinsert decodes CBOR the node itself produced from once-valid txs —
outside the gate's call list, deliberately.

**Consensus scope:** a validation tightening in the same class as the
guard-shape and field-type pins — honest bytes unmoved; txs that previously
applied while carrying envelope garbage (junk `protocolVersion`, stray keys)
become rejections. Covered by the standing fresh-chain gate.

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

Every condition in this table is a **consensus rule enforced by the engine**
(`checkTransitions`, with guard satisfaction from `checkGuards`) — reachable by
block-embedded transactions, not only by the service layer. Service-layer
checks (rate limits, fixed amounts, pairing at create) are policy on *this
node's* mempool entry and are NOT listed here.

| Consumed | Created | Condition |
|----------|---------|-----------|
| KarmaBox | KarmaBox | Same owner, balance change (earn/spend) |
| KarmaBox | KarmaBox | **Like** (P2-D): `likeTarget` present ⟺ deficit exactly `LIKE_KARMA_COST` — the only legal deficit in any user tx. Exactly one karma output, same owner as all inputs; target must be a live post; `(liker, target)` not yet recorded |
| KarmaBox | KarmaBox + PostLockBox | Same owner, value conserved |

⚠ **"Same owner" binds the inputs to each other, not only the outputs to
`inputs[0]`.** Every karma row above requires **all karma inputs to share one
owner** — see "Karma transition rules" below. Consolidating several of your
own karma boxes stays legal; that is the legitimate multi-input case.
| KarmaBox | KarmaBox + InviteBox + BondBox | Invite create: same owner, value conserved, **and the BondBox output is uncommitted** — `inviteePublicKey` empty, both probation fields `0` |
| KarmaBox | KarmaBox + VouchBox | Vouch cast: karma outputs same owner; `vouch.value == VOUCH_KARMA_AMOUNT`; `vouch.voucherId` == the karma input's owner; no active cooldown for `(voucherId, targetId)` |
| VouchBox | — (unvouch) | **Exactly one VouchBox input**, zero outputs, voucher-signed. The staked karma escrows to `vouch_cooldowns` and is re-minted to `voucherId` at maturity — a round trip, not a burn |
| BondBox (uncommitted) | BondBox (committed) | Commit: paired invite's preimage + committed-invitee signature (H-2); preservation fields unchanged; probation window pinned — see bond rules below |
| InviteBox + BondBox (committed) | KarmaBox + BondBox | Claim (reveal): preimage + committed-invitee signature; karma output owner = committed invitee; bond preservation fields unchanged |
| KarmaBox + InviteBox + BondBox | KarmaBox | Cancel: inviter signature; output karma owner = input karma owner = `bond.inviterId` = `invite.inviterId` |
| BondBox (committed) | KarmaBox | Settlement: karma output owner = `bond.inviterId`, AND (settle height > `probationEndBlock` OR invitee's summed unspent karma ≥ `INVITE_KARMA_THRESHOLD`) |
| CreditBox | CreditBox(+CreditBox) | Any owner, value conserved |
| PostLockBox | PostLockBox(+KarmaBox) | Block application only (per-block vesting) — no user transaction can spend a `PostLockBox` |

There is **no other legal bond or invite shape**. In particular:

- **No standalone spend of an InviteBox.** The reveal guard
  (`hash_preimage_with_bond`) requires a BondBox input in the same
  transaction, so `InviteBox → KarmaBox` alone is guard-unreachable; the
  legal exits for an invite are the claim and cancel shapes above. (The
  previous table listed the standalone spend as a legal row with its rules
  "handled at service layer" — both halves of that were wrong.)
- **No standalone spend of an uncommitted BondBox.** Its exits are the
  commit and cancel shapes. A standalone spend would strand the paired
  invite: the claim shape needs a bond input, so an invite whose bond is
  gone can never be claimed.
- **No bond burn.** `BondBox → ∅` is illegal — see the bond rules below.

### Bond transition rules (P2-B phase 1)

- **The bond's value only ever returns to `bond.inviterId`.** Every shape
  that releases bond value (cancel, settlement) pins the receiving karma
  box's owner to the inviter. This is the rule that closes audit
  F-consensus-1: before it, a committed invitee could sign
  `bond → own KarmaBox` (or absorb invite + bond through the cancel shape)
  and take the deposit.
- **Settlement unlock is a spend-time predicate.** The invitee's *current*
  summed unspent karma ≥ `INVITE_KARMA_THRESHOLD`, or probation has
  expired (`settle height > probationEndBlock`). The historical form in
  ARCHITECTURE's bond-outcomes table ("reached the threshold within
  probation") is deliberately NOT the consensus rule — a spend-time check
  cannot see history, and the early-unlock leg is strictly
  inviter-favorable timing. Karma is summed across boxes, not per-box:
  multiple unspent karma boxes per owner is reachable (faucet grant +
  mint, or a karma split).
- **Forfeiture is not implemented, and no burn shape exists.**
  "Invitee karma < minimum during probation → burned" is a claim about
  history; enforcing it requires per-block bond scanning, and the
  karma-economics vesting design (design track §1.2) replaces bond
  settlement wholesale — the scanner would be built for deletion. Until
  that track lands: no legal transition destroys a bond, and value
  conservation has **no BondBox zero-output exception**. A voluntary burn
  was also considered and rejected: no flow needs it, and allowing it
  would let the committed invitee (whose signature satisfies `bond_dual`)
  torch the inviter's stake out of spite.
- **The probation window is pinned at commit:** `probationStartBlock > 0`,
  `probationStartBlock ≤ apply height`, and
  `probationEndBlock − probationStartBlock == INVITE_PROBATION_BLOCKS`.
  Without these, the committing invitee chooses the window freely and can
  lock the inviter's bond forever — via `probationEndBlock` directly, or
  by future-dating `probationStartBlock` under a pinned length. A strict
  `probationStartBlock == apply height` is NOT required: it would break on
  the delay between building the commit and its being mined. Past-dating
  the start is permitted and harmless: it only *shortens* the effective
  probation (at the limit, already-expired at commit), which strictly
  favors the inviter's unlock and evades nothing while forfeiture does not
  exist; the vesting design replaces these mechanics before forfeiture
  becomes real.
- **Engine inputs these rules need:** `checkTransitions` becomes
  height-aware (the settle height already flows into `validateTx`), and
  the deps gain an invitee-karma-sum read — the store's `getKarmaValue`
  (see §Store), which is the one implementation every path shares.
- **Known residual — claim-time invite↔bond pairing is unenforced**
  (audit F-consensus-5). The claim shape accepts *any* committed bond
  alongside the invite. It cannot be enforced under current fields: after
  commit, the bond's provenance (`txId`) points at the commit transaction,
  so `(bond.txId, bond.inviteOutputIndex)` no longer resolves the invite
  it shipped with. The fix is the committed bond carrying the invite's
  **box id** — safe there (the invite's id is fixed by the create tx
  before the commit tx exists, so no circularity), but it is a
  consensus-format change and belongs in the P2-C break bundle. Impact of
  the gap with this phase's rules in force: crossed pairs strand value
  recoverable only by the inviter's own cancels — a griefing wart, not
  theft.
- **A bond is born uncommitted, and committed state is reachable only
  through the commit transition** (P2-B phase 2). Invite creation must emit
  `inviteePublicKey` empty and both probation fields `0`. Without that, an
  inviter can emit a bond that is *born committed* with a zeroed window, and
  the settlement rule above accepts an immediate reclaim to themselves —
  every clause satisfied, the expiry leg vacuously true — while the InviteBox
  stays live and claimable. The bond, the network's only sybil cost, would
  cost nothing. This is the invariant that makes the commit-time window pin
  mean anything: with it, every committed bond has passed through the pinned
  commit path by construction.

### Karma transition rules (P2-B phase 4)

- **All karma inputs must share one owner.** The engine pins every karma
  *output* to `inputs[0].owner` and calls the violation "Karma cannot be
  transferred", but never checked that the inputs themselves agree — and
  `validateTx` step 3 only requires a common `boxType`. So
  `[karmaA(10), karmaB(10)] → karmaA(20)` validated: conservation holds,
  every output matches `inputs[0].owner`, and `checkGuards` gets the owner
  signature it wants from each of A and B. **B's karma became A's.**
  Consensual, but karma is non-transferable *by rule* — a consensual transfer
  is still a transfer, and it prices off-chain. This is the audit's most
  severe class, and unlike the unlike-path instance it does **not** close when
  P2-D removes unlike.
- Self-consolidation (several of your own karma boxes into one) is the
  legitimate multi-input case and stays legal. The faucet grant is unaffected:
  it is a single input. The 3-input invite cancel has exactly one karma input,
  and the 2-input claim has none.
- **Credits are deliberately exempt.** They are tradeable, so multi-owner
  credit inputs are an ordinary multi-party payment, not a leak.

### Vouch transition rules (P2-B phase 2)

- **The stake is pinned at cast: `VouchBox.value == VOUCH_KARMA_AMOUNT`.**
  A vouch is one vote and always stakes exactly 1 karma (user decision,
  2026-08-07). Before the pin, value was bounded only by conservation and
  `checkOutputValues` — which permits `0n` — while unvouch escrowed the
  **constant**. Both directions broke: a 0-value vouch matured into 1 karma
  minted from nothing, and a 100-value vouch destroyed 99 (audit
  F-consensus-3).
- **`voucherId` is pinned at cast: it must equal the karma input's owner.**
  `checkGuards` resolves a box's signer as `owner ?? voucherId`, so a
  VouchBox carrying a *foreign* `voucherId` is guarded by that foreign key:
  A stakes their own karma, B unvouches it, and the escrow matures to B.
  That is a karma transfer with no invite — the property the whole
  invite/bond mechanism protects. Not in the audit; found deriving this
  phase. `castVouch` never compared the signer to `voucherId` either, so it
  was reachable through the front door as well as through a block.
- **The escrow records the actual staked value**, never the constant, and
  maturity re-mints exactly that. With the cast pin the two always agree —
  recording the real value is what makes the round trip conservation-
  structural rather than true by coincidence.
- **A vouch cast is invalid while an active cooldown exists for
  `(voucherId, targetId)`** — the mempool's `hasActiveVouchCooldown`
  predicate, promoted to a consensus rule (decided 2026-08-04, built in this
  phase). Without it a block-embedded vouch→unvouch pair for a pair with a
  live cooldown reaches `insertVouchCooldown`'s `INSERT OR REPLACE` and
  destroys the first escrow's pending re-mint on the forward path. With the
  gate the overwrite is unreachable; the `replaced` side-record stays as
  rollback-exactness machinery.
- **Determinism.** `vouch_cooldowns` is not committed state — it is outside
  the `stateRoot`, the known escrow wart — but it is derived deterministically
  from block application alone, so every node that applied the same chain
  holds the same rows and this gate cannot split honest nodes. Modelling the
  escrow as a maturing box is tracked separately.
- **Self-vouch stays service-layer policy, not consensus.** At consensus a
  self-vouch is a value-neutral round trip of the actor's own karma, and vouch
  *score* is interpretation-layer (the node records; clients rank). Recorded
  so it is not promoted without a reason.
- **An unvouch consumes exactly one VouchBox** (P2-B phase 4). Block
  application detects the unvouch by walking the inputs for a VouchBox,
  writing one escrow row, and **stopping at the first one** — so a transaction
  consuming two VouchBoxes consumed both and escrowed one, destroying the
  other stake. Nothing bounded the count: the transition arm asked only for
  zero outputs, and conservation exempts zero-output vouch spends wholesale
  however many inputs there are. Reachable because the one-vouch-at-a-time
  rule is service-layer only, so block-embedded casts can give one voucher two
  live boxes, and two colluding owners reach it directly. The pin belongs in
  `checkTransitions` rather than in a block-apply loop that handles N: burning
  several stakes in one transaction has no meaning in the design, so it should
  be inexpressible rather than handled — the same reasoning as the bond
  settlement's single-input bound.

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
| `like-payout` | `author` | raw | 32 | per-block like settlement → `mintKarma(author, paid)`; one mint per author per block (P2-D) |
| `postlock-unlock` | `targetPostId` | `utf8(hex)` | 64 | per-block post-lock vesting → `mintKarma(post.author, toUnlock)` |
| `postlock-remainder` | `targetPostId` | `utf8(hex)` | 64 | per-block post-lock vesting, reduced-`PostLockBox` re-mint |
| `decay` | `owner` | raw | 32 | `applyKarmaDecay` |
| `genesis` | which genesis box | `u32BE(k)`: `0` = system karma, `1` = faucet credits | 4 | `ensureSystemKarmaBox` / `ensureFaucetCreditBox` |
| `prune-refund-author` | `(rootPostHash, owner)` | `utf8(hex)` ‖ raw | 96 | `settlePruneUtxo`, author leg |

**Retired by P2-D — names reserved, never reuse:** `author-reward` and `liker-refund`
(the epoch tally's reasons, superseded by `like-payout`), and `prune-refund-liker` (with
no `LikeBox` there is nothing to refund a liker at prune — the like's karma was burned at
cast and is deliberately unrecoverable).

✅ **Landed in phase G1/G2.** The two tags are in `MintReason`, the encoders are
in `mint-provenance.ts`, and `settlePruneUtxo` takes `rootPostHash` and passes
real contexts. `mintKarma`/`mintCredits` now take a **required** `MintContext` —
the `| null` escape hatch is gone, so a producer emitting no provenance is a
**compile error** (`TS2345`) rather than a runtime constraint failure at apply
time. That is the whole point of removing it: the defect class left the runtime.

Three things about them that are decided, not open:

- **Distinct recipients-at-height need distinct `(reason, subject)` pairs.** This
  bullet's original head — prune settlement carrying *two* reasons because one user can
  be both author and liker in one subtree — is historical since P2-D deleted the liker
  leg, but the rule it taught stands and has live instances: `like-payout` and
  `postlock-unlock` can both mint to the same author at the same height, separated by
  reason (and, as it happens, by subject shape).
- **`rootPostHash` is load-bearing, not decoration.** `settlePruneUtxo` runs
  **per prune entry**, so a block carrying two entries calls it twice at one
  height. Without the entry's identity in the subject, an author with refunds in
  both subtrees derives the same `mintTxId` twice at `index` 0, trips
  `UNIQUE(tx_id, output_index)`, and a **legitimate block is rejected**.
  (`subtreeMerkleRoot` — raw 32, giving a 64-byte subject — would serve equally
  and commits to the exact post set; `rootPostHash` was chosen because the mint
  id then traces to a post that can be looked up.)
- **Prefix-freeness still holds** across the post-P2-D set: `like-payout` is not a
  prefix of any live tag and none is a prefix of it (it also diverges from the *retired*
  `liker-refund` at the fifth byte, so even historical collisions are impossible).
  Phase A test-pinned the property over the whole `MintReason` union, so it re-checks
  automatically when the types phase edits the set.

**The author leg describes today's settlement and is still expected to be retired** —
karma-economics burns the pruner's own bond rather than refunding it (design track
§1.4.1). The liker leg is **already gone**: P2-D deleted `prune-refund-liker` with
`LikeBox`, since a like's karma is burned at cast and deliberately unrecoverable.
Retiring a `MintReason` pre-network costs nothing; retired names stay reserved.

Every encoding above is **fixed-length**, so the rule holds by construction
rather than by inspection.

⚠ **`genesis` deliberately does not use the ASCII tags `system-karma` /
`faucet-credits`** that Spec G §3.2 sketched. Those are variable-length and
neither self-delimiting nor fixed — they are merely *prefix-free*, which happens
to be sufficient for this pair but is not a property the rule can check per
encoding. A `u32BE` selector satisfies the rule outright. Adding a third genesis
box then costs one integer, not a re-examination of prefix-freeness.

`reason` is the discriminant that separates `like-payout` from `postlock-unlock` —
both can mint to the same author at the same height; the reason alone already
separates them (their subjects differ in shape too: raw author vs post-id hex).

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

`u32BE` is **exported from `@dagsocial/types`** (phase G1) and
`mint-provenance.ts` imports it; it previously kept a local mirror, and a silent
divergence between the two would have moved mint txIds — and therefore box ids —
with nothing to catch it, while this contract's own subject table mandates the
encoding. One implementation feeds both derivations. The demo UI cannot import
it and so must still reproduce the sentinel behaviour, and must not throw.

### The demo UI mirror carries the same strip defect (phase E)

`public/index.html`'s client-side `computeBoxId` does `const { id, ...rest } = box`
— the **id-only strip** that phase C0 removed from `@dagsocial/types`. Both of
its call sites hash **client-built** boxes carrying no provenance (the predicted
`inviteBoxId`, and the cached LikeBox id for unlike), so server and client agree
today and phase C does not change that. (P2-D deletes unlike and `LikeBox`
entirely — its UI phase removes that call site, and with it the last flow that
predicts a box id at all.)

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

⚠ **The UI had the id-only strip in TWO places, not one — `computeTxId` as well
as `computeBoxId`.** This contract named only the latter. Found and fixed in
phase E1 by extracting a single `canonicalBoxBytes()` helper in the UI and
routing both through it, mirroring how types is structured.

That makes **four** instances of the same defect: `computeTxId` in types (phase
A), `computeBoxId` in types (phase C0), and both UI sites (phase E1). The rule
was always "exactly one strip rule, so tx and box derivation cannot drift", and
it was violated everywhere it could be, in both implementations, because a local
`const { id, ...rest } = box` is the obvious thing to write and is wrong in a way
nothing detects until provenance exists. **When auditing a mirror, assume the
defect is in every site that strips, not the one that was reported.**

#### The mirror test MUST cover every box type

Not a representative one. The UI converts hex-string fields to bytes before
encoding using a hardcoded `binaryFields` name list, which is a hand-maintained
copy of "which box fields are `Uint8Array` in types" — and it **omitted
`VouchBox`'s `voucherId` and `targetId`**. A client-built vouch box would encode
them as CBOR *text* (`7840` + 64 ASCII) where the node writes a *byte string*
(`5820` + 32 raw), giving a different box id. Latent only because the vouch flow
POSTs to `/vouches` and never builds the box client-side.

That gap survived because the mirror covered **karma and credit only** — five of
seven box types were never encoded through both implementations and compared. So
the enforceable rule is coverage, not documentation: with every box type in the
mirror, a missing `binaryFields` entry fails mechanically instead of waiting for
someone to notice the list is a manual copy of a type definition.

⚠ **This is the second instance of the shape.** Phase C's report §4.2 records the
same thing in a different file — a round-trip test that used only a karma box, so
an in-range record tag at `0x03` could not collide with karma at `0x01` and the
mutation died against the literal assertion instead of the behaviour. **A
"representative" fixture in a test whose whole job is cross-implementation or
cross-kind agreement is not representative of anything.** Enumerate.

*(Having UI builders carry `Uint8Array` directly would remove the list entirely
and is the cleaner end state. It is deliberately **not** done here: it is
consensus-visible surgery across every box-building site, and it stops being
urgent once drift is caught by test.)*

### Phase G checklist — LANDED (phases G1–G3b)

Obligations accumulated across phases B–D and were stated where they were found,
which is right for context and wrong for not missing any. All nine are done;
kept here as the record of what closed, and where the reasoning lives.

**Format tightening**

1. ✅ `computeBoxId` **is** `computeCandidateBoxId(box, box.txId, box.index)`, and
   `TX_ID_DOMAIN` is applied to `computeTxId` — including in the demo UI, in the
   same commit. There is now exactly **one** implementation of each: node's
   `utxo-engine.ts` carried a second `computeTxId` (its own cbor-x `Encoder`,
   the id-only strip in its **sixth** location) which produced the hash
   *signatures were verified against*; applying the domain tag to types alone
   would have left builders signing a tagged id while the engine verified an
   untagged one. Deleted in G3b.
2. ✅ `txId`/`index` required on `BoxBase`; `UtxoTransaction.outputs` is
   `AnyBoxCandidate[]` (`TYPES_INTERFACE.md` → BoxId for why that is not the
   base `BoxCandidate`). `id` stays optional, deliberately — same reference.
3. ✅ `createdAtBlock` and `lastTouchBlock` deleted from the box protocol. The
   `created_at_block` **column** stays; `last_touch_block` was dropped with the
   field, having had no reader anywhere — only the INSERT that wrote it.
4. ✅ `utxo_boxes.tx_id` / `output_index` are `NOT NULL`, in the same commit as
   the box-field deletions. That grouping earned itself twice over: it avoided
   editing ~190 fixtures twice, **and** NOT NULL turned out to be the only thing
   that fails loudly. `TextEncoder` encodes `undefined` as zero bytes and `u32BE`
   maps it to the sentinel, so a box with missing provenance derives a stable
   *wrong* id rather than throwing — invisible in the one phase where every
   golden legitimately moves. `box-provenance.test.ts`'s nullable-pinning cases
   were deleted, not repaired.
4b. ✅ `CURRENT_SCHEMA_VERSION` 0 → 1 — the first time the counter has moved, and
   the first time it could act.

**Correctness debts that only became enforceable here**

5. ✅ **Canonical key ordering in both encoders**, plus the demo UI's. Retires
   hazards 1b and 1c. `post_lock`'s producer-vs-`rowToBox` divergence is fixed
   **by the sort, not by reordering that site** — a producer can no longer get
   key order wrong because it no longer chooses it.
6. ✅ Attach-provenance-before-deriving-the-id is now testable, and tested:
   `computeBoxId` observes `txId`/`index`, so the two orders are no longer
   byte-identical.
7. ✅ `insertBox` takes the height from the open journal
   (`openBlockJournalHeight()`), never from the box. Deleting the field is what
   proved it: there is nothing else it could read. `0` outside a journal —
   genesis and bootstrap — which is honest rather than a fallback.

**Blockers, both cleared before G3**

8. ✅ `settlePruneUtxo` mint reasons (G2).
9. ✅ `u32BE` exported from `@dagsocial/types` (G1).

### What G3 changed that was NOT on this list

**`BondBox.inviteBoxId` → `inviteOutputIndex`** (user decision, 2026-08-06). A
box id in a **content** field is circular under the provenance derivation: the id
derives from the creating `txId`, and a content field is inside the bytes
`computeTxId` hashes. Measured: no fixed point exists. Spec G §3.1's
"no circularity" argument covers *provenance* fields and does not reach this.

The index form is not a workaround for the hash cycle. The bond and its invite
are always outputs of one transaction, so pairing by position makes a bond that
names *someone else's* invite inexpressible — the old field could name any box in
the world and was checked only when dereferenced, one transaction later. Two
things carry it:

- `invites.ts` rejects at **create** if `inviteOutputIndex` does not address the
  InviteBox output of the same transaction. Scope is structural, target is
  checked; together a mispaired bond cannot be built.
- the commit path resolves via `getBoxByProvenance(bond.txId, inviteOutputIndex)`,
  backed by the `UNIQUE(tx_id, output_index)` index that already existed. Both
  `checkTransitions` preservation checks compare the index.

**The demo UI stops predicting an id for invites entirely** — it states an output
index it already knows. That is stronger than the "exact prediction" Spec G aimed
at: prediction became *unnecessary*. The unlike path still genuinely predicts, and
is now the only flow that does.

### A frozen golden cannot defend a property

Found by G3b's mutation battery and general beyond this spec. Dropping
`TX_ID_DOMAIN` was killed only by three frozen-constant assertions. A golden
catches a removal **only because the golden was regenerated after the change**,
so the assertion is "this id equals this number" and the natural response to it
failing is to update the number — which is exactly what a phase that legitimately
moves every golden invites.

**A property needs an assertion that does not depend on the current output.** The
working shape is an *independent recompute*: write the preimage out from the
contract text and compare, rather than calling the function under test. Applied
to the domain tags in `types/test/utxo.test.ts`, alongside distinctness and
prefix-freeness over the tag set.

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
6.–11. *(Retired by P2-D. Standalone-like sidecar attachment (old step 6), like
    collection, like dedup and the epoch-boundary check are gone — likes are ordinary
    mempool UTXO transactions, so they flow through steps 7–8 like any other tx; dedup is
    the like-record's existence, enforced at apply; there is no epoch. Numbering kept so
    later step references stay stable.)*
7. Standalone UTXO entries → `utxoTxIds` (likes included — no sidecar diversion)
8. Batch-linked UTXO entries → `utxoTxIds`
12. Always produce a block — miners need coinbase rewards even when there
    is no user work.  Empty blocks carry credit emission.
    ⚠ **One exception, and only one (P2-B phase 1c): a body its own mutation
    phase rejects.** See step 15b — the creator produces nothing and evicts
    the included mempool entries. Mining over a body the node itself will not
    apply wastes PoW on a block that cannot be accepted anywhere.
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
6. Remove confirmed entries from mempool (`removeEntry` for each confirmed rowid).
   ⚠ **This runs even when the block was rejected**, and that is deliberate,
   not an oversight: whatever made the body invalid is still pooled, so
   leaving it would rebuild the same rejected block every interval and stall
   the chain — expiry cannot save it, since `purgeExpired` keys on a height
   that stops advancing when production stops. Step 15b's `body rejected`
   outcome applies the same eviction for the same reason.
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

**The speculation has three outcomes, not two** (P2-B phase 1c — the code
returns them as a discriminated union so no caller can conflate them):

| Outcome | Meaning | Creator's obligation |
|---|---|---|
| computed | the post-block digest | mine over it |
| no prover | no prover initialized — test-only | write `EMPTY_STATE_ROOT` and produce |
| **body rejected** | the mutation phase rejected this body | **produce nothing, and evict the included mempool entries** |

A producer with no prover initialized writes `EMPTY_STATE_ROOT`. Production
nodes always initialize one at startup, so this is a test-only path — but a
node running with `VERIFY_STATE_ROOT` enabled will reject such a block, which
is correct.

**Body rejected is fatal to production, and the eviction is not optional.**
Mining over a body this node's own mutation phase refuses produces a block
nothing will accept — the pre-fix code warned "the block cannot be produced"
and then mined it anyway. Producing nothing while *leaving the entries pooled*
is worse still: the creator rebuilds the identical body every interval, and
`MEMPOOL_EXPIRY_BLOCKS` can never rescue it because expiry keys on a chain
height that stops advancing the moment the node stops producing — a permanent
silent stall. Eviction-on-rejection is the same semantics the finalize path
already applies to a rejected block, and it is load-bearing for exactly this
reason. An unexpected throw during speculation counts as **body rejected**,
not as "no prover": the apply funnel's totality doctrine treats the same throw
as a block rejection, so a body that crashes speculation is one no node will
apply.

Residual, recorded rather than hidden: entries that rode into the same body
are evicted with the offending one. Transaction-level drop-and-retry — evict
only the culprit and rebuild — needs the mutation phase to report *which*
transaction failed, and is not built.

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

> ⚠ **VIOLATED — the lock has no spend-time enforcement, so it is decorative.**
> Measured 2026-08-07. `lockedUntilBlock` is checked when a coinbase output is
> *created* (`block-apply` rejects a block whose coinbase carries the wrong
> lock) and used as a *selection* filter (`getUnlockedCreditBoxes`, for the UI
> and faucet). No validation path reads it: `validateTx`, `checkTransitions`
> and `checkGuards` never mention it, and `net.onTx` calls `validateTx` and
> nothing else — so a gossiped transaction naming a locked coinbase box as an
> input pools and applies today.
>
> **Enforcing it is not a one-line check**, and that is why it is recorded
> rather than fixed. `mintCredits` consolidates *every* credit box an owner
> holds into one carrying `max(all locks)`, so under enforcement a single
> mined block would freeze the miner's whole balance for 720 blocks, and
> mining again would extend it — an active miner could never spend. The rule
> and the consolidation have to be designed together (a coinbase mint keeping
> its own box is the obvious shape, and is how Bitcoin and Ergo do it), which
> makes this an emission-model decision the karma-economics track owns.

### Difficulty schedule

`powTargetBits` is a deterministic function of block height — Phase 1 is a
fixed target (`expectedTarget(height) = ORDERING_BLOCK_POW_TARGET_BITS`),
enforced at apply on every path: a block whose header target differs from the
schedule is rejected. There is **no wall-clock retargeting** — the previous
duration-ratio adjustment was removed because it made the target a function of
local wall time (audit M-2). Normative spec: `MINING_INTERFACE.md`
("Difficulty Schedule").

### Per-block like settlement (P2-D — replaced the epoch tally)

Runs at the end of **every** block's mutation phase. Entirely **derived** — nothing rides
in the block (compare the retired `EpochTallyResults`, which had to be carried and
compared; per-block settlement cannot disagree between producer and verifier because
neither transports it).

**During embedded-tx application**, each like transaction (the `likeTarget` biconditional
shape, validated by the engine):

1. Re-checks at apply: target confirmed and **live** at this height (likes on pruned
   posts rejected by stated rule); author resolved from **`block_topology`**, never
   `dag_posts.author`; like-record `(liker, targetPostId)` absent — else the tx is
   invalid and the block is rejected
2. Writes the like-record via `insertLikeRecord` (journalled side-record)
3. Increments an in-memory per-author counter and per-post counter for this block

**At end of mutation phase, after all embedded txs** (order pinned: embedded txs →
like settlement → post-lock vesting → decay → vouch cooldowns):

4. **Author settlement** — for each author with a non-zero counter, in ascending
   author-hex order:
   ```
   total = record.likeCarry + likesThisBlock
   paid  = (total / LIKES_PER_KARMA_PAYOUT) * (LIKES_PER_KARMA_PAYOUT − 1)   // integer, truncating
   carry = total % LIKES_PER_KARMA_PAYOUT
   ```
   If `paid > 0`: `mintKarma(author, paid, { reason: 'like-payout', subject: author })` —
   one mint per author per block, consolidating as every karma mint does. Write `carry`
   back via `putIdentityRecord` **unconditionally** (it changed even when `paid` is 0) —
   journalled as `kind:'record'`, so it reaches the AVL feed and the `stateRoot`.
5. **Post-lock vesting** — for each post with a non-zero per-post counter and a live
   `PostLockBox`, in ascending post-id order:
   ```
   totalLikes      = getLikeRecordCount(postId)          // lifetime, live post
   alreadyUnlocked = originalValue − value
   shouldUnlock    = totalLikes / POST_LOCK_UNLOCK_PER_LIKES   // integer division
   toUnlock        = min(value, shouldUnlock − alreadyUnlocked)
   ```
   If `toUnlock > 0`: consume the box, `mintKarma(post.author, toUnlock,
   { reason: 'postlock-unlock', subject: targetPostId })`, and re-mint the reduced box
   (`postlock-remainder`) unless fully unlocked.

**Determinism:** iteration orders are pinned (author hex, post id) for journal-order
canonicality; the mint ids are order-independent regardless (`(height, reason, subject)`).
All arithmetic `bigint`/integer — a float intermediate is a consensus fork.

**Same-block exclusion:** a block may not carry both a like on post `P` and a prune entry
covering `P`. Prune settlement runs before embedded txs in the mutation order, so the like
finds its target pruned, is invalid, and the whole block is rejected. Producers must not
assemble such a block; the rule makes the outcome deterministic when one does.

**Blocks with no likes** run neither loop — no record writes, no mints, no vesting. An
author's carry sits unchanged in the `stateRoot` until their next liked block.

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

### Like-records (P2-D — replaces `dag_likes`)

**Table:** `like_records (target_post_id TEXT NOT NULL, liker_id BLOB NOT NULL,
applied_at_block INTEGER NOT NULL, PRIMARY KEY (target_post_id, liker_id))`. Written
**only** at block application (never by an HTTP route — the retired free-like tier's
`dag_likes` rows were route-written, which is what made the old epoch mint a DAG-index
read inside consensus). Content-layer consensus state, the `block_topology` tier:
deterministic by replay, journalled with exact inverses, not in the `stateRoot`. The
`dag_likes` table is **dropped** — schema version bumps (`CURRENT_SCHEMA_VERSION` 1 → 2),
so a node started against an old DB fails loudly at startup.

| Function | Signature |
|----------|-----------|
| `insertLikeRecord(targetPostId, likerId, blockHeight)` | `(PostId, UserId, number) => void` — **block application only**; records a `likeRecordInsertions` journal side-record; throws on the primary key — the structural dedup |
| `hasLikeRecord(targetPostId, likerId)` | `(PostId, UserId) => boolean` |
| `getLikeRecordCount(postId)` | `(PostId) => number` — lifetime likes on a live post; feeds post-lock vesting and API `likeCount` |
| `deleteLikeRecordsForPosts(postIds)` | `(PostId[]) => void` — **prune settlement only**; captures every deleted row as a `likeRecordDeletions` journal side-record before deleting |
| `deleteLikeRecord(targetPostId, likerId)` | `(PostId, UserId) => void` — fork-rollback inverse (never records) |
| `restoreLikeRecord(targetPostId, likerId, appliedAtBlock)` | `(PostId, UserId, number) => void` — fork-rollback inverse (never records) |

### UTXO

| Function | Signature |
|----------|-----------|
| `getBox(boxId)` | `(string) => AnyBox \| null` |
| `getUnspentBoxes()` | `() => AnyBox[]` — all unspent boxes (for AVL bootstrapping) |
| `getKarmaBox(owner)` | `(Uint8Array) => KarmaBox \| null` — single box (backward compat) |
| `getKarmaBoxes(owner)` | `(Uint8Array) => KarmaBox[]` — multi-box listing (full boxes, keyed on `id` — the contract previously said `{ boxId, value }[]`, which was never the implementation) |
| `getKarmaValue(owner)` | `(Uint8Array) => bigint` — **summed** value of every unspent karma box. **Consensus input** (bond settlement's unlock predicate), and the single implementation every validation path shares since P2-B phase 1b. It must sum, never read one box: `getKarmaBox` is `LIMIT 1` with no `ORDER BY`, so a single-box read makes the verdict a function of SQLite's physical row order — M-12's class. Kept as one store function rather than a closure per deps literal, because a consensus-critical read reproduced at each call site is the mirror pattern that produced `computeTxIdLocal` and the copied `u32BE` |
| `getCreditBox(owner)` | `(Uint8Array) => CreditBox \| null` — single box |
| `getCreditBoxes(owner)` | `(Uint8Array) => CreditBox[]` — multi-box, `ORDER BY value DESC` (the contract previously said `{ boxId, value, lockedUntilBlock? }[]`, which was never the implementation) |
| `getUnlockedCreditBoxes(owner, blockHeight)` | `(Uint8Array, number) => CreditBox[]` |
| `getPendingInvites(inviterId)` | `(UserId) => InviteBox[]` — unclaimed, unexpired |
| `getPendingInviteCount(inviterId)` | `(UserId) => number` |
| `getBondBoxes(inviterId)` | `(UserId) => BondBox[]` — active bonds |
| `getLikersForPost(postId)` | `(string) => string[]` — hex user IDs who liked; reads `like_records` (P2-D), `ORDER BY liker_id` so the listing is a function of state, not row order (N4a ratification) |
| `getUnspentPostLockBoxes()` | `() => PostLockBox[]` |
| `getPostLockBox(targetPostId)` | `(string) => PostLockBox \| null` |
| `insertBox(box)` | `(AnyBox) => void` — writes the provenance columns; records `{kind:'box', op:'insert', boxId, box}` while a block journal is open |
| `consumeBox(boxId, consumedAtBlock)` | `(string, number) => void` — mark as spent; records `{kind:'box', op:'remove', boxId}` while a block journal is open |
| `unconsumeBox(boxId)` | `(string) => void` — un-mark spent (fork-rollback inverse; never records) |
| `deleteBox(boxId)` | `(string) => void` — (fork-rollback inverse; never records) |

(P2-D deleted the like-box readers — `getLockedLikeBoxes`, `getUnspentLikeBoxes`,
`getUnprocessedLockedLikeBoxes`, `getPostTotalLikes` — and `markLikeBoxesTallied`, the
epoch's sentinel-spend choke point. Like counts come from `getLikeRecordCount`.)

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
  likeCarry: bigint           // < LIKES_PER_KARMA_PAYOUT — outstanding like accrual (P2-D)
}
```

**AVL key** — `blake2b512( IDENTITY_KEY_DOMAIN ‖ identityId )[0:32]`, **never
the raw `identityId`.** Records and boxes share one 32-byte AVL keyspace, and
an `identityId` is 32 *attacker-chosen* bytes (a public key): used raw, someone
could grind a keypair whose pubkey equals a live box id and collide the two
entity kinds in the tree. Hashing under a domain tag makes that infeasible and
is what makes the two kinds provably disjoint.

**Table:** `identity_records (identity_id BLOB PRIMARY KEY, last_activity_block
INTEGER NOT NULL, last_decay_block INTEGER NOT NULL, like_carry INTEGER NOT NULL
DEFAULT 0)`. The SQL table keys on the raw 32 bytes; the AVL key is derived. Both
are total functions of the identity, so the two representations cannot drift.

⚠ **`likeCarry` enters the record's AVL value encoding as an always-present field** —
conditional presence would reopen the key-set-exactness fork (contract 1a: cbor-x
encodes present-but-`undefined` differently from absent, and the map header counts
keys). The record shape change moves every record's AVL value bytes ⇒ `stateRoot`
changes ⇒ covered by the standing fresh-chain deploy gate.

| Function | Signature |
|----------|-----------|
| `getIdentityRecord(identityId)` | `(UserId) => IdentityRecord \| null` |
| `putIdentityRecord(identityId, record)` | `(UserId, IdentityRecord) => void` — upsert; while a block journal is open, captures the row it replaces and records `{kind:'record', key, record, replaced?}` |
| `deleteIdentityRecord(identityId)` | `(UserId) => void` — fork-rollback inverse only; never records |

**Lifecycle:** created on first karma receipt or on the first like received (the
settlement's unconditional carry write — P2-D), **never deleted** in normal
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
- **`likeCarry`** (P2-D) — written **only** by per-block like settlement, via
  `putIdentityRecord` at the end of the mutation phase, unconditionally for every
  author who received likes in the block. No other path may touch it.

**The height comes from the open journal, not from the box.** `insertBox` takes
no height, and `createdAtBlock` is the field Spec G is removing — reading it
would reintroduce the dependency phase D exists to delete, and would break
outright at phase G. The open journal already carries the block's height
(`beginBlockJournal(height)`), and that *is* the settled height. A narrow
accessor for it is the right seam; the record is only meaningful during block
application anyway, which is exactly when a journal is open.

With no journal open (bootstrap, non-block paths) `insertBox` records nothing,
consistent with every other choke-point hook.

**A missing record means maximally stale, never "skip this owner".** The
fallback is `{lastActivityBlock: 0, lastDecayBlock: 0}`. Both total options are
defensible in isolation and they fail in **opposite directions**, which is why
the choice belongs here rather than in whoever writes the code: over-charging an
identity by a fraction of an interval is recoverable and visible, whereas
silently exempting one from decay forever is an unbounded economic hole and
looks like nothing at all. Choose the recoverable failure.

With genesis writing its own record (below), this path should be unreachable —
but "should be unreachable" is exactly the condition under which a silent
exemption would never be noticed.

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

> ⚠ **SUPERSEDED (2026-08-07) — rebuilding the tree from the UTXO set is being
> removed, because it is both unreachable and unsound.** The requirement above
> was the right fix for the tree it described; the mechanism itself does not
> survive scrutiny.
>
> - **Unreachable.** The trigger is `storage.version() === null`, and under
>   `@ergots/avltree` 0.4.0 the `PersistentBatchAVLProver` constructor writes
>   the empty-tree version to empty storage — so the condition is statically
>   false after `createAvlProver()`. Almost certainly a regression from the
>   0.4.0 migration (`7c8fbe5`), unnoticed because nothing exercised the path.
> - **Unsound even if revived.** AVL+ tree *shape* is history-dependent, so a
>   tree rebuilt by re-inserting a set does not generally have the digest of a
>   tree grown incrementally to the same content. Measured: identical 7-box
>   content agreed on the digest in **6 of 10 rounds** (content lookups agreed
>   10/10). A rebuilt node would therefore fork against a node that never
>   restarted — the failure the rebuild exists to prevent.
>
> **The sound restart path is the persisted tree**, which the constructor
> loads and which is what every normal restart already uses. Replay from the
> journal would also be sound and is not built.
>
> **Operational consequence: AVL storage must never be wiped independently of
> the chain.** There is no recovery path that reconstructs a matching tree
> from boxes. Wiping both together is the only supported reset.

### Vouch Cooldowns

| Function | Signature |
|----------|-----------|
| `insertVouchCooldown(voucherId, targetId, releaseAtBlock, karmaAmount)` | `(UserId, UserId, number, bigint) => void` — `INSERT OR REPLACE`; while a block journal is open, records the insertion side-record, capturing any row it replaces. `karmaAmount` is the **actual staked value** of the VouchBox being spent, never a constant (P2-B phase 2). Since the same phase gates a cast on there being no active cooldown for the pair, the REPLACE arm is unreachable at apply; it and the `replaced` capture remain for rollback exactness |
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
  likeRecordInsertions: Array<{ targetPostId: string, likerId: UserId }>
                                   // inverse: deleteLikeRecord (P2-D)
  likeRecordDeletions: Array<{ targetPostId: string, likerId: UserId,
    appliedAtBlock: number }>      // inverse: restoreLikeRecord — a reverted prune
                                   // restores the subtree's like-records exactly (P2-D)
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
`consumeBox` appends `{kind:'box', op:'remove', boxId}`; `putIdentityRecord`
appends `{kind:'record', …}`, capturing the row it replaces;
`insertLikeRecord`, `deleteLikeRecordsForPosts`, `insertVouchCooldown`, and
`deleteVouchCooldown` append their side-records, capturing the affected row(s)
before writing. Services and call sites MUST NOT maintain parallel mutation
bookkeeping — record-once at the choke point is the drift fix (C-5, H-5, H-7,
and the merge-consume value-loss: the boxes `mintKarma`/`mintCredits` consume
internally are now journaled by construction). With no journal open, every
primitive behaves as before and records nothing (bootstrap and non-block
paths). The rollback inverses — `deleteBox`, `unconsumeBox`,
`deleteIdentityRecord`, `deleteLikeRecord`, `restoreLikeRecord` — never record.
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
merged in), like-payout mints (including pre-existing karma merged in),
post-lock vesting swap, like-record inserts and prune-time deletes (rows
restored exactly), decay, vouch-cooldown mint (escrow row restored), prune
settlement, user txs, and **identity records** (`likeCarry` included). Reorg re-insertion reads
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

`insertStump`'s only caller is prune settlement in block application — every
row derives from a PruneEntry the funnel verified (see "Pruning" → "Stumps
are derived state"). Because the insert is unconditional at settlement and
every apply path goes through the one funnel, a settled prune without its
stump row cannot arise on a fresh chain; there is no repair or pull path.

⚠ **Known gap (recorded, not fixed here):** stump inserts are not
journalled, so `revertBlock` does not remove them — a reorged-away prune
leaves its stump row (and `getPost` keeps resolving it) until the entry
settles again on the winning branch. Belongs to the journalling work
sequenced with P2-D4.

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
> in costs no extra churn; doing it earlier moves ids twice.

> ✅ **LANDED — phase G3b, 2026-08-06. This hazard is CLOSED.** Both encoders now sort
> keys (`canonicalBoxBytes` → `encodeForHash(sortKeys(rest))`; `serialize-box.ts` →
> `cborEncode(sortKeys(fields))`), so a producer no longer chooses key order and cannot
> get it wrong. **`post_lock`'s producer-vs-`rowToBox` divergence is fixed by the sort,
> not by reordering that site.**
>
> ⚠ **The paragraph above previously ended with an interim rule that is now actively
> harmful and has been removed:** *"Until then, producers and `rowToBox` MUST agree on
> field order, and `post_lock` is a known outstanding violation."* That mandated a
> hand-maintained coupling between distant call sites which the sort exists to make
> unnecessary — following it would re-introduce exactly what G3b removed. It survived
> because G3b landed **one day after** this section was written, and the phase-G checklist
> elsewhere in this file was ticked while this section was not. **A reader consulting the
> detailed hazard section got "live fork, apply this discipline"; a reader consulting the
> checklist got "done."** Both read as authoritative.
>
> **Header key order is a separate matter and is NOT closed by this** — `encodeHeader` is
> still an unsorted `toBuffer(h)`. It holds today only because the store persists the
> producer's exact bytes and `decodeHeader` preserves their order on the way back. See
> §Ordering Block Creator.

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

**2. The proof endpoint must not throw on a record, and must say which kind it
served.** `GET /api/v1/proof/:boxId` decodes whatever value the key resolves to;
a record-shaped value would throw under a box-only decoder. Keys are
indistinguishable from outside — both kinds are 32 bytes of hash output — so a
client *can* ask for one. Landed in phase D, alongside populating the record.

The response carries **`kind: 'box' | 'record' | null`**. This is required, not
cosmetic: the proof verifies the value bytes whichever kind they are, so without
an explicit discriminant a light client would verify a valid proof and then read
a record as a box with every field `undefined` — treating committed state as a
malformed box. That is strictly worse than the throw it replaced, because it
fails silently and *with* a valid proof. `null` distinguishes an absent key (a
valid exclusion proof) from "present, and not a box".

*(The route parameter is still named `boxId` while addressing two entity kinds.
Renaming it is a public API change and deliberately not done here.)*

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

> ⚠ **NEVER BUILT — NOT PLANNED, and this one is actively dangerous.**
> **"All storage access goes through the `PostStore` interface" is false.** Nothing routes
> through it. Every real write path is a module function in `store/*`, and the abstraction
> is wired but never called.
>
> **Its `put()` would corrupt `dag_posts` if used.** A future session that reads this
> section, believes the abstraction is the sanctioned path, and writes through it will
> damage the posts table — which is why this is marked rather than deleted. Use the
> `store/*` module functions.
>
> The opaque `(typeId, id, sequence, data)` design principle below describes the intended
> shape of an abstraction that was never adopted. Treat it as a design sketch, not as a
> description of the store.

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
| `block-apply.ts` | Block application, UTXO settlement, per-block like settlement | Block creation |
| `utxo-engine.ts` | UTXO transaction validation and application | Block structure |
| `stump-engine.ts` | Verifiable prune execution | DAG content |
| `content-sweep.ts` | Placeholder resolution (missing post content pulled from peers) | Post creation |
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

> ⚠ **NEVER BUILT — NOT PLANNED.** Neither identifier exists in `packages/`. Queries serve
> the DAG tip, not a validated watermark. The `dag_meta` values with similar names are
> write-only `+1` counters — not heights, never read, not reset on reorg. Duplicated in
> `VALIDATION_INTERFACE.md → Phased Validation Pipeline`; **change both together or
> neither.**

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

All config via environment variables with defaults.

**Every variable carries a `Class`. The class is normative, not descriptive.**

| Class | Meaning | Rule |
|---|---|---|
| `consensus` | Changing it diverges committed state or block validity | **MUST NOT be readable from the environment.** Two nodes differing on any one of these partition permanently. These belong in `@dagsocial/types` as constants |
| `consensus-check` | Does not change what is *valid*; disables a node's own verification of it | May be configurable, but the contract must state what stops being checked |
| `advertised` | Reported to clients; the verifier enforces a compile-time constant instead | Changing it changes what the node *claims*, not what it *accepts* |
| `network-identity` | Selects the network — **and with it every consensus parameter, the wire magic, and the genesis** | Not a within-network parameter; nodes on different values are different networks. **Exactly one variable carries this class** |
| `local` | Genuinely a node's own choice — producer behaviour, resource ceilings | Free to vary |
| `operational` | Paths, ports, keys, addresses | Free to vary |

⚠ **Nine of these were undocumented until 2026-08-06, and five of those are `consensus`.** The
convention exists because the absence of one is a live defect class: nothing marked which variables an
operator may safely change, and four consensus parameters were environment-tunable.

> ✅ **DONE — P2-A removed all ten from the environment** (PR #8, `4670ae5`). They did not
> become better-documented environment variables; they stopped being configuration. **Five**
> are now fields of the **network profile** and **five** are plain universal constants in
> `@dagsocial/types`. Verified 2026-08-07: none of the ten is read anywhere in
> `packages/node/src`. The rows below are struck through and kept as a record, so an
> operator carrying an old env file can see what happened to each one — **all ten are now
> silently ignored if set.** See `ARCHITECTURE §Network Identity` and
> `TYPES_INTERFACE §Network profiles`.
>
> All ten are now fully closed: `AVL_KEY_LENGTH` was the last half-done one, and it is now a
> `@dagsocial/types` export (TYPES_INTERFACE → State format) that `config.ts` imports.

**Where each consensus value went:**

| Value | Destination | Why |
|---|---|---|
| `ORDERING_BLOCK_POW_TARGET_BITS` | **profile** | Difficulty differs per network |
| `POST_POW_TARGET_BITS` | **profile** | Difficulty differs per network |
| `KARMA_DECAY_INTERVAL_BLOCKS` | **profile** | Timescale differs per network |
| `KARMA_STALE_THRESHOLD_BLOCKS` | **profile** | Timescale differs per network |
| `TREASURY_PUBKEY` | **profile** | Genesis data — a different chain has a different treasury |
| `KARMA_DECAY_AMOUNT` | universal constant | Economics. Devnet decays *often*, not *harder* |
| `KARMA_MINIMUM` | universal constant | Economics |
| `CREDIT_TREASURY_PCT` | universal constant | Economics |
| `CREDIT_INITIAL_REWARD` | universal constant | Economics — separately, it is read and never used (A5) |
| `AVL_KEY_LENGTH` | universal constant | Format. No network has a reason to differ |

> **`POST_POW_TARGET_BITS` — A6 resolved: make it real, do not stop exposing it.** It is
> classed `advertised` today because the challenge endpoint reports it while the verifier
> enforces the compile-time constant, so a node can tell clients a difficulty it does not
> enforce. Under the profile both sides read the same field and the class becomes moot.
>
> The evidence that this is the right direction is already in the repo:
> `test/harness/node-manager.ts:47-50` carries a comment explaining that the harness
> **deliberately does not override** `POST_POW_TARGET_BITS`, because doing so makes the
> challenge endpoint and the verifier disagree. That comment is a workaround for exactly
> this defect — and it is why the harness could never get cheap post PoW.

| Variable | Class | Default | Description |
|----------|-------|---------|-------------|
| `NETWORK_TYPE` | `network-identity` | `testnet` | **The profile selector — `mainnet` \| `testnet` \| `devnet`.** The only environment variable that may change a consensus parameter, and it changes every one of them together. Also gates debug endpoints (faucet: testnet and devnet only, via the shared `isFaucetNetwork` allow-list). An unrecognised value **throws at startup** rather than defaulting |
| ~~`AVL_KEY_LENGTH`~~ | **removed** | ~~`32`~~ | AVL tree key length — **sets the shape of every `stateRoot`** (`avl-prover.ts`). Env read deleted by P2-A; now a `@dagsocial/types` export (TYPES_INTERFACE → State format) that `config.ts` imports and plumbs through `Config.avlKeyLength` |
| ~~`KARMA_DECAY_AMOUNT`~~ | **removed** | ~~`5`~~ | → universal constant `KARMA_DECAY_AMOUNT` (`@dagsocial/types`). Devnet decays *often*, not *harder* |
| ~~`KARMA_DECAY_INTERVAL_BLOCKS`~~ | **removed** | ~~`720`~~ | → profile field `karmaDecayIntervalBlocks`. Value corrected to `1440` by P2-A (60s blocks) |
| ~~`KARMA_STALE_THRESHOLD_BLOCKS`~~ | **removed** | ~~`20160`~~ | → profile field `karmaStaleThresholdBlocks`. Value corrected to `40320` by P2-A (60s blocks) |
| ~~`KARMA_MINIMUM`~~ | **removed** | ~~`10`~~ | → universal constant `KARMA_MINIMUM` (`@dagsocial/types`) |
| ~~`ORDERING_BLOCK_POW_TARGET_BITS`~~ | **removed** | ~~`12`~~ | → profile field `orderingBlockPowTargetBits`. Closed MINING invariants 4, 5 and 7 — `expectedTarget(height)` now sources the profile, and its unused `height` parameter is the seam a real retarget will need |
| ~~`CREDIT_TREASURY_PCT`~~ | **removed** | ~~`10`~~ | → universal constant `CREDIT_TREASURY_PCT` (`@dagsocial/types`) |
| ~~`TREASURY_PUBKEY`~~ | **removed** | ~~`""`~~ | → profile field `treasuryPubKey` — genesis data, so a different chain has a different treasury |
| ~~`CREDIT_INITIAL_REWARD`~~ | **removed** | ~~`10000000000`~~ | → universal constant `CREDIT_INITIAL_REWARD` (`@dagsocial/types`), which `block-creator.ts` imports directly. The dead `Config.creditInitialReward` field it left behind was pruned 2026-08-07 (audit **A5**, closed) |
| `VERIFY_STATE_ROOT` | `consensus-check` | `true` | Verify `header.stateRoot` at apply (Spec B P3). ⚠ Setting `false` removes the **sole backstop** against the `computeTxId`-collision class, where two distinct block bodies share a header |
| ~~`POST_POW_TARGET_BITS`~~ | **removed** | ~~`20`~~ | → profile field `postPowTargetBits`. The `advertised` class is retired with it: the challenge endpoint and the verifier now read the same field, so a node can no longer report a difficulty it does not enforce (A6) |
| ~~`NETWORK_MODE`~~ | **renamed** | ~~`testnet`~~ | → `NETWORK_TYPE`. The name changes because the meaning does: it selected a faucet flag, it now selects the whole consensus parameter table |
| `MAX_SUB_BLOCKS_PER_BLOCK` | `local` | `1000` | Sub-blocks this node puts in blocks **it produces**. ⚠ NO BOUND — CONSENSUS GAP: no maximum is enforced at apply, so this is local only because the consensus cap does not exist |
| `ORDERING_BLOCK_MIN_SUB_BLOCKS` | `local` | `1` | Sub-blocks that trigger immediate block production |
| `ORDERING_BLOCK_INTERVAL_MS` | `local` | `60000` | Producer cadence (wall clock — producer-side only, never a validity input) |
| `CHALLENGE_WINDOW_BLOCKS` | `local` | `10` | Expiry of challenges this node issues |
| `MAX_MEMPOOL_ENTRIES` | `local` | `10000` | Mempool capacity |
| `MAX_PEERS` | `local` | `50` | Max connected libp2p peers |
| `MAX_PROOF_HISTORY` | `local` | `1440` | AVL versions retained for proof serving |
| `PORT` | `operational` | `3000` | HTTP listen port |
| `ADMIN_PORT` | `operational` | `3001` | Admin listener port |
| `ADMIN_BIND_ADDRESS` | `operational` | `127.0.0.1` | Admin listener bind address. ⚠ The admin listener is **unauthenticated**; binding it off loopback exposes it |
| `DB_PATH` | `operational` | `dagsocial.db` | SQLite database path |
| `NODE_ROLE` | `operational` | `server` | `server` (applies peer blocks) or `miner` (produces blocks) |
| `MINING_MODE` | `operational` | `internal` | `internal` (node mines) or `external` (template endpoint) |
| `MINING_SECRET` | `operational` | `""` | Mining auth secret — **required**; startup asserts it is set |
| `BOOTSTRAP_PEERS` | `operational` | `[]` | Comma-separated libp2p multiaddrs |
| `LISTEN_ADDRS` | `operational` | `/ip4/0.0.0.0/tcp/0` | libp2p listen addresses |
| `PUBLIC_URL` | `operational` | `/` | Base path where the demo UI is served |
| ~~`EPOCH_BLOCKS`~~ | **removed** | ~~`60`~~ | Epoch interval — **the epoch is deleted** (P2-D); accrual and settlement are per-block. No env read, no constant remains; the name is retired-reserved |

> ⚠ **The karma decay constants are documented for a block time the node does not use.**
> `constants.ts` annotates `KARMA_STALE_THRESHOLD_BLOCKS = 20160` as "28 days at 2m blocks" and
> `KARMA_DECAY_INTERVAL_BLOCKS = 720` as "24 hours at 2m blocks", while `ORDERING_BLOCK_INTERVAL_MS`
> defaults to **60000** and MINING_INTERFACE's emission schedule is computed "at 60-second blocks".
> At 60s the real durations are **14 days and 12 hours** — half the documented values. Either the
> annotations are stale or the block interval is. These are consensus parameters and the discrepancy
> must be resolved before launch, not after.

---

## Net Integration

The node creates a `NetNode` from `@dagsocial/net` during startup and registers
Stage 2 handlers for inbound gossip messages. Startup order:

```
1. initDb()
2. Create NetNode with config + validators
3. Register Stage 2 handlers (onSubBlock, onOrderingBlock, onTx)
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
| **Validation** | chain-link, protocol version, PoW target + PoW, validator signature, Merkle roots, coinbase value + maturity, block storage, `clearTemplate` | No — the header does not exist yet |
| **Mutation** | coinbase mint, sub-block confirmation, DAG scores, topology, prune verification + settlement, embedded UTXO txs, per-block like settlement + post-lock vesting, decay, vouch cooldowns | Yes — verbatim, at an explicitly passed height |
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

Additional hooks: `onSyncComplete(cb)` and `onPeerActive(cb)` trigger
content sweep for placeholder resolution.

The node registers no stump handlers in either direction: inbound
`/dagsocial/stump/1` gossip is not consumed, `broadcastStump` is not called,
and stumps are neither requested from peers nor served to them — every node
derives its own rows at prune settlement (see "Pruning" → "Stumps are
derived state"). The net-side stump surface this orphans (topic, codec,
GetStumps/Stumps protocol, handler seams) is deleted in the same unit's net
phase; NET_INTERFACE is authoritative for that side.

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
