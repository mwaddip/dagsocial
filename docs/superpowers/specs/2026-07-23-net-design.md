# @dagsocial/net — Design Spec

**Date:** 2026-07-23
**Protocol version:** 2
**Status:** approved

## Overview

`@dagsocial/net` is the libp2p-based peer-to-peer networking layer for
DAGsocial. It handles peer discovery, sub-block gossip, ordering block gossip,
UTXO transaction relay, and missing sub-block retrieval.

Phase 2 scope: get sub-blocks, ordering blocks, and UTXO transactions flowing
between nodes. DAG synchronization (historical catch-up) is deferred.

## Package Architecture

```
@dagsocial/types          @dagsocial/validation
       │                         │
       └──────────┬──────────────┘
                  │
             @dagsocial/net
                  │
          ┌───────┴───────┐
          │               │
    @dagsocial/node  (future: @dagsocial/web)
```

### Dependency rules

- **`@dagsocial/validation`** (new) — depends only on `@dagsocial/types`. Pure
  functions, no I/O, no DB access.
- **`@dagsocial/net`** (new) — depends on `types`, `validation`. Does NOT
  depend on `node`.
- **`@dagsocial/node`** (existing, modified) — depends on `types`,
  `validation`, `net`.

Each package uses the existing build pattern: `tsup --format esm --dts`,
`vitest` for tests, `tsc --noEmit` for typechecking.

## Validation Architecture

Two-stage validation, modeled after Ergo's modifier processing:

### Stage 1 (net package, stateless)

Runs on inbound gossip messages before forwarding to mesh peers. Uses
`@dagsocial/validation` functions:

- Parse CBOR (structural validity)
- `verifyProtocolVersion` — reject unsupported versions
- `verifyContentLimits` — 1–300 UTF-8 bytes
- `verifyPoW` — blake2b512 meets target difficulty
- `verifyPostSignature` — Ed25519 signature valid against public key
- `verifySubBlockStructure` — post present, likeBoxes array valid
- `verifyTxStructure` — inputs/outputs non-empty, no duplicates, conservation
- `verifyOrderingBlockStructure` — prevBlockHash present, signature present
- `verifyBlockChainLink` — extends known chain

### Stage 2 (node package, stateful)

Runs after Stage 1 passes. Registered via `on*` callbacks:

- Parent refs exist (live post or stump)
- Author has sufficient karma (POST_LOCK_THREAD_COST / POST_LOCK_REPLY_COST)
- UTXO inputs unspent, guard scripts satisfied
- Challenge check skipped for relayed posts (challenge was local to origin node)

### Forwarding rule

Forward to mesh peers after Stage 1 passes. If Stage 2 fails later, penalize
the source peer. This keeps propagation fast (no DB wait on forward path)
while gatekeeping on structure and PoW.

## `@dagsocial/validation` — API

Pure functions, all synchronous:

```
verifyPoW(input: Uint8Array, nonce: number, targetBits: number): boolean
verifyPostSignature(post: Post, publicKey: Uint8Array): boolean
verifyProtocolVersion(version: number): boolean
verifyContentLimits(content: string): boolean
verifySubBlockStructure(sb: SubBlock): { valid: boolean; error?: string }
verifyTxStructure(tx: UtxoTransaction): { valid: boolean; error?: string }
verifyOrderingBlockStructure(block: OrderingBlock): { valid: boolean; error?: string }
verifyBlockChainLink(block: OrderingBlock, prevBlock: OrderingBlock): boolean
```

Imported by both `net` (Stage 1) and `node` (its own verification path).

## `@dagsocial/net` — Internal Architecture

Four modules:

```
src/
  node.ts          — NetNode: lifecycle, libp2p creation, topic subscription
  gossip.ts        — broadcast helpers, inbound message routing
  peer-mgr.ts      — bootstrap, peer tracking, penalty scoring
  sync.ts          — missing sub-block request protocol
```

### node.ts — NetNode

