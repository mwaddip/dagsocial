# DAGsocial

Decentralized social network — no tokens to buy, no ads, no corporate servers.
Content lives in a prunable DAG controlled by authors. Karma and credits live in
a Bitcoin-style UTXO ledger secured by Ed25519 signatures. Phase 2: local HTTP
node with identity, PoW posting, DAG storage, UTXO engine, AVL+ state root,
verifiable prune consensus, libp2p networking, and a demo UI.

**905 tests pass** across 5 packages. Node.js ≥ 22, TypeScript, pnpm. MIT licensed.

---

## Quick Start

### Build

```bash
pnpm install
pnpm build
pnpm typecheck
```

### Single node (local dev)

```bash
NETWORK_MODE=testnet NODE_ROLE=miner node packages/node/dist/index.js
```

This starts a miner node on `http://localhost:3000` with the demo UI at the
same address. It produces ordering blocks every 60 seconds and mines PoW
in-process.

### Devnet (split mining)

For running a node on a VPS without PoW (ToS compliance, etc.), DAGsocial
supports external mining. The node builds block templates and exposes them
over HTTP; a separate miner script solves PoW and submits.

**VPS node:**

```bash
NODE_ROLE=miner MINING_MODE=external MINING_SECRET=<secret> node packages/node/dist/index.js
```

**Laptop miner:**

```bash
NODE_URL=https://your-node.example.com/testnet/api MINER_PCT=25 MINING_SECRET=<secret> node packages/node/scripts/miner.mjs
```

`MINER_PCT` controls CPU usage (0–100, default 25). The miner ships as a
single zero-dependency script — no repo or `pnpm install` needed, just Node.js ≥ 22.

A reference systemd unit is at `packages/node/scripts/dagsocial-miner.service`.

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
| `MINING_MODE` | `internal` | `internal` or `external` (node builds templates, miner solves PoW remotely) |
| `MINING_SECRET` | (empty) | Bearer token for mining API auth (empty = no auth) |
| `ORDERING_BLOCK_POW_TARGET_BITS` | 12 | Ordering block PoW difficulty |
| `EPOCH_BLOCKS` | 60 | Blocks per epoch (like processing + difficulty adjustment) |

---

## API

All endpoints are JSON. POST/PUT bodies are JSON. Auth is Bearer token only
on `/mining/*` when `MINING_SECRET` is set.

### Node status

| Method | Path | Description |
|---|---|---|
| GET | `/status` | Node status (block height, post count, karma, credits) |
| GET | `/health` | Admin health check (port 3001) |

### Identity

| Method | Path | Description |
|---|---|---|
| GET | `/karma/:id` | Karma balance for an identity |
| GET | `/credits/:id` | Credit boxes for an identity |
| GET | `/invites/:id` | Invite state for an identity |

### Posts

| Method | Path | Description |
|---|---|---|
| GET | `/posts?limit=50` | Recent posts |
| GET | `/posts/:id` | Single post by ID |
| POST | `/posts` | Create a post (requires PoW challenge first) |
| DELETE | `/posts/:id` | Delete a post |
| POST | `/posts/:id/prune` | Prune a subtree (author only) |

### Challenges

| Method | Path | Description |
|---|---|---|
| GET | `/challenge` | Get a PoW challenge for posting |

### Likes

| Method | Path | Description |
|---|---|---|
| POST | `/likes` | Like a post |
| DELETE | `/likes/remove` | Unlike a post |

### Invites

| Method | Path | Description |
|---|---|---|
| POST | `/invites` | Create an invite |
| POST | `/invites/:id/claim` | Claim an invite |
| POST | `/invites/:id/cancel` | Cancel an unclaimed invite |

### Credits (testnet)

| Method | Path | Description |
|---|---|---|
| POST | `/credits/send` | Transfer credits between identities |
| POST | `/credits/faucet` | Testnet credit faucet |

### Karma faucet (testnet)

| Method | Path | Description |
|---|---|---|
| POST | `/faucet` | Testnet karma faucet |

### Mining (auth required)

