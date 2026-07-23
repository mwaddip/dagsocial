# DAGsocial Architecture

**Protocol version:** 2 (Phase 2 redesign)
**Last updated:** 2026-07-23

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

Inspired by Ergo's subblock model:

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

## The Three Layers

### 1. Posts DAG (Content Layer)

Every post is the **root of a sovereign subtree.** The author controls
everything under it — replies, replies to replies, the entire transitive
closure of `parentRefs` that trace back to this root.

#### Post structure

```
Post {
  content: string              // 1–MAX_CONTENT_BYTES UTF-8
  author: UserId               // base58btc(blake2b512(publicKey))
  parentRefs: PostId[]         // 0–MAX_PARENT_REFS per post
  challenge: bytes             // Random nonce issued by node (anti-precomputation)
  powNonce: number             // PoW solution — proves work against challenge
  protocolVersion: number
  timestamp: number
  signature: bytes             // Ed25519 over signingHash(post)
}

PostId = blake2b512(content || author || parentRefs || challenge || powNonce || protocolVersion || timestamp)
         .subarray(0, 32).toString('hex')
```

A post's `parentRefs` may reference either live posts or stumps. The hash is
the same either way — the DAG's cryptographic integrity doesn't depend on
content availability.

#### Post-level PoW (sub-block mechanism)

PoW is a single challenge-response pass, collapsed from the Phase 1 two-phase
model. The post's PoW solution IS the sub-block proof:

1. Author requests a challenge from a node → node returns random nonce
2. Author constructs the post, iterates `powNonce` until:
   `blake2b512(content || author || parentRefs || challenge || protocolVersion || timestamp || powNonce)`
   meets the target difficulty
3. Author submits the completed post → it becomes a sub-block with pending
   likes attached as sidecars
4. Validators verify the PoW when anchoring sub-blocks in an ordering block

The challenge prevents precomputation. The concurrency constraint holds:
one outstanding challenge per account at a time. The author cannot request a
new challenge until the current one is submitted or expires (challenge
expiry: `CHALLENGE_WINDOW_BLOCKS`).

PoW difficulty is a protocol parameter (`POST_POW_TARGET_BITS`). It may
become karma-proportional in the future (high karma → lower difficulty),
but for Phase 2 it is fixed.

#### Subtree pruning (deletion)

The root author may prune their entire subtree at any time. Pruning:

1. Removes the root post and all descendant posts from the indexable DAG
2. Cascades to all replies — a reply exists only in the context of its root
3. Replaces the entire subtree with a **stump** (see §3)
4. Is authorized by a signed prune transaction from the root author's key

The prune is authorized **solely** by the root author's Ed25519 signature.
No validator attestation is required — karma deltas are deterministically
computable from the UTXO state (like boxes). Any node can verify the stump
independently.

Pruning is irreversible. Once content is pruned, it cannot be recovered.
Nodes propagate stumps, not the original content.

Future stump triggers beyond author deletion (dRep governance removal,
storage pruning for lean nodes) will use their own authorization paths
but produce the same stump data structure.

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

#### Karma boxes

