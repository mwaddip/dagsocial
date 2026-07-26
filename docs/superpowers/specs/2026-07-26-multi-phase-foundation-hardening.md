# multi-phase-foundation-hardening

**Date:** 2026-07-26
**Source:** Ergo node Rust practices report (`docs/ergo-node-practices-report.md`)
**Approach:** Dependency-chain phasing (each phase unlocks the next)
**Implementation:** Subagent-driven development, contracts updated first

## Overview

Adopt production-grade practices from the Ergo Rust node across 6 phases, each producing a working product. Every phase touches contracts first, then implementation. The dependency chain ensures each phase builds on verified infrastructure from the prior one.

## Pre-phase: Contract Updates

Before any implementation, update all affected contracts. This is a single pass so each phase has its spec ready.

### Contracts to update

| Contract | Sections affected |
|---|---|
| `contracts/NODE_INTERFACE.md` | Storage invariants, service layer, API design, observability, journal events |
| `contracts/TYPES_INTERFACE.md` | New types: `DagMetaEntry`, `JournalEvent`, `CanonicalBranch`, `PostScore`, `PostStore` interface |
| `contracts/NET_INTERFACE.md` | Biased event loop, stall detection, penalty attribution, peer state machine, local-serve-before-relay |
| `contracts/ARCHITECTURE.md` | Cross-cutting invariants from the Ergo report, `PostStore` as backend-agnostic trait, write-through cache invariant |

### Invariants from the Ergo report to adopt in ARCHITECTURE.md

- **No method panics on untrusted input** — every deserialization/signature-verification boundary returns `Result<T, E>`, never `unwrap()`
- **Validate, don't trust** — independently recompute hashes, parent pointers, signatures; never trust self-reported fields
- **Never add checks the reference lacks** — extra validation rules create fork surfaces; every rule is either protocol-spec or explicitly local-policy-only
- **Single-transaction atomic writes** — every post insertion (body + edges + indices + score) in one SQLite transaction
- **Best DAG is a view, not structural** — all branches stored, canonical ordering derived from cumulative PoW, reorgs are view updates
- **Sort-order determinism** — any operation feeding a Merkle tree or content hash must have documented, identical sort order across implementations
- **No dependencies above the package's abstraction level** — storage layer depends only on DB bindings and blake2b, never on post content types or networking
- **"Does NOT own" on every package** — explicit boundary documentation prevents scope creep
- **Timestamps are untrusted** — timing-sensitive logic uses DAG depth or local wall clock, never a remote post's self-reported timestamp
- **Precondition/postcondition documentation** on every public function in the store and service layers

---

## Phase 1: `dag_meta` + Schema Versioning

### Goal
One new table that enables safe migrations, startup consistency checks, and metadata centralization for all subsequent phases.

### What changes

**New table:**
```sql
CREATE TABLE dag_meta (
    key   TEXT PRIMARY KEY,
    value BLOB NOT NULL
);
```

**Schema versioning:**
- On startup: read `schema_version` from `dag_meta`
- If missing: assume v0, run pending migrations, write current version
- If higher than code expects: refuse with diagnostic `"Database schema version is X but this build expects Y. Downgrade is not supported."`
- If lower: run idempotent migrations to bring it up, each guarded by a sentinel key

**Immediate keys:**
| Key | Value | Purpose |
|---|---|---|
| `schema_version` | integer (LE bytes) | Version gate at startup |
| `dag_tip_hash` | 32 bytes | Current canonical DAG head |
| `last_validated_sequence` | integer (LE bytes) | Validation watermark |

**Future-phase sentinel keys (seeded now, used later):**
| Key | Phase |
|---|---|
| `atomic_writes_audit_v1` | Phase 2 |
| `facade_refactor_v1` | Phase 3 |
| `canonical_branch_migration_v1` | Phase 4 |

### Files touched
- `packages/node/src/store/db.ts` — `CREATE TABLE IF NOT EXISTS dag_meta`
- `packages/node/src/store/system.ts` — startup schema version check
- `packages/node/src/index.ts` — wire startup check before any other DB access

### Verification
- Startup against fresh database (no dag_meta) → creates table, writes v0, proceeds
- Startup against future version → refuses with diagnostic
- Startup against older version → runs migration, writes new version
- Kill -9 during migration, restart → migration re-runs idempotently

### Contract deliverables
- `contracts/NODE_INTERFACE.md` — storage section updated with dag_meta schema, invariants, startup version gate

