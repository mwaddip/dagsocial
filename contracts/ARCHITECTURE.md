# DAGsocial Architecture

**Protocol version:** 1
**Last updated:** 2026-08-07

## Status markers — the convention for every contract in this directory

A contract section describes one of several different things, and until 2026-08-06 nothing
distinguished them: text describing running code, text describing intended design, and text
describing a mechanism that was documented and never built all read with identical authority.
A repo-wide audit found **41 `never-true` claims against 25 genuine drift** — the dominant
failure was not documentation falling behind code, it was documentation that was never true.

**Every section that is not plainly describing running code MUST carry one of these:**

| Marker | Meaning |
|---|---|
| `> ⚠ NOT IMPLEMENTED` | Intended design. Not built. **Is** meant to be built |
| `> ⚠ PARTIAL` | Some of it runs. The marker must say which part |
| `> ⚠ NEVER BUILT — NOT PLANNED` | Was documented, never built, and there is no intent to build it. Kept so nobody re-adds it believing it was an oversight |
| `> ⚠ VIOLATED` | The rule is **correct** and the code breaks it. **Never weaken the rule to match the code** |
| `> ⚠ SUPERSEDED` | Replaced by a later decision; points at it |

**The markers are mandatory, not optional.** An optional marker reproduces the exact defect
this convention exists to fix — a reader cannot tell whether its absence means "verified" or
"nobody looked."

**Why this works:** the one section of this document with no false invariant
(§Block Application Journal) is also the only one written *after* its implementation existed.
The failure mode is timing, not care. These markers make timing visible at read time instead
of requiring `git blame`.

## Overview

DAGsocial is an invite-only decentralized social network built on a dual-ledger
architecture:

| Layer | Purpose | Mutability |
|-------|---------|------------|
| **Posts DAG** | Content, social graph | Author-sovereign (prunable) |
| **UTXO Ledger** | Karma & credits state | Owner-controlled (spendable) |
| **Stumps** | Compact proofs binding DAG → UTXO | Immutable once created |

These layers are interdependent but cryptographically independent: the DAG's
integrity doesn't depend on the UTXO state, and vice versa. Stumps are the
binding layer — they crystallize karma issuance from pruned DAG content.

### Why dual-ledger

- **Content ledger (DAG):** Posts are sovereign to their author. The author can
  delete their entire reply subtree for privacy. Content is additive by default
  but prunable by the root owner.
- **Value ledger (UTXO):** Karma and credits track account state with
  cryptographic lineage. Boxes are consumed and created; history is immutable
  even though current balances change.

A pure-additive DAG can't model deletion or mutable account state. A pure UTXO
system can't model threaded conversation or author-sovereign content spaces.
The hybrid preserves the strengths of both.

### Block architecture: sub-blocks + ordering blocks

See `SUBBLOCK_INTERFACE.md` for the full sub-block contract.

Inspired by Ergo's subblock model (EIP-15):

| Block type | Producer | PoW difficulty | Purpose | Interval |
|------------|----------|----------------|---------|----------|
| **Sub-block** | User (post author) | Post PoW | Fast inclusion: post + pending likes | Per post |
| **Ordering block** | Validator | Full PoW | Consensus anchor: batches sub-blocks, deduplicates likes, triggers epoch processing | Configurable |

A user's post PoW solution IS the sub-block proof. The sub-block carries the
post plus any pending likes queued since the last sub-block. Likes without
posts between ordering blocks sit in a pending queue and are bundled into the
next ordering block directly.

Validators produce ordering blocks: full PoW, batch all sub-blocks produced
since the previous ordering block, deduplicate any doubly-submitted likes,
trigger epoch transitions (like tallies), and distribute credit rewards.

---

## Design Principles

### Node as record-keeper, not ranker

The node's job is to faithfully record, validate, and serve data — posts, likes,
vouches, karma state, blocks. **Feed ranking, algorithmic curation, reputation
scores, and any interpretation of on-chain data are the responsibility of client
implementations and indexers.** The node provides the raw, verifiable dataset;
clients decide what to surface and how to weight it.

This means:
- On-chain primitives (likes, vouches) exist to be queried and aggregated, not
  to drive built-in ranking logic
- The built-in feed endpoint (`GET /feed`) is for testing convenience only —
  production feeds come from indexers
- New primitives are designed for what they record, not for how a client might
  interpret them

---

## The Three Layers

### 1. Posts DAG (Content Layer)

Every post is the **root of a sovereign subtree.** The author controls
everything under it — replies, replies to replies, the entire transitive
closure of `parentRefs` that trace back to this root.

#### Post structure

```
Post {
  content: string              // 1–MAX_CONTENT_BYTES UTF-8
  author: UserId               // 32 raw bytes — see the representation rule below
  parentRefs: PostId[]         // 0–MAX_PARENT_REFS per post
  challenge: bytes             // Random nonce issued by node (anti-precomputation)
  powNonce: number             // PoW solution — proves work against challenge
  protocolVersion: number
  timestamp: number
  signature: bytes             // Ed25519 over signingHash(post)
}

PostId = blake2b512(POST_ID_DOMAIN ‖ postFieldBytes(post) ‖ u64LE(powNonce))[0:32], hex
```

> **The byte-exact preimage is specified in `TYPES_INTERFACE.md` (§Core Types) and nowhere
> else.** Every field is length-prefixed and the ref array carries an explicit `u32LE`
> count (audit M-1); the domain tag keeps a post id from ever colliding with the PoW hash
> over the same post. **Do not restate the formula here.** This document previously carried
> it twice, in two different field orders, both in the pre-M-1 unprefixed form — a
> restatement of a byte format is a mirror implementation in prose, and it diverged exactly
> the way mirrors do.

A post's `parentRefs` may reference either live posts or stumps. The hash is
the same either way — the DAG's cryptographic integrity doesn't depend on
content availability.

#### Public-key representation — the rule, and where the boundary is

**`UserId` is `Uint8Array` — 32 raw bytes — everywhere it appears as `UserId`.** This
document previously said `hex(publicKey) — 64 chars`, which was never true of `Post.author`.

A public key is rendered as a **hex `string`** in exactly three places, each explicitly
typed `string` rather than `UserId`: `SubBlockEntry.author`, the `signatures` map keys,
and `proofSource`. That is deliberate, not drift — those structures are JSON-oriented and
JSON has no byte type. `SubBlockEntry` in particular is serialized through
`JSON.stringify` into a consensus Merkle leaf, so a byte array there would encode as
`{"0":1,"1":2,…}`.

**The rule: if the field is typed `UserId`, it is raw bytes. If it is typed `string`, it
is lowercase hex.** The type is the boundary marker; there is no third form. Both
representations are genuinely live, so this is a convention to state and hold, not drift
to eliminate.

#### Post-level PoW (sub-block mechanism)

PoW is a single challenge-response pass, collapsed from the Phase 1 two-phase
model. The post's PoW solution IS the sub-block proof:

1. Author requests a challenge from a node → node returns random nonce
2. Author constructs the post and iterates `powNonce` until `postPowPreimage(post)`
   hashes below the target difficulty — **preimage specified in `TYPES_INTERFACE.md`,
   not here** (see the note above; the formula previously restated at this line
   disagreed with the one four lines earlier on field order)
3. Author submits the completed post → it becomes a sub-block (likeBoxes are
   collected separately at ordering block assembly, not attached as sidecars)
4. Validators verify the PoW when anchoring sub-blocks in an ordering block

The challenge prevents precomputation. Requesting a new challenge replaces
any existing one (upsert). Challenge expires after `CHALLENGE_WINDOW_BLOCKS`.

PoW difficulty is a protocol parameter (`POST_POW_TARGET_BITS`). It may
become karma-proportional in the future (high karma → lower difficulty),
but for Phase 2 it is fixed.

#### Subtree pruning (deletion)

The root author may prune their entire subtree at any time. Pruning:

1. Removes the root post and all descendant posts from the indexable DAG
2. Cascades to all replies — a reply exists only in the context of its root
3. Replaces the entire subtree with a **stump** (see §3)
4. Is authorized by a signed prune transaction from the root author's key

The prune is authorized **solely** by the root author's Ed25519 signature
over `(rootPostHash, subtreeMerkleRoot)`. The signature travels in the block
as a PruneEntry. Who "the author" is, is itself consensus data: every
confirmed post's `author` is carried in its block's `SubBlockEntry` and
recorded in `block_topology`, and a PruneEntry is valid only if its
`authorId` equals that recorded author (audit H-3) — so a signature from
anyone else, however valid for its own key, authorizes nothing. No validator
attestation is required — settlement is deterministically computable from the
UTXO state (PostLockBoxes, LikeBoxes). Any node can verify the prune
independently, with or without the DAG content.

Pruning is irreversible. Once content is pruned, it cannot be recovered.
Nodes propagate stumps, not the original content.

Future stump triggers beyond author deletion (storage pruning for lean nodes)
will use their own authorization paths but produce the same stump data structure.

**Privacy rationale:** Even if only the root post is deleted, replies in the
subtree contain signals (tone, specificity, timing) that can leak what the
root said. Cascade deletion is the only privacy-preserving default.

#### Subtree ownership

- The author of post `P` owns the subtree rooted at `P`
- Ownership means the exclusive right to prune
- Replying to a post grants the root author sovereignty over your reply
- This is a social contract encoded in the protocol: replying is consent

A reply author may delete their own reply individually (it's their subtree
root), but cannot prevent the parent author from pruning the whole tree.

### 2. UTXO Ledger (Value Layer)

The UTXO layer tracks two non-fungible value types:

