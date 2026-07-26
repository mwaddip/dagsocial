# Ergo Node Rust — Practices Report for DAGsocial

**Generated:** 2026-07-26
**Source:** 24 fact files from `~/projects/ergo-node-rust/facts/` (SPECIAL.md excluded)
**Scope:** Every extractable practice, mechanic, invariant, and design decision relevant to DAGsocial

---

## Executive Summary

The Ergo Rust node is a production-grade blockchain node with a rigorous Design by Contract approach. Of ~120+ extractable practices across 24 fact files, roughly 60 are directly applicable to DAGsocial at its current stage. The rest apply to future phases (libp2p networking, cross-node sync).

### Top 10 highest-impact adoptions (in priority order)

| # | Practice | DAGsocial Impact |
|---|----------|-----------------|
| 1 | **"No method panics on untrusted input"** — every network byte → `Result<T, E>`, never `unwrap()` | Critical: every deser/sig-verify boundary |
| 2 | **Single-transaction atomic writes** — post + edges + indices + score in one SQLite txn | Critical: crash safety |
| 3 | **Validate, don't trust** — independently recompute hashes, parent pointers, signatures | Critical: fork safety |
| 4 | **Never add checks the reference lacks** — extra validation rules create fork surfaces | Critical: consensus |
| 5 | **Facade pattern** — zero business logic in Express handlers, thin delegation to services | High: testability, reusability |
| 6 | **Best DAG is a view, not structural** — store all branches, canonical view is derived | High: reorg safety |
| 7 | **Opaque storage layer** — store sees bytes, doesn't parse/validate domain objects | High: separation of concerns |
| 8 | **Two-phase PoW with candidate caching + solved latch** | High: already designed, validate against Ergo's pattern |
| 9 | **Structured journal events with stable marker contracts** | High: operational visibility |
| 10 | **Schema-versioned store with hard refusal on mismatch** | Medium: migration safety |

---

## 1. Validation & Security

### 1.1 No method panics on untrusted input
**Source:** chain.md (Invariants)

Every `parse_*` function returns `Result<T>` and never panics on malformed input. This is a hard invariant at the crate level. DAGsocial must adopt this for every deserialization and signature-verification boundary — any byte buffer from the network must return `Result<DecodedPost, PostParseError>` and never `unwrap()`, panic, or OOM on adversarial input.

### 1.2 Phased validation pipeline
**Source:** chain.md, validation.md

Validation is structured in phases of increasing cost: Phase 1 (header parse), Phase 2 (PoW check), Phase 3 (chain linkage), Phase 4 (body validation). Cheap checks run first. DAGsocial should adopt: Phase 1 (signature verify — cheap), Phase 2 (PoW verify — cheap), Phase 3 (DAG linkage/parent-hash integrity — moderate), Phase 4 (content type/size validation — variable cost). A post failing Phase 1 is discarded without touching the DAG graph.

### 1.3 Validate, don't trust (independently recompute)
**Source:** voting.md (Validator wiring)

A block claiming to be valid at height H with parameters P must have P independently recomputed from the chain's own history. Mismatch = reject. For DAGsocial: a post's claimed parent hash must be verified by independently hashing the parent. Never trust self-reported fields without verification.

### 1.4 Never add checks the reference node lacks
**Source:** validation.md (BlockVersion gate)

Extra validation rules beyond the protocol spec create fork surfaces. Every rule must be either (a) specified in the protocol spec or (b) explicitly local-policy-only with no consensus implications.

### 1.5 Sort-order determinism
**Source:** validation.md, state.md

Any operation feeding a Merkle tree or content hash must have a deterministic sort order identical across all implementations. For DAGsocial: post ordering within multi-parent structures must be deterministic and documented.

### 1.6 Two watermarks (indexed vs. validated)
**Source:** validation.md (Watermarks)

The node tracks `state_applied_height` and `script_verified_height` with the invariant `script_verified <= state_applied <= downloaded <= chain_height`. DAGsocial should track: `post_indexed_height` (bytes stored, hash verified) and `post_validated_height` (content checks passed). External queries serve only up to `post_validated_height`.

### 1.7 Malformed input swallow parity
**Source:** chain.md (block_proposed_update normalization)

If a field is malformed but the reference implementation ignores it (e.g., unknown extension key), do NOT reject the post. Mirror the error handling of the canonical implementation exactly.

### 1.8 Parse before allocate
**Source:** nipopow.md

Every incoming message body is validated for maximum size BEFORE allocating a buffer. "Every byte from a peer is adversarial." Reject oversized messages before allocation.

### 1.9 Expiring invalidation cache
**Source:** mempool.md

An `ExpiringCache<K>` stores recently-invalidated IDs with a TTL. Absorbs DoS from repeated invalid submissions. DAGsocial should cache recently-rejected post IDs to avoid re-validating them.

