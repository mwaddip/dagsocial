# How DAGsocial Works

DAGsocial is an invite-only decentralized social network. There are no tokens to
buy, no ads, no corporate servers. The network runs on karma — a non-tradeable
social currency you earn by contributing content that other people like.

---

## What Makes It Different

Most "decentralized social" projects put posts on a blockchain. DAGsocial splits
the problem into two layers, each doing what it's good at:

| | Posts DAG | UTXO Ledger |
|---|---|---|
| **What it tracks** | Content, replies, who said what | Karma, credits, who has how much |
| **Who controls it** | Each author controls their own subtree | Box owners control their boxes via signatures |
| **Can it be deleted?** | Yes — authors can prune their content | No — box history is immutable |
| **What it's good at** | Threaded conversation, author sovereignty | Value accounting with cryptographic lineage |

The insight: content and value have different requirements. A threaded reply
chain shouldn't be an immutable ledger entry, and your karma balance shouldn't
vanish when someone deletes a post.

---

## How Karma Works

Karma is the social currency of the network. It's not a token you can buy — it
only moves in specific, protocol-enforced ways.

### What you can do with karma

| Action | Karma effect |
|---|---|
| **Like a post** | 2 karma locked while the like is pending (refunded later if the post gets enough traction) |
| **Create an invite** | You split off some karma + post a bond for a new member |
| **Earn from likes** | Each post earns 1 karma per 5 likes, up to 10 maximum |
| **Just hold it** | Karma above a floor gives you social weight (future: lower PoW difficulty) |

### What you can NOT do with karma

- **Buy, sell, or transfer it** — karma is non-tradeable. The only way karma moves between accounts is through the invite system or through like rewards.
- **Cash it out** — there is no bridge to external tokens or fiat.
- **Stake it for governance** — at least not yet. Governance is deferred.

### Why non-tradeable matters

If karma were tradeable, a rich account could buy reputation. By restricting
karma movement to protocol actions (liking, inviting, earning), the network
ensures karma reflects actual social contribution — not wallet depth.

### Karma decay

Karma slowly decays if your account is dormant. The decay clock resets every
time you do something that touches your karma box (post a like, receive a like
reward, create an invite). Active accounts never feel it. Ghost accounts
eventually bleed down to a floor value.

The three parameters:
- **Grace period:** No decay for the first N blocks after your last karma box touch
- **Decay rate:** A fraction of your karma lost per block after the grace period
- **Floor:** Minimum karma you keep no matter how long you've been gone

---

## The DAG / UTXO Hybrid

### The Posts DAG (Content Layer)

Every post is the root of its own subtree. When someone replies to your post,
that reply lives under your subtree. You control everything under your root:

- **You can delete (prune) your entire subtree** — the root post and every reply under it, regardless of who wrote the replies. This is the privacy model: you own the conversation space you started.
- **Replying is consent** — when you reply to someone's post, you're accepting that they can prune the whole tree later. This is a social contract baked into the protocol.

Posts link to each other via `parentRefs` — a post can reference up to 8 parent
posts, creating a DAG (directed acyclic graph) rather than a strict tree. This
lets a post be part of multiple conversations at once.

### The UTXO Ledger (Value Layer)

Karma and credits live in **boxes** — think of them as sealed envelopes with a
value and a guard condition. To spend karma, you consume your existing karma box
and create new boxes (some going to you, some going to likes, some going to
invites).

The UTXO model means:
- Every karma movement has a cryptographic trail
- Boxes have owners and guards — only the owner's signature can spend them
- The set of unspent boxes IS the current state — no separate "balance" table
- Conservation: total value in = total value out (except mint and burn)

### How They Connect: Stumps

When you prune your content, the DAG subtree vanishes — but the karma people
earned from likes in that subtree still needs to be tracked. Enter **stumps**:
compact cryptographic proofs that a subtree existed and contributed specific
karma deltas.