| Asset | Tradeable | Earned via | Spent via | Decays | Mint/Burn |
|-------|-----------|------------|-----------|--------|-----------|
| **Karma** | No | Likes on posts | Invites, likes | Yes (storage rent) | Mint: like rewards. Burn: invite bond forfeiture |
| **Credits** | Yes | Validator rewards, genesis | Ads, transfers (future) | No | Mint: ordering block rewards |

Both are stored as **boxes** — UTXO entries guarded by cryptographic scripts.
Boxes are consumed and created in transactions; the set of unspent boxes IS
the current state.

Box `value` is a uniform **`bigint`** — credits are 8-decimal integer base units
(10⁻⁸ credit), karma small bigints. No float arithmetic in consensus value math;
`value < 2⁶⁴`. See `TYPES_INTERFACE.md` "Value denomination" and Spec B P0.

#### Karma boxes

```
KarmaBox {
  id: BoxId
  value: bigint                // Karma balance (bigint base units — see value denomination)
  owner: PublicKey             // Ed25519 public key (32 bytes)
  createdAtBlock: number       // Block height when box was created
  guard: "owner_signature"     // Only the owner can spend
  proofSource: PostId | StumpHash | InviteTxId  // Where this karma came from
}
```

Karma can only be transferred via the **invite mechanism** (§4). Normal
transfers between existing accounts are forbidden — this is what makes karma
non-tradeable. An account's karma box can be consumed only to:
- Create invite boxes
- Create like boxes (spending karma to vote)
- Create a new karma box for the same owner (after earning/burning, resetting
  the activity clock)

#### Karma decay (periodic burn)

After 28 days of inactivity, karma is burned periodically at block application
time:

- **Staleness check:** An identity is stale if it has NO unspent karma box
  without `decayBurn` that was created within `KARMA_STALE_THRESHOLD_BLOCKS`
- **Decay execution:** At each ordering block, stale karma boxes have their karma
  boxes consumed and replaced with a single consolidated box with value reduced
  by `KARMA_DECAY_AMOUNT` per `KARMA_DECAY_INTERVAL_BLOCKS` elapsed
- **Floor:** Decay never reduces karma below `KARMA_MINIMUM`
- **Provenance:** Decay-created boxes are marked with `decayBurn: true` so they
  don't reset the staleness clock. Normal user activity (post, like, invite)
  creates boxes without this flag, resetting the clock.
- **Rollback:** Decay burns are journaled and reversed during fork rollback

All four are **consensus parameters** — decay mutates committed state, so two nodes
holding different values compute different `stateRoot`s and partition permanently.
Classes are defined in `NODE_INTERFACE.md → Configuration`.

| Parameter | Class | Default | Description |
|-----------|-------|---------|-------------|
| `KARMA_STALE_THRESHOLD_BLOCKS` | **consensus** | 40320 | Grace period before decay begins (28d at 60s blocks) |
| `KARMA_DECAY_INTERVAL_BLOCKS` | **consensus** | 1440 | Decay period (24h at 60s blocks) |
| `KARMA_DECAY_AMOUNT` | **consensus** | 5 | Karma burned per period |
| `KARMA_MINIMUM` | **consensus** | 10 | Floor — decay never reduces below this |

> ⚠ **VIOLATED — all four are environment-readable** (`config.ts:106-119`), and none of
> them appeared in `NODE_INTERFACE.md`'s Configuration table until 2026-08-06. This
> section is **right** that they are fixed protocol parameters; the code ignores it.
> Phase 2 promotes them to `@dagsocial/types` constants and removes the `process.env`
> reads.

> ✅ **RESOLVED 2026-08-06 — the target block time is 60 seconds, and the two `*_BLOCKS`
> values are recomputed above.** The code still holds the pre-correction values
> (`20160` / `720`); Phase 2 changes `constants.ts`.
>
> The karma pair were the **only** constants on a 2-minute basis — `CREDIT_MINER_REWARD_DELAY`
> and `MEMPOOL_EXPIRY_BLOCKS` (both `720` = ~12h), `CREDIT_EPOCH_BLOCKS` (`129_600` = ~90d)
> and `CREDIT_FIXED_RATE_BLOCKS` ("at 60s blocks") all agree on 60s. So at the block time
> the node runs, these two delivered **14 days and 12 hours instead of 28 and 24**.
>
> ⚠ **The 28-day figure is separately still open.** The economics design track wants a
> short, days-scale grace window ("e.g. ~5, not 28"), so `40320` is a faithful translation
> of a value that is itself pending the constants-pinning session — not a decided number.

#### Credit boxes

```
CreditBox {
  id: BoxId
  value: bigint                // Credit balance (integer base units of 10⁻⁸ credit)
  owner: PublicKey
  guard: "owner_signature"
  proofSource: BlockId         // Which ordering block minted these credits
}
```

Credits are freely transferable between accounts. They are minted as validator
rewards for producing ordering blocks. Credit sinks (ads, author boosts, tips)
are deferred to future protocol versions. For Phase 2, the credit supply grows
with each ordering block — the reward amount is a protocol parameter.

#### Vouch boxes

```
VouchBox {
  id: BoxId
  value: 1n                   // VOUCH_KARMA_AMOUNT — always 1n (bigint)
  voucherId: UserId           // Who staked the karma
  targetId: UserId            // Who is being vouched for
  createdAtBlock: number      // Block height when vouch was cast
  guard: "owner_signature"    // Only the voucher may spend (unvouch)
}
```

A vouch is a 1-karma endorsement from one identity to another. Casting a vouch
consumes 1 karma from the voucher's KarmaBox and creates a VouchBox. The karma
is escrowed — not burned, not transferred to the target. Unvouching (spending
the VouchBox) triggers a cooldown: the karma is not immediately returned to the
voucher but is held for `VOUCH_COOLDOWN_BLOCKS` before release.

Each identity may vouch for at most one target at a time. The minimum karma
balance to cast a vouch is `VOUCH_MIN_BALANCE` (11).

#### Box lifecycle

All box transitions are atomic — a transaction consuming N boxes and creating M
boxes either fully commits or fully fails. The ledger enforces:

- Total value in = total value out (conservation, except mint/burn)
- Guard scripts evaluate to true for every consumed box
- New boxes are valid under protocol rules

#### AVL+ State Root

The UTXO set is indexed by an AVL+ authenticated dictionary. Every ordering
block header carries a `stateRoot` — the root hash of the AVL+ tree over all
unspent boxes **after this block has been applied**. This enables light clients
to verify box existence or absence without storing the full UTXO set.

- **Post-state, not parent-state (H-6).** `stateRoot` commits to the state the
  block *produces*, following Ergo. The block therefore commits to its own
  effect, and the tip's state is provable as soon as the tip exists. The cost
  is that a producer must know its block's outcome before mining it — see
  `NODE_INTERFACE.md` → "Ordering Block Creator Contract" for how that is
  obtained without a second implementation of the state transition.

- **Module:** `packages/node/src/state/` (avl-storage, avl-prover, avl-endpoint)
- **Proof endpoint:** `GET /api/v1/proof/:boxId?atHeight=N` — returns an
  inclusion or exclusion proof for a box at a given block height
- **Config flags:** `VERIFY_STATE_ROOT` (`consensus-check` — validate stateRoot at
  block apply, **default on** since Spec B P3), `MAX_PROOF_HISTORY` (`local` — prune
  old proof versions). **`AVL_KEY_LENGTH`** is no longer configuration at all — it is a
  `@dagsocial/types` export (TYPES_INTERFACE → State format), imported by `config.ts` and
  plumbed through `Config.avlKeyLength`. It determines the **shape** of every `stateRoot`,
  so two nodes differing on it compute different digests for identical state; P2-A removed
  its environment read and the types export gives a second implementation an authoritative
  definition to read.
- **Deterministic:** Every node computing the AVL+ over the same UTXO set at
  the same height **and holding the same `AVL_KEY_LENGTH`** produces the identical
  stateRoot. Box `value` serializes as a
  `bigint` (CBOR uint64), so the AVL leaf bytes — hence the stateRoot — are
  stable across implementations (the demo UI mirrors the encoding)
- **Journal-fed:** The per-block mutation set fed to the prover is derived from
  the block journal (see Invariants → Block application journal), with
  intra-block insert+remove pairs for the same boxId netted out
  deterministically. Inserted box bytes come from the journal's recorded box,
  never a store re-fetch
- **Canonically ordered (M-12):** the AVL digest is insertion-order-sensitive,
  so every prover feed is sorted before the operations run: the per-block net
  set applies all removes then all inserts, each sorted lexicographically by
  hex boxId, and the startup bootstrap feeds the unspent set sorted by boxId
  as well. Two nodes holding the same box set — whatever order their rows
  arrived in — always compute the identical digest
- **Rejection-safe:** A rejected block leaves the prover at its pre-block
  digest, whatever stage the rejection happened at — the apply funnel
  snapshots the digest before any mutation and restores it on every rejection
  path, including the totality catch. A failed reorg likewise leaves the
  prover at its pre-reorg digest (SQLite rollback restores the storage rows
  but cannot reach the prover's in-memory state — the reorg restores it
  explicitly)

### 3. Stumps (Binding Layer)

A stump is what remains after a post subtree is pruned. It is a compact,
cryptographically signed proof that the subtree existed and that specific
value was earned inside it.

