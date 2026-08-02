# NET Interface Contract

**Component:** `@dagsocial/net`
**Protocol version:** 2
**Last updated:** 2026-08-01

## Scope

libp2p-based peer-to-peer networking for DAGsocial. Owns: wire framing,
handshake, header-first historical sync, peer discovery, sub-block gossip,
ordering block gossip, UTXO transaction relay, and peer penalty management.

Depends on `@dagsocial/wire` for ByteReader/ByteWriter/VLQ/frame encode-decode
stream framing, `@dagsocial/validation` for Stage 1 (stateless) validation,
and `@dagsocial/types` for wire types.

---

## Wire Framing

Every stream message is wrapped in a frame. Gossipsub messages are **not**
framed — they carry raw CBOR directly on the wire as before.

### Frame Format

```
[magic:4][version:1][code:VLQ][length:VLQ][checksum:4][body:length]
```

| Field | Size | Description |
|-------|------|-------------|
| magic | 4 bytes | Network identifier |
| version | 1 byte | Framing version. Independent of app `protocolVersion`. Starts at `1`. |
| code | VLQ | Message type identifier |
| length | VLQ | Body length in bytes (0 = empty body) |
| checksum | 4 bytes | First 4 bytes of `blake2b256(body)` |
| body | `length` bytes | CBOR-encoded payload |

### Magic Bytes

| Network | Magic | Bytes |
|---------|-------|-------|
| mainnet | "MDAG" | `0x4D 0x44 0x41 0x47` |
| testnet | "TDAG" | `0x54 0x44 0x41 0x47` |

### Version Negotiation

On receiving a frame with an unsupported version:
- **Major version higher**: close the stream. The peer is using a newer framing
  protocol. Not a penalty — the peer may support an older version on retry.
- **Minor version higher**: accept. Forward-compat — unknown fields in the body
  are ignored.

Version 1 is the baseline. A frame version bump means an incompatible change
to the envelope structure (not the message bodies).

### Design Decisions

- **Version byte before VLQ fields**: the framing layer can evolve independently
  (e.g., switch to fixed-width lengths or a different checksum).
- **Checksum after length**: parser knows the body size before verifying — can
  allocate once.
- **VLQ for code**: message type namespace effectively unlimited.
- **VLQ for length**: handshake (~100 bytes) encodes in 1 byte; block response
  (~100KB) encodes in 3 bytes.
- **Body is CBOR**: consistent with existing gossip encoding. No second
  serialization format.
- **Checksum via blake2b256**: matches the project's hash standard.

### Message Codes

| Code | Name | Direction | Description |
|------|------|-----------|-------------|
| 1 | `Handshake` | both | Exchange after libp2p identify |
| 2 | `SyncInfo` | both | Chain tip + recent header anchors |
| 3 | `Inv` | both | "I have these objects" — type + ID list |
| 4 | `ModifierRequest` | → | "Send me these objects" |
| 5 | `ModifierResponse` | ← | Serialized objects |
| 6 | `GetSubBlock` | → | Request sub-block by ID (specific) |
| 7 | `SubBlockResponse` | ← | Sub-block or not-found |
| 8 | `GetPeers` | → | Request peer list |
| 9 | `Peers` | ← | Peer list response |
| 10 | `GetPosts` | → | Request posts by ID |
| 11 | `Posts` | ← | Posts response |
| 12 | `GetStumps` | → | Request stumps by ID |
| 13 | `Stumps` | ← | Stumps response |

Codes 10–11 support content-sweep (placeholder fill) for posts the node
has headers for but not content. Codes 12–13 support missing-stump resolution.
Codes 6-7 replace the old ad-hoc `/dagsocial/sync/1` stream protocol.
Codes 2-5 replace the old `/dagsocial/headers/1` protocol. The old protocols
are deleted.

---

## Gossip Topics

Sub-block structure, lifecycle, and propagation semantics are defined in
`SUBBLOCK_INTERFACE.md`.

| Topic | Payload | Priority | Description |
|-------|---------|----------|-------------|
| `/dagsocial/subblock/1` | SubBlock (CBOR) | High | User posts + sidecar likes |
| `/dagsocial/ordering-block/1` | OrderingBlock (CBOR) | Critical | Consensus anchors |
| `/dagsocial/tx/1` | UtxoTransaction (CBOR) | High | Invites, claims, cancellations, credit transfers |
| `/dagsocial/stump/1` | Stump (CBOR) | Normal | Pruned subtree records |

