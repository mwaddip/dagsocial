# DAGsocial

Decentralized social network — no tokens to buy, no ads, no corporate servers.
Content lives in a prunable DAG controlled by authors. Karma and credits live in
a Bitcoin-style UTXO ledger secured by Ed25519 signatures. Phase 2: local HTTP
node with identity, PoW posting, DAG storage, UTXO engine, libp2p networking,
and a demo UI.

**483 tests pass** across 4 packages. Node.js ≥ 22, TypeScript, pnpm.

---

## Quick Start

### Build

```bash
pnpm install
pnpm build
pnpm typecheck
```

### Single node (testnet, miner)

```bash
NETWORK_MODE=testnet NODE_ROLE=miner node packages/node/dist/index.js
```

This starts a miner node on `http://localhost:3000` with the demo UI at the
same address. It produces ordering blocks every 60 seconds.

### Multi-node cluster

The cluster script starts N miner nodes with sequential ports, fresh databases,
and automatic peer discovery via a bootstrap node:

```bash
# 3 nodes, fresh DBs, 60s block interval
./scripts/cluster.sh

# 5 nodes, 30s blocks
./scripts/cluster.sh 5 --interval-ms 30000

# 4 nodes, keep DBs between runs
./scripts/cluster.sh 4 --persist

# Custom port ranges
./scripts/cluster.sh 3 --base-http 4000 --base-p2p 5000
```

Node 1 is the bootstrap seed. Others dial it and join the gossip mesh. Logs go
to `/tmp/dagsocial-cluster/node-*.log`.

```bash
# Stop all nodes
kill $(cat /tmp/dagsocial-cluster/pids)
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | 3000 | HTTP API port |
| `DB_PATH` | `dagsocial.db` | SQLite database path |
| `NETWORK_MODE` | `testnet` | `testnet` or `mainnet` |
| `NODE_ROLE` | `server` | `server` or `miner` |
| `ORDERING_BLOCK_INTERVAL_MS` | 60000 | Block creation cooldown (ms) |
| `BOOTSTRAP_PEERS` | (empty) | Comma-separated libp2p multiaddrs |
| `LISTEN_ADDRS` | `/ip4/0.0.0.0/tcp/0` | libp2p listen address |
| `POST_POW_TARGET_BITS` | 20 | Post PoW difficulty |
| `CHALLENGE_WINDOW_BLOCKS` | 10 | Challenge expiry blocks |
| `CREDIT_INITIAL_REWARD` | 100 | Credits per block |
| `CREDIT_TREASURY_PCT` | 10 | Percent of reward to treasury |
| `KARMA_STALE_THRESHOLD_BLOCKS` | 20160 | Blocks before decay starts |
| `KARMA_DECAY_INTERVAL_BLOCKS` | 720 | Blocks between decay burns |
| `KARMA_DECAY_AMOUNT` | 5 | Karma burned per interval |
| `KARMA_MINIMUM` | 10 | Decay floor |

---

## Demo UI

Open `http://localhost:3000` (or the bootstrap node's port in a cluster).
The UI is a single HTML page with vanilla JS — no build step.

**Getting started:**

1. **Create an identity** — click "+ New" to generate an Ed25519 keypair
2. **Get karma** — in testnet mode, use the Karma Faucet (Admin section)
3. **Get credits** — in testnet mode, use the Credit Faucet (Admin section)
4. **Post** — write a message. The browser solves PoW in under a second and
   submits it to the mempool
5. **Like posts** — costs 2 karma locked per like. Refunded at epoch if the
   post has 10+ likes
6. **Send credits** — transfer credits between identities via the Credit
   Transfer form (Admin section, testnet only)
7. **Invite** — create an invite (25 karma + 25 bond), share the secret,
   have the invitee redeem it with the Invite Box ID + Bond Box ID + secret

The admin section (faucets, invites, credit transfer) is only visible in
testnet mode.

---

## Architecture

```
@dagsocial/types          @dagsocial/validation
       │                         │
       └──────────┬──────────────┘
                  │
             @dagsocial/net (libp2p + Gossipsub + headers sync)
                  │
          ┌───────┴───────┐
          │               │
    @dagsocial/node  (future: @dagsocial/web)
```