```
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

#### Prune lifecycle

1. Author's client walks reply subtree locally, builds Merkle root over
   postIds
2. Author signs `blake2b512(rootPostHash || subtreeMerkleRoot).subarray(0,32)`
   with their Ed25519 key
3. Client submits signed PruneIntent to node via `POST /posts/:id/prune`
4. Node verifies signature, subtree completeness, and Merkle root
5. Node enqueues PruneEntry in mempool — included in next ordering block via
   `SubBlockTree.pruneEntries`
6. At block application, every node independently verifies: authorship
   binding (`authorId` equals the `block_topology`-recorded author of the
   root; unconfirmed roots are not prunable), Ed25519 signature, postId set
   against block_topology, Merkle root, then settles UTXO deterministically
   (consumes PostLockBoxes and LikeBoxes, mints refund karma)
7. DAG content pruned (when present) — simplified Stump stored for
   historical/gossip purposes

No validator attestation is needed — the author's signature authorizes the
prune, and the settlement is deterministically computable from UTXO state.

#### Cryptographic guarantees

- Settlement is deterministic from UTXO state + block's PruneEntry — any node
  can verify independently without DAG content
- The author's signature over `(rootPostHash, subtreeMerkleRoot)` in the block
  is the single point of authorization, and "the author" is pinned by
  consensus: `PruneEntry.authorId` must equal the author recorded for the
  root in `block_topology` (carried by `SubBlockEntry.author`, verified
  against real content by every node that holds it at confirmation time)
- A node that held the full subtree can verify the Merkle root against the
  original content
- Parent hashes remain valid — a reply referencing a pruned post still has a
  valid `parentRefs` entry; the parent is just a stump now

---

## Identity

An account is a cryptographic keypair. There is no separate registration step.

```
UserId = hex(publicKey) — 64 hex chars, raw Ed25519 key bytes
```

An account comes into existence the first time it appears in a committed UTXO
box (via invite claim, genesis committee allocation, or credit receipt). There
is no "account table" — identity is derived from key material and visibility
on the ledger.

### Username claims

> ⚠ **SUPERSEDED (user decision, 2026-08-06) — usernames are NOT claim posts.**
> The first-claim-wins, post-based, prune-to-release model described below is replaced by a
> **UTXO asset**: a username is **tradeable for credits**, **free to claim while unused**,
> and **burnable by its owner**. Nothing in this section survives that change — the claim
> post, the DAG walk, and prune-to-release are all artefacts of the post-based model.
>
> **Deferred — "way down the line."** Do not build, and do not design it further here; it
> lands in the economics track when it is picked up, since a credit-denominated asset class
> is an economic mechanism rather than a DAG one.
>
> Two consequences worth recording now:
> - **The `Post.type` dependency is void.** A previous version of this marker said username
>   claims required a post discriminator that does not exist. Under a UTXO asset they are
>   not posts at all, so no post-typing change is implied and no post ids move.
> - **`docs/site/architecture` still publishes the old model** ("Usernames and profiles are
>   DAG-native — they're just posts. A username is claimed first-come-first-served and can
>   be released by pruning the claim"). That page is normally authoritative; here it is
>   stale and needs correcting. See the Phase 1 plan's `docs/site/` disclosure item.
> - **Profiles are NOT superseded — they stay DAG-native** (user, 2026-08-06: "a profile
>   would indeed be a *self post*"). Only usernames leave the post model. **The `Post.type`
>   dependency therefore does not disappear, it relocates:** see §Profile root below, which
>   keys on `type: "profile"`.

Usernames are DAG-native objects using a **first-claim-wins** model:

1. An account posts a claim: `{ claim: "username", name: "@alice" }`, signed
   by the account's key
2. The first valid claim for a name string wins — the name is permanently
   associated with that account
3. Changing username: account prunes the old claim post (now a stump), posts
   a new claim. The resolver takes the most recent unpruned claim.
4. A claim is only valid if the account has nonzero karma at claim time

No expiry. No renewal. The name claim is a post like any other — it can be
pruned by its author, and pruning it releases the name.

### Profile root

> ⚠ **NOT IMPLEMENTED — intended design, zero code.** Profiles **stay DAG-native**: a
> profile is a *self post* (user, 2026-08-06), unlike usernames, which became a UTXO asset.
>
> **Blocking dependency, live here:** the marker post below carries `type: "profile"`, and
> **`Post` has no `type` field** — nor any other discriminator. So profiles cannot be built
> until post typing exists, and adding a field to `Post` enters `postFieldBytes`, which
> **moves every post id**. That makes it a protocol-breaking change that should ride with
> another id-moving change rather than go alone.
>
> This dependency was originally recorded against usernames and is void there — a UTXO asset
> is not a post. It applies to profiles instead. **Any alternative discriminator (a reserved
> parent ref, a content convention) would avoid the id move and is worth considering before
> committing to a `type` field.**

An account may post a **profile root** — a special marker post:

```
Post {
  content: ""                  // Empty
  author: UserId
  parentRefs: []               // Genesis — no parents
  type: "profile"              // Profile root marker
  ...
}
```

The profile root acts as an anchor. Child posts (with `parentRefs: [profileRootId]`)
carry profile fields:

- **Bio:** A post with `type: "bio"` and content = bio text
- **Display name:** A post with `type: "display_name"` and content = display name
- **Avatar:** A post with `type: "avatar"` referencing a content hash

The resolver collects the most recent child post of each type under the
profile root. Editing a field = new child post of that type (the old one
remains in the DAG but the resolver takes the newest).

Profile roots and their children are normal posts — they can be pruned by
their author.

### Identity resolution

```
userId → walk DAG for active username claim
       → walk DAG for profile root
       → walk DAG for latest bio/display_name/avatar child posts
       → read karma balance from UTXO set
       → read credit balance from UTXO set
```

---

## Likes

> ⚠ **SUPERSEDED IN ITS ENTIRETY (2026-08-06) — do not implement, do not reconcile
> line by line.** These 120 lines are 100% original July text describing a **two-phase
> locked/free** system with refunds, an epoch tally and a free tier. All of it is replaced.
>
> **The decided design** (`docs/site/economy`, `tmp/karmanomics.md`, design track §5.3–§5.5):
> - **A like costs the liker 1 karma and it does not come back.** One-way. **There is no
>   unlike**, and no free tier — no like is free.
> - **The author receives `x−1` per `x` likes; 1 is burned.** Integer arithmetic only.
> - **The accumulator is per author, not per post**, held as a carry (< `x`) on the
>   committed per-identity record.
> - **No epoch.** Accrual and settlement are **per block** — the arithmetic never needed an
>   interval, so it was dropped (KISS, where it costs nothing in security or determinism).
> - **`LikeBox` is eliminated.** With the karma burned at like time there is nothing to
>   hold: a like is a **burn transaction plus a `(liker, post)` record**. Records die with
>   the post on prune and survive withdraw; likes on pruned posts are rejected by rule.
>
> **What this section gets right and is worth carrying forward:** likes belong to the value
> layer rather than the content DAG. That survives — the record is committed state, not a
> DAG object.
>
> Everything below describes the retired model and is retained only so it is not rebuilt.

Likes exist in the value layer, not the content DAG. The system has two phases
depending on how many likes a post has already accumulated.

### Liking a post

**One like per account per post.** Enforced at the service layer.

**Phase A — locked likes (likes 1–50 on a post, i.e. < 10 × LIKE_THRESHOLD):**

1. 2 karma locked from the liker's karma box
2. A LikeBox (value 2, `epoch_tally` guard) is created in the UTXO set
3. The like box rides the next sub-block or goes directly to an ordering block
4. At the next epoch boundary, the karma is refunded according to the refund
   schedule (see below)

**Phase B — free likes (like 51+ on a post, i.e. ≥ 10 × LIKE_THRESHOLD):**

1. No karma locked. The like is recorded as a simple `dag_likes` row.
2. Only gate: the liker has any karma (> 0 karma box value)
3. Free likes still count toward the total for author rewards

### Refund schedule (for locked likes, computed at epoch)

| Likes on post | Refund | Effect |
|---------------|--------|--------|
| < 10 (2× threshold) | 0 | Like stays locked, rolls over to next epoch |
| ≥ 10 (2× threshold) | 2 (full) | Like box consumed, 2 karma returned to liker |

Locked karma is never burned. It remains locked across epochs until the
2× threshold is met. Free likes (51+) cost nothing and generate no refunds.

### Epoch tally (every EPOCH_BLOCKS ordering blocks)

Epoch processing runs every `EPOCH_BLOCKS` ordering blocks (default 60), not
every block. It processes both locked like boxes and free like rows:

1. Collects all unprocessed locked like boxes + unprocessed free like rows
2. Groups by `targetPostId` — total = locked count + free count
3. Deduplicates (a like can only appear in one epoch)
4. For each target post:
   - **Author reward:** `min(floor(totalLikes / LIKE_THRESHOLD), LIKE_MAX_AUTHOR_REWARD)` — minted to post author
   - **Liker refunds** (locked like boxes only, per above schedule):
     - If net == 0: full 2 karma returned to liker's karma box
     - If net < 0: like box consumed, difference burned
   - **Free likes:** marked as processed (no karma movement)
5. Consume all processed like boxes, mark free likes processed
6. Record `EpochTally` in the ordering block

### Like parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `LIKE_COST` | 2 | Karma locked to cast a like |
| `LIKE_THRESHOLD` | 5 | Absolute like count per multiplier step |
| `LIKE_MAX_AUTHOR_REWARD` | 10 | Maximum karma an author can earn per post |
| `LIKE_FREE_THRESHOLD` | 10 | 10× LIKE_THRESHOLD; beyond this, likes are free |
| `EPOCH_BLOCKS` | 60 | Like processing every N ordering blocks |

All are protocol parameters, absolute (not proportional to author karma).

### Post karma locking

Posting requires karma to be locked — skin in the game against spam. The locked
karma is held in a `PostLockBox` (guard: `epoch_tally`) and gradually unlocked
as the post accumulates likes.

**Lock amounts:**

| Post type | Karma locked |
|-----------|-------------|
| New thread (no parentRefs) | `POST_LOCK_THREAD_COST` (5) |
| Reply (has parentRefs) | `POST_LOCK_REPLY_COST` (3) |

**Unlock schedule:**

At each epoch boundary, for every post with a `PostLockBox`:

```
totalLikes       = locked likes + free likes (lifetime, cumulative)
alreadyUnlocked  = originalValue - currentValue
shouldUnlock     = floor(totalLikes / POST_LOCK_UNLOCK_PER_LIKES)
toUnlock         = min(currentValue, shouldUnlock - alreadyUnlocked)
```

For every 10 lifetime likes, 1 karma is unlocked and returned to the author.
A thread post (5 locked) needs 50 likes to fully unlock; a reply (3 locked)
needs 30 likes. If `toUnlock` is zero, the box rolls over to the next epoch.

**Locking at post time:**

When a post is submitted:
1. The verifier checks the author has >= required karma
2. The route handler performs a UTXO transaction:
   - Consume author's existing KarmaBox (value V)
   - Create new KarmaBox (value V - lockAmount)
   - Create PostLockBox (value = lockAmount, originalValue = lockAmount, guard = epoch_tally)

**Epoch processing:**

During `runEpochTally()`, after processing LikeBoxes:
- Collect all unspent PostLockBoxes
- For each, compute unlockable karma based on lifetime likes
- Consume old PostLockBox, create reduced one with remaining locked value
- Mint unlocked karma back to the author
- Record `postLockKarmaUnlocked` in the epoch tally's LikeReward entry

**Post lock parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `POST_LOCK_THREAD_COST` | 5 | Karma locked for new threads |
| `POST_LOCK_REPLY_COST` | 3 | Karma locked for replies |
| `POST_LOCK_UNLOCK_PER_LIKES` | 10 | Every N likes unlocks 1 karma |

All are protocol parameters, governable in the future.

---

## Invite System

The network is invite-only. An existing account must vouch for every new
account. Invites are hash-locked karma boxes — the invitee doesn't need a
keypair until they're ready to claim.

### Invite creation

Alice creates an invite for Bob:

1. Alice generates a random secret `s`
2. Alice gives `s` to Bob out of band
3. Alice constructs a UTXO transaction:

```
Consume: Alice's karma box (K karma)