---

## 2. State & Storage

### 2.1 Single-transaction atomic writes
**Source:** state.md (Design Principles), store.md

Every update is a single write transaction: nodes, undo records, and metadata committed atomically. No partial writes. For DAGsocial's SQLite: every post insertion that touches posts, edges, indexes, and scores must happen in a single transaction. WAL ensures either the full insertion is there or nothing.

### 2.2 Opaque storage layer (bytes-in, bytes-out)
**Source:** store.md

The store trait stores `(type_id, modifier_id, height, data)` tuples without parsing, validating, or interpreting domain types. DAGsocial's SQLite store should treat posts as opaque tuples. Validation lives in a separate layer.

### 2.3 Backend-agnostic interface
**Source:** store.md

The public trait (`ModifierStore`) is implemented by `redb`. A different backend is a new `impl` of the same trait. DAGsocial: define a `PostStore` TypeScript interface, implement with SQLite. Swap in an in-memory implementation for testing.

### 2.4 Schema-versioned with hard refusal on mismatch
**Source:** indexer.md

The `indexer_state` table carries a `schema_version` row. Code refuses to start against an incompatible version. DAGsocial: store `schema_version` in `dag_meta`, check at startup, refuse on downgrade.

### 2.5 `dag_meta` KV table for migration sentinels
**Source:** store.md (chain_meta table)

A tiny KV store inside the database for migration sentinels, feature flags, and per-chain-state values. DAGsocial should add:
```sql
CREATE TABLE dag_meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
```
Use for: migration sentinels (`scores_backfill_v1`), current DAG tip hash, schema version, last PoW-validated sequence number.

### 2.6 Lazy loading with LRU cache + loader fallback
**Source:** chain.md (Lazy header store), state.md

The tree starts with only the root in memory. Child nodes loaded on demand via a `Resolver` callback. For DAGsocial: never materialize the full DAG in memory. Keep an LRU cache of ~10K recent posts. Misses fall through to SQLite.

### 2.7 Undo log for rollback
**Source:** state.md (Design Principles)

Every version records what was removed and inserted. Rollback replays undo records in reverse. For DAGsocial: if implementing soft-delete or pruning, store undo records for fork recovery.

### 2.8 Restore from store (no per-post re-validation)
**Source:** chain.md (Chain restore)

After a restart, the in-memory index is reconstructed from stored metadata without re-hashing or re-verifying every post. Store enough metadata at write time that recovery is a scan, not a recomputation.

### 2.9 Write-through cache, no invalidation gap
**Source:** chain.md (Cache invariants)

Every mutation updates the cache in lockstep with canonical state. A cache hit is never stale. For DAGsocial: in-memory DAG cache must be write-through. Never have a window where SQLite is updated but the cache isn't.

### 2.10 Narrow writes for backfill operations
**Source:** store.md (put_header_score)

For bulk score/hash recalculations, use narrow SQL `UPDATE` statements touching only the column that needs changing. Batch into transactions of ~50,000 rows. Never rewrite entire post rows for a single-field update.

### 2.11 Fork-aware storage (multi-header at same height)
**Source:** store.md, reorg.md

Headers have dedicated multi-table layout so multiple headers can exist at the same height. Best chain is a view. DAGsocial: maintain `post_score` table and `canonical_branch` table. Multiple posts can exist at the same DAG depth; canonical ordering is by cumulative PoW.

### 2.12 Reorg through the same write path
**Source:** store.md (Reorg handling through put_batch)

No dedicated "switch chain" API. Reorgs re-emit every new-branch post via the same `put_batch` method. One code path, one set of invariants.

### 2.13 Pruning with idempotency and structural-data protection
**Source:** store.md

Prune old content blobs below a horizon, but never prune structural data (DAG edges, author keys, scores). Prune is atomic, idempotent, and explicitly rejects structural types.

### 2.14 Peer database co-located in the same store
**Source:** store.md

Peer records live in the same transactional database as chain data — crash-safe alongside everything else. DAGsocial: store peers in a `peers` table in the same SQLite file.

---

## 3. Chain/DAG Organization

### 3.1 Best chain is a view, not structural
**Source:** reorg.md (Design Decision)

All validated headers kept permanently. Reorg is a local operation over stored data, never a network round-trip. Fork branches stored locally. For DAGsocial: never delete valid posts from alternative branches. The canonical DAG view is a derived index.

### 3.2 Cumulative score as tiebreaker
**Source:** chain.md, reorg.md

"Strictly greater score wins. Equal score = no reorg. First-seen chain wins on ties." For DAGsocial: when ordering multiple branches at the same DAG depth, use cumulative PoW. Equal work = stick with first-seen.