A stump contains:
- The hash of the pruned root post (so parent refs still work)
- A merkle root over the pruned content (for nodes that held the full data)
- The net karma earned by each participant in that subtree
- The author's signature authorizing the prune

Stumps are the bridge. They let the DAG be prunable while the UTXO ledger stays
complete.

---

## Posting: Sub-blocks and Proof of Work

Every post requires a small amount of computational work. This isn't about
mining — it's about making spam expensive while keeping posting free.

### Single-pass PoW

1. **Request a challenge** — your node gives you a random nonce. You can only
   have one outstanding challenge at a time, preventing work precomputation.
2. **Solve the puzzle** — iterate a counter until the hash of your post meets a
   difficulty target. A typical laptop solves this in under a second.
3. **Submit the post** — your solved post IS a sub-block. It carries your content
   plus any pending likes you've queued.

### Sub-blocks and Ordering Blocks

The network uses a two-level block structure inspired by Ergo:

| | Sub-block | Ordering block |
|---|---|---|
| **Producer** | You (the poster) | Validator (PoW miner) |
| **Frequency** | Per post | Every ~60 seconds |
| **Contains** | One post + queued likes | Batch of sub-blocks + deduplicated likes + epoch processing |
| **PoW difficulty** | Low (post-level) | High (consensus-level) |

Your post gets included instantly as a sub-block. The next ordering block
confirms it, deduplicates any overlapping likes, and triggers epoch processing
if enough blocks have passed.

This means you don't wait for a miner to see your post — it's visible as soon
as you submit it. The ordering block just anchors it.

---

## Likes: Cost, Locking, and Refunds

Likes are the engine that distributes karma. The system is designed so liking
is cheap for active posts and rewards flow to good content.

### Two phases of likes

**Phase A — Locked likes (first 50 likes on a post):**

When you like a post that has fewer than 50 likes:
1. 2 karma is locked from your box — you can't spend it elsewhere
2. A "like box" is created in the UTXO set, holding your 2 karma
3. The like sits pending until the next epoch boundary
4. At the epoch, the system tallies the post's total likes and decides your refund

**Phase B — Free likes (51st like onward):**

Once a post has accumulated 50 likes:
- Liking costs nothing — no karma locked
- You just need to have any karma at all (> 0) to prove you're a real account
- Free likes still count toward the author's reward

The threshold between phases is `LIKE_FREE_THRESHOLD × LIKE_THRESHOLD` =
10 × 5 = 50 likes. This means most posts stay in Phase A, and the posts that
organically blow up become free to like.

### Refund schedule

At each epoch (every 60 ordering blocks, roughly every hour), the system
processes all pending likes:

| Total likes on the post | Your 2 karma | Why |
|---|---|---|
| **Less than 10** | Stays locked, rolls to next epoch | Post hasn't proven it's real content yet |
| **10 or more** | Full refund — 2 karma returned to you | The post has traction; your judgment was sound |

**Locked karma is never burned.** If a post sits at 7 likes forever, your 2
karma stays locked forever — but it's never destroyed. This is deliberate:
burning karma would punish people for liking posts that didn't take off, which
would make everyone conservative about liking. The lock is enough skin in the
game.

### Author reward

The post author earns karma based on total likes:

```
reward = min(floor(totalLikes / 5), 10)
```

| Likes | Author earns |
|---|---|
| 1–4 | 0 karma |
| 5–9 | 1 karma |
| 10–14 | 2 karma |
| ... | ... |
| 45–49 | 9 karma |
| 50+ | 10 karma (max) |

Author rewards are minted — they increase the total karma supply. Combined with
invite bond burning (which destroys karma), the net supply trends with network
health.

### One like per account per post

You can only like a post once. No double-tapping. Likes are tracked in the UTXO
layer, not the content DAG — they're economic actions, not content signals.

---

## The Invite System

The network is invite-only. Every new account needs someone to vouch for them
with real karma at stake.

### How an invite works

Alice wants to invite Bob:

1. **Alice creates an invite:** She splits off some karma from her box (minimum:
   the posting minimum, enough for Bob to start participating) plus a **bond**
   (additional karma she puts at risk).

2. **Alice generates a secret** and gives it to Bob out of band (QR code, message,
   whatever). The secret is hashed — only the hash goes on-chain.

3. **Bob generates a keypair** and claims the invite by revealing the secret and
   his public key. His first karma box is created. He now exists on the network.

4. **The bond sits in escrow** during Bob's probation period. Three possible outcomes:

| Outcome | What happens to the bond | What it means |
|---|---|---|
| Bob reaches the karma threshold within probation | Returned to Alice | Alice vouched for a contributing member |
| Bob's karma drops below the posting minimum during probation | **Burned** — destroyed permanently | Alice vouched for a bad actor. This is the penalty for inviting spammers or trolls. |
| Probation expires, Bob is fine but hasn't hit the threshold | Returned to Alice | Bob's a normal user, just hasn't gotten popular |

### Why bonds matter

The bond makes invites consequential. If Alice could invite infinite spammers
with no cost, the network would drown. The bond means Alice puts her own karma
on the line — if she invites someone who gets downvoted into oblivion (karma <
posting minimum), she loses that karma permanently.

Burned karma is deflationary — it reduces the total karma supply. This
counterbalances the inflation from author rewards.

### Invite cancellation

If Bob never claims the invite, Alice can cancel it and get her karma back
(both the invite amount and the bond). The invite is a bearer instrument —
anyone holding the secret can claim it. Bob could even pass the secret to Carol
if he decides not to join.

---

## Putting It All Together: A Day on DAGsocial

**Morning:** You post a thought. Your laptop solves a quick PoW puzzle (under a
second). The post appears immediately as a sub-block.

**Throughout the day:** People see your post and like it. Each like locks 2 of
their karma. Once you hit 10 total likes, the early likers get their 2 karma
back. Once you hit 50 likes, further likes are free. You earn 1 karma for every
5 likes, up to 10 max.

**Evening:** You decide to invite a friend. You create an invite, splitting off
25 karma (minimum for posting) + 10 karma as a bond. You send them the secret
code. They generate a keypair, claim the invite, and post their first message.
Your bond sits in escrow — if they turn out to be a valuable community member,
you get it back. If they spam and get downvoted, you lose it.

**A week later:** You decide to prune an old thread. The content vanishes from the
DAG, replaced by a stump. The karma people earned from likes in that thread
survives — the stump's karma deltas are committed to the UTXO ledger. Nothing is
lost but the content itself.

---

## The Big Picture

| Concept | How it works | Karma's role |
|---|---|---|
| **Posting** | Single-pass PoW → sub-block → ordering block confirms | Future: higher karma = easier PoW |
| **Liking** | Lock 2 karma → epoch tally → refund or lock continues | Skin in the game; refunds reward good judgment |
| **Earning** | Author gets 1 karma per 5 likes, max 10 per post | Incentivizes quality content |
| **Inviting** | Split karma + post bond → invitee claims → bond resolves | Bond puts inviter's karma at stake |
| **Pruning** | Author deletes subtree → stump with karma deltas | Karma earned in pruned content is preserved |
| **Decay** | Dormant boxes lose karma over time, down to a floor | Incentivizes ongoing participation |
| **Burning** | Bad invite bonds destroyed permanently | Deflationary counterbalance to author rewards |

Karma isn't a token you trade. It's a reputation signal with teeth — you earn
it by contributing, you risk it by vouching for others, and you can lose it
through inactivity. The system is closed: karma only moves through defined
protocol actions, not through markets.

---

## Current Status (July 2026)

Phase 2 is implemented and tested: 262 tests, 0 failures. The node runs as a
local HTTP server on port 3000 with a demo UI for testing all features.

**What's next:** libp2p networking (`@dagsocial/net`), a proper React client
(`@dagsocial/web`), reply earning (upstream karma flow), genesis committee
bootstrapping, and credit sinks (ads, boosts, tips).