Create:
  1. Alice's remaining karma box:  K - N - D
  2. Invite karma box:             N karma
     Guard: H(s_preimage) == H(s) ∧ recipient_pubkey not already an account
     (Bob claims by revealing s and his pubkey)
  3. Bond box:                     D karma
     Guard: Alice's signature
     Unlock conditions:
       ├── Bob.karma ≥ INVITE_KARMA_THRESHOLD within probation → Alice claims
       ├── Bob.karma < KARMA_POSTING_MINIMUM during probation      → burned
       └── Probation expires (block H + INVITE_PROBATION_BLOCKS)  → Alice claims
```

The invite is a bearer instrument — anyone holding `s` can claim it. Bob can
pass `s` to Carol if he chooses not to join.

The node implements this as a two-phase **commit → claim**: the invitee first
commits, binding their public key to the bond, then claims. The bond-commit
guard requires a **valid signature from the committed public key**, so revealing
the preimage `s` alone does not authorize a commit and a commit cannot bind a
key the committer does not control (audit H-2). This does **not** remove the
bearer front-run: because `s` names no specific invitee, an observer who learns
`s` can commit under their own key. Binding the invite to a specific invitee at
creation — which would close the front-run — is deferred to the karma-econ
emission-model design (the same track that owns bond settlement).

### Invite claim

Bob generates a keypair, then constructs a claim transaction:

```
Consume: Invite karma box (N karma, guarded by H(s))
         (Bob reveals s as preimage, provides his pubkey as recipient)

Create:
  1. Bob's karma box: N karma (Bob's first box — account exists now)