### 3.3 Atomic reorg
**Source:** reorg.md (Invariants)

"Either the in-memory chain AND the store both switch, or neither does." For DAGsocial: DAG head switch must atomically update both in-memory graph and SQLite canonical view. Two-phase: update memory, update store, if store fails roll back memory.

### 3.4 Reorg floor
**Source:** chain.md (reorg_floor)

Chains installed from a bootstrap proof have a `reorg_floor()` — cannot unwind past the snapshot depth. DAGsocial: if bootstrapping from a snapshot at depth D, reorgs to depths < D must be rejected.

### 3.5 Watermark reset on reorg
**Source:** reorg.md (Watermarks on reorg)

When reorg hits validated_height: reset watermarks to fork_point, re-scan forward. If rollback fails, watermarks stay unchanged — never advance onto inconsistent state.

### 3.6 Reorg notification via unbounded channel
**Source:** reorg.md (Reorg notification)

Reorg events use an unbounded channel — must never be dropped. Sync loop polls it with priority. DAGsocial: DAG head changes must be communicated via a channel that cannot drop events.

### 3.7 Fork pre-fetching near tip
**Source:** reorg.md (Block section download strategy)

Near the tip, request sections for ALL headers at each height including forks. Far from tip, best-chain only. DAGsocial: pre-fetch content for known alternative branches near the DAG head.

### 3.8 Parent-linkage verification on every insert
**Source:** indexer.md (Reorg detection)

On every new post, verify parent_id(s) exist in local DAG and are consistent with the last indexed post. Mismatch triggers fork-point search and rollback. Automatic reorg detection.

### 3.9 Deterministic cascade delete order for rollback
**Source:** indexer.md

When rolling back, delete in specific order to respect foreign keys: scores → tags → edges → posts. Documented as contract. Future migrations must update the cascade.

---

## 4. Mining / PoW

### 4.1 Two-phase PoW with candidate caching (two slots)
**Source:** mining.md

CandidateBlock template produced by node (expensive), miners poll for it (cheap), submit solutions. Two candidate slots: `cached` (current) and `previous` (superseded). Miners with stale work can still submit against previous. DAGsocial: matches your design — validate the two-slot + latch pattern.

### 4.2 Solved-block latch (at-most-one submission)
**Source:** mining.md (SolvedLatch)

A `solved` latch prevents accepting a second solution for the same height. Atomic compare-and-set. Non-atomic check-then-set has a race window exploitable at low difficulty. DAGsocial: acquire an atomic latch keyed on `(post_hash, author)` when accepting a solution.

### 4.3 Block-application hook (cleanup on every applied block)
**Source:** mining.md (on_block_applied)

`on_block_applied` runs for EVERY applied block (own or peer). Drops candidates whose parent_id doesn't match the new tip, clears the solved latch. DAGsocial: on new post acceptance, clean up stale candidates.

### 4.4 Byte-identical header serialization
**Source:** mining.md (Step 8: Derive WorkMessage)

HeaderWithoutPow serialization must match byte-for-byte across implementations. Byte-level divergence = miners produce invalid solutions. DAGsocial: define a strict canonical byte serialization for the post pre-image. Test against golden vectors.

### 4.5 Validated height, not header height, for candidate serving
**Source:** mining.md (Height source)

Candidate cache keyed on validated height, not header chain height. Querying header height fails when headers lead validation (the normal transient state). DAGsocial: PoW template generation uses validated head, not latest-seen gossip post.

### 4.6 Prover rollback after template computation
**Source:** mining.md (Required Interface Additions)

`proofs_for_transactions()` saves digest, applies operations, captures result, rolls back. "Never leaves the prover in a modified state." DAGsocial: compute post templates on a clone or with save/rollback. Never mutate canonical state during template generation.

---

## 5. Consensus / Voting

### 5.1 Receiver MUST independently recompute parameters
**Source:** chain.md (Phase 6), voting.md

Epoch-boundary blocks carry parameters. Validator recomputes `compute_expected_parameters(height)` from own history and verifies byte-for-byte match. Mismatch = reject. DAGsocial: any protocol parameter upgrade must be independently recomputable by every node from post history.

### 5.2 Active parameters advance only at epoch boundaries
**Source:** chain.md (Voting invariants)

Parameters change only at predetermined checkpoints. Within a checkpoint interval, parameters are frozen. DAGsocial: protocol parameters change at configurable sequence intervals, not per-post.

### 5.3 Post-reorg parameter rollback
**Source:** chain.md

After reorg past an epoch boundary, roll back parameters to values at the new tip. The recompute path must be the same as for a fresh sync.

### 5.4 Pure consensus seams
**Source:** chain.md (Pure consensus seams)