---

## Phase 2: Atomic Writes + `PostStore` Interface

### Goal
Define a backend-agnostic store interface. Audit and harden every multi-table write path to guarantee atomicity. Support SQLite as the default backend, PostgreSQL as a deferred alternative.

### What changes

**2a. `PostStore` interface (new file: `packages/node/src/store/post-store.ts`)**

A TypeScript interface modeled on Ergo's `ModifierStore` trait — content-addressed, bytes-in/bytes-out. No domain types in the interface signature.

```typescript
interface PostStore {
  // Atomic batch write — all entries commit or none do
  putBatch(entries: StoreEntry[]): Promise<void>;

  // Single-entry put (idempotent — duplicate with same id is no-op)
  put(entry: StoreEntry): Promise<void>;

  // Lookup by content hash
  get(typeId: number, id: Uint8Array): Promise<Uint8Array | null>;

  // Check existence without reading full data
  has(typeId: number, id: Uint8Array): Promise<boolean>;

  // Best-chain queries (delegated to canonical_branch in Phase 4)
  bestPostAt(sequence: number): Promise<Uint8Array | null>;

  // Range scan for canonical branch (used at startup to rebuild in-memory view)
  canonicalBranchEntries(): Promise<Array<{ sequence: number; postId: Uint8Array }>>;

  // Chain metadata (delegated to dag_meta)
  metaGet(key: string): Promise<Uint8Array | null>;
  metaPut(key: string, value: Uint8Array): Promise<void>;

  // Peer records (co-located in same store for crash-safety)
  listPeers(): Promise<PeerRecord[]>;
  putPeer(peer: PeerRecord): Promise<void>;
  deletePeer(peerId: string): Promise<void>;

  // Pruning
  pruneBelowHorizon(horizon: number, typeIds: number[]): Promise<void>;
  minSequencePresent(typeId: number): Promise<number>;

  // Schema version
  schemaVersion(): Promise<number>;

  // Lifecycle
  close(): Promise<void>;
}

interface StoreEntry {
  typeId: number;
  id: Uint8Array;       // 32-byte blake2b hash
  sequence: number;      // caller-provided, store doesn't derive it
  data: Uint8Array;      // opaque serialized bytes
}

interface PeerRecord {
  peerId: string;
  lastSeenMs: number;
  addresses: string[];
  features: Uint8Array;
}
```

**2b. Audit and harden existing write paths**

Audit every write in `packages/node/src/store/` that touches multiple tables for a single logical operation:
- Post creation (posts + dag_edges + indexes + scores)
- Block application (posts + utxo + stumps + credits)
- Credit transfers
- Invite commit/redeem
- Karma operations

Each must be wrapped in a single `BEGIN IMMEDIATE ... COMMIT`. If any path does intermediate commits, fix it.

**2c. `putBatch` — the canonical write path**

All multi-row writes go through `putBatch`. No separate "upsert post" and "upsert edge" calls from callers. The store entry grouping is the transaction boundary.

**2d. Narrow writes**

Where existing code rewrites entire rows for single-field updates, switch to targeted `UPDATE`:
```sql
UPDATE post_scores SET cumulative_score = ? WHERE post_id = ?;
```

Batch narrow writes into transactions of ~50,000 rows for backfill operations.

**2e. Idempotent writes**

All inserts use `INSERT OR REPLACE` or `ON CONFLICT DO NOTHING` semantics. A duplicate post from gossip must not error.

### Files touched
- `packages/node/src/store/post-store.ts` — new interface file
- `packages/node/src/store/db.ts` — WAL pragmas, transaction helpers
- `packages/node/src/store/posts.ts` — audit, wrap in transactions
- `packages/node/src/store/utxo.ts` — audit, wrap in transactions
- `packages/node/src/store/system.ts` — audit
- `packages/node/src/services/` — update callers to use `PostStore` interface

### Verification
- Unit tests for `PostStore` with in-memory SQLite
- Crash-recovery test: begin multi-table write, kill -9, restart, verify consistency
- Duplicate post test: insert same post twice, verify idempotent
- Existing 630 tests continue to pass

### Contract deliverables
- `contracts/TYPES_INTERFACE.md` — `PostStore` interface specification
- `contracts/NODE_INTERFACE.md` — atomic write invariant, `putBatch` contract, WAL pragmas

---