```

### Invite cancellation

Alice may cancel an unclaimed invite at any time:

```
Consume: Invite karma box (N karma, guarded by Alice's signature)

Create:
  1. Alice's karma box: Alice's current karma + N (return)
```

The bond box is also reclaimable by Alice if the invite is canceled (the bond
is tied to the invite — cancelling the invite cancels the bond).

### Bond outcomes

| Scenario | Bond karma | Significance |
|----------|------------|--------------|
| Bob reaches `INVITE_KARMA_THRESHOLD` within probation | Returned to Alice | Alice vetted a good member |
| Bob's karma drops below `KARMA_POSTING_MINIMUM` during probation | Burned | Alice vouched for a bad actor |
| Probation expires without Bob reaching threshold | Returned to Alice | Bob was fine, just didn't cross the threshold |

Burned karma is permanently destroyed — not redistributed. This creates
deflationary pressure on karma supply and makes invite decisions consequential.

### Invite parameters

| Parameter | Description |
|-----------|-------------|
| `MAX_PENDING_INVITES` | Maximum concurrent unclaimed invites per account |
| `INVITE_MIN_KARMA` | Minimum karma transferred in an invite (= `KARMA_POSTING_MINIMUM`) |
| `INVITE_BOND_KARMA` | Karma deposit locked during probation |
| `INVITE_PROBATION_BLOCKS` | Probation window in blocks |
| `INVITE_KARMA_THRESHOLD` | Invitee's karma target for early bond return |

---

## Validators

> ⚠ **NOT IMPLEMENTED as described — 35 lines, 100% original 2026-07-20 text, written
> before any of it existed.** Block production works, but the "validator" as a *distinct
> role* with the responsibilities enumerated below is not a thing the code has: block
> production is a node mode (`NODE_ROLE=miner`), not a separate class of participant with
> its own lifecycle. Read this as design intent and verify every claim against
> `MINING_INTERFACE.md` and `block-creator.ts` before relying on it.
>
> The one part that is real and load-bearing: the **validator signature** on ordering
> blocks is verified on every apply path (audit H-1, confirmed).

Validators secure the network via Proof of Work. They are distinct from users.

### Responsibilities

1. Produce ordering blocks — batch sub-blocks, deduplicate likes, trigger
   epoch processing (like tallies)
2. Earn newly minted credits as ordering block rewards
3. Anchor the sub-block chain via Merkle tree digest in each ordering block

Validators do **not** attest to stumps. The prune authorization is the root
author's signature alone.

### Selection

Validator selection is purely PoW-based — no stake, no karma gating. Any node
that solves the ordering block PoW puzzle may produce the next ordering block.
This keeps the consensus layer independent of the social and economic layers.

### Rewards

Validators earn credits for each ordering block produced. Credits are freely
tradeable — validators may sell them to users.

> ⚠ **`ORDERING_BLOCK_REWARD_CREDITS` does not exist, and "a flat protocol parameter" is
> the wrong model.** This document states the emission twice, in two incompatible forms —
> a flat per-block reward here, and Ergo-style linear decay with a treasury split in
> §Implemented (v2). The second is right.
>
> **The reward is `computeBlockReward(height)`** — a fixed-rate period, then linear decay
> per epoch, specified in `MINING_INTERFACE.md`. **Emission terminates** (decision
> 2026-08-06, Ergo shape, decay to zero, no tail); the perpetual security budget comes from
> **fees and storage rent**, which are recycled rather than minted.
>
> ⚠ **The code does not yet terminate** — it floors at `CREDIT_TAIL_REWARD` and mints
> forever. Phase 2. **Every total-supply figure currently in the repo is wrong**, including
> `MINING_INTERFACE.md`'s ~453.9M.

### Separation from users

A validator may also hold a user account (karma, posts) but the roles are
cryptographically and economically independent. A validator's block reward
credit box and their user karma box are separate UTXO entries controlled by
separate keys if desired.

---

## Genesis

> ⚠ **NOT IMPLEMENTED — 22 lines, 100% original 2026-07-20 text, and it ships in a state
> that cannot run.** `GENESIS_COMMITTEE_KEYS` is `[]` with "TBD at genesis" recorded only
> in `TYPES_INTERFACE.md`, and **nothing fails loudly if a chain starts with an empty
> committee** — there is no startup assertion, so the two-phase model below silently has no
> phase one. Committee dissolution (`BOOTSTRAP_PERIOD_BLOCKS`) is likewise unimplemented.
>
> **Genesis is where an unset consensus parameter is least recoverable** — it is baked into
> the first block and every state root after it. Before any launch: decide the committee
> set, decide whether an empty committee is a startup failure, and pin both. This belongs
> with the constants-pinning session, not to be defaulted into.

Bootstrap uses a **two-phase genesis committee** model:

1. The genesis ordering block mints N karma boxes and M credit boxes,
   assigned to a small set of known genesis committee public keys
2. The committee's sole purpose: invite the first cohort of users and
   bootstrap ordering block production
3. After `BOOTSTRAP_PERIOD_BLOCKS`, all remaining genesis committee karma is
   burned and genesis committee credit boxes are distributed to early
   validators (proportional to blocks produced)
4. The committee dissolves — no permanent genesis class

| Parameter | Description |
|-----------|-------------|
| `GENESIS_COMMITTEE_KEYS` | List of public keys in the genesis committee |
| `GENESIS_KARMA_PER_MEMBER` | Initial karma per committee member |
| `GENESIS_CREDITS_PER_MEMBER` | Initial credits per committee member |
| `BOOTSTRAP_PERIOD_BLOCKS` | Blocks before committee dissolution |

---

## Data Flow

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────────┐
│   web    │────►│   node   │────►│   net    │     │  types   │◄────│  validation  │
│ (client) │     │ (server) │     │ (gossip) │     │ (shared) │     │  (pure fns)  │
└──────────┘     └────┬─────┘     └────┬─────┘     └──────────┘     └──────────────┘
                      │               │
                      │               ▼
                      │          ┌──────────┐
                      │          │   wire   │
                      │          │ (codec)  │
                      │          └──────────┘
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
     ┌─────────┐ ┌─────────┐ ┌──────────┐
     │  Posts  │ │  UTXO   │ │  Mempool │
     │   DAG   │ │ Ledger  │ │ (pending)│
     └────┬────┘ └────┬────┘ └────┬─────┘
          │           │           │
          └─────┬─────┘           │
                ▼                 ▼
          ┌──────────┐     ┌──────────┐
          │  Stumps  │     │ Ordering │
          └──────────┘     │  Blocks  │
                           └──────────┘
```

1. **Genesis:** Committee mints initial karma/credit boxes
2. **Invite:** Committee invites first users via hash-locked invite boxes
3. **Account creation:** Invitee claims invite with keypair → karma box exists
4. **Posting:** User requests challenge from node, constructs post, solves
   PoW → sub-block + karma-lock UTXO tx → mempool (batch-linked by postId)
5. **Liking:** User spends karma → like box UTXO tx → mempool (standalone)
6. **Ordering:** Block creator pulls from mempool (FIFO), assembles block with
   sub-blocks + UTXO txs + standalone likes, mines PoW, finalizes → state
   applied atomically
7. **Epoch tally:** Every `EPOCH_BLOCKS` ordering blocks — processes locked
   like boxes, free likes, post lock box unlocks, mints author rewards
8. **Pruning:** Author signs prune intent → stump constructed with deterministic
   karma deltas → committed in ordering block → DAG compacted
9. **Vouch cooldown:** Every block, matured vouch cooldowns release escrowed karma
   back to the voucher via mintKarma
10. **Net:** libp2p gossips sub-blocks, ordering blocks, and UTXO transactions.
   Stage 1 (stateless) validation via `@dagsocial/validation` runs before
   forwarding. Stage 2 (stateful) validation runs in the node after receipt.
   Relay handlers insert into mempool — state applied at block application.

---

### Wire Format

Stream messages are framed: `[magic:4][version:1][code:VLQ][length:VLQ][checksum:4][body]`. Gossip messages are raw CBOR. Wire-codec types (ByteReader, ByteWriter, VLQ) live in `@dagsocial/wire`.

---

## Network Identity

> ⚠ **PARTIAL — P2-A built the profile mechanism; one of the three commitment layers
> remains.** (PR #8, `4670ae5`.)
>
> **Built.** `NETWORK_TYPE` selects a `NetworkProfile` that carries the wire magic and every
> consensus parameter together; an unrecognised value throws at startup. `NetConfig.magic` is
> **required**, and the ten `?? MAGIC_MAINNET` fallbacks (nine in `node.ts`, one in
> `sync-machine.ts`) are deleted, so a missing magic is a compile error at the single
> construction site. Ten consensus parameters stopped being environment-readable. The
> transport layer of the commitment table below therefore works: networks no longer assemble
> each other's frames.
>
> **The defect this marker originally described was worse than it recorded.** `NETWORK_MODE`
> did not merely fail to reach `net` — **every node framed as mainnet on every network,
> unconditionally**, because the contract said `magic: number` while the code said `magic?:
> number` and node never passed it. A second, undocumented selector (`NETWORK_MAGIC`,
> defaulting to *testnet*) existed in dead code. Both are gone.
>
> **Not built:** the **block** layer — `networkType` is not a field of the ordering block
> header (verified 2026-08-07: no such field in `@dagsocial/types`). A cross-network block
> is currently rejected by the transport and chain layers only, never at the structure gate
> with a legible reason. That field is P2-C, which carries it alongside the other
> committed-byte changes.

A network is the pairing of a **parameter profile** with a **genesis block**. Three exist:

| Network | Purpose | Wiped on |
|---|---|---|
| `mainnet` | The real chain | Never |
| `testnet` | Public, used, non-breaking changes | Deliberate relaunch only |
| `devnet` | Local and disposable; protocol-breaking changes | Freely |

The taxonomy and the purpose split are Ergo's (`ergo.networkType`, with testnet for
non-breaking and devnet for protocol-breaking testing). The third network is **not** called
`regtest` — that is Bitcoin's word for a different thing.

### Selection

One setting, `NETWORK_TYPE`, class `network-identity`, names the whole profile. It is the
only environment variable that may change a consensus parameter, and it does so by selecting
a table rather than by setting a value. **Two operators who differ on it are on different
networks; two operators who agree on it cannot differ on anything below it.** That is the
property the class exists to guarantee, and it is why individual consensus parameters must
not be independently readable — nine of them are today, marked `⚠ VIOLATED` in
`NODE_INTERFACE §Configuration`.

### What varies per network, and what must not

**Per-network — the timescale, difficulty and genesis axes:**
`ORDERING_BLOCK_POW_TARGET_BITS` · `POST_POW_TARGET_BITS` · `KARMA_DECAY_INTERVAL_BLOCKS` ·
`KARMA_STALE_THRESHOLD_BLOCKS` · `VOUCH_COOLDOWN_BLOCKS` · `INVITE_PROBATION_BLOCKS` ·
`CREDIT_MINER_REWARD_DELAY` · `BOOTSTRAP_PERIOD_BLOCKS` · `CREDIT_FIXED_RATE_BLOCKS` ·
`CREDIT_EPOCH_BLOCKS` · `GENESIS_COMMITTEE_KEYS` · `GENESIS_KARMA_PER_MEMBER` ·
`GENESIS_CREDITS_PER_MEMBER` · `TREASURY_PUBKEY`

**Universal — every other constant, including consensus ones:** the format limits
(`MAX_CONTENT_BYTES`, `MAX_PARENT_REFS`, `PROTOCOL_VERSION`, `AVL_KEY_LENGTH`) and **every
karma and credit cost** (`LIKE_COST`, `POST_LOCK_*`, `VOUCH_KARMA_AMOUNT`, `INVITE_*`,
`KARMA_MINIMUM`, `KARMA_DECAY_AMOUNT`, `CREDIT_TREASURY_PCT`, `CREDIT_INITIAL_REWARD`).

**The split is normative: compress time, never economics.** Every per-network parameter is a
place where devnet and mainnet behave differently, which is precisely where a defect hides
from the test written to catch it. A test chain needs a 3-block decay interval; it does not
need cheaper likes. **Adding a parameter to the per-network set weakens every test that runs
on devnet** — the burden is on the addition, not on keeping the set small.

### How the network is committed

Three mechanisms, which fail differently and are listed in the order a foreign object meets
them.

| Layer | Mechanism | What a cross-network object does |
|---|---|---|
| **Transport** | Wire magic selected by the profile | Never assembles as a frame; peers do not connect |
| **Block** | `networkType` field in the ordering block header | Rejected at the structure gate with a legible reason |
| **Chain** | Distinct genesis per network | Cannot link; its input boxes do not exist here |

**The chain layer is what makes the networks genuinely separate**, and it is doing more work
than it appears to. A transaction's inputs are boxes whose id chains root at genesis, so a
mainnet transaction replayed against testnet names inputs that **do not exist** — replay
fails on the UTXO graph, without any network check. The header field and the magic are the
early, legible rejections; genesis is the one that cannot be circumvented.

> **Id derivation is deliberately NOT network-scoped.** An earlier draft of this section
> scoped the five domain tags (`BOX_ID_DOMAIN`, `TX_ID_DOMAIN`, `MINT_ID_DOMAIN`,
> `IDENTITY_KEY_DOMAIN`, `POST_ID_DOMAIN`) by network. **Dropped 2026-08-06**, for two
> reasons.
>
> **It conflicts with a load-bearing invariant.** `@dagsocial/types` is contractually pure —
> "no side effects, no module-level state" — and five packages derive consensus bytes from
> it. Network-scoped tags force either module-level state in that package or a network
> argument on every derivation. Module-level state is the config-read-at-a-distance defect
> this whole section exists to remove, wearing a different hat.
>
> **The analogy that motivated it was wrong.** It was argued as the structural equivalent of
> **Ergo's address prefix** (`0x00` mainnet, `0x10` testnet). It is not: an address prefix is
> a *serialization* concern — how a pubkey is rendered and parsed by a wallet — and **Ergo's
> own box ids and transaction ids are network-agnostic content hashes.** Scoping id
> derivation would have gone beyond Ergo, not matched it.
>
> **What this concedes:** cross-network **post** replay. Posts are DAG objects, so a mainnet
> post carries a valid signature and valid PoW onto devnet unchanged. Transaction replay is
> already impossible via the chain layer above; the accompanying karma-lock transaction fails
> regardless. This is a spam and confusion vector, not a value defect, and it is accepted.

> **Divergence from Ergo, stated deliberately.** Ergo's block header has **no** network
> field: `version`, `parentId`, `ADProofsRoot`, `stateRoot`, `transactionsRoot`, `timestamp`,
> `nBits`, `height`, `extensionRoot`, `powSolution`, `votes`. Notis adds one. With id
> derivation left network-agnostic this is the **only** consensus-visible network
> commitment short of genesis, so unlike the earlier draft it is not redundant — it is what
> turns a wrong-network block into a stated rejection rather than a chain-link failure.

### Sequencing

Adding `networkType` to the header changes `blockHash` and the PoW preimage, so it lands
**inside the P2-C consensus-format break bundle** with `computeTxId` length-prefixing (C1),
the Merkle leaf preimage replacement (C7) and post typing (H5) — one coordinated break, one
update to every id-asserting test. It must **not** land separately.

Everything else in P2-A — the profile table, the environment reads, the magic selection — is
**not** format-breaking and does not need to wait for that bundle.

---

## Protocol Versioning

Every post, stump, ordering block, sub-block, and UTXO transaction carries a
`protocolVersion` field. Validation rules are keyed to this version:

- **Version 1 (current):** Dual-ledger architecture, sovereign subtrees, stumps,
  UTXO karma/credits, likes, invite system, sub-blocks + ordering blocks, PoW
  validators, libp2p networking, two-stage validation (`@dagsocial/validation`
  + `@dagsocial/net`), unified mempool.
- **Future versions:** Credit sinks, reply earning, karma-proportional PoW,
  storage pruning, view keys.

An object with an old version is validated against that version's rules
forever. A node rejects objects with an unsupported protocol version.

> ⚠ **NOT IMPLEMENTED — the second sentence is true, the first is not.** There is **no
> version-keyed rule table and no dispatch**. Validation is a **strict equality check
> against `PROTOCOL_VERSION`**, so rejecting unsupported versions works, while "validated
> against that version's rules forever" describes a mechanism that was never built.
>
> **The consequence is worse than a missing feature: the first version bump makes existing
> history un-resyncable.** Under strict equality a v2 node rejects every v1 object,
> including the chain it already has — so the migration path the versioning scheme exists
> to provide is exactly what it cannot do. This must be built **before** the first bump,
> not during it.
>
> The design stands and is published as how the protocol evolves. **This claim appears in
> four places** — here, `CLAUDE.md` (auto-loaded into every session), `docs/site/architecture`
> (published), and `VALIDATION_INTERFACE.md`. Only `VALIDATION_INTERFACE.md` describes what
> the code does. **If this is built, all four change together.**

---

## Invariants

> ⚠ **Every invariant below was verified individually against the code on 2026-08-06.**
> **48 invariants: 21 true · 15 false · 4 unenforced · 5 qualified · 1 never built.**
> A false invariant is marked in place — **none has been weakened to match the code**,
> because the rule is what Phase 2 has to build. An unmarked invariant is verified true.
>
> The distribution is not random and is worth knowing before trusting any of them: of the
> 21 true, **six are the Block Application Journal block** (written 2026-08-04, *after* its
> implementation) and five are the bigint/value-denomination and guard/decay rules Specs B
> and G touched. Of the 15 false, **ten are July text**, and **all ten Ergo-Adopted bullets
> are July text** — six false, three unenforced or qualified, one true.
>
> Full per-invariant verdicts with sources: `prompts/audit-architecture.report.md` §3a.

### Cross-layer

- Karma is non-tradeable — only moves via invites, likes, earning, decay, or burn
  > ⚠ **VIOLATED — three independent ways. This is the most load-bearing false invariant
  > in the document.** The `like` transition checks only that every output is a karma box,
  > with **no owner constraint**, and the liker may consume their own LikeBox — so
  > like-then-unlike moves karma to an arbitrary recipient. A committed invitee can spend
  > the BondBox to their own karma box (no recipient, probation or threshold check).
  > Unvouch re-mints a constant rather than releasing the escrowed stake.
  > **The rule is correct and stays** — it is the premise the karma↔credit firewall rests
  > on, asserted in four places here and on two published pages. Phase 2 makes it true.
  > Note the first of the three closes by **feature removal**: unlike is not a feature in
  > the current design, so that path is deleted rather than fixed.
- Credits are freely tradeable
  > ⚠ **VIOLATED on-chain.** `sendCredits` mutates the UTXO set **outside block
  > application** — no block, no journal entry, no AVL feed. Credits are tradeable on one
  > node's disk and nowhere else, so the transfer is invisible to consensus and lost on
  > any rebuild from committed state.
- A post's cryptographic identity (hash) survives pruning — parent refs remain valid
- The DAG's merkle integrity is independent of content availability
- The UTXO ledger's correctness is independent of the DAG's index state
  > ⚠ **FALSE AS DESIGNED, not as implemented.** The epoch tally's author reward is a
  > function of a `dag_likes` row count — a DAG index read inside a consensus mutation.
  > **Resolved by the per-block accumulator** (design track §5.3), which reads a committed
  > per-identity record instead. Until that lands, this invariant does not hold.
- Stumps are the sole bridge: DAG compaction → karma issuance
- Like boxes live in the UTXO layer — they are not DAG objects
  > ⚠ **SUPERSEDED — `LikeBox` is being removed entirely** (design track §5.4). With the
  > karma burned at like time there is no held value, so a like becomes a burn transaction
  > plus a `(liker, post)` record. True of the object as it stands; the free-like tier the
  > §Likes section describes contradicted it by minting from `dag_likes`, and that tier is
  > also gone.

### Cryptographic

- Hashing: `blake2b512` truncated to 32 bytes for all 32-byte outputs
- Signatures: raw Ed25519 (64 bytes). **On the wire the encoding depends on the
  carrier, and "base64" — as this line previously read — is the rarest of the three:**
  raw bytes inside CBOR (all consensus structures), **lowercase hex** at the HTTP
  boundary (`json-to-tx.ts`) and in the demo UI, and base64 at exactly one endpoint
  (`routes/utxo.ts`). Verification is `crypto.verify(null, …)` with a KeyObject in
  every case
  > ⚠ **Non-malleability is relied upon and stated nowhere.** Measured on node v22.19.0 /
  > openssl 3.0.17: `crypto.verify` rejects the classic `S + L` malleation and the
  > high-bit variant, enforcing RFC 8032's `0 ≤ S < L`. This matters because
  > `serializePruneEntry` puts `authorSignature` **inside** the `prune` Merkle leaf, hence
  > inside `subBlockRoot` — every other signature in the system is excluded from every
  > preimage. A second verifier (light client, a pure-JS Ed25519 library) that is
  > cofactored or skips the range check would accept a second valid signature, and there
  > it would mean two valid *blocks*. **Any mirror implementation MUST enforce
  > `0 ≤ S < L`.** Untested: non-canonical `R` encodings, small-order points,
  > cofactored-vs-cofactorless verification
- Public keys: 32 raw bytes, hex-encoded on wire
- Secret keys never in API responses, DTOs, or committed data structures
- Post PoW acts as sub-block proof — verified by validators at ordering time


### Content sovereignty

- Post author owns the entire reply subtree under their post
- Pruning cascades to all descendants — replying is consent to this
- Pruning requires root author's signature (sole authorization)
- Pruning is irreversible
- Future prune triggers (storage pruning) use their own auth paths

### Identity

- An account comes into existence via first UTXO box appearance
- Invite secrets are hash-locked, portable bearer instruments
- An invite can be cancelled by the inviter (before claim) or claimed by the
  preimage holder
  > ⚠ **QUALIFIED — "bearer instrument" is no longer the whole story.** §Invite System
  > records that a commit now requires a signature from the committed key (audit H-2), so
  > the preimage alone is not sufficient. This bullet was not updated when that landed 200
  > lines above it.
- Invite bonds are lost if the invitee's karma drops below the posting minimum
  during probation
  > ⚠ **VIOLATED — and the failure is the opposite of the rule.** The bond transition
  > checks **no recipient, no probation height and no karma threshold**, so rather than
  > being forfeited the bond can be **taken by the invitee**. The rule is right — the
  > design has the bond vesting back to the inviter as the invitee earns likes, forfeited
  > if they never engage — and stays.
- ~~Usernames: first-claim-wins, DAG-native, prunable by holder~~
  > ⚠ **SUPERSEDED (2026-08-06).** Usernames become a **UTXO asset**: tradeable for
  > credits, free to claim while unused, burnable by the owner. Not a claim post, so
  > "DAG-native" and "prunable by holder" no longer apply. Deferred — see §Username claims
  > and design track §5.9. **Profiles are unaffected and stay DAG-native as self-posts.**

### UTXO conservation

- Total karma supply = genesis + like rewards (minted) - decay burns - invite bond burns
  > ⚠ **FALSE — incomplete.** `mint-provenance.ts` carries **ten** mint reasons, including
  > `prune-refund-author`, `prune-refund-liker`, `postlock-unlock`, vouch settlement and
  > the faucet. This equation names three. **The mint-reason table is the authoritative
  > enumeration; this bullet must be derived from it, not maintained beside it** — a
  > hand-kept parallel list of mint sources is a mirror, and it has already diverged.
- Total credit supply = genesis + ordering block rewards - future sinks
  > ⚠ **QUALIFIED — true in shape, but "total" is currently unbounded.** The reward
  > function has **no terminus**: it floors at `CREDIT_TAIL_REWARD` and mints 2 credits per
  > block forever, while `MINING_INTERFACE.md` states a fixed ~453.9M total. Emission is
  > decided to **terminate** (Ergo shape, decay to zero, no tail — design track §5.7), and
  > every current total-supply figure in the repo is wrong until that lands.
- Every UTXO transaction conserves value except mint and burn
  > ⚠ **UNENFORCED — and the repo already says so.** `packages/node/CLAUDE.md` states
  > verbatim: *"(Being enforced by the value-integrity spec — today the node does not
  > enforce it.)"* Live instances: unvouch re-minting a constant instead of releasing the
  > staked amount, and `sendCredits` mutating the UTXO set outside block application.
  > **This is a prerequisite, not a parallel track** — the like-burn transition of design
  > track §5.4 cannot be correct until burning is an enforced transition.