All consensus-critical functions (tally, difficulty adjustment) are PURE: all settings arrive as arguments, never read from global presets. Enables conformance testing. DAGsocial: PoW verify, difficulty adjust, vote counting should be pure functions.

### 5.5 Conformance testing against reference outputs
**Source:** chain.md (SANTA tier)

Multiple consensus bugs found by a conformance test runner feeding graded test vectors and comparing outputs byte-for-byte against JVM. DAGsocial: build a conformance suite against golden files.

### 5.6 Vote tally must match reference exactly (seeded tally)
**Source:** chain.md (count_votes_in_epoch)

Tally is SEEDED from the epoch's opening boundary. Non-zero votes enter with count 1. Subsequent headers only increment already-seeded IDs. A seemingly trivial simplification (unseeded counter) causes a consensus fork.

### 5.7 Tally order is consensus-relevant
**Source:** chain.md

The tally is an ORDERED sequence, not a map. Entry order determines LAST-WRITE-WINS outcome. HashMap makes that nondeterministic. DAGsocial: any aggregate with consensus implications must use deterministic ordering.

---

## 6. API Design

### 6.1 Facade pattern — zero business logic in HTTP layer
**Source:** api.md

The API crate is a "thin facade over existing components" with "zero business logic." Handlers validate input, call a component method, serialize the result. DAGsocial: Express handlers should be thin — validate, delegate to service, serialize. All logic in dedicated modules callable from CLI, cron, WebSocket.

### 6.2 Bounded queries — every list endpoint has a hard limit cap
**Source:** api.md

Default 50, hard cap 100. Values beyond cap silently clamped. No unbounded iteration. DAGsocial: every paginated endpoint must have `max: 100`. Out-of-range offset returns `[]`, not 404.

### 6.3 Separate listeners for public vs. admin/stats traffic
**Source:** api.md, stats.md

Public API on `0.0.0.0:9053`, stats on `127.0.0.1:9055`. Loopback bind is a layer-3 security boundary. DAGsocial: run two Express servers — public on `0.0.0.0:PORT`, admin/stats on `127.0.0.1:ADMIN_PORT`.

### 6.4 Standardized error envelope
**Source:** api.md

All errors: `{ "error": <http_code>, "reason": "<human>", "detail": "<optional technical>" }`. `reason` is safe to show users; `detail` restricted in production. DAGsocial: use a single error shape everywhere. Global error-handling middleware.

### 6.5 API key hashing with blake2b and constant-time comparison
**Source:** api.md

API key is blake2b256-hashed in config, stored as hash. Submitted key is hashed and compared in constant time. DAGsocial: hash admin API keys with blake2b, compare with `crypto.timingSafeEqual`.

### 6.6 503 for not-yet-ready subsystems
**Source:** api.md

Transaction submission returns 503 during sync. Mining returns 503 when no candidate. Modifier ingest returns 503 when channel full. Not 500. DAGsocial: return 503 when DAG store initializing, PoW verifier not caught up, or no peers connected.

### 6.7 HEAD for existence checks
**Source:** api.md

`HEAD /transactions/unconfirmed/{tx_id}` checks existence without transferring a body. DAGsocial: `HEAD /posts/:id` for lightweight existence checks.

### 6.8 Batch lookup with positional nulls
**Source:** api.md

`POST /utxo/withPool/byIds` returns positional results — missing IDs → `null` at index. Whole batch not rejected for one bad ID. DAGsocial: batch post lookup returns `null` at index for missing posts.

### 6.9 Fire-and-forget for async actions
**Source:** api.md

`POST /peers/connect` returns "queued" immediately. Actual connect happens async. DAGsocial: peer connect, sync trigger, PoW verification return "accepted" immediately, complete async.

### 6.10 Writes only through service-layer functions
**Source:** api.md

API crate never mutates chain, state, or store directly. Only through `mempool.process()`. DAGsocial: Express handlers never directly mutate SQLite. All writes go through `postService.create()`, etc.

### 6.11 Dependency injection at construction time
**Source:** api.md

API server receives shared state handles at construction. No global singletons. DAGsocial: Express setup accepts typed config object (db, DAG store, PoW verifier, peer manager).

### 6.12 OpenAPI 3.1 with separate rationale document
**Source:** api.md, openapi.yaml

Cross-cutting rationale in prose doc (`api.md`). OpenAPI specifies per-endpoint contract only. DAGsocial: maintain `docs/api.md` for rationale, `docs/openapi.yaml` for structural spec.

### 6.13 Reusable parameters and schemas via `$ref`
**Source:** openapi.yaml

Parameters (`Offset`, `Limit`, `PostIdPath`) defined once, referenced everywhere. Every schema has explicit `required` array. `operationId` on every endpoint. DAGsocial: adopt all three.