```
KarmaBox {
  id: BoxId
  value: number                // Karma balance
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
  the decay clock)

#### Karma decay (storage rent)

Karma decays based on box age, applied at consumption time:

```
age = currentBlock - box.createdAtBlock
graceAge = max(0, age - KARMA_DECAY_GRACE_BLOCKS)
decay = box.value * KARMA_DECAY_RATE * graceAge
effectiveKarma = max(box.value - decay, KARMA_FLOOR)
```

- Active accounts regularly consume and recreate their karma box (via likes,
  invites, earning), resetting the `createdAtBlock` clock
- Dormant accounts experience decay when they eventually touch their box
- `KARMA_FLOOR` guarantees a minimum regardless of inactivity
- All parameters are protocol constants, governable in the future

| Parameter | Description |
|-----------|-------------|
| `KARMA_DECAY_RATE` | Fraction of box value lost per block after grace period |
| `KARMA_DECAY_GRACE_BLOCKS` | Blocks before decay begins |
| `KARMA_FLOOR` | Minimum karma retained regardless of inactivity |

#### Credit boxes

```
CreditBox {
  id: BoxId
  value: number                // Credit balance
  owner: PublicKey
  guard: "owner_signature"
  proofSource: BlockId         // Which ordering block minted these credits
}
```

Credits are freely transferable between accounts. They are minted as validator
rewards for producing ordering blocks. Credit sinks (ads, author boosts, tips)
are deferred to future protocol versions. For Phase 2, the credit supply grows
with each ordering block — the reward amount is a protocol parameter.

#### Box lifecycle

All box transitions are atomic — a transaction consuming N boxes and creating M
boxes either fully commits or fully fails. The ledger enforces:

- Total value in = total value out (conservation, except mint/burn)
- Guard scripts evaluate to true for every consumed box
- New boxes are valid under protocol rules

### 3. Stumps (Binding Layer)

A stump is what remains after a post subtree is pruned. It is a compact,
cryptographically signed proof that the subtree existed and that specific
value was earned inside it.

```
Stump {
  rootPostHash: PostId         // Identity of the pruned root post
  subtreeMerkleRoot: Hash      // Merkle root over all posts in the pruned subtree
  authorId: UserId             // Account that authorized the prune
  pruneSignature: bytes        // Ed25519 signature from the root author's key
  trigger: "author" | "drep" | "storage_prune"  // What initiated the compaction

  // Crystallized value — what the subtree contributed to the ledger
  karmaDeltas: {
    userId: UserId
    delta: number              // Net karma earned in this subtree
  }[]

  replyCount: number           // Total replies in the pruned subtree
  upvoteCount: number          // Total upvotes the root post received

  protocolVersion: number
  compactedAtBlockHeight: number
}
```

#### Prune lifecycle

1. Root author signs a prune intent: `{ rootPostHash, trigger: "author" }`
   with their Ed25519 key
2. Node computes karma deltas from UTXO state (like boxes associated with
   posts in the subtree are deterministically resolved)
3. Node constructs the stump, embeds karma deltas, includes the author's
   signature
4. The stump is committed in an ordering block
5. All nodes replace the full subtree data with the stump
6. Karma deltas are credited to the ledger, referencing the stump hash

No validator attestation is needed — the author's signature authorizes the
prune, and the karma deltas are deterministically verifiable from UTXO state.

#### Cryptographic guarantees

- Karma deltas are deterministically computable from UTXO like boxes — any node
  can verify the stump independently
- A node that held the full subtree can verify the merkle root against the
  original content
- The ledger's karma entries reference specific stumps — a disputed stump (e.g.,
  fraudulently signed) invalidates downstream ledger entries
- Parent hashes remain valid — a reply referencing a pruned post still has a
  valid `parentRefs` entry; the parent is just a stump now
- The author's prune signature is the single point of authorization

---

## Identity

An account is a cryptographic keypair. There is no separate registration step.

```
UserId = base58btc(blake2b512(publicKey))
```

An account comes into existence the first time it appears in a committed UTXO
box (via invite claim, genesis committee allocation, or credit receipt). There
is no "account table" — identity is derived from key material and visibility
on the ledger.

### Username claims

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

Validators earn credits for each ordering block produced. The reward amount is
a protocol parameter (`ORDERING_BLOCK_REWARD_CREDITS`). Credits are freely
tradeable — validators may sell them to users.

### Separation from users

A validator may also hold a user account (karma, posts) but the roles are
cryptographically and economically independent. A validator's block reward
credit box and their user karma box are separate UTXO entries controlled by
separate keys if desired.

---

## Genesis

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
└──────────┘     └────┬─────┘     └──────────┘     └──────────┘     └──────────────┘
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
     ┌─────────┐ ┌─────────┐ ┌──────────┐
     │  Posts  │ │  UTXO   │ │ Ordering │
     │   DAG   │ │ Ledger  │ │  Blocks  │
     └────┬────┘ └────┬────┘ └──────────┘
          │           │
          └─────┬─────┘
                ▼
          ┌──────────┐
          │  Stumps  │
          └──────────┘
```

1. **Genesis:** Committee mints initial karma/credit boxes
2. **Invite:** Committee invites first users via hash-locked invite boxes
3. **Account creation:** Invitee claims invite with keypair → karma box exists
4. **Posting:** User requests challenge from node, constructs post, solves single-pass PoW →
   sub-block with post + pending likes
5. **Liking:** User spends karma → like box → committed in next sub-block or
   ordering block
6. **Ordering:** Validator solves full PoW → ordering block batches sub-blocks,
   deduplicates likes, triggers epoch tally, distributes credit rewards
