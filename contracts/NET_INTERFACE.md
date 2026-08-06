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
| devnet | "DDAG" | `0x44 0x44 0x41 0x47` — ⚠ NOT IMPLEMENTED |

**The magic is a field of the network profile** (`TYPES_INTERFACE §Network profiles`),
resolved once at startup from `NETWORK_TYPE`. It is never a per-call-site default.

> ⚠ **VIOLATED — the magic is not a fallback, it is the only path. Every node frames as
> mainnet, on every network, unconditionally.** Measured 2026-08-06, four links:
>
> 1. **This contract declares `magic: number`** (required). **The code declares
>    `magic?: number`** (`net/src/types.ts:131`) — a pre-existing contract/code drift.
> 2. **The only caller never passes it.** `node/src/index.ts:147-160` constructs `NetConfig`
>    with eleven fields; `magic` is not among them.
> 3. Ten sites therefore always take `?? MAGIC_MAINNET` — nine in `node.ts`, one in
>    `sync-machine.ts:160`.
> 4. `NETWORK_MODE` feeds none of them.
>
> So the transport separation this table describes **does not exist at all**. `MAGIC_TESTNET`
> has no production consumer; its only reference outside the table is a classifier
> (`bogus-addr.ts:85`). Testnet and mainnet peers assemble each other's frames today.
>
> **`NetConfig.magic` becomes required, with no fallback.** A default is the wrong shape
> here — an unset network is not a mainnet node, it is a misconfigured one, and defaulting
> silently resolves it toward the network where being wrong costs the most. Making it
> required turns link 2 into a compile error at the single construction site.
>
> `node/src/index.ts:145-146` already carries a comment about exactly this failure mode for
> the peer parameters — *"their defaults as binding only when node supplies them — unset,
> net's internal fallbacks silently govern instead."* The observation was written down and
> `magic` was not fixed.

> ⚠ **`KNOWN_FRAME_MAGICS` is hardcoded in `net/src/node.ts` as `[MAGIC_MAINNET,
> MAGIC_TESTNET]`.** Adding a third magic without updating that literal makes devnet frames
> fail the magic check, fall through to the legacy unframed path, decode as malformed, and
> **permanently ban the peer**. The canonical set must be **imported**, never re-declared.
>
> ⚠ **Both the magics and the canonical set come from `@dagsocial/types`, not
> `@dagsocial/wire`.** They move there in P2-A phase 5, beside `NetworkProfile` — wire's
> frame functions take `magic` as a parameter and never read the constants, and wire keeps
> its zero runtime dependencies, so the table cannot live there. Net's imports of
> `MAGIC_MAINNET` / `MAGIC_TESTNET` from `./frame.js` re-point to `@dagsocial/types`.
> **This reverses the pre-audit follow-up that said wire should own the canonical set** —
> that note predates the profile table.

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

> ⚠ **VIOLATED — "The old protocols are deleted" is false, and the replacement is the part
> that does not exist.** `/dagsocial/headers/1` is **live, and is the only path fork
> resolution uses.** Framed **codes 6–7 have never carried a byte.** So the sentence has it
> exactly backwards: the protocol described as deleted is the one in production, and the
> one described as its replacement is unused.
>
> This matters beyond bookkeeping: the legacy path is where peer headers arrive as a bare
> `decode()` plus a cast with no shape check, feeding `cumulativeWork` unbounded. Anyone
> hardening "the sync path" from this document would harden the wrong one.
>
> `ARCHITECTURE.md` also describes header-first sync as implemented. Both are wrong; fix
> together.

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

> ⚠ **NOT IMPLEMENTED — the anti-replay check does not exist.** Both sides generate a
> `sessionMagic` and **neither ever echoes or compares it.** The field is populated and
> discarded, so the handshake provides no replay protection whatsoever. Network agreement
> is established by the **frame magic** (`MAGIC_MAINNET`/`MAGIC_TESTNET`), which is a
> separate mechanism and does work — so the second half of this paragraph holds while the
> first does not.
>
> This is design worth building: the field is already on the wire, so implementing the
> echo-and-compare costs no format change.

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

> ⚠ **PARTIAL — the section title itself is not accurate.** Sync is **not header-first**
> and has **no body-download phase**; the watermark and durability protocol described
> below is unimplemented. Two specific mechanisms documented here do not exist:
>
> - **Common-ancestor discovery.** `anchors` are built, sent, validated and capped — and
>   **never read** by the receiver. There is no ancestor search.
> - **The framed protocol is not the live path.** `/dagsocial/headers/1` — documented
>   elsewhere in this file as *deleted* — is live and is the **only** path fork resolution
>   uses. Framed codes 6–7 have never carried a byte.
>
> Per-mechanism status is marked below. Inventory: `prompts/audit-net.report.md`.

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
- **Stall:** 60s without **real progress** (see Sync Integrity below) →
  rotate to different peer, mark current as stalled. On progress, clear
  stall set.
