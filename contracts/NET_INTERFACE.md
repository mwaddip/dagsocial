# NET Interface Contract

**Component:** `@dagsocial/net`
**Protocol version:** 2
**Last updated:** 2026-07-23

## Scope

libp2p-based peer-to-peer networking for DAGsocial. Owns: peer discovery,
sub-block gossip, ordering block gossip, UTXO transaction relay, and
DAG synchronization. Depends on `@dagsocial/validation` for Stage 1
(stateless) validation and `@dagsocial/types` for wire types.

Phase 2 scope is deliberately minimal: get sub-blocks and ordering blocks
flowing between nodes. Advanced features (DAG sync, peer scoring, validator
peering) are deferred.

---

## Gossip Topics

| Topic | Payload | Priority | Description |
|-------|---------|----------|-------------|
| `/dagsocial/subblock/1` | SubBlock (CBOR) | High | User posts + sidecar likes |
| `/dagsocial/ordering-block/1` | OrderingBlock (CBOR) | Critical | Consensus anchors |
| `/dagsocial/tx/1` | UtxoTransaction (CBOR) | High | Invites, claims, cancellations, credit transfers |

All topics carry CBOR-encoded messages. The topic version (`/1`) matches the
protocol version for topic naming but is independent — if the wire format
changes incompatibly, the topic version increments.

---

## Peer Discovery

### Bootstrap

A new node connects to one or more bootstrap peers (configured multiaddrs).
From there it discovers additional peers via:

1. **libp2p identify** — learn peer's supported protocols
2. **libp2p ping** — liveness checks
3. **Gossipsub mesh** — topic subscription builds the peer mesh organically

No DHT-based peer discovery in Phase 2. Bootstrap list is configured via
environment variable or config file.

### Bootstrap configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BOOTSTRAP_PEERS` | `[]` | Comma-separated multiaddrs |
| `LISTEN_ADDRS` | `/ip4/0.0.0.0/tcp/0` | libp2p listen addresses |
| `MAX_PEERS` | `50` | Max connected peers |

---

## Message Flows

### Sub-block propagation

```
┌─────────┐                     ┌─────────┐
│ Node A  │                     │ Node B  │
│ (origin)│                     │ (peer)  │
└────┬────┘                     └────┬────┘
     │                               │
     │ POST /posts → sub-block       │
     │ stored locally                │
     │                               │
     │─── gossip(subblock) ─────────►│
     │                               │
     │                     verify post (challenge? no — challenge was
     │                     local to A; B verifies PoW against target,
     │                     signature, parent refs, karma)
     │                               │
     │                     if valid: store sub-block, forward to mesh
     │                     if invalid: ignore, optionally score-down peer
```

**Key design point:** The PoW challenge is node-local — peer B only verifies
that the post's PoW meets the target difficulty, not that the challenge was
issued by a specific node. This keeps sub-block propagation stateless at
the network layer.

### Ordering block propagation

```
┌─────────┐                     ┌─────────┐
│ Node A  │                     │ Node B  │
│(miner)  │                     │ (peer)  │
└────┬────┘                     └────┬────┘
     │                               │
     │ ordering block created        │
     │ signed with validator key     │
     │                               │
     │─── gossip(ordering-block) ───►│
     │                               │
     │                     verify: PoW meets target, signature
     │                     valid, prevBlockHash matches, all
     │                     sub-blocks known (or request missing),
     │                     epoch tally correct, UTXO txs valid
     │                               │
     │                     if valid + extends known chain: apply
     │                     if valid + extends alternate chain:
     │                        compare cumulative work, switch if heavier
     │                     if invalid: ignore
```

### UTXO transaction relay

```
┌─────────┐                     ┌─────────┐
│ Node A  │                     │ Node B  │
│(origin) │                     │ (peer)  │
└────┬────┘                     └────┬────┘
     │                               │
     │ UTXO tx created (invite,      │
     │ claim, cancel, transfer)      │
     │ stored in local mempool       │
     │                               │
     │─── gossip(tx) ───────────────►│
     │                               │
     │                     verify: inputs unspent (from local
     │                     UTXO view), guards satisfied, value
     │                     conserved, box transitions legal
     │                               │
     │                     if valid: add to local mempool
     │                     if invalid: ignore
```

UTXO transactions in the mempool are picked up by the next ordering block
creator (whether local or remote). A transaction seen in an ordering block
is removed from the mempool.

---

## DAG Synchronization (deferred)

Phase 2 does not include full DAG sync. Sub-blocks propagate in real time
via gossip. A node that misses sub-blocks can request them from peers by
sub-block ID. Full catch-up (walking the DAG from genesis) is deferred to
a future protocol version.

### Missing sub-block request (Phase 2)

| Request | Response |
|---------|----------|
| `GET /net/subblock/:id` (custom libp2p protocol) | SubBlock (CBOR) or not-found |

A node detecting a gap in a just-received ordering block (unknown sub-block
IDs) requests them from the peer that sent the ordering block. This is a
direct request-response, not gossip.

---

## Validation Architecture

Two-stage validation, modeled after Ergo's modifier processing:

### Stage 1 (net package, stateless)

Runs on inbound gossip messages before forwarding to mesh peers. Uses
`@dagsocial/validation`:

- CBOR structural validity
- Protocol version check
- Content limits (1–300 UTF-8 bytes)
- PoW verification (blake2b512 meets target difficulty)
- Signature verification (Ed25519)
- Sub-block, ordering block, and UTXO transaction structural checks

### Stage 2 (node package, stateful)

Runs after Stage 1 passes, via registered `on*` callbacks:

- Parent refs exist (live post or stump)
- Author has sufficient karma
- UTXO inputs unspent, guard scripts satisfied
- Challenge check skipped for relayed posts (challenge was local to origin node)

### Forwarding rule

Forward to mesh peers after Stage 1 passes. If Stage 2 fails later, penalize
the source peer. This keeps propagation fast while gatekeeping on structure
and PoW.

---

## Missing Sub-Block Sync

Custom libp2p protocol: `/dagsocial/sync/1`. Simple request-response over a
libp2p stream:

```
Request:  subBlockId (32 bytes, hex-encoded)
Response: CBOR-encoded SubBlock, or 0x00 (not found)
```

Triggered when a node receives an ordering block referencing unknown sub-block
IDs. Requested from the peer that sent the ordering block. Timeout: 10s.

---

## Peer Penalty System

| Penalty type | Trigger | Score |
|-------------|---------|-------|
| MisbehaviorPenalty | Invalid message (fails Stage 1) | 100 |
| SpamPenalty | Duplicate sub-block within window | 50 |
| NonDeliveryPenalty | Missing sub-block request timeout | 75 |
| PermanentPenalty | Wrong magic bytes, incompatible version | 500 (instant ban) |

Accumulated score ≥ threshold → temporal ban for `temporalBanDuration`.
Safe interval cooldown between penalties for the same peer.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `PENALTY_SCORE_THRESHOLD` | `500` | Score to trigger ban |
| `TEMPORAL_BAN_DURATION_MS` | `3600000` | Ban duration (60 min) |
| `PENALTY_SAFE_INTERVAL_MS` | `120000` | Cooldown between penalties (2 min) |

---

## libp2p Stack

| Layer | Choice |
|-------|--------|
| Transport | TCP (with optional QUIC, deferred) |
| Stream multiplexing | yamux or mplex |
| Encryption | Noise (with libp2p-noise) |
| PubSub | Gossipsub 1.1 |
| Peer identity | libp2p peer ID (Ed25519 or secp256k1 keypair) |

The libp2p peer identity is separate from DAGsocial account identity. A
node operator may choose to link them (same keypair) or keep them separate.

---

## API

### Node Lifecycle

| Function | Signature | Description |
|----------|-----------|-------------|
| `start(config)` | `(NetConfig) => Promise<void>` | Create libp2p node, connect to bootstrap peers, subscribe to topics |
| `stop()` | `() => Promise<void>` | Graceful shutdown |
| `peerId()` | `() => string` | This node's libp2p peer ID |
| `peers()` | `() => Peer[]` | Connected peers with metadata |

### Gossip

| Function | Signature | Description |
|----------|-----------|-------------|
| `broadcastSubBlock(sb)` | `(SubBlock) => void` | Gossip a newly assembled sub-block |
| `broadcastOrderingBlock(b)` | `(OrderingBlock) => void` | Gossip a newly created ordering block |
| `broadcastTx(tx)` | `(UtxoTransaction) => void` | Gossip a UTXO transaction |

### Inbound Processing

| Function | Signature | Description |
|----------|-----------|-------------|
| `onSubBlock(callback)` | `((SubBlock) => void) => void` | Register handler for inbound sub-blocks |
| `onOrderingBlock(callback)` | `((OrderingBlock) => void) => void` | Register handler for inbound ordering blocks |
| `onTx(callback)` | `((UtxoTransaction) => void) => void` | Register handler for inbound UTXO transactions |

### Sync

| Function | Signature | Description |
|----------|-----------|-------------|
| `requestSubBlock(id, peerId)` | `(string, string) => Promise<SubBlock>` | Request a specific sub-block from a peer |

---

## Preconditions
- Node.js ≥ 22
- `@dagsocial/types`, `@dagsocial/validation`, and `@dagsocial/node` packages
  built and importable
- libp2p dependencies installed (`@libp2p/tcp`, `@chainsafe/libp2p-noise`,
  `@chainsafe/libp2p-yamux`, `@chainsafe/libp2p-gossipsub`, `@libp2p/identify`,
  `@libp2p/ping`)
- Bootstrap peer(s) reachable
- Port available for libp2p listen address

## Postconditions
- libp2p node running with configured transports and protocols
- Connected to bootstrap peers and meshed on all subscribed topics
- Sub-blocks received from peers are validated and forwarded to local node
  for storage
- Ordering blocks received from peers are validated and applied
- Locally-produced sub-blocks and ordering blocks are gossiped to peers

## Invariants
- Sub-block gossip is stateless — verification depends only on the post's
  PoW target, not on challenge provenance
- Ordering blocks are verified before application — a block extending an
  unknown chain may be buffered but never applied
- UTXO transactions are verified against the local UTXO view — conflicting
  transactions (double-spends) are rejected at gossip time
- Peer identity (libp2p) is independent of account identity (Ed25519 keypair)
- Topic names include protocol version — incompatible wire format changes
  get a new topic
- All wire messages are CBOR-encoded (same codec as local storage)
- Inbound messages are re-verified before forwarding and storing