## Phase 3: Facade Pattern + Validate-Don't-Trust

### Goal
Extract all business logic from Express handlers into a service layer. Move verification to service entry points so validation is a single choke-point, not duplicated across routes.

### What changes

**3a. Service layer extraction**

Create or harden service modules in `packages/node/src/services/`. Each service owns one domain concern:

| Service | Responsibility |
|---|---|
| `post-service.ts` | Create, verify (signature, PoW, DAG linkage, content), store |
| `feed-service.ts` | Query canonical DAG, paginate, assemble feed views |
| `identity-service.ts` | Key management, identity verification |
| `credit-service.ts` | Credit transfer validation and execution |
| `invite-service.ts` | Invite lifecycle (create, commit, redeem, cancel) |
| `faucet-service.ts` | Faucet allocation with rate limiting |
| `block-service.ts` | Block creation, validation, application |

**Handler → Service contract:**

Before:
```typescript
router.post('/posts', async (req, res) => {
  // validate body
  // verify signature
  // verify PoW
  // check parent refs
  // hash content
  // store in DB
  // build response
  // send
});
```

After:
```typescript
router.post('/posts', async (req, res) => {
  const result = await postService.create(req.body);
  res.status(200).json(PostDto.from(result));
});
```

The Express handler: validates input shape → delegates to service → serializes result. Zero domain logic.

**3b. Validate-don't-trust**

Every service entry point independently recomputes claims from incoming data:

- A post's `parentHash` field → independently hash the parent post bytes and compare
- A post's PoW solution → verify against the canonical difficulty for that depth
- A signature claim → verify with `crypto.verify(null, ...)` using the author's public key
- A credit transfer's claimed balances → recompute from the local UTXO view

The invariant: **"The store never receives data that hasn't been independently verified."**

**3c. Phased validation pipeline**

Validate in order of increasing cost:
1. Signature verification (cheap)
2. PoW verification (cheap)
3. DAG linkage / parent-hash integrity (moderate)
4. Content type/size/schema validation (variable cost, may be I/O-bound)

A post failing Phase 1 is rejected before Phase 2-4 run. This is especially important for content validation (Phase 4) which may involve deep content inspection.

**3d. Two validation watermarks**

Track two watermarks in `dag_meta`:
- `post_indexed_height` — bytes stored, hash verified, structurally linked into DAG
- `post_validated_height` — all content checks passed, safe for external queries

Invariant: `post_validated_height <= post_indexed_height <= dag_tip_height`

External queries serve only up to `post_validated_height`. Content validation can be deferred/parallelized without blocking DAG structure sync.

### Files touched
- `packages/node/src/routes/*` — strip business logic, delegate to services
- `packages/node/src/services/*` — new or hardened service modules
- `packages/node/src/verify.ts` — may move into validation package or service layer
- `packages/validation/src/verify.ts` — pure validation functions remain here

### Verification
- Handler unit tests: mock service, verify delegation and serialization
- Service unit tests: mock store, verify validation logic
- Integration tests: real store + real services, verify end-to-end
- Phased rejection tests: bad signature rejects before content validation runs

### Contract deliverables
- `contracts/NODE_INTERFACE.md` — service layer architecture, facade pattern, validation pipeline, watermark invariants
- `contracts/VALIDATION_INTERFACE.md` — phased validation, protocol vs. local-policy rules

---

## Phase 4: Best DAG as a View

### Goal
Store alternative branches. Derive canonical ordering from cumulative PoW. Make branch switching a view update — posts are never deleted.

### What changes

**4a. New tables**

```sql
-- Maps DAG depth to the canonical post at that depth
CREATE TABLE canonical_branch (
    depth    INTEGER PRIMARY KEY,
    post_id  TEXT NOT NULL
);

-- Cumulative PoW score per post
CREATE TABLE post_scores (
    post_id           TEXT PRIMARY KEY,
    cumulative_score  INTEGER NOT NULL
);

-- Alternative branch posts (non-canonical) that may become canonical later
-- Stored alongside main posts, distinguished by presence in canonical_branch
```

**4b. Branch storage**

Posts at the same DAG depth from different branches coexist in `posts` and `dag_edges`. The `canonical_branch` table maps depth → winning post. Alternative branch posts are stored identically — they just aren't in `canonical_branch`.

**4c. Cumulative score**

Each post carries `cumulative_score = parent_cumulative_score + work_proven_in_this_post`. Computed at write time, stored in `post_scores`. The score is the fork-choice tiebreaker:

- **Strictly greater score wins** — a new branch with higher cumulative score replaces the canonical branch from the fork point forward
- **Equal score = no reorg** — first-seen branch wins, no oscillation
- **No timestamps, no content hashes** in fork resolution — only accumulated work

**4d. Atomic reorg**

Switching canonical branches:
1. Find fork point (common ancestor of old and new tips)
2. Walk old branch from fork → old tip: remove entries from `canonical_branch`
3. Walk new branch from fork → new tip: insert entries into `canonical_branch`
4. All updates in a single SQLite transaction
5. Update in-memory DAG view after transaction commits
6. If transaction fails: in-memory view unchanged, retry or abort

**4e. Reorg invariants**

- **Reorg floor**: if the node started from a snapshot at depth D, reorgs to depths < D are rejected
- **Watermark reset**: on reorg past validated_height, reset watermarks to fork_point and re-validate forward
- **Reorg notification**: DAG head changes emitted via unbounded event channel, never dropped
- **Parent-linkage verification** on every insert: verify parent(s) exist in local DAG and are consistent with canonical branch at that depth. Mismatch → automatic fork-point search

**4f. Reorg event**

Emit `dag_reorg` journal event with:
- `fork_point` — common ancestor post ID
- `demoted` — number of posts removed from canonical branch
- `old_tip` — previous canonical tip
- `new_tip` — new canonical tip

### Files touched
- `packages/node/src/store/posts.ts` — new tables, canonical branch writes
- `packages/node/src/store/post-store.ts` — `canonicalBranchEntries()`, `bestPostAt()`
- `packages/node/src/services/post-service.ts` — score computation, reorg logic
- `packages/node/src/services/block-service.ts` — block-level branch switching

### Verification
- Unit tests for score computation and tiebreaking
- Reorg tests: create competing branches, verify canonical selection
- Atomic reorg test: kill -9 mid-reorg, restart, verify consistency
- Parent-linkage test: inject post with missing parent, verify rejection
- Watermark reset test: reorg past validated_height, verify watermark reset

### Contract deliverables
- `contracts/NODE_INTERFACE.md` — canonical branch, cumulative score, atomic reorg invariants
- `contracts/ARCHITECTURE.md` — best-DAG-as-view principle, fork-choice rules

---

## Phase 5: Operational Infrastructure

### Goal
Structured journal events with stable contracts. Separate admin/metrics listener on loopback.

### What changes

**5a. Journal events contract (`contracts/JOURNAL_EVENTS.md`)**

New contract file defining every structured log event. Each event has:
- **Marker prefix** — stable string identifier (e.g., `"post_validated"`, `"peer_penalised"`)
- **Level** — INFO, WARN, ERROR — part of the contract, stable per event
- **Fields** — fixed set of named fields with types
- **Stability** — `stable` or `experimental`
- **Emit precondition** — exactly when the event fires

**Minimum event set:**

| Event | Level | Fields | Precondition |
|---|---|---|---|
| `server_starting` | INFO | version, network | First line after logger init, before any I/O |
| `server_ready` | INFO | bind_address, admin_address | After all subsystems up |
| `shutdown_signal_received` | INFO | signal | On SIGTERM/SIGINT |
| `server_shutting_down` | INFO | reason | After flush, before process exit |
| `db_open_started` | INFO | path | Before opening SQLite |
| `db_open_complete` | INFO | schema_version, duration_ms | After schema version check passes |
| `dag_load_started` | INFO | — | Before rebuilding in-memory DAG view |
| `dag_load_complete` | INFO | post_count, duration_ms | After canonical branch loaded |
| `api_listening` | INFO | bind_address, port | After `app.listen()` succeeds |
| `post_received` | INFO | post_id, source (local/peer_id) | On post arrival (gossip or local API) |
| `post_validated` | INFO | post_id, validation_duration_ms | After all validation phases pass |
| `post_indexed` | INFO | post_id, depth | After post stored in DAG |
| `pow_verification_failed` | WARN | post_id, reason | On PoW check failure |
| `dag_reorg` | WARN | fork_point, demoted, old_tip, new_tip | After canonical branch switch |
| `validation_stuck` | WARN | post_id, reason, attempt_count | Same post fails 5+ consecutive sweeps |
| `dag_height_drift` | WARN | gap, mode, old_height, new_height | At most once at startup when DBs disagree |
| `peer_connected` | INFO | peer_id, direction | After handshake completes |
| `peer_disconnected` | INFO | peer_id, reason | On disconnect |
| `peer_penalised` | WARN | peer_id, kind, detail | On protocol violation |
| `sync_complete` | INFO | tip_height, duration_ms | First time synced after startup |
| `migration_started` | INFO | name, from_version, to_version | Before migration N begins |
| `migration_complete` | INFO | name, duration_ms, rows_affected | After migration N commits |