7. **Pruning:** Author signs prune intent → stump constructed with deterministic
   karma deltas → committed in ordering block → DAG compacted
8. **Net:** libp2p gossips sub-blocks and ordering blocks between nodes.
   Stage 1 (stateless) validation via `@dagsocial/validation` runs before
   forwarding. Stage 2 (stateful) validation runs in the node after receipt.

---

## Protocol Versioning

Every post, stump, ordering block, sub-block, and UTXO transaction carries a
`protocolVersion` field. Validation rules are keyed to this version:

- **Version 1:** Phase 1 (implemented) — simple additive DAG, no pruning, no
  UTXO, single-node HTTP server.
- **Version 2:** Phase 2 (this contract) — dual-ledger architecture, sovereign
  subtrees, stumps, UTXO karma/credits, likes, invite system, sub-blocks +
  ordering blocks, PoW validators, libp2p networking, two-stage validation
  (`@dagsocial/validation` + `@dagsocial/net`).

An object with an old version is validated against that version's rules
forever. A node rejects objects with an unsupported protocol version.

---

## Invariants

### Cross-layer

- Karma is non-tradeable — only moves via invites, likes, earning, decay, or burn
- Credits are freely tradeable
- A post's cryptographic identity (hash) survives pruning — parent refs remain valid
- The DAG's merkle integrity is independent of content availability
- The UTXO ledger's correctness is independent of the DAG's index state
- Stumps are the sole bridge: DAG compaction → karma issuance
- Like boxes live in the UTXO layer — they are not DAG objects

### Cryptographic

- Hashing: `blake2b512` truncated to 32 bytes for all 32-byte outputs
- Signatures: raw Ed25519 (64 bytes), base64-encoded on wire
- Public keys: 32 raw bytes, hex-encoded on wire
- Secret keys never in API responses, DTOs, or committed data structures
- Post PoW acts as sub-block proof — verified by validators at ordering time

### Content sovereignty

- Post author owns the entire reply subtree under their post
- Pruning cascades to all descendants — replying is consent to this
- Pruning requires root author's signature (sole authorization)
- Pruning is irreversible
- Future prune triggers (dRep, storage pruning) use their own auth paths

### Identity

- An account comes into existence via first UTXO box appearance
- Invite secrets are hash-locked, portable bearer instruments
- An invite can be cancelled by the inviter (before claim) or claimed by the
  preimage holder
- Invite bonds are lost if the invitee's karma drops below the posting minimum
  during probation
- Usernames: first-claim-wins, DAG-native, prunable by holder

### UTXO conservation

- Total karma supply = genesis + like rewards (minted) - decay - invite bond burns
- Total credit supply = genesis + ordering block rewards - future sinks
- Every UTXO transaction conserves value except mint and burn
- A box can only be consumed if its guard script evaluates to true
- Karma decay applied at consumption time based on box age

### Sub-blocks and ordering

- Sub-blocks are user-produced; ordering blocks are validator-produced
- Sub-blocks carry at most one post plus queued likes as sidecars
- Ordering blocks anchor sub-blocks via Merkle digest
- Like deduplication happens at ordering time
- Epoch transitions (like tally) happen at ordering block boundaries

---

## Store Architecture

Phase 2 uses a fresh SQLite database with namespaced tables:

| Prefix | Content |
|--------|---------|
| `dag_*` | Posts, parent refs, stumps |
| `utxo_*` | Karma boxes, credit boxes, like boxes, invite boxes, bond boxes |
| `sub_*` | Sub-blocks, sub-block-to-post mapping |
| `block_*` | Ordering blocks, block-to-sub-block mapping |

Single WAL, single connection. Phase 1 schema is not migrated — Phase 2 starts
fresh. Namespacing keeps the option open to split into separate stores later
(e.g., UTXO moves to an authenticated state trie for light client proofs).

---

## Deferred to future protocol versions

- **Credit sinks:** Ads, author boosts, reader tips
- **Reply earning:** Proportion of downstream likes flowing to upstream contributors
- **Karma-proportional PoW:** High-karma accounts do less work
- **dRep governance pruning:** Stump trigger via governance vote
- **Storage pruning:** Automatic compaction for lean nodes (archive nodes
  retain full content)
- **View keys / private content:** Reader spending credits to unlock content
- **Karma decay governance:** Decay parameters adjustable by future governance
- **Like threshold governance:** Like parameters adjustable by future governance