All gossip topics carry CBOR-encoded messages directly — no framing.
The topic version (`/1`) matches the protocol version for topic naming but
is independent — if the wire format changes incompatibly, the topic version
increments.

---

## Handshake (code 1)

After libp2p identify completes, both sides open a stream on
`/dagsocial/handshake/1` and exchange a framed `Handshake` message:

```
outbound: connect → identify → open stream → send Handshake → receive Handshake → active
inbound:  accept → identify → receive stream → receive Handshake → send Handshake → active
```

### Handshake Body (CBOR)

```typescript
{
  agentName: string          // e.g. "dagsocial/1.0.0"
  protocolVersion: number    // app protocol version the node supports
  nodeName: string           // operator-configured, human-readable
  chainHeight: number        // tip height of this node's chain
  declaredAddress?: string   // optional multiaddr this node advertises
  capabilities: number[]     // message codes this node can handle
  sessionMagic: number       // random per-connection uint32
}
```

Session magic: each side generates a random `uint32`. The outbound side
sends its magic; the inbound side echoes it back. Both sides verify the
magic matches their own network's magic bytes in the frame. Anti-replay,
validates both sides agree on network.

### Validation (and untrusted-input safety)

Every decoded stream message — the handshake and all sync messages (`SyncInfo`, `Inv`,
`ModifierRequest`, `ModifierResponse`, …) — is **structurally validated before use**:
required fields present and correctly typed, arrays are arrays, and every height or
count is a `Number.isInteger` that is **non-negative and within a sane maximum**. A
malformed or out-of-bounds message is dropped and the peer penalized — it must **never
throw out of, or crash, the handler**, and the sync event loop isolates a per-message
failure so one bad message degrades that message only, never the loop.

**Resource limits (untrusted counts and sizes).** Inbound array lengths (`ids`, `anchors`,
`modifiers`) are capped at `MAX_INV_IDS` **on receipt** — the cap applies to what a peer
*sends us*, not only to what we send. Raw stream reads are bounded by `MAX_STREAM_BYTES`
(never buffer an unbounded attacker-controlled stream). Per-request serve work is bounded:
handling a request must not be `O(ids × chainHeight)` — an unbounded id list must not each
trigger a full-chain scan.

Handshake specifics:
- `protocolVersion` must be one this node supports
- `chainHeight` (and `SyncInfo.tipHeight`) must be a non-negative integer `<=
  MAX_ADVERTISED_HEIGHT` (= 100,000,000, ~190 years at 1 block/min) — they drive
  `servePeer`, so an unbounded or negative value must never reach the serve loop (it
  would otherwise scan ~10⁹ heights). The same bound applies to the legacy
  `/dagsocial/headers/1` request range, which is ungated (no handshake) and must clamp
  its serve loop to the local tip.
- `agentName` / `nodeName` are strings; `capabilities` is an array of numbers (unknown
  capabilities preserved, not rejected — forward compat)

**Ban policy** — distinguish adversarial input from a compatibility mismatch:
- Malformed / out-of-bounds input (missing or wrong-typed fields, negative or
  over-`MAX_ADVERTISED_HEIGHT` values) is adversarial → stream closed, peer **banned
  permanently**.
- `protocolVersion` unsupported is a compatibility mismatch, not an attack → stream closed
  with a **soft refusal; do not permanently ban** (a routine `PROTOCOL_VERSION` bump must not
  partition the network — the peer may upgrade). A short temporary cooldown at most.

### Post-Handshake Routing

| Condition | Action |
|-----------|--------|
| `theirHeight > ourHeight` | Initiate sync from that peer |
| `theirHeight < ourHeight` | Offer them headers (serve mode — send Inv) |
| `theirHeight == ourHeight` | Idle — only gossip flows |

---

## Historical Sync (Header-First)

Sync uses four framed messages multiplexed over `/dagsocial/sync/1`.
All messages are CBOR-encoded bodies wrapped in frames.

### SyncInfo (code 2)

```typescript
{
  tipHeight: number
  tipBlockId: string              // hex
  tipCumulativeWork: bigint       // total PoW accumulated (fork choice)
  anchors: { height: number, blockId: string }[]
}
```

Anchors at heights `[tipHeight, tipHeight - 16, tipHeight - 128, tipHeight - 512]`
(fewer if chain is shorter). They let the receiver find the best common point.