**Output format:** JSON-line (using `pino`). Marker prefix becomes `"event"` field:
```json
{"event":"post_validated","level":"INFO","post_id":"abc123","validation_duration_ms":2,"timestamp":"2026-07-26T..."}
```

**5b. Admin/metrics listener**

A second Express server/router on `127.0.0.1:ADMIN_PORT` (configurable, default e.g. `3001`). Logs a WARN if bound to non-loopback.

**Endpoints:**

`GET /health` — in-memory metrics only. Never touches the database. Always returns 200:
```json
{
  "status": "ok",
  "dag_tip_height": 12345,
  "validated_height": 12344,
  "indexed_height": 12345,
  "peers_connected": 8,
  "last_post_received_ms_ago": 234,
  "syncing": false,
  "uptime_seconds": 84200
}
```

`GET /stats` — cumulative counters with `since` (process start Unix timestamp):
```json
{
  "since": 1751400000,
  "statsVersion": "1.0",
  "counters": {
    "posts_created_total": 5432,
    "posts_validated_total": 5430,
    "pow_verifications_total": 6100,
    "pow_verification_failures_total": 2,
    "peer_messages_in_total": 89000,
    "peer_messages_out_total": 92000,
    "peer_bytes_in_total": 125000000,
    "peer_bytes_out_total": 131000000,
    "http_requests_total": 12000,
    "unknown_message_types_total": 0
  }
}
```

`GET /health` also advertises contract versions:
```json
{
  "apiVersion": "1.0",
  "journalEventsVersion": "1.0",
  "statsVersion": "1.0"
}
```

**5c. Stuck detection**

Track validation attempts per post. If the same post fails validation for 5+ consecutive sweeps, emit `validation_stuck` at WARN. This surfaces silent retry loops that would otherwise go undetected.

### Files touched
- `packages/node/src/journal.ts` — event emission helpers (or extend existing)
- `packages/node/src/server.ts` — admin listener setup
- `packages/node/src/index.ts` — lifecycle event emission
- `packages/node/src/config.ts` — `ADMIN_PORT`, `ADMIN_BIND_ADDRESS`
- New: `contracts/JOURNAL_EVENTS.md`

### Verification
- Admin listener not reachable from non-loopback
- Health endpoint returns 200 even when DB is locked/corrupted
- Stats counters increment correctly across post creation and validation
- Stuck detection fires after 5 consecutive failures
- Journal events parse as valid JSON-line

### Contract deliverables
- `contracts/JOURNAL_EVENTS.md` — new contract for all structured events
- `contracts/NODE_INTERFACE.md` — health/stats endpoints, admin listener

---

## Phase 6: Net Hardening

### Goal
Apply Ergo P2P practices to the existing net package. Prevent known regressions. This phase is the most speculative — implementation adjusts as libp2p integration deepens.

### What changes

**6a. Biased event loop**

The sync/gossip event loop must prioritize:
1. Control events (reorg notification, peer disconnect, new peer) — unbounded channel, never dropped
2. Data events (post received, post acknowledged) — bounded channel, lossy
3. Timer ticks — fallback

In TypeScript/Node.js, this maps to: control events on an `EventEmitter` or unbounded queue checked at the top of each loop iteration, data events on a bounded async queue with `tryPush` semantics.

**6b. Local-serve-before-relay**

Incoming `PostRequest` from a peer:
1. Check `PostStore.hasPost(typeId, id)` — if yes, serve from local store
2. Only if not found locally: relay to other peers via Inv table
3. Serve and relay are mutually exclusive per request ID — never both