**Four packages:**
- **`@dagsocial/types`** — data structures, base58, CBOR encoding, protocol
  constants, UTXO selection. Pure functions only.
- **`@dagsocial/validation`** — pure stateless checks (PoW verification,
  block validation, Merkle root verification).
- **`@dagsocial/net`** — libp2p networking with Gossipsub (sub-blocks,
  ordering blocks, UTXO transactions) and a headers-sync protocol for fork
  resolution.
- **`@dagsocial/node`** — Express server, PoW challenges, UTXO engine,
  SQLite store, block creator, coinbase emission, karma decay, demo UI.

---

## How It Works

DAGsocial splits decentralized social networking into two layers, each doing
what it's good at:

| | Posts DAG | UTXO Ledger |
|---|---|---|
| **What it tracks** | Content, replies, who said what | Karma, credits, who has how much |
| **Who controls it** | Each author controls their own subtree | Box owners control their boxes via signatures |
| **Can it be deleted?** | Yes — authors can prune their content | No — box history is immutable |
| **What it's good at** | Threaded conversation, author sovereignty | Value accounting with cryptographic lineage |

Content and value have different requirements. A threaded reply chain shouldn't
be an immutable ledger entry, and your karma balance shouldn't vanish when
someone deletes a post.

### Karma

Karma is non-tradeable social currency. It only moves through specific
protocol-enforced actions:

| Action | Karma effect |
|---|---|
| **Like a post** | 2 karma locked while the like is pending (refunded at epoch if the post reaches 10+ likes) |
| **Create an invite** | 25 karma transferred + 25 karma posted as bond for a new member |
| **Earn from likes** | Author earns 1 karma per 5 likes, max 10 per post |
| **Just hold it** | Karma above a floor gives you social weight |

You **cannot** buy, sell, or transfer karma. The only way karma moves between
accounts is through invites or like rewards. If karma were tradeable, a rich
account could buy reputation. By restricting movement to protocol actions, karma
reflects actual social contribution.

#### Multi-box UTXO

Karma and credits use a Bitcoin-style multi-UTXO model. An identity can hold
multiple karma boxes (e.g., from earning rewards, receiving invite karma, or
getting like refunds). When you spend karma, the protocol selects the fewest
largest boxes needed to cover the amount (largest-first selection) and produces
change back to you. All boxes are consolidated during mint operations.

#### Karma decay

Karma decays through a periodic burn mechanism. If your account is dormant for
more than the stale threshold (28 days / 20,160 blocks), the system burns 5
karma every 24 hours (720 blocks) until you hit the floor of 10 karma or start
participating again. Every protocol action that touches your karma box resets
the clock. Active accounts never feel decay. Ghost accounts eventually bleed
down to the floor.

The decay parameters are overridable via environment variables for testing.

### Credits

Credits are a **transferrable** currency, separate from karma. Miners earn
credits through coinbase emission: 100 credits per block with Ergo-style linear
decay (fixed rate for ~2 years, then decreasing by 2 every ~90 days, tailing at
2 credits/block). The reward is split 90/10 between miner and an optional
treasury.

Unlike karma, credits can be freely transferred between identities
(Bitcoin-style UTXO selection, Ed25519 signatures). A testnet-only credit faucet
provides 1000 credits per call for development and testing.

### Posts DAG

Every post is the root of its own subtree. When someone replies, that reply
lives under your subtree. You control everything under your root:

- **You can prune your entire subtree** — the root post and every reply under
  it, regardless of who wrote the replies. This is the privacy model.
- **Replying is consent** — when you reply to someone's post, you accept that
  they can prune the whole tree later.

Posts link via `parentRefs` — a post can reference up to 8 parents, creating a
DAG rather than a strict tree. Content is 1–300 UTF-8 bytes.

#### Stumps

When you prune your content, the DAG subtree vanishes but the karma earned from
likes in that subtree survives. A **stump** is a compact cryptographic proof
containing the pruned root's hash, a Merkle root over the pruned content, the
net karma earned by each participant, and the author's signature. Stumps bridge
the prunable DAG to the immutable UTXO ledger.

### Posting: Sub-blocks and PoW