### Inv (code 3)

```typescript
{
  typeId: 101 | 102             // 101 = ordering block header, 102 = sub-block
  ids: string[]                  // hex IDs, max 400 per batch
}
```

### ModifierRequest (code 4)

```typescript
{
  typeId: 101 | 102
  ids: string[]
}
```

### ModifierResponse (code 5)

```typescript
{
  typeId: 101 | 102
  modifiers: { id: string, data: Uint8Array }[]
}
```

### Sync Flow

```
Late Node (height 0)                      Synced Peer (height 200)
     │                                            │
     │── Handshake ──────────────────────────────►│
     │◄── Handshake (height=200) ─────────────────│
     │                                            │
     │ peer ahead → pick as sync peer             │
     │── SyncInfo (height=0) ────────────────────►│
     │                                            │
     │ peer sees us behind → compute continuation │
     │◄── Inv (type=101, headers from h=1) ──────│
     │                                            │
     │── ModifierRequest (those ids) ────────────►│
     │◄── ModifierResponse (headers 1-200) ──────│
     │                                            │
     │ validate headers, build chain to h=200     │
     │── SyncInfo (height=200) ──────────────────►│
     │ peer sees equal → no Inv needed            │
     │                                            │
     │ sync complete → block body download        │
     │── ModifierRequest (type=102, missing       │
     │    sub-block ids from ordering blocks) ───►│
     │◄── ModifierResponse (sub-blocks) ─────────│
     │                                            │
     │ apply blocks to state, now at tip          │
```

### Serve Side (Peer Behind Us)

When receiving a SyncInfo showing the peer is behind or at genesis:
1. Compute continuation headers from their best known height + 1
2. Cap at 400 headers
3. Send Inv

An empty anchor list means a from-genesis peer — continuation starts at
height 1. This bidirectional pattern ensures nodes serve peers behind them,
not just consume.

### Sync State Machine

```
pick_sync_peer() → sync_from_peer() → synced()
       ↑                  │
       └── stall/disconnect ──┘
```

- **Pick:** handshake reveals peers ahead of us — pick the one with highest
  chain height
- **Sync:** send SyncInfo, process Inv → request headers, validate, append
  to chain, repeat
- **Stall:** 60s no progress → rotate to different peer, mark current as
  stalled. On progress, clear stall set.
- **Peer rotation:** `stalledPeers: Set<PeerId>` — peers that failed to
  produce progress. On stall, pick next outbound peer not in set. If all
  stalled, clear set and retry.
- **Synced:** periodic SyncInfo (30s) to detect new blocks. React to Inv
  from any peer.

### Watermarks

Three watermarks tracked:

| Watermark | Meaning |
|-----------|---------|
| `downloadedHeight` | Highest height with all headers stored |
| `stateAppliedHeight` | Highest height where ordering blocks applied to UTXO state |
| `chainHeight` | Best chain tip height |

During header sync, advance `downloadedHeight`. Once caught up, request
sub-blocks for ordering blocks referencing unknown sub-block IDs, advancing
`stateAppliedHeight`.

Invariant: `stateAppliedHeight <= downloadedHeight <= chainHeight`.

### Cross-DB Durability

Flush ordering on sync checkpoint:

1. `validator.flush()` — state DB fsync (`Durability::Immediate`)
2. `store.setValidatedHeight(height)` — modifiers DB chain_meta write
3. `store.flush()` — modifiers DB fsync

Order is load-bearing. Crash between (1) and (2): state ahead of recorded
height — startup reconciliation trusts state within a threshold window.
Crash between (2) and (3): modifiers DB already has validated_height
durably recorded.

### Block Body Download

After header sync: request sub-blocks for each ordering block whose
`subBlockIds` are not in the local store. Direct `ModifierRequest` (type 102)
to the sync peer.

---

## Peer Discovery

### PeerDb

In-memory registry backed by persistent storage (`peer_*` tables in the
store). Entries sourced from:
1. Our own handshake with a peer (authoritative)
2. `Peers` messages from other peers (hearsay)

```typescript
interface PeerRecord {
  address: string         // multiaddr, deduplication key
  lastSeenMs: number      // Unix epoch ms
  agentName: string
  nodeName: string
  protocolVersion: number
  capabilities: number[]  // message codes, opaque forward-compat
}
```