---

## 7. Metrics & Observability

### 7.1 Cumulative counters with `since` timestamp
**Source:** stats.md

All counters cumulative since process start. `since` (Unix seconds of start) included. Consumers compute deltas. Reset detectable by `since` change. DAGsocial: expose cumulative counters with `since` on admin loopback endpoint.

### 7.2 Structured journal events with stable marker contracts
**Source:** journal-events.md

Events have stable marker prefixes, fixed field sets, and stability classifications (`stable` vs `experimental`). Parsers match by marker prefix, not human-readable text. DAGsocial: define a `journal-events.md` contract listing every structured event. Use JSON-line format from day one.

### 7.3 Lifecycle events: starting, ready, shutting down
**Source:** journal-events.md

`node_starting` (first line before any I/O), `node_ready` (all subsystems up), `shutdown_signal_received`, `node_shutting_down`. DAGsocial: emit `server_starting`, `server_ready`, `shutdown_signal_received`, `server_shutting_down`.

### 7.4 Paired `_started`/`_complete` events for phase timing
**Source:** journal-events.md

Startup phases have paired events. Adapters compute duration as wall-clock delta. Deterministic order. DAGsocial: every init phase (DB open, DAG load, PoW init, libp2p start, API bind) emits a pair.

### 7.5 `validation_stuck` event for silent retry loop detection
**Source:** journal-events.md

WARN event when validated frontier fails to advance past the same height for 5+ consecutive sweeps. DAGsocial: add stuck-detection for DAG validation/PoW verification loops.

### 7.6 Penalty events for misbehaving peers
**Source:** journal-events.md

`peer_penalised` at WARN with peer, kind (`invalid_pow`, `header_parse_failed`), and detail. DAGsocial: emit when peer sends invalid DAG, fails PoW, or violates protocol.

### 7.7 Drift detection event on startup
**Source:** journal-events.md

`validated_height_drift` emitted at most once at startup when two databases disagree. DAGsocial: on startup, compare DAG store tip vs SQLite metadata. Emit event if they disagree.

### 7.8 Health endpoint that must NOT touch the database
**Source:** indexer.md

`GET /api/v1/health` reads ONLY in-memory state. Must NOT query DB. Always returns 200. Health judgment (thresholds on lag) is the caller's job. DAGsocial: `/health` returns in-memory metrics only, always 200.

### 7.9 Wire-level byte counting
**Source:** stats.md

`bytes` counter includes framing (magic + code + length + checksum + body). Operators graph real link utilization. DAGsocial: count bytes at transport/framing level when libp2p is added.

### 7.10 `unknown` counter as upgrade-pressure signal
**Source:** stats.md

Non-zero `unknown.in.count` means peers are sending protocol codes from a newer version. DAGsocial: add `unknown_message_types` counter for unrecognized libp2p messages.

---

## 8. P2P Networking (Future: libp2p phase)

### 8.1 Two-phase outbound manager (Floor / Fill)
**Source:** p2p-node.md

Below `min_peers`: aggressive seed dialing (Floor). Above `min_peers`: slow trickle from PeerDb every 30s (Fill). DAGsocial: layer this on top of libp2p's ConnectionManager.

### 8.2 Seed list is sole bootstrap source in Floor phase
**Source:** p2p-node.md

During Floor, only seeds dialed. PeerDb not consulted. Prevents bootstrap from stale/malicious peers. DAGsocial: maintain bootstrap node list separate from general peer store.

### 8.3 Peer state machine — no event leakage from non-Active peers
**Source:** p2p-protocol.md

States: Connecting, Handshaking, Active, Disconnected, Failed. Every ProtocolEvent is associated with a valid, handshaken peer. Security boundary. DAGsocial: messages from non-Active peers rejected before reaching the router.

### 8.4 Local-serve-before-relay for content requests
**Source:** p2p-routing.md

Incoming ModifierRequest checks local store first via callback. Only missing IDs fall through to relay. Regression: nodes relayed instead of serving. DAGsocial: always check local SQLite before forwarding post requests.

### 8.5 Penalty attribution via peer_id on every message
**Source:** p2p-node.md

Router includes `peer_id` on `Action::Validate`. Validation failure → penalty attributed to sender. DAGsocial: track which peer sent each post. Attribute validation failures to sender.

### 8.6 Frame envelope with magic, code, length, checksum
**Source:** p2p-transport.md

Every frame: `[magic:4][code:1][length:4 BE][checksum:4][body:N]`. Checksum = first 4 bytes of blake2b256(body). DAGsocial: for custom protocol on libp2p streams, adopt this envelope. Uses blake2b (already in DAGsocial).

### 8.7 Maximum frame body size enforced before allocation
**Source:** p2p-transport.md, nipopow.md