Every post requires a small Proof of Work. This isn't about mining — it's about
making spam expensive while keeping posting free.

1. **Request a challenge** — your node gives you a random nonce (one
   outstanding challenge at a time)
2. **Solve the puzzle** — iterate a counter until the hash meets a difficulty
   target. A typical laptop solves this in under a second.
3. **Submit** — your solved post IS a sub-block, carrying your content plus any
   queued likes

The network uses two-level blocks:

| | Sub-block | Ordering block |
|---|---|---|
| **Producer** | You (the poster) | Miner (PoW) |
| **Frequency** | Per post | ~60 seconds |
| **Contains** | One post + queued likes | Batch of sub-blocks + deduplicated likes + epoch processing |

Your post is visible as soon as you submit it. The ordering block anchors it.

### Likes

Likes distribute karma. The system is designed so liking is cheap for popular
posts and rewards flow to good content.

**Locked likes (first 50 likes on a post):** 2 karma locked from your box.
At the next epoch (every 60 blocks), the system tallies the post's total likes:

| Total likes | Your 2 karma |
|---|---|
| < 10 | Stays locked, rolls to next epoch |
| ≥ 10 | Full refund — 2 karma returned |

**Free likes (51st like onward):** Once a post has 50 likes, further likes cost
nothing. You just need > 0 karma to prove you're a real account.

**Author reward:** `min(floor(totalLikes / 5), 10)` karma minted to the author.
Rewards increase the total karma supply; invite bond burning is the deflationary
counterbalance.

### Invites

The network is invite-only. Every new account needs someone to vouch for them
with real karma at stake.

1. **Alice creates an invite:** 25 karma for the invitee + 25 karma bond (total
   50 karma from Alice's box)
2. **Alice generates a secret** — the hash goes on-chain, she sends the secret
   to Bob out of band
3. **Bob generates a keypair** and claims the invite by revealing the secret
4. **The bond sits in escrow** during probation:

| Outcome | Bond |
|---|---|
| Bob reaches the karma threshold (20) within probation | Returned to Alice |
| Bob falls below the posting minimum during probation | **Burned** |
| Probation expires, Bob's fine but below threshold | Returned to Alice |

Burned bonds reduce the total karma supply, counterbalancing author rewards.
Alice can cancel an unclaimed invite and get her karma back.

### Networking

The `@dagsocial/net` package provides libp2p-based peer-to-peer networking:

- **Gossipsub** for sub-blocks, ordering blocks, and UTXO transactions
- **Headers sync protocol** for fork resolution — nodes request block headers
  from peers, find the fork point, and reorg to the heaviest chain
- **Bootstrap peers** for initial discovery — nodes dial configured bootstrap
  addresses and join the gossip mesh

Fork resolution is cumulative-work-based: the chain with more total PoW wins.

### UTXO Engine

The UTXO engine validates every box transition:

- **Guard checks** — owner signatures for karma/credit boxes, hash preimages
  for invites, epoch tally for likes and post locks
- **Value conservation** — credit and invite transfers require strict
  face-value equality; karma allows mint (rewards) and burn (decay, bonds)
- **Legal transitions** — karma can produce karma + post_lock + like boxes;
  credits can only produce credits; invites can only be claimed by revealing
  the preimage

---

## Development

```bash
pnpm build          # Build all 4 packages
pnpm test           # Run all 483 tests
pnpm typecheck      # Type-check all packages
```

```bash
# Watch mode during development
pnpm --filter @dagsocial/types build --watch
pnpm --filter @dagsocial/node vitest
```

### Contracts

Design-by-contract workflow. The `contracts/` directory is the source of truth
for interfaces. Contracts are updated before implementation code.

| Contract | Status |
|---|---|
| `ARCHITECTURE.md` | Current |
| `TYPES_INTERFACE.md` | Current |
| `VALIDATION_INTERFACE.md` | Current |
| `NODE_INTERFACE.md` | Current |
| `MEMPOOL_INTERFACE.md` | Current |
| `MINING_INTERFACE.md` | Current |
| `NET_INTERFACE.md` | Current |
| `WEB_INTERFACE.md` | Future (Phase 3) |