```typescript
class NetNode {
  constructor(config: NetConfig, validators: NetValidators)
  async start(): Promise<void>
  async stop(): Promise<void>
  peerId(): string
  peers(): Peer[]

  // Outbound
  broadcastSubBlock(sb: SubBlock): void
  broadcastOrderingBlock(block: OrderingBlock): void
  broadcastTx(tx: UtxoTransaction): void

  // Inbound handlers (registered by node)
  onSubBlock(cb: (sb: SubBlock) => void): void
  onOrderingBlock(cb: (block: OrderingBlock) => void): void
  onTx(cb: (tx: UtxoTransaction) => void): void

  // Sync
  requestSubBlock(id: string, peerId: string): Promise<SubBlock>
}
```

`NetValidators` is an interface passed at construction — the concrete
functions from `@dagsocial/validation`. This keeps net testable: tests can
pass mock validators.

### gossip.ts — Message Flow

**Inbound (on each Gossipsub topic):**
1. Receive bytes from peer
2. CBOR decode
3. Stage 1 validate via `@dagsocial/validation`
4. If valid: forward to mesh peers, fire registered `on*` callback (fire-and-forget — net does not await the callback)
5. If invalid: penalize source peer (MisbehaviorPenalty), drop

**Outbound (broadcast* calls):**
1. Accept typed object
2. CBOR encode
3. Publish to Gossipsub topic

### Topics

| Topic | Payload | Priority |
|-------|---------|----------|
| `/dagsocial/subblock/1` | SubBlock (CBOR) | High |
| `/dagsocial/ordering-block/1` | OrderingBlock (CBOR) | Critical |
| `/dagsocial/tx/1` | UtxoTransaction (CBOR) | High |

Topic version (`/1`) is independent of protocol version. If the wire format
changes incompatibly, the topic version increments.

### peer-mgr.ts — Peer Management

- **Bootstrap:** Connect to `BOOTSTRAP_PEERS` multiaddrs on start
- **Discovery:** Gossipsub mesh builds peer set organically (no DHT in Phase 2)
- **Tracking:** connected peers, supported protocols (identify), latency (ping)
- **Penalty scoring:**

| Penalty type | Trigger | Score |
|-------------|---------|-------|
| MisbehaviorPenalty | Invalid message (fails Stage 1) | 100 |
| SpamPenalty | Duplicate sub-block within window | 50 |
| NonDeliveryPenalty | Missing sub-block request timeout | 75 |
| PermanentPenalty | Wrong magic bytes, incompatible version | 500 (instant ban) |

- Accumulated score ≥ `penaltyScoreThreshold` → blacklist for `temporalBanDuration`
- `penaltySafeInterval` — cooldown between penalties for same peer
- Random peer eviction every `peerEvictionInterval` to avoid eclipse attacks

### sync.ts — Missing Sub-Block Request

Custom libp2p protocol: `/dagsocial/sync/1`.

Simple request-response over a libp2p stream:

```
Request:  subBlockId (32 bytes, hex-encoded)
Response: CBOR-encoded SubBlock, or 0x00 (not found)
```

Triggered when node receives an ordering block referencing unknown sub-block
IDs. The node requests missing sub-blocks from the peer that sent the ordering
block. Timeout: 10s. On timeout: NonDeliveryPenalty on peer, retry from
another peer.

## libp2p Stack

| Layer | Choice |
|-------|--------|
| Transport | TCP |
| Stream multiplexing | yamux |
| Encryption | Noise (`@chainsafe/libp2p-noise`) |
| PubSub | Gossipsub 1.1 (`@chainsafe/libp2p-gossipsub`) |
| Peer identity | libp2p peer ID (Ed25519 keypair, separate from DAGsocial account identity) |

## Integration with Node

### Startup order

```
1. initDb()
2. Create NetNode with config + validators
3. Register handlers:
     net.onSubBlock(handleSubBlock)
     net.onOrderingBlock(handleOrderingBlock)
     net.onTx(handleTx)
4. await net.start()        // connect to bootstrap, subscribe to topics
5. startHttpServer()        // begin accepting API requests
6. startBlockCreator()      // begin producing ordering blocks
```