Key behaviors:
- **Soft cap:** 1000 entries (`peerDbCap`). Evict oldest `lastSeenMs` on
  overflow.
- **Self-address filter:** entries matching our own listen addresses are
  silently dropped
- **Blacklist filter:** banned peers excluded from `recent()` lookups
- **Persistence:** write-through via `PeerStorage` trait. `put` failures
  logged and swallowed — in-memory state demotes to ephemeral.

### GetPeers (code 8)

Body: empty. A peer receiving this queries PeerDb for up to 8 recently-seen
non-blacklisted, non-self peers (excluding the requester's address) and
responds with `Peers`.

### Peers (code 9)

```typescript
{
  peers: {
    address: string        // multiaddr
    agentName: string
    nodeName: string
    protocolVersion: number
    capabilities: number[]
  }[]
}
```

Max 64 entries per response. Cap is enforced on the receiver — bodies
declaring more trigger a permanent ban of the sender. Empty selection
produces `{ peers: [] }`.

### Peers Intake

On receiving `Peers`: for each entry where the address is not blacklisted,
not bogus, and not self — record into PeerDb with `lastSeenMs = now`.
Malformed Peers (cap exceeded, truncated body, invalid strings) triggers
permanent ban of the source. Bogus addresses in a valid body do NOT
penalize the source — they are silently dropped.

### Bogus Address Classification

**Always bogus** (any network):
- IPv4: loopback (127/8), link-local (169.254/16), multicast (224/4),
  broadcast (255.255.255.255), unspecified (0.0.0.0), benchmark (198.18/15),
  reserved Class E (240/4)
- IPv6: loopback (::1), unspecified (::), multicast (ff00::/8),
  link-local (fe80::/10), IPv4-mapped (::ffff:0:0/96)

**Mainnet-only bogus** (valid on testnet/LAN):
- IPv4: RFC 1918 private (10/8, 172.16/12, 192.168/16), CGN (100.64/10),
  documentation (192.0.2/24, 198.51.100/24, 203.0.113/24)
- IPv6: unique-local (fc00::/7), documentation (2001:db8::/32)

### Outbound Manager

Two phases:

**Floor phase** (connections < `minPeers`):
- Dial bootstrap seeds aggressively with retry/backoff
- PeerDb not consulted — seeds are the bootstrap source

**Fill phase** (connections >= `minPeers`, < `maxPeers`):
- Every `outboundFillIntervalMs` (30s), query
  `PeerDb.recent(N, exclude=connected)` where
  `N = maxPeers - connectedOutbound`
- Dial one candidate per tick (most recently seen first)
- Respect blacklist and redial cooldown (`outboundRedialCooldownMs`, 60s)
- If PeerDb exhausted, idle until new gossip arrives

### Bootstrap Flow (New Node)

```
Node start
  │
  ├── Load peer records from store → populate PeerDb
  ├── Dial bootstrap seeds
  │     │
  │     ├── Handshake → add to PeerDb, transition to Active
  │     ├── Send GetPeers → receive Peers → feed PeerDb
  │     └── If peer ahead → initiate sync
  │
  └── Outbound manager fills from PeerDb
```

---

## Peer Penalty System

| Penalty type | Trigger | Score |
|-------------|---------|-------|
| MisbehaviorPenalty | Invalid message (fails Stage 1) | 100 |
| SpamPenalty | Duplicate sub-block within window | 50 |
| NonDeliveryPenalty | Missing sub-block request timeout | 75 |
| PermanentPenalty | Wrong magic bytes, incompatible version | 500 (instant ban) |

Accumulated score >= threshold → temporal ban for `temporalBanDuration`.
Safe interval cooldown between penalties for the same peer.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `PENALTY_SCORE_THRESHOLD` | `500` | Score to trigger ban |
| `TEMPORAL_BAN_DURATION_MS` | `3600000` | Ban duration (60 min) |
| `PENALTY_SAFE_INTERVAL_MS` | `120000` | Cooldown between penalties (2 min) |

---

## Biased Event Loop

The sync/gossip event loop MUST prioritize:
1. Control events (reorg notification, peer disconnect, new peer) —
   unbounded channel, never dropped
2. Data events (post received, post acknowledged) — bounded channel, lossy
3. Timer ticks — fallback

## Local-Serve-Before-Relay

Incoming content requests MUST check local storage before relaying to
other peers. Serve and relay are mutually exclusive per request ID —
never both.

## Penalty Attribution

Every incoming message carries `sourcePeerId`. Validation failures are
attributed to the sending peer. Three penalty tiers:
- **Transient failure** (timeout, slow response): cooldown, not a ban
- **Protocol violation** (malformed message, invalid encoding): permanent
  ban, peer removed from PeerDb
- **Bogus addresses in valid gossip**: silently dropped, sender NOT
  penalized (NAT'd peers sending private addresses is normal)

## Peer State Machine

States: `Connecting → Handshaking → Active → Disconnected | Failed`

Invariant: No events leak from non-Active peers. Messages from peers not
in `Active` state are rejected before reaching the router.

## Stall Detection

Track peers that fail to deliver requested content within a timeout. On
stall: mark peer, rotate to next outbound peer not in stalled set. On
successful receipt from any peer: clear the stalled set. All peers stalled:
clear and retry.

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

## Stream Protocols

| Protocol | Framing | Purpose |
|----------|---------|---------|
| `/dagsocial/handshake/1` | Frame | Post-identify peer handshake |
| `/dagsocial/sync/1` | Frame | Historical sync + peer discovery (codes 2-9) |

All stream protocols multiplex over the sync stream. The frame `code`
byte disambiguates message types.

Removed protocols:
- Old `/dagsocial/sync/1` (individual sub-block request/response) —
  replaced by framed GetSubBlock/SubBlockResponse (codes 6-7)
- `/dagsocial/headers/1` — replaced by framed
  SyncInfo/Inv/ModifierRequest/ModifierResponse (codes 2-5)

---

## Validation Architecture

Two-stage validation, modeled after Ergo's modifier processing:

### Stage 1 (net package, stateless)

Runs on inbound gossip messages before forwarding to mesh peers. Uses
`@dagsocial/validation`:

- CBOR structural validity
- Protocol version check
- Content limits (1-300 UTF-8 bytes)
- PoW verification (blake2b512 meets target difficulty)
- Signature verification (Ed25519)
- Sub-block, ordering block, and UTXO transaction structural checks

### Stage 2 (node package, stateful)

Runs after Stage 1 passes, via registered `on*` callbacks:

- Parent refs exist (live post or stump)
- Author has sufficient karma
- UTXO inputs unspent, guard scripts satisfied
- Challenge check skipped for relayed posts (challenge was local to origin node)

### Forwarding Rule

Forward to mesh peers after Stage 1 passes. If Stage 2 fails later, penalize
the source peer. This keeps propagation fast while gatekeeping on structure
and PoW.

---

## API

### Node Lifecycle

| Function | Signature | Description |
|----------|-----------|-------------|
| `start(config)` | `(NetConfig) => Promise<void>` | Create libp2p node, connect to bootstrap peers, subscribe to topics |
| `stop()` | `() => Promise<void>` | Graceful shutdown |
| `peerId()` | `() => string` | This node's libp2p peer ID |
| `peers()` | `() => Peer[]` | Connected peers with metadata |
| `getConnectedPeers()` | `() => string[]` | Peer IDs of currently connected peers |

### Gossip

| Function | Signature | Description |
|----------|-----------|-------------|
| `broadcastSubBlock(sb)` | `(SubBlock) => Promise<void>` | Gossip a newly assembled sub-block |
| `broadcastOrderingBlock(b)` | `(OrderingBlock) => Promise<void>` | Gossip a newly created ordering block |
| `broadcastTx(tx)` | `(UtxoTransaction) => Promise<void>` | Gossip a UTXO transaction |
| `broadcastStump(stump)` | `(Stump) => Promise<void>` | Gossip a stump for pruned content |

### Inbound Processing

| Function | Signature | Description |
|----------|-----------|-------------|
| `onSubBlock(callback)` | `((SubBlock) => void) => void` | Register handler for inbound sub-blocks |
| `onOrderingBlock(callback)` | `((OrderingBlock) => void) => void` | Register handler for inbound ordering blocks |
| `onTx(callback)` | `((UtxoTransaction) => void) => void` | Register handler for inbound UTXO transactions |
| `onStump(callback)` | `((Stump) => void) => void` | Register handler for inbound stumps |

### Pull Requests (Peer-to-Peer)

| Function | Signature | Description |
|----------|-----------|-------------|
| `requestHeaders(start, max, peerId)` | `(number, number, string) => Promise<BlockHeader[]>` | Request block headers for fork resolution |
| `requestBlocks(start, end, peerId)` | `(number, number, string) => Promise<OrderingBlock[]>` | Request full blocks for reorg |
| `requestPosts(peerId, postIds)` | `(string, string[]) => Promise<PostsMsg>` | Request posts by ID (content-sweep) |
| `requestStumps(peerId, stumpIds)` | `(string, string[]) => Promise<StumpsMsg>` | Request stumps by ID |

### Sync Handler Registration

| Function | Signature | Description |
|----------|-----------|-------------|
| `setSyncHandler(cb)` | `((id: string) => SubBlock \| null) => void` | Provider for sub-block content (placeholder fill) |
| `setBlocksHandler(cb)` | `((block: OrderingBlock) => void) => void` | Handler for blocks received during sync |
| `setHeadersHandler(cb)` | `((height: number) => BlockHeader \| null) => void` | Provider for block headers |
| `setPostsHandler(cb)` | `((ids: string[]) => PostsEntry[]) => void` | Provider for posts by ID |
| `setStumpsHandler(cb)` | `((ids: string[]) => {stumpId, stump}[]) => void` | Provider for stumps by ID |
| `onSyncComplete(cb)` | `(() => void) => void` | Fired when sync finishes |
| `onPeerActive(cb)` | `((peerId: string) => void) => void` | Fired when a peer becomes active |

---

## Config

```typescript
interface NetConfig {
  // Transport
  bootstrapPeers: string[]
  listenAddrs: string
  maxPeers: number

  // Magic bytes
  magic: number                    // 0x4D444147 (mainnet) or 0x54444147 (testnet)

  // Peer discovery
  minPeers: number                 // floor for fill phase (default 3)
  peerDbCap: number                // soft cap on PeerDb entries (default 1000)
  outboundFillIntervalMs: number   // fill phase tick (default 30000)
  outboundRedialCooldownMs: number // redial cooldown (default 60000)

  // Syncing
  syncRequestTimeoutMs: number

  // Penalties
  penaltyScoreThreshold: number
  temporalBanDurationMs: number
  penaltySafeIntervalMs: number
  peerEvictionIntervalMs: number
}
```

---

## Preconditions

- Node.js >= 22
- `@dagsocial/wire`, `@dagsocial/types`, `@dagsocial/validation`, and
  `@dagsocial/node` packages built and importable
- libp2p dependencies installed (`@libp2p/tcp`, `@chainsafe/libp2p-noise`,
  `@chainsafe/libp2p-yamux`, `@chainsafe/libp2p-gossipsub`, `@libp2p/identify`,
  `@libp2p/ping`)
- Bootstrap peer(s) reachable
- Port available for libp2p listen address

## Postconditions

- libp2p node running with configured transports and protocols
- Connected to bootstrap peers, handshake exchanged, and meshed on all
  subscribed gossip topics
- Handshake validated — wrong-network peers rejected at magic byte level
- Sync initiated with peers ahead of us; sync served to peers behind us
- Sub-blocks received from peers are validated and forwarded to local node
  for storage
- Ordering blocks received from peers are validated and applied
- Locally-produced sub-blocks and ordering blocks are gossiped to peers
- PeerDb populated from handshakes and Peers gossip; outbound manager
  maintaining peer count between minPeers and maxPeers

## Invariants

- Frame magic bytes reject wrong-network connections at the transport layer
- Frame checksum catches corruption before body parsing
- Stream protocols carry framed messages; Gossipsub topics carry raw CBOR
- Sync is bidirectional — nodes serve peers behind them, not just consume
- Watermark invariant: `stateAppliedHeight <= downloadedHeight <= chainHeight`
- Flush ordering: state → validated_height → modifiers (same order every time)
- Unknown message codes and peer capabilities are preserved, not rejected
- PeerDb self-address filter prevents self-dial loops
- Bogus addresses filtered silently; malformed Peers trigger permanent ban
- Sub-block gossip is stateless — verification depends only on the post's
  PoW target, not on challenge provenance
- Ordering blocks are verified before application — a block extending an
  unknown chain may be buffered but never applied
- UTXO transactions are verified against the local UTXO view — conflicting
  transactions (double-spends) are rejected at gossip time
- Peer identity (libp2p) is independent of account identity (Ed25519 keypair)
- Topic names include protocol version — incompatible wire format changes
  get a new topic
- Inbound messages are re-verified before forwarding and storing