- Box `value` and all value/amount arithmetic are `bigint` integer base units
  (`value < 2⁶⁴`); **no float math in any consensus value path** — floats are
  non-deterministic across platforms and credit sums exceed 2⁵³ (Spec B P0)
- A box can only be consumed if its guard script evaluates to true
- Karma decay applied periodically at block application time (not at spend time)

### Block application journal (Spec B P1)

- **One record-once mutation log.** Block application maintains a single
  ordered journal of primitive box mutations —
  `{ op: 'insert' | 'remove', boxId, box? }` — recorded automatically at the
  store choke point (`insertBox`, `consumeBox`, `markLikeBoxesTallied`) while
  a block journal is open. Call sites never maintain parallel mutation
  bookkeeping; every box mutation a block makes appears in the log exactly
  once, in application order.
- **Accounting-agnostic.** The log carries no per-mutation-class fields.
  Future mutation classes (invite/post bonds, one-way like accounting,
  storage rent, coinbase splits) journal through the same log unchanged.
- **Rollback replays inverses.** Reverting a block walks the log in reverse:
  `insert` → delete the box, `remove` → un-spend it. Non-box side effects
  (post confirmations, free-like processed flags, vouch-cooldown rows,
  mempool re-insertion payloads) travel as typed side-records, each with an
  exact inverse. Apply-then-revert restores the identical UTXO set and AVL
  digest for every mutation class.