Frames >256KB rejected. Size checked before allocating buffer. DAGsocial: enforce max message size before reading full body. Cap appropriate for social media posts.

### 8.8 Bogus addresses in gossip silently dropped, not punished
**Source:** p2p-routing.md

Valid entries alongside bogus addresses: bogus dropped, valid ingested, sender NOT penalized. NAT'd peers with private addresses is normal, not malice. DAGsocial: distinguish "bogus address" (non-punishable) from "malformed protocol message" (permanent ban).

### 8.9 Unknown message codes preserved, not dropped
**Source:** p2p-protocol.md

Unrecognized message → `Unknown` variant preserving raw payload. Forward compatibility. DAGsocial: map unknown message types to generic container. Never throw on unrecognized types.

### 8.10 Unknown feature IDs preserved and relayed
**Source:** p2p-protocol.md

Unknown feature IDs stored as `Feature { id, body }` and re-gossiped. Forward-compatible feature propagation. DAGsocial: preserve and relay unknown capability flags in peer records.

### 8.11 PeerDb soft cap with LRU eviction
**Source:** p2p-peerdb.md

Configurable cap (default 1000). LRU eviction on overflow. DAGsocial: cap peer store, evict least-recently-seen.

### 8.12 Pcap-based message capture for debug
**Source:** p2p-capture.md

Mmap-backed ring buffer capturing every frame in pcap format. Zero overhead when disabled. DAGsocial: implement capture facility for protocol debugging. pcap or newline-delimited JSON. Off by default.

### 8.13 Non-blocking everywhere on the hot path
**Source:** p2p-node.md

`send_to` never blocks. `broadcast_outbound` never blocks. Event subscriber drops when full. DAGsocial: all P2P message processing must be non-blocking.

### 8.14 Session magic / network identifier in handshake
**Source:** p2p-transport.md

Handshake validation: version >= minimum AND session magic matches configured network. Prevents testnet↔mainnet cross-connection. DAGsocial: include network identifier in handshake.

### 8.15 Distinguish permanent bans from transient backoff
**Source:** p2p-node.md, p2p-peerdb.md

Permanent ban → `PeerDb::forget()`. Transient failure → cooldown only. Separate data structures. DAGsocial: separate tables/structures for banned, backoff'd, and rate-limited peers.

---

## 9. Sync Protocol (Future: cross-node sync)

### 9.1 Dependency inversion via traits
**Source:** sync.md

Sync crate defines `SyncTransport`, `SyncStore`, `SyncChain` traits. Zero knowledge of concrete P2P or chain types. DAGsocial: gossip engine depends on interfaces (`PostStore`, `PostDag`, `Transport`), not on SQLite or libp2p directly.

### 9.2 Biased event-driven loop (control > data > timers)
**Source:** sync.md

`tokio::select!` with `biased;` — control events checked before data events before timers. Control events: unbounded channel, never dropped. Data events: bounded, lossy. DAGsocial: gossip loop prioritizes control (peer disconnect, reorg) over data (post received).

### 9.3 Header-first sync, body backfill
**Source:** sync.md, jvm-reorg-spec.md

Separate header download from body download. Headers small/high-priority; bodies large/low-priority. DAGsocial: sync post metadata first (parent refs, author, PoW), backfill content bodies after DAG structure known.

### 9.4 Bidirectional serving required from day one
**Source:** sync.md

Regression: from-genesis peer stalled forever because no peer had ever needed to sync FROM a Rust node. Only consume side existed. DAGsocial: every node must implement both consumer and server sides of sync from day one.

### 9.5 Store-first modifier serving
**Source:** sync.md

Regression: node with 11 GB store answered requests by asking others instead of serving from its own store. DAGsocial: incoming post request checks local SQLite first. Only missing posts forwarded.

### 9.6 Stall detection and peer rotation
**Source:** sync.md

Track stalled peers. On stall, rotate to any outbound peer not in set. On progress, clear set. All stalled → clear and retry. DAGsocial: simple peer rotation on timeout. Clear-on-progress heuristic.

### 9.7 Bootstrap mode / fastsync
**Source:** sync.md

Optional external process fetches via REST from multiple peers in parallel. Process boundary = zero dependency on main crate. Missing binary = fall back to P2P. DAGsocial: consider REST-based bulk catch-up for long-offline nodes.

### 9.8 At-tip storage reopen (smaller cache for steady state)
**Source:** sync.md

Once within 16 blocks of tip, reopen DB with smaller cache to reduce RSS. One-shot handshake. DAGsocial: if bulk sync needs different SQLite cache than steady-state gossip, swap configs at the boundary.

### 9.9 Cross-database durability handshake
**Source:** sync.md

