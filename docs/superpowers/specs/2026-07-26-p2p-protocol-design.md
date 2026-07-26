# P2P Protocol Design

**Date:** 2026-07-26
**Protocol version:** 2
**Status:** design

## Overview

Restructure the p2p networking layer with:

1. A `@dagsocial/wire` package — ByteReader, ByteWriter, VLQ encoding, and framed message envelope (extracted from `@ergots/scorex`, which is a byte-for-byte JVM reference port)
2. A proper frame format with magic bytes, versioning, VLQ length prefixing, and checksum
3. A handshake protocol exchanged after libp2p identify
4. Header-first historical sync (SyncInfo → Inv → ModifierRequest → ModifierResponse)
5. Peer discovery via GetPeers/Peers gossip + outbound manager with floor/fill phases
6. Bidirectional sync serve — nodes serve peers behind them, not just consume

The transport remains libp2p (TCP → Noise → yamux). The frame format wraps every stream message; Gossipsub topics continue using CBOR directly.

---

## `@dagsocial/wire` package

Extracted from `@ergots/scorex`. Pure functions only, no dependencies except a hash function (blake2b256, injectable).

### Exports

| Export | Purpose |
|--------|---------|
| `ByteReader` | Stateful cursor: `readU8`, `readBytes`, `readBool`, `readVlqU`, `readVlqS`, `readArray`, `readOption`, position limits, `remaining` |
| `ByteWriter` | Accumulator: `writeU8`, `writeBytes`, `writeBool`, `writeVlqU`, `writeVlqS`, `writeArray`, `writeOption`, `toBytes()` |
| `encodeVlqU` / `decodeVlqU` | Standalone VLQ (for callers that don't want a full reader/writer) |
| `encodeVlqZigZag` / `decodeVlqZigZag` | Signed VLQ (future-proofing) |
| `ReaderError` | Typed errors: `truncated`, `vlq-overflow`, `array-too-large`, `position-limit-exceeded` |
| `MAX_ARRAY_LENGTH` | `1 << 24` — hard cap on VLQ-length-prefixed array reads |
| `encodeFrame(magic, code, body)` | `(number, number, Uint8Array) → Uint8Array` |
| `decodeFrame(magic, data)` | `(number, Uint8Array) → { code: number, body: Uint8Array }` |

### Stripped from scorex

ErgoTree-specific features not carried over: `MAX_TREE_DEPTH`, `enterDepth`/`exitDepth`, `forkSubReader`, `readVlqU32`, `readVlqBigInt`/`readVlqBigIntSigned`, `positionLimit` setter, `AutolykosSolution`, `Header` types. VLQ is carried via `number` (safe integer range, ≤ 2^53). If u64 wire values are needed later, BigInt VLQ paths are added then.

### ByteReader / ByteWriter

Same API surface as scorex. `ByteReader` wraps a `Uint8Array` with a cursor; reads advance the cursor and throw `ReaderError` on malformed input. `ByteWriter` accumulates chunks and produces a single `Uint8Array` via `toBytes()`.

---

## Frame format

Every libp2p stream message (handshake, sync, peer discovery):

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

### Magic bytes

| Network | Magic | Bytes |
|---------|-------|-------|
| mainnet | "MDAG" | `0x4D 0x44 0x41 0x47` |
| testnet | "TDAG" | `0x54 0x44 0x41 0x47` |

### Version negotiation

On receiving a frame with an unsupported version:
- **Major version higher**: close the stream. The peer is using a newer framing protocol. Not a penalty — the peer may support an older version on retry.
- **Minor version higher**: accept. Forward-compat — unknown fields in the body are ignored.

Version 1 is the baseline. A frame version bump means an incompatible change to the envelope structure (not the message bodies).

### Design decisions

- **Version byte before VLQ fields**: the framing layer can evolve independently (e.g., switch to fixed-width lengths or a different checksum).
- **Checksum after length**: parser knows the body size before verifying — can allocate once.
- **VLQ for code**: message type namespace effectively unlimited.
- **VLQ for length**: handshake (~100 bytes) encodes in 1 byte; block response (~100KB) encodes in 3 bytes.
- **Body is CBOR**: consistent with existing gossip encoding. No second serialization format.
- **Checksum via blake2b256**: matches the project's hash standard.

### Gossip exception

Gossipsub topics (`/dagsocial/subblock/1`, `/dagsocial/ordering-block/1`, `/dagsocial/tx/1`) do **not** use frames. Gossipsub owns message boundaries and validation — CBOR goes directly on the wire as today. The frame is for stream protocols only.

---

## Message codes

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

Codes 6–7 replace the existing ad-hoc `/dagsocial/sync/1` stream protocol. Codes 2–5 replace `/dagsocial/headers/1`. The old protocols are deleted.

---

## Handshake (code 1)

After libp2p identify completes, both sides open a stream on `/dagsocial/handshake/1` and exchange a framed `Handshake` message:

```
outbound: connect → identify → open stream → send Handshake → receive Handshake → active
inbound:  accept → identify → receive stream → receive Handshake → send Handshake → active
```

### Handshake body (CBOR)

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

Session magic: each side generates a random `uint32`. The outbound side sends its magic; the inbound side echoes it back. Both sides verify the magic matches their own network's magic bytes in the frame. Anti-replay, validates both sides agree on network.

### Validation

- `protocolVersion` must be one this node supports
- `chainHeight` is informational — used to decide sync direction
- Unknown capabilities are preserved, not rejected (forward compat)

Validation failure → stream closed, peer banned permanently.

### Post-handshake behavior

| Condition | Action |
|-----------|--------|
| `theirHeight > ourHeight` | Initiate sync from that peer |
| `theirHeight < ourHeight` | Offer them headers (serve mode — send Inv) |
| `theirHeight == ourHeight` | Idle — only gossip flows |

---

## Historical sync (header-first)

### Protocol messages

**SyncInfo (code 2):**

```typescript
{
  tipHeight: number
  tipBlockId: string              // hex
  tipCumulativeWork: bigint       // total PoW accumulated (fork choice)
  anchors: { height: number, blockId: string }[]
}
```

Anchors at heights `[tipHeight, tipHeight - 16, tipHeight - 128, tipHeight - 512]` (fewer if chain is shorter). They let the receiver find the best common point.

**Inv (code 3):**

```typescript
{
  typeId: 101 | 102             // 101 = ordering block header, 102 = sub-block
  ids: string[]                  // hex IDs, max 400 per batch
}
```

**ModifierRequest (code 4):**

```typescript
{
  typeId: 101 | 102
  ids: string[]
}
```

**ModifierResponse (code 5):**

```typescript
{
  typeId: 101 | 102
  modifiers: { id: string, data: Uint8Array }[]
}
```

### Sync flow

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

### Serve side (peer behind us)

When receiving a SyncInfo showing the peer is behind or at genesis:
1. Compute continuation headers from their best known height + 1
2. Cap at 400 headers
3. Send Inv

An empty anchor list means a from-genesis peer → continuation starts at height 1. This bidirectional pattern was missing in the current implementation and prevented rust-to-rust sync.

### Sync state machine

```
pick_sync_peer() → sync_from_peer() → synced()
       ↑                  │
       └── stall/disconnect ──┘
```

- **Pick:** handshake reveals peers ahead of us → pick the one with highest chain height
- **Sync:** send SyncInfo, process Inv → request headers, validate, append to chain, repeat
- **Stall:** 60s no progress → rotate to different peer, mark current as stalled. On progress, clear stall set.
- **Peer rotation:** `stalledPeers: Set<PeerId>` — peers that failed to produce progress. On stall, pick next outbound peer not in set. If all stalled, clear set and retry.
- **Synced:** periodic SyncInfo (30s) to detect new blocks. React to Inv from any peer.

### Two-batch pattern (from ergo-node-rust)

Send SyncInfo once from the scheduled timer, once after the first batch is processed. Gets ~800 headers per 20-second cycle.

### Watermarks

Three watermarks tracked:

| Watermark | Meaning |
|-----------|---------|
| `downloadedHeight` | Highest height with all headers stored |
| `stateAppliedHeight` | Highest height where ordering blocks applied to UTXO state |
| `chainHeight` | Best chain tip height |

During header sync, advance `downloadedHeight`. Once caught up, request sub-blocks for ordering blocks referencing unknown sub-block IDs, advancing `stateAppliedHeight`.

Invariant: `stateAppliedHeight <= downloadedHeight <= chainHeight`.

### Cross-DB durability

Same flush ordering from ergo-node-rust:

1. `validator.flush()` — state DB fsync (`Durability::Immediate`)
2. `store.setValidatedHeight(height)` — modifiers DB chain_meta write
3. `store.flush()` — modifiers DB fsync

Order is load-bearing. Crash between (1) and (2): state ahead of recorded height — startup reconciliation trusts state within a threshold window. Crash between (2) and (3): modifiers DB already has validated_height durably recorded.

### Graceful shutdown

On SIGTERM/SIGINT: run the same flush sequence. Clean shutdowns preserve everything; unclean shutdowns recover via reconciliation on next start.

### Block body download

After header sync: request sub-blocks for each ordering block whose `subBlockIds` aren't in the local store. Direct `ModifierRequest` (type 102) to the sync peer. In DAGsocial this is simpler than Ergo — no separate AD proof or extension sections, no script evaluation watermark.

---

## Peer discovery

### PeerDb

In-memory registry backed by persistent storage (`peer_*` tables in the store, treated as opaque bytes). Entries sourced from:
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
- **Soft cap:** 1000 entries (`peerDbCap`). Evict oldest `lastSeenMs` on overflow.
- **Self-address filter:** entries matching our own listen addresses are silently dropped
- **Blacklist filter:** banned peers excluded from `recent()` lookups
- **Persistence:** write-through via `PeerStorage` trait (store crate implements). `put` failures logged and swallowed — in-memory state demotes to ephemeral.

### GetPeers (code 8)

Body: empty. A peer receiving this queries PeerDb for up to 8 recently-seen non-blacklisted, non-self peers (excluding the requester's address) and responds with `Peers`.

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

Max 64 entries per response. Cap is enforced on the receiver — bodies declaring more trigger a permanent ban of the sender. Empty selection produces `{ peers: [] }`.

### Peers intake

On receiving `Peers`: for each entry where the address is not blacklisted, not bogus, and not self — record into PeerDb with `lastSeenMs = now`. Malformed Peers (cap exceeded, truncated body, invalid strings) triggers permanent ban of the source. Bogus addresses in a valid body do NOT penalize the source — they are silently dropped.

### Bogus address classification (network-conditional)

**Always bogus** (never legitimate, any network):
- IPv4: loopback (127/8), link-local (169.254/16), multicast (224/4), broadcast (255.255.255.255), unspecified (0.0.0.0), benchmark (198.18/15), reserved Class E (240/4)
- IPv6: loopback (::1), unspecified (::), multicast (ff00::/8), link-local (fe80::/10), IPv4-mapped (::ffff:0:0/96)

**Mainnet-only bogus** (valid on testnet/LAN):
- IPv4: RFC 1918 private (10/8, 172.16/12, 192.168/16), CGN (100.64/10), documentation (192.0.2/24, 198.51.100/24, 203.0.113/24)
- IPv6: unique-local (fc00::/7), documentation (2001:db8::/32)

### Outbound manager

Two phases:

**Floor phase** (connections < `minPeers`):
- Dial bootstrap seeds aggressively with retry/backoff
- PeerDb not consulted — seeds are the bootstrap source

**Fill phase** (connections ≥ `minPeers`, < `maxPeers`):
- Every `outboundFillIntervalMs` (30s), query `PeerDb.recent(N, exclude=connected)` where `N = maxPeers - connectedOutbound`
- Dial one candidate per tick (most recently seen first)
- Respect blacklist and redial cooldown (`outboundRedialCooldownMs`, 60s)
- If PeerDb exhausted, idle until new gossip arrives

### Bootstrap flow (new node)

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

## Net package restructure

```
packages/net/src/
├── index.ts              # NetNode public API
├── config.ts             # NetConfig (adds: magic, minPeers, peerDbCap, fillInterval, redialCooldown)
├── types.ts              # Peer, PenaltyRecord, NetValidators
├── peer-mgr.ts           # PeerManager (penalties, bans)
├── peerdb.ts             # NEW: PeerDb — in-memory registry + persistence adapter
├── frame.ts              # NEW: encodeFrame / decodeFrame (uses @dagsocial/wire)
├── handshake.ts          # NEW: build/parse Handshake, run handshake exchange
├── gossip.ts             # Sub/tx/block gossip (unchanged except topic constants)
├── sync.ts               # REPLACED: header-first sync machine
├── node.ts               # Updated: wire up handshake + sync + peerdb
├── util.ts               # mergeUint8Arrays (unchanged)
```

Removed:
- `headers.ts` — replaced by framed SyncInfo/Inv/ModifierRequest/ModifierResponse
- Old `sync.ts` — replaced by sync machine

### Package dependency

```
@dagsocial/wire       ← NEW
       │
@dagsocial/net        ← uses wire for all stream framing
```

### Gossip — no changes

Gossip topics stay CBOR-on-Gossipsub exactly as today. Topic validators, Stage 1/Stage 2 unchanged.

### Protocol layer summary

| Layer | Protocol | Framing |
|-------|----------|---------|
| Gossip (sub-blocks, ordering blocks, txs) | Gossipsub topics | CBOR directly |
| Handshake | `/dagsocial/handshake/1` stream | Frame |
| Sync + Peer discovery | `/dagsocial/sync/1` stream | Frame |

All stream protocols multiplex over the sync stream. The frame `code` byte disambiguates.

### Config additions

```typescript
interface NetConfig {
  // existing
  bootstrapPeers: string[]
  listenAddrs: string
  maxPeers: number
  penaltyScoreThreshold: number
  temporalBanDurationMs: number
  penaltySafeIntervalMs: number
  peerEvictionIntervalMs: number
  syncRequestTimeoutMs: number

  // new
  magic: number                    // 0x4D444147 (mainnet) or 0x54444147 (testnet)
  minPeers: number                 // floor for fill phase (default 3)
  peerDbCap: number                // soft cap on PeerDb entries (default 1000)
  outboundFillIntervalMs: number   // fill phase tick (default 30000)
  outboundRedialCooldownMs: number // redial cooldown (default 60000)
}
```

---

## Contracts to update

1. **`contracts/ARCHITECTURE.md`** — add `@dagsocial/wire` to package diagram, update protocol version to 2
2. **`contracts/NET_INTERFACE.md`** — full rewrite: frame format, handshake, sync machine, peer discovery. Remove old `/dagsocial/sync/1` and `/dagsocial/headers/1` stream protocols.

New contract needed:
3. **`contracts/WIRE_INTERFACE.md`** — `@dagsocial/wire` package contract: ByteReader, ByteWriter, VLQ, frame encode/decode, ReaderError taxonomy, array limits.

---

## Implementation order

1. **Contracts** — update ARCHITECTURE.md, NET_INTERFACE.md; create WIRE_INTERFACE.md
2. **`@dagsocial/wire` package** — extract ByteReader, ByteWriter, VLQ from scorex; add frame encode/decode
3. **Frame format** — implement encodeFrame/decodeFrame in net package
4. **Handshake** — build/parse, exchange, validation, post-handshake routing
5. **PeerDb** — in-memory registry, storage adapter, GetPeers/Peers handlers
6. **Outbound manager** — floor phase, fill phase, redial cooldown
7. **Sync machine** — SyncInfo, Inv, ModifierRequest/Response, header validation loop, watermark tracking, serve side, stall/rotation
8. **Integration** — wire everything into NetNode, remove old headers.ts and sync.ts
9. **E2e** — multi-node cluster test: start N1, mine blocks, start N2, verify catch-up

---

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