The serve callback is injected into the router (doesn't live in the sync loop).

**6c. Penalty attribution**

Every incoming message tracks `sourcePeerId`. When validation fails:
- `peer_penalised` event emitted with `peer_id`, `kind`, `detail`
- Penalty system increments per-peer penalty counter
- Above threshold → permanent ban (remove from PeerDb, add to banned table)
- Transient failures → cooldown, not ban

Separate data structures for: permanently banned peers, temporarily backoff'd peers, rate-limited peers. Never conflate them.

**6d. Peer state machine**

States: `Connecting → Handshaking → Active → Disconnected | Failed`

Invariant: **No events leak from non-Active peers.** Messages from peers not in `Active` state are rejected before they reach the router. This is a security boundary.

**6e. Stall detection + peer rotation**

- Track peers that fail to deliver requested content within a timeout
- On timeout: mark peer stalled, rotate to next outbound peer not in stalled set
- On successful receipt from any peer: clear the stalled set (optimistic heuristic)
- All peers stalled: clear set and retry

**6f. Bogus vs. malformed distinction**

- Valid gossip with some non-routable addresses: silently drop bad entries, keep good ones, do NOT penalize sender
- Truly malformed protocol messages (cap exceeded, truncated body, invalid encoding): permanent ban of sender
- NAT'd peers with private addresses in gossip is normal, not malice

**6g. PeerDb hardening**

Check existing `peerdb.ts` against Ergo patterns:
- Soft cap with LRU eviction (default 1000)
- Self-address filtering (filter in memory, keep on disk — self-address today may be legitimate peer tomorrow)
- `lastSeenMs = Math.max(existing, new)` to prevent timestamp regression from out-of-order gossip
- Write-through persistence (every `record()` writes to store; failure logged, in-memory state becomes ephemeral)

### Files touched
- `packages/net/src/sync-machine.ts` — biased event loop, stall detection
- `packages/net/src/gossip.ts` — local-serve-before-relay, penalty attribution
- `packages/net/src/peer-mgr.ts` — peer state machine
- `packages/net/src/peerdb.ts` — hardening
- `packages/net/src/node.ts` — wiring

### Verification
- Unit tests for peer state machine transitions
- Stall detection: mock slow peer, verify rotation
- Serve-before-relay: inject post in local store, verify request served locally
- Penalty attribution: inject invalid post, verify penalty event emitted
- Bogus address test: gossip with mix of valid and private addresses, verify valid ingested, bogus dropped, sender not penalized

### Contract deliverables
- `contracts/NET_INTERFACE.md` — biased event loop, stall detection, penalty attribution, peer state machine, local-serve-before-relay, bogus-vs-malformed distinction

---

## Phase Dependency Summary

```
Pre-phase (contracts)
    ↓
Phase 1: dag_meta + schema versioning
    ↓
Phase 2: Atomic writes + PostStore interface
    ↓
Phase 3: Facade pattern + validate-don't-trust
    ↓
Phase 4: Best DAG as a view
    ↓
Phase 5: Operational infrastructure (independent of 4, but placed here so prior phases are observable)
    ↓
Phase 6: Net hardening (independent of 3-5, but placed last as net is most in flux)
```

Each phase produces a working product. Phases 5 and 6 are independent of 3-4 but ordered for observability coverage.

## Contracts Checklist

| Contract | Pre-phase | P1 | P2 | P3 | P4 | P5 | P6 |
|---|---|---|---|---|---|---|---|
| `ARCHITECTURE.md` | ✓ | | | | ✓ | | |
| `TYPES_INTERFACE.md` | ✓ | | ✓ | | | | |
| `NODE_INTERFACE.md` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `VALIDATION_INTERFACE.md` | | | | ✓ | | | |
| `NET_INTERFACE.md` | ✓ | | | | | | ✓ |
| `JOURNAL_EVENTS.md` (new) | | | | | | ✓ | |

---

## References

- `docs/ergo-node-practices-report.md` — full 120-practice extraction from 24 Ergo fact files
- `~/projects/ergo-node-rust/facts/` — source material (24 files, ~500KB)
- Ergo store contract: `store.md`, `state.md` — primary models for PostStore and atomic writes
- Ergo validation contract: `validation.md`, `chain.md` — phased validation, watermarks, validate-don't-trust
- Ergo reorg contract: `reorg.md`, `jvm-reorg-spec.md` — best-chain-as-view, atomic reorg, fork storage
- Ergo API contract: `api.md`, `stats.md`, `journal-events.md` — facade pattern, health endpoint, structured events
- Ergo P2P contracts: `p2p-node.md`, `p2p-routing.md`, `p2p-protocol.md`, `p2p-peerdb.md` — event loop, serve-before-relay, peer state machine