| Method | Path | Description |
|---|---|---|
| GET | `/mining/template` | Current block template (PoW preimage, target bits, header) |
| POST | `/mining/submit` | Submit `{ powNonce, height }` — returns block hash on success |

### Vouches

| Method | Path | Description |
|---|---|---|
| GET | `/vouches` | Query vouches (`?target=` or `?voucher=` or `?cooldowns`) |
| POST | `/vouches` | Cast a vouch for another identity |
| DELETE | `/vouches/:targetId` | Initiate unvouch (cooldown starts) |

### AVL proofs

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/proof/:boxId?atHeight=N` | AVL+ proof for a UTXO box |

---

## Demo UI

Open `http://localhost:3000` (or the bootstrap node's port in a cluster).
When behind nginx with path isolation, the UI is at `/testnet/` and the
API at `/testnet/api/`. The UI is a single HTML page with vanilla JS — no
build step.

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
        @dagsocial/wire (frame codec)
                  │
             @dagsocial/net (libp2p + Gossipsub + headers sync)
                  │
          ┌───────┴───────┐
          │               │
    @dagsocial/node  (future: @dagsocial/web)
```

**Five packages:**
- **`@dagsocial/types`** — data structures, base58, CBOR encoding, protocol
  constants, UTXO selection. Pure functions only.
- **`@dagsocial/validation`** — pure stateless checks (PoW verification,
  block validation, Merkle root verification).
- **`@dagsocial/wire`** — stream framing (VLQ, blake2b checksums, CBOR),
  message codec, magic-byte discrimination. Shared by net and node.
- **`@dagsocial/net`** — libp2p networking with Gossipsub (sub-blocks,
  ordering blocks, UTXO transactions) and a headers-sync protocol for fork
  resolution.
- **`@dagsocial/node`** — Express server, PoW challenges, UTXO engine,
  SQLite store, AVL+ state root prover, block creator, coinbase emission,
  karma decay, demo UI.

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

#### Stumps and Verifiable Pruning

When you prune your content, the DAG subtree vanishes but the karma earned from
likes in that subtree must be refunded. Pruning is consensus-critical — every
node must agree on who gets what karma back, even nodes that never had the
original content.

A **PruneEntry** in the ordering block carries everything needed for independent
verification: the list of pruned post IDs committed by a Merkle root, and an
Ed25519 signature from the root author over `blake2b512(rootPostHash,
subtreeMerkleRoot)`. At block application, every node:

1. Verifies the author's signature
2. Checks the post ID set matches the reply tree via `block_topology`
3. Verifies the Merkle root over the post IDs
4. Deterministically settles UTXO state — consuming PostLockBoxes and LikeBoxes,
   minting refund karma to authors and likers

No DAG content is required. A node syncing UTXO-only verifies prune settlements
identically to a full node. The DAG-side **Stump** becomes a lightweight
historical record for gossip purposes — the block is the settlement authority.

See [docs/CONSENSUS.md](docs/CONSENSUS.md) for the full consensus model.

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
pnpm build          # Build all 5 packages
pnpm test           # Run all 905 tests
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

| Document | Type | Status |
|---|---|---|
| `contracts/ARCHITECTURE.md` | System architecture & invariants | Current (2026-07-29) |
| `contracts/TYPES_INTERFACE.md` | Types package contract | Current (2026-07-29) |
| `contracts/VALIDATION_INTERFACE.md` | Validation package contract | Current |
| `contracts/NODE_INTERFACE.md` | Node package contract | Current (2026-07-29) |
| `contracts/MEMPOOL_INTERFACE.md` | Mempool contract | Current (2026-07-29) |
| `contracts/MINING_INTERFACE.md` | Mining contract | Current |
| `contracts/NET_INTERFACE.md` | Networking contract | Current |
| `contracts/SUBBLOCK_INTERFACE.md` | Sub-block contract | Current |
| `contracts/WIRE_INTERFACE.md` | Wire framing contract | Current |
| `contracts/JOURNAL_EVENTS.md` | Journal events contract | Current |
| `contracts/WEB_INTERFACE.md` | Web client contract | Future (Phase 3) |
| `docs/CONSENSUS.md` | Consensus model | Current (2026-07-29) |