- **Peer rotation:** `stalledPeers: Set<PeerId>` — peers that failed to
  produce progress. On stall, pick next outbound peer not in set. If all
  stalled, clear set and retry.
- **Synced:** periodic SyncInfo (30s) to detect new blocks. An Inv is
  acted on only while syncing and only from the current sync peer (see
  Sync Integrity — request provenance); an Inv from any other peer, or
  while not syncing, is dropped without penalty.

### Sync Integrity (audit M-10)

- **Response binding.** A `ModifierResponse` is processed only if it
  answers an outstanding `ModifierRequest` this node previously sent **to
  that same peer**: the machine tracks the requested modifier ids per
  request target; a response modifier whose id was not requested from its
  sender is dropped — dropped, not penalized, because a response can
  legitimately cross a peer rotation in flight. Requests are only ever
  sent to the current sync peer, so this implies: no other peer can push
  blocks into the store via the sync path.
- **Request provenance.** While syncing, only an Inv from the current sync
  peer may trigger a `ModifierRequest`. A third party's Inv must neither
  cause requests nor grow the outstanding set.
- **Outstanding-set lifecycle.** Ids are added when a request is sent,
  removed as matching response modifiers are accepted, bounded by a fixed
  cap (new requests must not grow the set past it), and cleared on peer
  rotation and on sync-peer disconnect. The framed sync path has no
  per-request timer — stall rotation IS the request timeout.
- **Stall progress = chain height.** The stall clock advances only when
  applying a response strictly increases `chainHeight` — never on mere
  receipt of bytes or non-advancing modifiers. A peer feeding junk
  therefore stalls out and is rotated away within one stall window; it
  cannot pin sync indefinitely.

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

In-memory registry backed by persistent storage (the `peers` table in the
store — see the persistence seam below). Entries sourced from:
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

#### Persistence seam

`PeerStorage` (`loadAll`/`put`/`delete`) is defined by `@dagsocial/net`
and **implemented by `@dagsocial/node`** over the `peers` table — net
must not depend on SQLite. The implementation is supplied to
`NetNode` at construction, alongside `NetValidators`, and handed to the
`PeerDb` constructor so `loadAll()` repopulates the table at startup.
Omitting it yields an ephemeral PeerDb (the current state); that is a
valid test/embedded configuration, not the production one.

#### Ban surfaces are unified

`PeerManager` bans by **peerId**; `PeerDb` bans by **address**. These
must not drift apart: a peer that `PeerManager` bans is otherwise still
served in `Peers` responses and re-dialed by the outbound fill phase.

- `PeerMetadata` carries the peer's declared `address`, recorded when the
  peer reaches `Active` (the handshake is the only place both identities
  are known).
- Every `PeerManager` ban — temporal or permanent — propagates to
  `PeerDb.ban(address)` for the peer's recorded address, so the address
  leaves `recent()` and is refused re-entry by `record()`.
- Expiry of a temporal ban calls `PeerDb.unban(address)`.

**Known limitation, deliberately not solved here:** a libp2p peerId is
freely regenerable and an address can be re-dialed from a new identity,
so peerId-keyed banning deters unsophisticated abuse only. Address-keyed
pressure is the stronger surface; treating it as authoritative is a
future design decision, not an implementation detail.

### GetPeers (code 8)