Two independent databases. On flush: [data DB immediate] → [index DB immediate-with-watermark] → [index DB flush]. Startup reconciles heights with decision tree (4 branches). DAGsocial: if using multiple DB files, adopt this pattern.

### 9.10 Graceful shutdown with explicit signal
**Source:** sync.md

`oneshot::Sender<()>` for shutdown. `run()` races `run_inner()` against shutdown receiver, then unconditionally runs `shutdown_flush()`. Never rely on reference-count drops as shutdown signal. DAGsocial: use `AbortSignal` or explicit shutdown channel. Host awaits task completion with timeout before tearing down shared resources.

---

## 10. Migrations & Operations

### 10.1 Separate binary for migration tool
**Source:** indexer-migration.md

Migrator is a separate binary, not a daemon subcommand. Shares schema types but runs independently. DAGsocial: `dagsocial-migrate` as separate CLI tool. Verifies daemon is stopped before proceeding.

### 10.2 Resumable migration with checkpoint keys
**Source:** indexer-migration.md

Three keys: `migration_cursor` (last copied height), `migration_source` (source URL), `migration_source_fingerprint` (blake2b256 of source content at fixed height). Each catches a different resume hazard. DAGsocial: adopt the three-key checkpoint pattern.

### 10.3 Six precondition checks before resume
**Source:** indexer-migration.md

Target schema version match, checkpoint keys exist, source URL matches, source fingerprint matches, spot-check hash at cursor. Any failure → diagnostic. DAGsocial: adopt precondition checks before resuming migration.

### 10.4 Per-sequence transaction with cursor update
**Source:** indexer-migration.md

For each sequence: INSERT, UPDATE, UPDATE cursor, COMMIT. Cursor never ahead of actual data. DAGsocial: migrate one sequence at a time in a single transaction.

### 10.5 `.start-height` dotfile — one-shot resume
**Source:** indexer.md

Dotfile in DB directory read at startup, value applied, dotfile deleted. Delete-before-apply ensures strictly one-shot. DAGsocial: `.reset-sequence` dotfile for one-shot re-index operations.

### 10.6 Configuration precedence chain
**Source:** indexer.md

Defaults < config file < env vars < CLI flags. Each key resolves independently. DAGsocial: use `cosmiconfig` or simple precedence resolver.

### 10.7 Required key with no default — exit with diagnostic
**Source:** indexer.md

`storage.db` REQUIRED, no default. Exit with clear message if missing. "Too operationally important to silently default to a relative path." DAGsocial: database path must be explicitly configured.

### 10.8 Malformed config → exit non-zero; missing config → log and continue
**Source:** indexer.md

Config file exists but fails parse: exit with diagnostic. Config file doesn't exist: log info, continue with defaults. DAGsocial: malformed config is always fatal. Missing config is harmless.

### 10.9 Passwords never in config files
**Source:** indexer.md

`PGPASSWORD` from env var or `~/.pgpass` — never config file. DAGsocial: private keys, API tokens never in config files. Use env vars or separate key files.

### 10.10 Non-interactive guard — refuse without `-y` when stdout is not a TTY
**Source:** indexer-migration.md

Non-TTY context AND `-y` not set → refuse with diagnostic. Prevents accidental yes-by-redirection. DAGsocial: destructive commands prompt for confirmation unless `-y` passed.

### 10.11 Progress output with dots and percentage boundaries
**Source:** indexer-migration.md

One `.` per 1000 items. Percentage boundaries terminate line with `(N%)`. Flush after each dot. DAGsocial: dot-per-N pattern for long-running maintenance operations.

---

## 11. General Architectural Patterns

### 11.1 "Does NOT own" sections on every component
**Source:** chain.md, state.md, validation.md, mining.md, sync.md, mempool.md, store.md

Every component explicitly lists what it does NOT own. Prevents scope creep, clarifies integration boundaries. DAGsocial: every package should have an explicit "Does NOT own" section.

### 11.2 SPECIAL profile ratings per component
**Source:** state.md, validation.md, mining.md, voting.md, mempool.md, nipopow.md

Safety, Performance, Edge-cases, Complexity, Internal-quality, Architecture, Luck rated 1-10. Guides review effort and risk assessment. DAGsocial: assign SPECIAL profiles to each package.

### 11.3 Precondition/postcondition documentation on every public function
**Source:** chain.md, state.md, validation.md, store.md

Every method documents preconditions and postconditions. "Preconditions: header.height == self.validated_height() + 1." "Postconditions on Ok: validated_height == header.height." DAGsocial: adopt for all DAG mutation functions and SQLite write paths.

### 11.4 No dependencies above the crate's abstraction level
**Source:** state.md (Dependencies)