- **Sole replay basis.** UTXO boxes + the journal are a complete replay
  source. No mutation or rollback may read pruned DAG content.
- **AVL feed derives from the journal.** The prover's per-block mutation set
  is computed from the journal — never from hand-maintained consumed/created
  lists (the drift source behind audit C-5/H-5/H-7).
- **Prover restored on rejection.** A rejected block leaves the AVL prover at
  its pre-block digest regardless of which stage rejected it.

### Sub-blocks and ordering

See `SUBBLOCK_INTERFACE.md` for the full contract.

- Sub-blocks are user-produced; ordering blocks are validator-produced
- Sub-blocks carry at most one post (like boxes collected at ordering time)
- Ordering blocks anchor sub-blocks via Merkle digest
- Like deduplication happens at ordering time
- Epoch transitions (like tally) happen at ordering block boundaries

### Network identity

> ⚠ **NOT IMPLEMENTED — added 2026-08-06, after the audit. These four are NOT part of the
> 48 verified above and carry no audit verdict**, because nothing they describe exists yet.
> They are the rules P2-A and P2-C build to. See §Network Identity for the mechanism.

- **`NETWORK_TYPE` is the only environment variable that may change a consensus parameter,
  and it changes all of them together.** No individual consensus parameter is
  environment-readable. Two nodes agreeing on `NETWORK_TYPE` cannot differ on any value it
  selects.
- **Id derivation is network-agnostic.** No domain tag, box id, transaction id, post id or
  identity record key carries the network. `@dagsocial/types` stays pure — no module-level
  state, no network argument on a derivation function. Network separation is carried by
  genesis, the header field and the wire magic instead.
- **The per-network parameter set covers timescale, difficulty and genesis only.** Costs and
  format limits are universal across networks. Adding a parameter to the per-network set
  requires justifying why devnet may behave differently from mainnet in that respect.
- **The wire magic is a function of the network profile**, not a per-call-site default. A
  node cannot frame for one network while validating for another.

---

## Ergo-Adopted Invariants

These invariants are adopted from production-grade Ergo Rust node practices:

> ⚠ **This whole section is 100% original 2026-07-26 text and it is the worst-performing
> block in the document: of its ten bullets, six are false, three are unenforced or
> qualified, and one is true.**
>
> **Check the premise before adopting anything else from Ergo.** One analogy is already
> recorded as not having transferred: Ergo can leave `creationHeight` client-declared
> because nothing consensus-critical reads it, whereas here `createdAtBlock` **was** the
> decay clock, so the field had to leave the box protocol entirely and the clock moved into
> committed state. An invariant that is correct for Ergo and wrong here, kept because the
> analogy sounded right, is this section's characteristic failure — and one bullet below is
> transliterated Rust naming a hazard TypeScript does not have.

### Validation boundaries
- **No method panics on untrusted input** — every deserialization and
  signature-verification function returns a `Result<T, Error>` equivalent.
  No `unwrap()`, no `as` casts that truncate, no OOM on adversarial input.
  > ⚠ **FALSE on all three limbs, and the `as`-cast clause names the wrong hazard.**
  > *Panics:* the Stage-1 pipeline has an unguarded throwing step between its documented
  > calls. *OOM:* `cumulativeWork` allocates ~128 MB on an attacker-supplied
  > `powTargetBits` and `readArray` pre-allocates its declared length before reading an
  > element. *Casts:* the legacy headers path is a bare `decode()` plus cast with no shape
  > check.
  > **A TypeScript `as` cast does not truncate — it erases at compile time and asserts a
  > type that was never checked.** That is a *different and larger* hazard than Rust's
  > truncating numeric cast: it produces no runtime error at all. The clause reads as
  > transliterated Rust and should name the real risk — unvalidated `as` on decoded input.
- **Validate, don't trust** — independently recompute every self-reported
  claim. A post's parent hash, PoW solution, and signature MUST be verified
  by the local node before the post enters the store.
  > ⚠ **FALSE — three paths write before verifying.** `insertPostPlaceholder` writes a
  > confirmed row before anything verifies it; a post is written to `dag_posts` before its
  > karma-lock transaction validates, with no rollback; and `onStump` stores unauthenticated
  > gossip stumps — a forged one satisfies the verifier's parent-existence check for a post
  > that never existed. **Post PoW is not verified at ordering time either**: `verifyPoW`
  > has two call sites, both in the verifier, neither reachable from block application.
- **Never add checks the reference lacks** — extra validation rules beyond
  the protocol spec create fork surfaces. Every rule is either
  protocol-spec or explicitly local-policy-only.
  > ⚠ **UNENFORCED, and the premise has no referent.** There **is** no reference
  > implementation — this node is the only one — so "the reference" names nothing.
  > **Nothing in the repo marks any rule as protocol-spec or local-policy-only**, which is
  > precisely the gap the parameter-class convention now fills for configuration and which
  > remains open for validation rules. `verifyContentCharacters` is an example: an unlisted
  > post-validity rule that is neither declared protocol nor declared local.

### Storage guarantees
- **Single-transaction atomic writes** — every post insertion that touches
  multiple tables (posts, dag_edges, indexes, scores) MUST happen in a
  single SQLite transaction. No partial writes.
- **Best DAG is a view, not structural** — all alternative-branch posts are
  stored permanently. Switching branches is a view update — posts are never deleted.
  **Canonical ordering is `max(parentScores) + 1` — uniform weight per post, not
  PoW-weighted.**
  > **Corrected 2026-08-06 (decision, not drift).** This bullet previously said "derived
  > from cumulative PoW"; the live rule weights every post at 1. That is deliberate:
  > **post difficulty is static, so weighting by actual PoW is numerically identical to
  > weighting by 1** and the count buys no information. A second, independent reason to
  > prefer it: PoW-weighting would let **hashpower buy canonical prominence**, which
  > contradicts *the node records, it doesn't rank*.
  >
  > ⚠ **PREMISE — re-argue this before making post difficulty dynamic.** The equivalence
  > holds **only while post PoW difficulty is static.** If a retarget or user-chosen
  > difficulty is introduced, uniform weight stops equalling cumulative work and this must
  > be decided again — at which point the second reason becomes load-bearing rather than
  > corroborating. *(Chain selection is unaffected and does use genuine cumulative PoW;
  > these are two different mechanisms and this bullet is about the DAG.)*
- **Sort-order determinism** — any operation feeding a Merkle tree or
  content hash MUST have a documented, identical sort order across all
  implementations.
  > ⚠ **FALSE on "documented" — and the fix is to change the format, not to document it.**
  > Two consensus Merkle leaf preimages (`subblock`, `coinbase`) are `JSON.stringify` output
  > feeding `subBlockRoot` and `utxoTxRoot` under PoW. Documenting them would commit every
  > future implementation to replicating **ECMAScript JSON semantics** — key order equal to
  > object-literal insertion order, ES2019 escaping, `Array.from` on byte arrays (else
  > `{"0":1,…}`), bigint pre-rendered as decimal because `JSON.stringify` throws on it. A
  > non-JS light client would have to reimplement V8 string escaping to compute a block root.
  >
  > **Decision 2026-08-06: replace, do not specify.** Move to a length-prefixed canonical
  > encoding — the pattern `postFieldBytes` already uses, which is the M-1 fix and is
  > verified injective. Two supporting reasons: the format is **already straining**
  > (`canonicalEpochTallyJson` exists precisely because JSON insertion order was not
  > deterministic enough for one leaf), and it is protocol-breaking either way, so it costs
  > nothing extra folded into the id-moving bundle (`computeTxId` length-prefixing, post
  > typing) rather than as a second coordinated break later.
  >
  > `stump`, `prune` and `utxotx` are simple byte forms and are unaffected — they get written
  > specs as-is. `epoch` and `likebox` are deleted with the like/epoch removal.