Body: empty. A peer receiving this queries PeerDb for up to 8 recently-seen
non-blacklisted, non-self peers (excluding the requester's address) and
responds with `Peers`.

Sent to each connected peer every `GET_PEERS_INTERVAL_MS` (120000, 2 min)
while connected. An inbound `GetPeers` is answered whatever our own sync
phase is — serving discovery does not depend on being synced.

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

**Encoding.** Both bodies are CBOR, like every other framed message
(`encodeFrame(magic, code, encode(body))`); there is no bespoke
byte-level codec. Decoding follows the `sync-codec.ts` pattern: a decoder
returns `null` for anything that is not well-formed CBOR **or** does not
match the declared shape — `peers` an array, and every entry an object
with a string `address`, string `agentName`, string `nodeName`, plus
`protocolVersion` and `capabilities` bounded **exactly as
`validateHandshake` bounds the same two fields** (`isBoundedInt` /
`isBoundedIntArray` against `MAX_CAPABILITY_CODE`). Pinning them to the
handshake's bounds rather than "any safe integer" is deliberate: the two
carry the same values, and a looser rule here would mean two
implementations disagreeing about which sender gets banned. `null` is a
`ProtocolViolation` (permanent ban); shape checking is not optional,
because each field reaches string and dial paths that a CBOR payload can
otherwise feed any type.

A single invalid entry rejects the **whole** body, banning the sender.
That is not collateral damage: a node serves `Peers` from its own PeerDb,
and every PeerDb entry has already passed this same validation on the way
in (from a handshake or from intake), so a well-behaved node cannot
produce an invalid entry.

`Peers` is accepted **only as the response to a `GetPeers` this node
sent** on that stream. An unsolicited `Peers` frame is ignored — the same
posture as Sync Integrity's response binding, and for the same reason:
otherwise any peer could push addresses into our PeerDb unasked, which is
the cheapest possible table-poisoning primitive.

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

Both phases are driven by the count of **outbound** connections, never
by the total peer count. This is load-bearing: an attacker who fills
every inbound slot must not be able to stop us from dialing out, which
is how a node gets eclipsed. Inbound connections are counted toward
`maxPeers` capacity, but never toward the floor/fill thresholds.

**Floor phase** (outbound connections < `minPeers`):
- Dial bootstrap seeds aggressively with retry/backoff
- PeerDb not consulted — seeds are the bootstrap source

**Fill phase** (outbound connections >= `minPeers`, < `maxPeers`):
- Every `outboundFillIntervalMs` (30s), query
  `PeerDb.recent(N, exclude)` where `N = maxPeers - connectedOutbound`
- `exclude` is the union of **currently-connected addresses** and
  addresses in redial cooldown. Excluding connected addresses is
  required, not an optimization — without it the manager re-dials peers
  it already holds and starves genuinely new candidates.
- Dial one candidate per tick (most recently seen first)
- Respect blacklist and redial cooldown (`outboundRedialCooldownMs`, 60s)
- If PeerDb exhausted, idle until new gossip arrives

The discovery-related knobs (`minPeers`, `peerDbCap`,
`outboundFillIntervalMs`, `outboundRedialCooldownMs`) are optional in
`NetConfig` and fall back to net-internal defaults. A node that leaves
them unset inherits those defaults rather than the values in this
document — `@dagsocial/node` MUST pass them for the documented behavior
to hold.

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

### Accrual and decay (audit L-13)

**Every penalty accrues.** A penalty is never discarded because another
one arrived recently — that made ban pressure independent of attack
rate, since a peer flooding invalid messages paid exactly what a peer
misbehaving once every safe interval paid, while each invalid message
still cost full Stage-1 work (which now includes PoW and signature
verification).

Instead the accumulated score **decays with time**: it is reduced by
`PENALTY_DECAY_PER_INTERVAL` (100 — one MisbehaviorPenalty) for every
`PENALTY_SAFE_INTERVAL_MS` of elapsed time since the peer's score was
last updated, floored at zero. Decay is applied lazily at penalty time,
before the new score is added — no timers.

The break-even point is therefore **one MisbehaviorPenalty per safe
interval**: a peer misbehaving faster than that accrues pressure and is
eventually banned, one misbehaving more slowly fades back to zero and is
never banned. A flooding peer crosses the threshold in five messages
rather than ten minutes.

Permanent penalties (`PenaltyKind.ProtocolViolation`, `'permanent'`)
bypass scoring entirely and ban instantly — decay never applies to them.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `PENALTY_SCORE_THRESHOLD` | `500` | Score to trigger ban |
| `TEMPORAL_BAN_DURATION_MS` | `3600000` | Ban duration (60 min) |
| `PENALTY_SAFE_INTERVAL_MS` | `120000` | Decay interval — `PENALTY_DECAY_PER_INTERVAL` points of accumulated score decay per interval (2 min) |

The parameter keeps its `SAFE_INTERVAL` name because it is set from the
environment by `@dagsocial/node`; renaming it is a cross-package change
tracked as a follow-up.

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

Runs inside the gossipsub topic validators — i.e. **before** a message is
forwarded to mesh peers. A message that fails Stage 1 is Rejected (never
forwarded) and penalized: undecodable → `ProtocolViolation` (permanent
ban); well-formed but invalid → misbehavior penalty (100). Uses
`@dagsocial/validation`. Per topic:

| Topic | Checks before Accept |
|-------|----------------------|
| sub-block | `verifySubBlockStructure`; content limits (1–300 UTF-8 bytes) + character rules; parent-refs count; protocol version; post PoW (`verifyPoW` over `postPowPreimage` at `POST_POW_TARGET_BITS`); post signature (`verifyPostSignature` — the post's own `author` key) |
| ordering-block | `verifyOrderingBlockStructure`; protocol version; `header.height` is a safe integer (NaN/float/±Infinity → Reject); ordering-block PoW (`verifyOrderingBlockPoW`) — the solution must satisfy the header's own `powTargetBits` (bounded ≥ `ORDERING_BLOCK_POW_TARGET_FLOOR` by structure), and a non-safe-integer `powNonce`/`powTargetBits` never verifies (audit M-6, M-9) |
| tx | `verifyTxStructure`; protocol version |
| stump | `rootPostHash` is 64-char hex |

Stage 1 is stateless. It does **not** check the difficulty schedule
(`powTargetBits === expectedTarget(height)`), chain linkage, validator
signatures, or state roots — those are apply-time checks in
`@dagsocial/node`, enforced for every entry path (gossip, sync, reorg) by
the block-apply funnel. The relay PoW gate exists to make mesh propagation
cost-bearing: no zero-work ordering block may be re-gossiped (audit M-9).

### Stage 2 (node package, stateful)

Runs after Stage 1 passes, via registered `on*` callbacks:

- Parent refs exist (live post or stump)
- Author has sufficient karma
- UTXO inputs unspent, guard scripts satisfied
- Challenge check skipped for relayed posts (challenge was local to origin node)

### Forwarding Rule

Forward to mesh peers only after Stage 1 passes — for ordering blocks this
includes PoW verification, so a bogus-PoW or NaN-nonce block is dropped at
the first hop instead of amplified mesh-wide. If Stage 2 fails later,
penalize the source peer. This keeps propagation fast while gatekeeping on
structure, PoW, and signatures.

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

  // Network — both REQUIRED, both supplied by the node from its resolved profile.
  // No defaults; see §Magic Bytes and §Consensus parameters net enforces.
  magic: number                    // mainnet 0x4D444147 · testnet 0x54444147 · devnet 0x44444147
  postPowTargetBits: number        // ⚠ NOT IMPLEMENTED — field does not exist yet

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
}
```

### Consensus parameters net enforces

Stage-1 relay validation checks proof-of-work before forwarding, so **net enforces a
consensus parameter** and must be told which network it is on. It receives values; it does
not resolve them, does not import `NetworkProfile`, and reads no environment variable for
them.

| Value | Why net needs it | Today |
|---|---|---|
| `magic` | Frame assembly and the frame-magic check | ⚠ VIOLATED — see §Magic Bytes |
| `postPowTargetBits` | `gossip.ts:242` verifies post PoW before relay | ⚠ VIOLATED — imports the constant from `@dagsocial/types` |

> ⚠ **`gossip.ts:242` has the same defect node closed as audit A6.** It calls
> `v.verifyPoW(powInput, post.powNonce, POST_POW_TARGET_BITS)` against the compile-time
> constant, so post difficulty is network-invariant at the relay boundary even though it is a
> profile field. **A devnet node would reject its own network's posts** — mined at devnet's
> target, checked against mainnet's — before they ever reach the node. It must read
> `config.postPowTargetBits`, supplied by the node.

> ⚠ **VIOLATED — `NETWORK_MAGIC`, an undocumented `network-identity` environment read.**
> `net/src/config.ts:5`:
> ```ts
> magic: parseInt(process.env['NETWORK_MAGIC'] ?? '0x54444147', 16), // default testnet
> ```
> Found 2026-08-06 by an exhaustive `process.env` sweep across all five packages. It appears
> in **no contract** — not here, not in `NODE_INTERFACE §Configuration` — and the ten-unit
> audit did not surface it. Three problems, in ascending order:
>
> 1. **It is a second network selector.** `NETWORK_TYPE` is supposed to be the only
>    environment variable that can change a consensus parameter.
> 2. **Its default contradicts the live path.** This says testnet (`0x54444147`); the ten
>    `?? MAGIC_MAINNET` sites say mainnet. The two disagree about which network an
>    unconfigured node joins.
> 3. **It is dead, which is why nobody noticed.** `loadNetConfig` has no production caller
>    and is not exported from net's barrel — only its own test file calls it. The node builds
>    its `NetConfig` literal by hand instead. Dead code carrying a live escape hatch is worse
>    than live code carrying one: it reads as the intended path and invites being wired up.
>
> **Resolution: delete `loadNetConfig` and its test.** Net does not resolve configuration —
> it receives it.

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