State crate depends on redb + bytes, not on ergo-lib or ergo-chain-types. DAGsocial: storage layer depends only on SQLite bindings and blake2b. No post content types, networking, or UI code.

### 11.5 Invariants as first-class documentation
**Source:** sync.md, mempool.md, jvm-reorg-spec.md

Invariants documented with names, inequality chains, and failure-mode descriptions. DAGsocial: document invariants for every core data structure. Add runtime assertions (debug-only).

### 11.6 Startup reconciliation pattern
**Source:** sync.md

On startup, read two independent sources, compare, execute one of N reconciliation branches. Emit structured events with mode discriminator. DAGsocial: if multiple on-disk stores exist, implement startup reconciliation.

### 11.7 Graceful shutdown funnels every exit through flush
**Source:** sync.md

`run()` wraps `run_inner()` in race against shutdown signal. After either resolves, unconditionally runs `shutdown_flush()`. DAGsocial: every long-running task accepts AbortSignal, wraps main loop in race, unconditionally flushes after race resolves.

### 11.8 Fork of upstream for architectural fixes
**Source:** state.md (Resolver Strategy)

`Resolver` was a bare function pointer that couldn't capture state. Forked `ergo_avltree_rust` to change to `Arc<dyn Fn>`. DAGsocial: if a library has an architectural limitation blocking correct function, fork it. Document the fork, PR upstream.

### 11.9 Cost-bounded operations with documented complexity
**Source:** chain.md (build_nipopow_proof)

Every operation has documented O() bounds. Cache sizes justified by maximum expected input. DAGsocial: every DAG walk should have known complexity bounds.

### 11.10 Timestamps are untrusted; timing logic uses block height
**Source:** chain.md (Invariants)

"All timestamps are treated as untrusted data. Timing logic uses block height." DAGsocial: post timestamps from authors are untrusted. Timing-sensitive logic uses DAG depth or local wall clock.

### 11.11 Testing strategy documented in design docs
**Source:** api.md, snapshot.md, nipopow.md

Every component doc enumerates test categories. DAGsocial: write testing strategies in design docs. Include: unit tests with mocks, integration against in-memory SQLite, input validation fuzz tests, auth tests.

---

## Phased Adoption Roadmap

### Immediate (Phase 2 — current)
- [x] ~~Two-phase PoW~~ (already designed)
- [ ] Single-transaction atomic writes for post insertion
- [ ] `dag_meta` KV table for schema version + migration sentinels
- [ ] Schema-versioned store with hard refusal on mismatch
- [ ] Facade pattern enforced in Express handlers
- [ ] Standardized error envelope + global error middleware
- [ ] Bounded pagination with hard limit caps
- [ ] Separate admin/metrics listener on loopback
- [ ] Structured journal events (JSON-line) with marker contracts
- [ ] Lifecycle events: starting, ready, shutting down
- [ ] "Does NOT own" sections on each package

### Near-term (Phase 2 → 3)
- [ ] Opaque store interface (bytes-in/bytes-out)
- [ ] Backend-agnostic PostStore interface with in-memory test impl
- [ ] Write-through DAG cache with LRU eviction
- [ ] Fork-aware post storage (multi-post at same depth)
- [ ] Best-DAG-as-view over stored data
- [ ] Cumulative PoW score storage per post
- [ ] Two watermarks (indexed vs. validated)
- [ ] API key hashing with blake2b + timingSafeEqual
- [ ] Health endpoint (in-memory only, always 200)
- [ ] Cumulative stats counters with `since` timestamp
- [ ] Expiring invalidation cache for rejected posts

### P2P phase (libp2p integration)
- [ ] Two-phase outbound manager (Floor/Fill)
- [ ] Seed list as sole bootstrap source
- [ ] Peer state machine with Active-only message processing
- [ ] Local-serve-before-relay for content requests
- [ ] Penalty attribution per incoming message
- [ ] Frame envelope with blake2b checksum
- [ ] Max message size enforced before allocation
- [ ] Bogus address vs. malformed protocol distinction
- [ ] Unknown message/feature preservation
- [ ] PeerDb soft cap with LRU eviction
- [ ] Pcap-based message capture for debugging
- [ ] Non-blocking everywhere on P2P hot path
- [ ] Session magic in handshake
- [ ] Permanent ban vs. transient backoff separation

### Sync phase (cross-node sync)
- [ ] Dependency inversion via interfaces
- [ ] Biased event loop (control > data > timers)
- [ ] Header-first sync, body backfill
- [ ] Bidirectional serving from day one
- [ ] Stall detection and peer rotation
- [ ] Bootstrap mode / fastsync via REST
- [ ] Cross-database durability handshake
- [ ] Graceful shutdown with explicit signal
- [ ] Atomic reorg with store-level consistency
- [ ] Startup reconciliation pattern