### Package boundaries
- **No dependencies above the package's abstraction level** — the storage
  layer depends only on DB bindings and hashing. It MUST NOT import post
  content types, networking code, or UI code.
  > ⚠ **FALSE in the positive clause; the prohibition holds.** `store/` value-imports CBOR
  > serializers (`encodeTx`, `decodeTx`, `encodeStump`, `serializePruneEntry`) and
  > `store/mempool.ts` imports `../config.js` — **the application layer, imported by the
  > storage layer, and load-bearing** (it carries `MAX_MEMPOOL_ENTRIES` into the capacity
  > check). The *prohibitions* are respected: post content types are `import type` only,
  > and there is no networking or UI import.
- **"Does NOT own" on every package** — each package explicitly lists what
  it is NOT responsible for. Prevents scope creep.
  > **True — all five packages carry it.** Note it lives in `packages/*/CLAUDE.md`, not in
  > `contracts/`, so it is a session-context convention rather than a contract one.

### Data integrity
- **Timestamps are untrusted** — timing-sensitive logic uses DAG depth or
  local wall clock, never a remote post's self-reported timestamp.
  > ⚠ **FALSE — and the invariant's own escape clause is the deeper problem.** Live
  > violations: `store/posts.ts` orders feeds by `ORDER BY timestamp DESC` on the
  > self-reported value; `getPendingPosts` does the same; `sqlite-store.ts` writes
  > `Date.now()` into the column that is **inside `computePostId`**; the demo UI ranks its
  > feed by `post.timestamp`.
  > **"or local wall clock" contradicts the project's own rule that on-chain time is block
  > height.** A *local* wall clock is precisely what makes two nodes disagree. That clause
  > should be struck, not merely qualified — it licenses the failure mode it exists to
  > prevent.
- **Precondition/postcondition documentation** on every public function in
  the store and service layers.
  > ⚠ **FALSE — 174 exported functions across `store/` and `services/`, and exactly one
  > file in `packages/node/src` contains the word "Precondition".** Either the invariant is
  > adopted for real or it should be dropped; as written it is aspiration in the present
  > indicative, which is the failure mode the status markers exist to prevent.

---

## Build and test resolution

Every package is ESM and builds with `tsup src/index.ts --format esm --dts` to a single bundled
`dist/index.js`. The four library packages (`types`, `wire`, `validation`, `net`) each declare
exactly one export condition — `"."` — and there are no subpath exports anywhere. **`node` has no
`exports` field at all**, only `main`; it is the application package and nothing depends on it, so
bare-specifier resolution there goes through `main`. The practical effect is identical, but `node`
is not subject to the subpath restriction the other four get from `exports`.

**Test code resolves `@dagsocial/*` to the package's `src/index.ts`, never to `dist/`.** A vitest
`resolve.alias` maps each workspace package name to `packages/<pkg>/src/index.ts`, declared once at
the repo root and merged into every package's vitest config.

Four rules govern it:

1. **Uniform across all five packages.** Aliasing some and not others puts two copies of the same
   module in one process — one transpiled from `src`, one bundled inside `dist`. `instanceof` fails
   across that boundary and every module-level singleton exists twice.
2. **The alias target is `src/index.ts`, not `src/`.** The barrel stays the surface under test, so a
   symbol exported from a module but missing from `index.ts` still fails at import.
3. **`pnpm test` no longer proves a package builds.** Nothing in the unit-test path executes `tsup`,
   so a bundling or externalisation break passes the suite. `pnpm -r build && pnpm -r typecheck &&
   pnpm -r test` is the gate before any commit or PR — **the build is a separate obligation, not a
   side effect of testing.**
4. **Spawned processes are exempt and still need a real build.** A vitest alias exists only inside
   the vitest process. `packages/node/test/e2e/*` spawns `dist/index.js` as a child process, so any
   run including that suite requires a genuine build first. Node's `globalSetup` build therefore
   stays, **gated on the resolved exclude list**: it skips while `'test/e2e/**'` sits in
   `config.exclude`, and re-arms by itself when the post-P2-D rewrite removes that exclusion. The
   gate fails safe — an exclude string it does not recognise builds rather than skips.

**Cost, measured 2026-08-07.** Node's suite went **11.7 s → 25.1 s**: transforming three sibling
packages' `src` per file costs more than the `tsup` build it replaced. This is a known, accepted
trade — the alias buys correctness and removes `dist`-write contention, **not** speed. Do not
"optimise" it away expecting the suite to get faster.

**Why this rule exists.** Before it, 12 test files imported their own package by name — all 5 in
`wire`, 7 of 20 in `net` — and neither package had a rebuild hook, so a source edit was invisible to
its own tests. That produced false-green mutation runs twice, a completeness grep that hit stale
`dist` and read as a genuine failure, and a "mutation survived" conclusion that was really a stale
binary. The alternative — a build hook in every package — was **rejected**: the recorded failure mode
is two sessions racing the same `dist` (a build in one window swapped `net/dist` under a suite
running in another), and four more build-on-test-start hooks makes that worse rather than better.
Taking `dist` out of the unit-test path dissolves the race instead of tightening the discipline
around it.

---

## Store Architecture

> ⚠ **The namespacing below does not match the schema.** 17 of 18 lines are original
> 2026-07-20 text and predate the actual tables by weeks. **`sub_*` has no tables at all**
> — sub-block state lives in the mempool and in `block_topology`. Ordering blocks are
> outside the `block_*` prefix. The audit also found the store contract naming tables and
> columns that do not exist, and `routes/status.ts` querying three (`blocks`, `posts`,
> `identities`) that were never created.
>
> **`NODE_INTERFACE.md → Store Interface` is authoritative for the schema; this section is
> a sketch of an organising principle that was not followed.** Do not derive table names
> from it.

Phase 2 uses a fresh SQLite database with namespaced tables:

| Prefix | Content |
|--------|---------|
| `dag_*` | Posts, parent refs, stumps |
| `utxo_*` | Karma boxes, credit boxes, like boxes, invite boxes, bond boxes |
| `sub_*` | Sub-blocks, sub-block-to-post mapping |
| `block_*` | Ordering blocks, block-to-sub-block mapping |
| `peers` | Discovered peer addresses (unprefixed — it belongs to none of the four ledgers; it backs `@dagsocial/net`'s PeerDb across restarts) |

Single WAL, single connection. Phase 1 schema is not migrated — Phase 2 starts
fresh. Namespacing keeps the option open to split into separate stores later
(e.g., UTXO moves to an authenticated state trie for light client proofs).

---

## Implemented (v2)

> ⚠ **This list is 88% pre-August and overstates what runs. Five entries are not
> implemented as described** — marked inline below. "Implemented" is the strongest claim a
> heading can make, so a wrong entry here is more misleading than the same error anywhere
> else in the document.

- Sovereign subtrees with author-controlled pruning
- UTXO ledger: karma (non-tradeable) + credits (tradeable)
  > ⚠ **karma non-tradeable is VIOLATED three ways; credits are tradeable only on one
  > node's disk** (`sendCredits` bypasses block application). See §Invariants → Cross-layer.
- ~~Like system: locked likes (karma staking) + free likes (post-50), epoch tally~~
  > ⚠ **SUPERSEDED.** Likes are one-way at 1 karma with no refund, no free tier and no
  > epoch. The **free-like tier has no producer anywhere in the node** — correctly never
  > built rather than a gap. See §Likes.
- Invite system: hash-locked bearer invites, bond/probation, cancel
  > ⚠ **PARTIAL.** A commit now requires a signature from the committed key (H-2), so
  > "bearer" is qualified; and **bond forfeiture on probation failure is not enforced** —
  > the invitee can take the bond.
- ~~Post karma locking with gradual unlock at epoch boundaries~~
  > ⚠ **PARTIAL.** The post bond (`PostLockBox`) is real and stays — it is the anti-dodge
  > mechanism. But **"at epoch boundaries" is superseded**: vesting moves to per-block with
  > the epoch's removal, and the `epoch_tally` guard becomes "consumable only by block
  > application."
- Sub-blocks + ordering blocks with PoW (user PoW + validator PoW)
- Verifiable prune: block-level PruneEntry, Ed25519-signed, UTXO-deterministic
  settlement (consumes PostLockBoxes and LikeBoxes, mints refund karma)
- AVL+ state root: authenticated dictionary over UTXO set, stateRoot in block
  headers, `GET /api/v1/proof/:boxId` for light-client proofs
- block_topology table (post_id, parent_refs, author, block_height — all
  consensus-sourced) for subtree topology and prune-authorship lookups
- libp2p networking with two-stage validation (stateless + stateful)
- Credit emission: Ergo-style linear decay, treasury split, miner reward delay
- Height-deterministic difficulty schedule for ordering block PoW (no wall clock)
- Internal + external mining modes
- Unified mempool: all state mutations queued, applied atomically at block
  finalization
- Framed p2p stream protocol with magic bytes, VLQ length prefixing, and a **4-byte**
  checksum (the first 4 bytes of a blake2b digest — the frame layout at the top of this
  document says `[checksum:4]`, and `WIRE_INTERFACE.md` agrees; "32-byte" here was wrong)
- Header-first historical sync with SyncInfo/Inv/Modifier protocol
- Peer discovery via GetPeers/Peers gossip + PeerDb

## Deferred to future protocol versions

- **Credit sinks:** Ads, author boosts, reader tips
- **Reply earning:** Proportion of downstream likes flowing to upstream
  contributors
- **Karma-proportional PoW:** High-karma accounts do less work
- **Storage pruning:** Automatic compaction for lean nodes (archive nodes
  retain full content)
- **View keys / private content:** Reader spending credits to unlock content
- **Parameter governance:** Karma decay, like thresholds, emission schedule
  adjustable by future governance
- **Fee market:** Replacement semantics, priority fees, fee-based eviction
  (a flat reject-at-cap mempool bound ships already — audit M-8)