Net starts before HTTP — the network layer is ready before the API accepts
requests. If bootstrap peers are unreachable, the node still starts (it just
won't receive gossip until connections establish).

### Handler wiring

```typescript
net.onSubBlock(async (sb) => {
  const result = verifier.verifyPostForRelay(sb.post, currentBlockHeight);
  if (!result.valid) return;
  store.insertPost(sb.post, rawCbor);
  store.insertSubBlock(sb);
  blockCreator.onSubBlockReceived();
  for (const lb of sb.likeBoxes) store.insertBox(lb);
});

net.onOrderingBlock(async (block) => {
  await blockProcessor.validateAndApply(block);
});

net.onTx(async (tx) => {
  await utxoEngine.validateAndApplyTx(tx, currentBlockHeight);
});
```

### Node changes

- `index.ts`: ~30 lines for net setup
- Route handlers: add `net.broadcastSubBlock(sb)` / `net.broadcastTx(tx)` /
  `net.broadcastOrderingBlock(block)` after local processing
- Verifier: new `verifyPostForRelay` — same as `verifyPost` but skips
  challenge check (challenge is node-local, not relevant for relayed posts)
- No API changes. Existing routes, existing response shapes. Net is transparent
  to API consumers.

### Verification difference: local vs relayed posts

| Check | Local post | Relayed post |
|-------|-----------|--------------|
| Challenge active | ✓ | skipped (node-local) |
| PoW meets target | ✓ | ✓ |
| Signature valid | ✓ | ✓ |
| Parent refs exist | ✓ | ✓ |
| Content limits | ✓ | ✓ |
| Protocol version | ✓ | ✓ |
| Karma sufficient | ✓ | ✓ |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BOOTSTRAP_PEERS` | `[]` | Comma-separated multiaddrs |
| `LISTEN_ADDRS` | `/ip4/0.0.0.0/tcp/0` | libp2p listen addresses |
| `MAX_PEERS` | `50` | Max connected peers |
| `PENALTY_SCORE_THRESHOLD` | `500` | Score to trigger ban |
| `TEMPORAL_BAN_DURATION_MS` | `3600000` | Ban duration (60 min) |
| `PENALTY_SAFE_INTERVAL_MS` | `120000` | Cooldown between penalties (2 min) |
| `PEER_EVICTION_INTERVAL_MS` | `3600000` | Random eviction interval (1 hr) |
| `SYNC_REQUEST_TIMEOUT_MS` | `10000` | Missing sub-block request timeout |

## Testing Strategy

Three layers:

1. **Unit tests (`@dagsocial/validation`):** Pure functions tested exhaustively
   against known inputs/outputs. No mocking needed.

2. **Unit tests (`@dagsocial/net`):** Mock libp2p transports and pubsub.
   Test:
   - Inbound message routing (valid → callback fires, invalid → penalty, spam → penalty)
   - Penalty score accumulation and banning
   - Sub-block request/response protocol
   - Peer tracking and eviction

3. **Integration tests:** Two real libp2p nodes on localhost, different ports.
   Test:
   - Bootstrap connection
   - Sub-block propagation (A posts → B receives via gossip)
   - Ordering block propagation
   - UTXO transaction relay
   - Missing sub-block request (B receives ordering block referencing unknown
     sub-block → requests from A → receives and processes)
   - Node startup with unreachable bootstrap (graceful degradation)

## What's NOT in scope

- DAG synchronization (historical catch-up)
- DHT-based peer discovery
- QUIC transport (TCP only in Phase 2)
- Credit transfer relay (credit transfers exist in the UTXO model but are
  deferred — credits aren't tradeable through the network yet)
- Validator peering / prioritization
- Karma-proportional PoW difficulty (net is difficulty-agnostic)

## Invariants

- Sub-block gossip is stateless — verification depends only on post fields,
  not on challenge provenance
- Ordering blocks verified before application — unknown chains buffered, never
  applied
- UTXO transactions verified against local UTXO view — conflicting transactions
  rejected at gossip time
- Peer identity (libp2p) is independent of account identity (Ed25519 keypair)
- Topic names include protocol version — incompatible wire format changes get
  a new topic
- All wire messages are CBOR-encoded
- Inbound messages re-verified (Stage 1) before forwarding
- Stage 2 validation happens after forwarding — penalties applied if Stage 2
  fails
- Secret keys never in wire messages or DTOs crossing the net/node boundary

## Contract Updates Required

`contracts/NET_INTERFACE.md` needs updates:
- Add `@dagsocial/validation` package to dependency list
- Document two-stage validation split
- Add penalty/peer management parameters
- Add sync protocol specification
- Update preconditions to include validation package
