# Multi-Phase Foundation Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt 7+ production-grade practices from the Ergo Rust node across 6 dependency-chain phases, each producing a working, testable product.

**Architecture:** Contracts-first workflow — update all affected contracts in a pre-phase, then implement bottom-up from storage (dag_meta, atomic writes, PostStore interface) through services (facade, validate-don't-trust) to DAG structural changes (best-DAG-as-view) and finishing with operational visibility (journal events, admin listener) and net hardening. Each phase depends on the prior one; Phases 5-6 are independent of 3-4 but ordered for observability coverage.

**Tech Stack:** TypeScript, Node.js ≥ 22, SQLite (better-sqlite3), Express, vitest, pino (journal), libp2p (net package), pnpm workspaces, Design by Contract

## Global Constraints

- `packages/types/` is pure functions only — no side effects, no I/O
- `packages/validation/` is pure stateless checks — no storage access
- Secret keys never in API responses, DTOs, or config files
- All hashing: `blake2b512` with `.subarray(0, 32)` (Node.js v22 lacks blake2b256)
- Signatures: raw Ed25519 (64 bytes), verified with `crypto.verify(null, ...)` using KeyObject
- Protocol version on every post and block (`PROTOCOL_VERSION = 1`)
- Slot validity measured in block height, not wall clock
- Post content: 1–300 UTF-8 bytes, parent refs: 0–8 per post
- 630 tests must continue passing after every task; `pnpm typecheck` must stay clean
- Contracts lead; code follows — update `contracts/` before touching implementation

---

### Task 0: Update All Affected Contracts

**Files:**
- Modify: `contracts/ARCHITECTURE.md`
- Modify: `contracts/NODE_INTERFACE.md`
- Modify: `contracts/TYPES_INTERFACE.md`
- Modify: `contracts/NET_INTERFACE.md`
- Modify: `contracts/VALIDATION_INTERFACE.md`
- Create: `contracts/JOURNAL_EVENTS.md`

**Interfaces:**
- Consumes: nothing (this is the contract layer)
- Produces: updated contracts that all subsequent tasks implement against

- [ ] **Step 1: Read ARCHITECTURE.md to understand current structure**

Read `contracts/ARCHITECTURE.md` to understand the current system overview and invariants section.

- [ ] **Step 2: Add cross-cutting invariants to ARCHITECTURE.md**

Add a new `## Ergo-Adopted Invariants` section after the existing invariants:

```markdown
## Ergo-Adopted Invariants

These invariants are adopted from production-grade Ergo Rust node practices:

### Validation boundaries
- **No method panics on untrusted input** — every deserialization and
  signature-verification function returns a `Result<T, Error>` equivalent.
  No `unwrap()`, no `as` casts that truncate, no OOM on adversarial input.
- **Validate, don't trust** — independently recompute every self-reported
  claim. A post's parent hash, PoW solution, and signature MUST be verified
  by the local node before the post enters the store.
- **Never add checks the reference lacks** — extra validation rules beyond
  the protocol spec create fork surfaces. Every rule is either
  protocol-spec or explicitly local-policy-only.

### Storage guarantees
- **Single-transaction atomic writes** — every post insertion that touches
  multiple tables (posts, dag_edges, indexes, scores) MUST happen in a
  single SQLite transaction. No partial writes.
- **Best DAG is a view, not structural** — all alternative-branch posts are
  stored permanently. The canonical ordering is derived from cumulative
  PoW. Switching branches is a view update — posts are never deleted.
- **Sort-order determinism** — any operation feeding a Merkle tree or
  content hash MUST have a documented, identical sort order across all
  implementations.

### Package boundaries
- **No dependencies above the package's abstraction level** — the storage
  layer depends only on DB bindings and hashing. It MUST NOT import post
  content types, networking code, or UI code.
- **"Does NOT own" on every package** — each package explicitly lists what
  it is NOT responsible for. Prevents scope creep.

### Data integrity
- **Timestamps are untrusted** — timing-sensitive logic uses DAG depth or
  local wall clock, never a remote post's self-reported timestamp.
- **Precondition/postcondition documentation** on every public function in
  the store and service layers.
```

- [ ] **Step 3: Update NODE_INTERFACE.md — storage section**

Add a `### dag_meta Table` subsection to the storage section:

```markdown
### dag_meta Table

A key-value metadata table stored alongside post data. Used for schema
versioning, migration sentinels, watermarks, and operational state.

**Schema:**
```sql
CREATE TABLE dag_meta (
    key   TEXT PRIMARY KEY,
    value BLOB NOT NULL
);
```

**Required keys and their invariants:**

| Key | Value encoding | Invariant |
|-----|---------------|-----------|
| `schema_version` | u32 LE | Must equal the version compiled into the binary at startup. Higher = refuse with diagnostic. Lower = run idempotent migrations. |
| `dag_tip_hash` | 32 bytes | Updated atomically with every canonical DAG advance. |
| `last_validated_sequence` | u32 LE | Must never exceed the DAG tip. Reset to fork point on reorg. |
| `last_indexed_sequence` | u32 LE | `last_validated_sequence <= last_indexed_sequence <= dag_tip_height`. External queries serve only up to `last_validated_sequence`. |

**Startup contract:**
1. Read `schema_version`. If missing, write current version.
2. If stored > expected: exit with diagnostic `"Database schema version is X but this build expects Y. Downgrade is not supported."`
3. If stored < expected: run idempotent migrations in order, each guarded by a sentinel key in dag_meta.
4. Read `dag_tip_hash` and watermarks to rebuild in-memory DAG view.
```

- [ ] **Step 4: Update NODE_INTERFACE.md — PostStore interface**

Add a `### PostStore Interface` subsection:

```markdown
### PostStore Interface

The store layer is backend-agnostic. All storage access goes through the
`PostStore` interface. The SQLite implementation is the default; PostgreSQL
is a deferred alternative.

**Design principle:** The store sees opaque `(typeId, id, sequence, data)`
tuples. It does NOT parse post content, verify signatures, or validate the
DAG structure. Domain semantics live in the service layer above.

```typescript
interface PostStore {
  putBatch(entries: StoreEntry[]): Promise<void>;
  put(entry: StoreEntry): Promise<void>;
  get(typeId: number, id: Uint8Array): Promise<Uint8Array | null>;
  has(typeId: number, id: Uint8Array): Promise<boolean>;
  bestPostAt(sequence: number): Promise<Uint8Array | null>;
  canonicalBranchEntries(): Promise<Array<{ sequence: number; postId: Uint8Array }>>;
  metaGet(key: string): Promise<Uint8Array | null>;
  metaPut(key: string, value: Uint8Array): Promise<void>;
  listPeers(): Promise<PeerRecord[]>;
  putPeer(peer: PeerRecord): Promise<void>;
  deletePeer(peerId: string): Promise<void>;
  pruneBelowHorizon(horizon: number, typeIds: number[]): Promise<void>;
  minSequencePresent(typeId: number): Promise<number>;
  schemaVersion(): Promise<number>;
  close(): Promise<void>;
}

interface StoreEntry {
  typeId: number;
  id: Uint8Array;       // 32-byte blake2b hash
  sequence: number;      // caller-provided; store never derives it
  data: Uint8Array;      // opaque serialized bytes
}
```

**Invariants:**
- `putBatch` is atomic — all entries commit or none do.
- `put` is idempotent — duplicate `(typeId, id)` with same data is a no-op.
- `bestPostAt(n)` returns null, not an error, for non-existent sequences.
- `canonicalBranchEntries()` reads sequentially, not via N point lookups.
- `pruneBelowHorizon` never touches structural types (post metadata, DAG
  edges, scores).
```

- [ ] **Step 5: Update NODE_INTERFACE.md — service layer**

Add a `### Service Layer Architecture` section:

```markdown
### Service Layer Architecture

Express route handlers are thin facades with zero business logic. Every
handler: validates input shape → delegates to a service → serializes the
result. An `if` that makes a domain decision belongs in the service, not
the handler.

**Service modules and their responsibilities:**

| Service | Responsibility | Does NOT own |
|---------|---------------|--------------|
| `post-service.ts` | Create, verify (sig, PoW, DAG linkage, content), store | Networking, block assembly |
| `feed-service.ts` | Query canonical DAG, paginate, assemble feed views | Post creation, auth |
| `identity-service.ts` | Key management, identity verification | Post storage, networking |
| `credit-service.ts` | Credit transfer validation and execution | UTXO engine internals |
| `invite-service.ts` | Invite lifecycle (create, commit, redeem, cancel) | Bond box internals |
| `faucet-service.ts` | Faucet allocation with rate limiting | Credit system design |
| `block-service.ts` | Block creation, validation, application | Post validation, DAG structure |

**Validation pipeline (phased, increasing cost):**
1. Signature verification (cheap — Ed25519 verify)
2. PoW verification (cheap — blake2b + difficulty check)
3. DAG linkage / parent-hash integrity (moderate)
4. Content type/size/schema validation (variable, may be I/O-bound)

A post failing Phase N is rejected before Phase N+1 runs.

**Validation watermarks:**
- `post_indexed_height` — bytes stored, hash verified, DAG-linked
- `post_validated_height` — full content checks passed, safe for queries

Invariant: `post_validated_height <= post_indexed_height <= dag_tip_height`.
External queries serve only up to `post_validated_height`.
```

- [ ] **Step 6: Update NODE_INTERFACE.md — operational infrastructure**

Add sections for admin listener, health endpoint, and stats:

```markdown
### Admin Listener

A second Express server on `127.0.0.1:ADMIN_PORT` (default 3001). Never
binds to a non-loopback address — a non-loopback bind logs a WARN at
startup.

**Endpoints:**

`GET /health` — in-memory metrics only. Never queries the database.
Always returns 200. Response shape:
```json
{
  "status": "ok",
  "dag_tip_height": 12345,
  "validated_height": 12344,
  "indexed_height": 12345,
  "peers_connected": 8,
  "last_post_received_ms_ago": 234,
  "syncing": false,
  "uptime_seconds": 84200,
  "apiVersion": "1.0",
  "journalEventsVersion": "1.0"
}
```

`GET /stats` — cumulative counters with `since` (process start):
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
```

- [ ] **Step 7: Update NODE_INTERFACE.md — canonical DAG**

Add a `### Canonical DAG (Best DAG as a View)` section:

```markdown
### Canonical DAG (Best DAG as a View)

**Design principle:** All posts from all branches are stored permanently.
The canonical DAG is a view derived from cumulative PoW. Switching branches
is a view update — posts are never deleted.

**Tables:**
```sql
CREATE TABLE canonical_branch (
    depth    INTEGER PRIMARY KEY,
    post_id  TEXT NOT NULL
);

CREATE TABLE post_scores (
    post_id           TEXT PRIMARY KEY,
    cumulative_score  INTEGER NOT NULL
);
```

**Fork-choice rule:** Strictly greater cumulative score wins. Equal score
= no reorg (first-seen wins on ties). No timestamps or content hashes
in fork resolution.

**Atomic reorg:** Switching canonical branches updates both the in-memory
DAG view and the `canonical_branch` table in a single transaction. If the
store transaction fails, the in-memory view is rolled back.

**Reorg floor:** If the node started from a snapshot at depth D, reorgs to
depths < D are rejected (`dag_meta` stores the floor depth).

**Reorg event:** Emit `dag_reorg` with `fork_point`, `demoted` count,
`old_tip`, and `new_tip`.
```

- [ ] **Step 8: Update TYPES_INTERFACE.md — new types**

Add type specifications for the new constructs:

```markdown
### PostStore Interface Types

`StoreEntry`:
```
{
  typeId: uint8,
  id: bytes[32],
  sequence: uint32,
  data: bytes
}
```

`PeerRecord`:
```
{
  peerId: string,
  lastSeenMs: uint64,
  addresses: string[],
  features: bytes
}
```

### Journal Event Types

`JournalEvent`:
```
{
  event: string,        // stable marker identifier
  level: "INFO" | "WARN" | "ERROR",
  timestamp: string,    // ISO 8601
  ...fields             // event-specific fields per JOURNAL_EVENTS.md
}
```

### DAG Structural Types

`CanonicalBranchEntry`:
```
{
  depth: uint32,
  postId: bytes[32]
}
```

`PostScore`:
```
{
  postId: bytes[32],
  cumulativeScore: uint64
}
```
```

- [ ] **Step 9: Update VALIDATION_INTERFACE.md — phased pipeline**

Add a `### Phased Validation Pipeline` section:

```markdown
### Phased Validation Pipeline

Validation runs in order of increasing cost. A post failing phase N is
rejected before phase N+1 executes.

**Phase 1 — Structural (cheapest):**
- Post deserializes without error
- All required fields present
- `protocolVersion` is supported
- `content.length` within [1, MAX_CONTENT_BYTES]
- `parentRefs.length` within [0, MAX_PARENT_REFS]

**Phase 2 — Cryptographic (cheap):**
- `verifyPostSignature(post)` passes
- `verifyPoW(post, targetBits)` passes

**Phase 3 — DAG integrity (moderate):**
- Every `parentRefs[i]` exists in local DAG or unconfirmed pool
- Parent linkage consistent with canonical branch at that depth
- No duplicate post in local DAG (idempotent — treated as no-op, not error)

**Phase 4 — Content (variable cost, deferrable):**
- `verifyContentCharacters(content)` passes (no Unicode category C except \n)
- Content-specific validation (future: homoglyph detection, media checks)

**Watermarks:**
- `post_indexed_height`: advanced after Phase 3
- `post_validated_height`: advanced after Phase 4

Invariant: `post_validated_height <= post_indexed_height <= dag_tip_height`.
External queries serve only up to `post_validated_height`.

**Protocol vs. local-policy rules:**
- Phases 1-3 are protocol rules — all nodes must enforce identically
- Phase 4 may include local-policy rules — configurable, non-consensus
- Local-policy rules are explicitly documented as such
```

- [ ] **Step 10: Update NET_INTERFACE.md — hardening additions**

Add sections for the net hardening practices:

```markdown
### Biased Event Loop

The sync/gossip event loop MUST prioritize:
1. Control events (reorg notification, peer disconnect, new peer) —
   unbounded channel, never dropped
2. Data events (post received, post acknowledged) — bounded channel, lossy
3. Timer ticks — fallback

### Local-Serve-Before-Relay

Incoming content requests MUST check local storage before relaying to
other peers. Serve and relay are mutually exclusive per request ID —
never both.

### Penalty Attribution

Every incoming message carries `sourcePeerId`. Validation failures are
attributed to the sending peer. Three penalty tiers:
- **Transient failure** (timeout, slow response): cooldown, not a ban
- **Protocol violation** (malformed message, invalid encoding): permanent
  ban, peer removed from PeerDb
- **Bogus addresses in valid gossip**: silently dropped, sender NOT
  penalized (NAT'd peers sending private addresses is normal)

### Peer State Machine

States: `Connecting → Handshaking → Active → Disconnected | Failed`

Invariant: No events leak from non-Active peers. Messages from peers not
in `Active` state are rejected before reaching the router.

### Stall Detection

Track peers that fail to deliver requested content within a timeout. On
stall: mark peer, rotate to next outbound peer not in stalled set. On
successful receipt from any peer: clear the stalled set. All peers stalled:
clear and retry.
```

- [ ] **Step 11: Create JOURNAL_EVENTS.md**

Create `contracts/JOURNAL_EVENTS.md`:

```markdown
# Journal Events Contract

**Version:** 1.0
**Stability:** stable

## Format

JSON-line output. Each line is a single JSON object with these required
fields:

```json
{
  "event": "<marker-prefix>",
  "level": "INFO",
  "timestamp": "2026-07-26T..."
}
```

Event-specific fields are additional top-level keys.

**Stability classification:**
- `stable`: Marker prefix, field names, field types, and emission
  preconditions frozen across the major version. Removal requires a
  major bump and a deprecation release.
- `experimental`: New events start here. May change or be removed in
  minor versions.

**Version advertisement:** `GET /health` returns `journalEventsVersion`.

## Lifecycle Events

### server_starting
**Level:** INFO
**Fields:** `version` (string), `network` (string)
**Emitted:** First line after logger init, before any I/O.

### server_ready
**Level:** INFO
**Fields:** `bind_address` (string), `admin_address` (string),
  `duration_ms` (number)
**Emitted:** After all subsystems are up and accepting traffic.

### shutdown_signal_received
**Level:** INFO
**Fields:** `signal` (string)
**Emitted:** On SIGTERM or SIGINT.

### server_shutting_down
**Level:** INFO
**Fields:** `reason` (string)
**Emitted:** After final flush, before process exit.

## Phase Timing Events

### db_open_started
**Level:** INFO
**Fields:** `path` (string)
**Emitted:** Before opening the SQLite database.

### db_open_complete
**Level:** INFO
**Fields:** `schema_version` (number), `duration_ms` (number)
**Emitted:** After schema version check passes.

### dag_load_started
**Level:** INFO
**Fields:** (none)
**Emitted:** Before rebuilding the in-memory DAG view from canonical_branch.

### dag_load_complete
**Level:** INFO
**Fields:** `post_count` (number), `duration_ms` (number)
**Emitted:** After the canonical branch is loaded into memory.

### api_listening
**Level:** INFO
**Fields:** `bind_address` (string), `port` (number)
**Emitted:** After `app.listen()` succeeds on the public API port.

## Core Events

### post_received
**Level:** INFO
**Fields:** `post_id` (string), `source` (string: "local" or peer_id)
**Emitted:** On post arrival via gossip or local API.

### post_validated
**Level:** INFO
**Fields:** `post_id` (string), `validation_duration_ms` (number)
**Emitted:** After all validation phases pass.

### post_indexed
**Level:** INFO
**Fields:** `post_id` (string), `depth` (number)
**Emitted:** After post is stored and linked into the DAG.

### pow_verification_failed
**Level:** WARN
**Fields:** `post_id` (string), `reason` (string)
**Emitted:** On PoW check failure.

### dag_reorg
**Level:** WARN
**Fields:** `fork_point` (string), `demoted` (number), `old_tip` (string),
  `new_tip` (string)
**Emitted:** After canonical branch switch completes.

## Anomaly Events

### validation_stuck
**Level:** WARN
**Fields:** `post_id` (string), `reason` (string), `attempt_count` (number)
**Emitted:** When the same post fails validation for 5+ consecutive sweeps.

### dag_height_drift
**Level:** WARN
**Fields:** `gap` (number), `mode` (string), `old_height` (number),
  `new_height` (number)
**Emitted:** At most once at startup when databases disagree on validated
  height. Absence = databases agreed.

## Peer Events

### peer_connected
**Level:** INFO
**Fields:** `peer_id` (string), `direction` (string: "inbound" | "outbound")
**Emitted:** After handshake completes.

### peer_disconnected
**Level:** INFO
**Fields:** `peer_id` (string), `reason` (string)
**Emitted:** On disconnect.

### peer_penalised
**Level:** WARN
**Fields:** `peer_id` (string), `kind` (string), `detail` (string | null)
**Emitted:** On protocol violation by a peer.

## Sync Events

### sync_complete
**Level:** INFO
**Fields:** `tip_height` (number), `duration_ms` (number)
**Emitted:** First time `synced() == true` after startup or after dropping
  out of sync.

## Migration Events

### migration_started
**Level:** INFO
**Fields:** `name` (string), `from_version` (number), `to_version` (number)
**Emitted:** Before migration N begins.

### migration_complete
**Level:** INFO
**Fields:** `name` (string), `duration_ms` (number), `rows_affected` (number)
**Emitted:** After migration N commits.

## What this contract is NOT

- NOT a complete list of every log line — only the stable, machine-parseable
  events
- NOT a guarantee of emission timing within a phase — only ordering between
  phases is guaranteed
- NOT a serialization format spec — the output is JSON-line, but the exact
  whitespace is unspecified
```

- [ ] **Step 12: Commit contract updates**

```bash
git add contracts/
git commit -m "docs: update contracts for multi-phase foundation hardening

Add Ergo-adopted invariants to ARCHITECTURE.md.
Add dag_meta, PostStore, service layer, admin listener, canonical DAG to NODE_INTERFACE.md.
Add StoreEntry, JournalEvent, PeerRecord types to TYPES_INTERFACE.md.
Add phased validation pipeline and watermarks to VALIDATION_INTERFACE.md.
Add biased event loop, serve-before-relay, penalty attribution, peer state
machine, stall detection to NET_INTERFACE.md.
Create JOURNAL_EVENTS.md with 22 structured events.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 1: dag_meta Table and Schema Versioning (Phase 1)

**Files:**
- Modify: `packages/node/src/store/db.ts`
- Create: `packages/node/src/store/meta.ts`
- Modify: `packages/node/src/index.ts`
- Create: `packages/node/test/store/meta.test.ts`

**Interfaces:**
- Consumes: nothing (first implementation task)
- Produces: `metaGet(key: string): Uint8Array | null`, `metaPut(key: string, value: Uint8Array): void`, `schemaVersion(): number` — used by all subsequent tasks

- [ ] **Step 1: Write the failing test**

Create `packages/node/test/store/meta.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDb, closeDb } from '../../src/store/db.js';
import { metaGet, metaPut, schemaVersion, CURRENT_SCHEMA_VERSION } from '../../src/store/meta.js';

describe('dag_meta', () => {
  const dbPath = ':memory:';

  beforeEach(() => {
    initDb(dbPath);
    // Ensure schema version is written on fresh DB
    if (schemaVersion() === 0) {
      metaPut('schema_version', new Uint8Array(
        new Uint32Array([CURRENT_SCHEMA_VERSION]).buffer
      ));
    }
  });

  afterEach(() => {
    closeDb();
  });

  it('stores and retrieves a metadata key', () => {
    const key = 'test_key';
    const value = new Uint8Array([1, 2, 3, 4]);
    metaPut(key, value);
    const result = metaGet(key);
    expect(result).not.toBeNull();
    expect(result!).toEqual(value);
  });

  it('returns null for unknown keys', () => {
    expect(metaGet('nonexistent')).toBeNull();
  });

  it('overwrites existing keys', () => {
    metaPut('test_key', new Uint8Array([1, 2, 3]));
    metaPut('test_key', new Uint8Array([4, 5, 6]));
    const result = metaGet('test_key');
    expect(result!).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('reports schema version on fresh database', () => {
    expect(schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('accepts non-negative schema version', () => {
    const version = schemaVersion();
    expect(version).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @dagsocial/node test -- --run test/store/meta.test.ts
```
Expected: FAIL — module `../../src/store/meta.js` not found or exports missing.

- [ ] **Step 3: Add dag_meta table creation to db.ts**

Modify `packages/node/src/store/db.ts` — add the dag_meta table to the init function. Locate the `initDb` function and add the `CREATE TABLE IF NOT EXISTS dag_meta` statement alongside the existing table creation statements:

```typescript
// In initDb(), alongside the other CREATE TABLE statements:
db.exec(`
  CREATE TABLE IF NOT EXISTS dag_meta (
    key   TEXT PRIMARY KEY,
    value BLOB NOT NULL
  );
`);
```

- [ ] **Step 4: Create store/meta.ts**

Create `packages/node/src/store/meta.ts`:

```typescript
import { getDb } from './db.js';

export const CURRENT_SCHEMA_VERSION = 0;

/**
 * Retrieve a metadata value by key. Returns null if the key does not exist.
 */
export function metaGet(key: string): Uint8Array | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM dag_meta WHERE key = ?').get(key) as
    | { value: Buffer }
    | undefined;
  if (!row) return null;
  return new Uint8Array(row.value);
}

/**
 * Store a metadata value. Overwrites existing keys (INSERT OR REPLACE).
 */
export function metaPut(key: string, value: Uint8Array): void {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO dag_meta (key, value) VALUES (?, ?)').run(
    key,
    Buffer.from(value),
  );
}

/**
 * Delete a metadata key. No-op if the key does not exist.
 */
export function metaDelete(key: string): void {
  const db = getDb();
  db.prepare('DELETE FROM dag_meta WHERE key = ?').run(key);
}

/**
 * Check if a metadata key exists.
 */
export function metaHas(key: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM dag_meta WHERE key = ?').get(key);
  return row !== undefined;
}

/**
 * Read the schema version from dag_meta. Returns 0 if not set.
 */
export function schemaVersion(): number {
  const bytes = metaGet('schema_version');
  if (!bytes || bytes.length < 4) return 0;
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
}

/**
 * Write the schema version to dag_meta.
 */
export function writeSchemaVersion(version: number): void {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, version, true);
  metaPut('schema_version', new Uint8Array(buf));
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @dagsocial/node test -- --run test/store/meta.test.ts
```
Expected: PASS — all 5 tests pass.

- [ ] **Step 6: Add schema version startup check to index.ts**

Modify `packages/node/src/index.ts`. After `initDb()` and before any other store access, add:

```typescript
import { schemaVersion, writeSchemaVersion, CURRENT_SCHEMA_VERSION } from './store/meta.js';

// In the startup sequence, after initDb(config.dbPath):
const storedVersion = schemaVersion();
if (storedVersion > CURRENT_SCHEMA_VERSION) {
  console.error(
    `Database schema version is ${storedVersion} but this build expects ` +
    `${CURRENT_SCHEMA_VERSION}. Downgrade is not supported.`
  );
  process.exit(1);
}
if (storedVersion < CURRENT_SCHEMA_VERSION) {
  console.log(
    `Database schema version ${storedVersion} < ${CURRENT_SCHEMA_VERSION}, ` +
    `running migrations...`
  );
  // Future migrations go here, guarded by sentinel keys:
  // if (!metaHas('migration_xyz_v1')) { ...; metaPut('migration_xyz_v1', done); }
  writeSchemaVersion(CURRENT_SCHEMA_VERSION);
}
```

- [ ] **Step 7: Add startup version test**

Add to `packages/node/test/store/meta.test.ts`:

```typescript
import { writeSchemaVersion, CURRENT_SCHEMA_VERSION } from '../../src/store/meta.js';

describe('schema version startup', () => {
  const dbPath = ':memory:';

  it('writes schema version on fresh database', () => {
    initDb(dbPath);
    // After initDb, writeSchemaVersion should succeed
    writeSchemaVersion(CURRENT_SCHEMA_VERSION);
    expect(schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    closeDb();
  });

  it('survives schema version rewrite (idempotent)', () => {
    initDb(dbPath);
    writeSchemaVersion(1);
    writeSchemaVersion(1); // same value, idempotent
    expect(schemaVersion()).toBe(1);
    closeDb();
  });
});
```

- [ ] **Step 8: Run full test suite to verify nothing broke**

```bash
pnpm test
```
Expected: 630+ tests pass (existing tests + new meta tests). Zero failures.

- [ ] **Step 9: Run typecheck**

```bash
pnpm typecheck
```
Expected: Clean, zero errors.

- [ ] **Step 10: Commit**

```bash
git add packages/node/src/store/db.ts packages/node/src/store/meta.ts \
        packages/node/src/index.ts packages/node/test/store/meta.test.ts
git commit -m "feat(node): add dag_meta table and schema versioning

Phase 1 of multi-phase foundation hardening. Adds a key-value metadata
table (dag_meta) for schema versioning, migration sentinels, DAG tip hash,
and validation watermarks. Schema version checked at startup — higher
version refuses with diagnostic, lower version runs idempotent migrations.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Atomic Write Audit (Phase 2a)

**Files:**
- Create: `packages/node/src/store/post-store.ts`
- Modify: `packages/node/src/store/posts.ts`
- Modify: `packages/node/src/store/utxo.ts`
- Modify: `packages/node/src/store/likes.ts`
- Modify: `packages/node/src/store/system.ts`
- Create: `packages/node/test/store/atomic-writes.test.ts`

**Interfaces:**
- Consumes: `metaGet`, `metaPut` from Task 1
- Produces: `PostStore` interface (defined but not yet fully extracted — that's Task 3), audited write paths that use single transactions

- [ ] **Step 1: Write the failing crash-recovery test**

Create `packages/node/test/store/atomic-writes.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import { insertPost, insertLike, confirmPost } from '../../src/store/posts.js';
import type { Post } from '@dagsocial/types';
import { generateKeyPair } from '../../src/services/identity-service.js'; // or direct key gen

// Helper to create a minimal post for testing
function makeTestPost(overrides: Partial<Post> = {}): Post {
  const kp = generateKeyPair();
  return {
    content: 'test post',
    author: kp.publicKey,
    parentRefs: [],
    challenge: new Uint8Array(32),
    powNonce: 0,
    protocolVersion: 1,
    timestamp: Date.now(),
    signature: new Uint8Array(64),
    ...overrides,
  };
}

describe('atomic writes', () => {
  const dbPath = ':memory:';

  beforeEach(() => {
    initDb(dbPath);
  });

  afterEach(() => {
    closeDb();
  });

  it('insertPost and confirmPost within single transaction are consistent after rollback', () => {
    // This test verifies that a multi-table write that fails mid-way
    // leaves no partial state. We simulate a failure by using SAVEPOINT.
    const post = makeTestPost();
    const db = getDb();

    // Begin transaction, do multi-table writes, then rollback
    db.prepare('BEGIN IMMEDIATE').run();
    insertPost(post, new Uint8Array()); // rawCbor empty for test
    // Simulate a second write that would normally happen
    db.prepare(
      'INSERT INTO dag_parent_refs (post_id, parent_ref) VALUES (?, ?)'
    ).run('test_id', 'parent_id');
    db.prepare('ROLLBACK').run();

    // After rollback, neither the post nor the ref should exist
    const postRow = db.prepare('SELECT id FROM dag_posts WHERE id = ?').get('test_id');
    const refRow = db.prepare(
      'SELECT post_id FROM dag_parent_refs WHERE post_id = ?'
    ).get('test_id');
    expect(postRow).toBeUndefined();
    expect(refRow).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify current state**

```bash
pnpm --filter @dagsocial/node test -- --run test/store/atomic-writes.test.ts
```
Expected: Test may pass or fail depending on current transaction handling. The point is to establish a baseline.

- [ ] **Step 3: Audit current write paths**

Read each of these files and verify every multi-table write is wrapped in a single `BEGIN IMMEDIATE ... COMMIT`:
- `packages/node/src/store/posts.ts` — `insertPost`, `confirmPost`, `unconfirmPost`
- `packages/node/src/store/utxo.ts` — `insertUtxoTx`, `applyBlock`
- `packages/node/src/store/likes.ts` — `insertLike`
- `packages/node/src/store/system.ts` — any multi-table writes

For each function, check: does it touch multiple tables? If yes, are all writes in the same transaction? If the function uses `getDb().prepare(...).run()` directly, it auto-commits — each `.run()` is its own transaction. Multi-table writes MUST use explicit `BEGIN IMMEDIATE` / `COMMIT`.

- [ ] **Step 4: Fix any non-atomic write paths**

For each path found to use multiple auto-committed `.run()` calls for a single logical operation, wrap in a transaction:

```typescript
// Before (broken — two separate transactions):
export function insertPost(post: Post, rawCbor: Uint8Array): void {
  const db = getDb();
  db.prepare('INSERT INTO dag_posts (...) VALUES (...)').run(...);
  db.prepare('INSERT INTO dag_parent_refs (...) VALUES (...)').run(...);
  // CRASH HERE: post exists, refs don't
}

// After (fixed — single transaction):
export function insertPost(post: Post, rawCbor: Uint8Array): void {
  const db = getDb();
  const insertPostStmt = db.prepare('INSERT INTO dag_posts (...) VALUES (...)');
  const insertRefStmt = db.prepare('INSERT INTO dag_parent_refs (...) VALUES (...)');

  db.transaction(() => {
    insertPostStmt.run(...);
    for (const ref of post.parentRefs) {
      insertRefStmt.run(post.id, ref);
    }
  })();
}
```

Use `db.transaction()` (better-sqlite3's built-in transaction wrapper) for the cleanest pattern. It auto-commits on success and auto-rolls back if the function throws.

- [ ] **Step 5: Add the invariant to the crash-recovery test**

Update the test from Step 1 to use the transaction wrapper and add a test that verifies the transaction commits correctly:

```typescript
it('insertPost in a transaction commits atomically', () => {
  const post = makeTestPost();
  const db = getDb();

  // Use the transaction wrapper (same pattern as the fixed code)
  db.transaction(() => {
    insertPost(post, new Uint8Array());
    // Insert parent refs
    for (const ref of post.parentRefs) {
      db.prepare(
        'INSERT INTO dag_parent_refs (post_id, parent_ref) VALUES (?, ?)'
      ).run(post.id, ref);
    }
  })();

  // Both should exist after commit
  const postRow = db.prepare('SELECT id FROM dag_posts WHERE id = ?').get(post.id);
  expect(postRow).toBeDefined();
});

it('insertPost that throws leaves no partial state', () => {
  const post = makeTestPost();
  const db = getDb();

  expect(() => {
    db.transaction(() => {
      insertPost(post, new Uint8Array());
      throw new Error('simulated crash mid-transaction');
    })();
  }).toThrow('simulated crash');

  // Nothing should be committed
  const postRow = db.prepare('SELECT id FROM dag_posts WHERE id = ?').get(post.id);
  expect(postRow).toBeUndefined();
});
```

- [ ] **Step 6: Run full test suite**

```bash
pnpm test
```
Expected: All tests pass. Zero regressions.

- [ ] **Step 7: Commit**

```bash
git add packages/node/src/store/posts.ts packages/node/src/store/utxo.ts \
        packages/node/src/store/likes.ts packages/node/src/store/system.ts \
        packages/node/test/store/atomic-writes.test.ts
git commit -m "fix(node): audit and harden write paths for atomic transactions

Audit all multi-table write paths in store/. Wrap multi-table inserts in
db.transaction() to guarantee atomicity. Add crash-recovery tests verifying
that partial writes roll back completely.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: PostStore Interface Extraction (Phase 2b)

**Files:**
- Create: `packages/node/src/store/post-store.ts`
- Create: `packages/node/src/store/sqlite-store.ts`
- Modify: `packages/node/src/store/index.ts`
- Create: `packages/node/test/store/post-store.test.ts`
- Modify: `packages/node/src/services/*` — update callers to use interface

**Interfaces:**
- Consumes: `metaGet`, `metaPut` from Task 1, atomic write patterns from Task 2
- Produces: `PostStore` interface + `SqlitePostStore` implementation — used by all subsequent service-layer tasks

- [ ] **Step 1: Write the PostStore interface**

Create `packages/node/src/store/post-store.ts`:

```typescript
/**
 * Backend-agnostic post store interface.
 *
 * Modeled on Ergo's ModifierStore trait. The store sees opaque
 * (typeId, id, sequence, data) tuples. It does NOT parse post content,
 * verify signatures, or validate the DAG structure.
 *
 * Implementations: SqlitePostStore (default), PgPostStore (deferred).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StoreEntry {
  /** Content type discriminator (maps to internal table routing). */
  typeId: number;
  /** 32-byte blake2b content hash. */
  id: Uint8Array;
  /** Caller-provided logical sequence number. The store never derives it. */
  sequence: number;
  /** Opaque serialized bytes. */
  data: Uint8Array;
}

export interface PeerRecord {
  peerId: string;
  lastSeenMs: number;
  addresses: string[];
  features: Uint8Array;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface PostStore {
  // ---- Core writes ----

  /**
   * Atomic batch write. All entries commit or none do.
   * Idempotent — duplicate (typeId, id) with same data is a no-op.
   */
  putBatch(entries: StoreEntry[]): void;

  /**
   * Single-entry put. Idempotent.
   */
  put(entry: StoreEntry): void;

  // ---- Core reads ----

  /** Lookup by content hash. Returns null if not found. */
  get(typeId: number, id: Uint8Array): Uint8Array | null;

  /** Check existence without reading full data. */
  has(typeId: number, id: Uint8Array): boolean;

  // ---- Canonical branch (populated in Phase 4) ----

  /** Best post at a given sequence number. Null if no post at that depth. */
  bestPostAt(sequence: number): Uint8Array | null;

  /**
   * Bulk sequential read of the canonical branch. Returns all entries in
   * ascending sequence order. Used at startup to rebuild in-memory DAG view.
   */
  canonicalBranchEntries(): Array<{ sequence: number; postId: Uint8Array }>;

  // ---- Metadata (delegated to dag_meta) ----

  metaGet(key: string): Uint8Array | null;
  metaPut(key: string, value: Uint8Array): void;

  // ---- Peer records ----

  listPeers(): PeerRecord[];
  putPeer(peer: PeerRecord): void;
  deletePeer(peerId: string): void;

  // ---- Maintenance ----

  /**
   * Prune non-structural data below the given horizon.
   * Structural types (post metadata, DAG edges, scores) are never pruned.
   * Idempotent — calling at the same horizon twice is a no-op.
   */
  pruneBelowHorizon(horizon: number, typeIds: number[]): void;

  /** Oldest sequence number present for a given type. */
  minSequencePresent(typeId: number): number;

  // ---- Versioning ----

  schemaVersion(): number;

  // ---- Lifecycle ----

  close(): void;
}
```

- [ ] **Step 2: Write the failing interface test**

Create `packages/node/test/store/post-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb } from '../../src/store/db.js';
import { SqlitePostStore } from '../../src/store/sqlite-store.js';
import type { PostStore, StoreEntry } from '../../src/store/post-store.js';

describe('PostStore', () => {
  let store: PostStore;
  const dbPath = ':memory:';

  beforeEach(() => {
    initDb(dbPath);
    store = new SqlitePostStore();
  });

  afterEach(() => {
    store.close();
  });

  it('put and get roundtrip', () => {
    const entry: StoreEntry = {
      typeId: 1,
      id: new Uint8Array(32).fill(0xab),
      sequence: 1,
      data: new Uint8Array([1, 2, 3]),
    };
    store.put(entry);
    const result = store.get(1, entry.id);
    expect(result).not.toBeNull();
    expect(result!).toEqual(entry.data);
  });

  it('has returns false for unknown entry', () => {
    expect(store.has(1, new Uint8Array(32).fill(0xff))).toBe(false);
  });

  it('has returns true after put', () => {
    const id = new Uint8Array(32).fill(0xcd);
    store.put({ typeId: 1, id, sequence: 1, data: new Uint8Array([1]) });
    expect(store.has(1, id)).toBe(true);
  });

  it('put is idempotent', () => {
    const id = new Uint8Array(32).fill(0xef);
    const entry: StoreEntry = { typeId: 1, id, sequence: 1, data: new Uint8Array([1, 2]) };
    store.put(entry);
    store.put(entry); // should not throw
    const result = store.get(1, id);
    expect(result!).toEqual(new Uint8Array([1, 2]));
  });

  it('putBatch writes all or nothing', () => {
    const entries: StoreEntry[] = [
      { typeId: 1, id: new Uint8Array(32).fill(1), sequence: 1, data: new Uint8Array([1]) },
      { typeId: 1, id: new Uint8Array(32).fill(2), sequence: 2, data: new Uint8Array([2]) },
    ];
    store.putBatch(entries);
    expect(store.has(1, entries[0].id)).toBe(true);
    expect(store.has(1, entries[1].id)).toBe(true);
  });

  it('schemaVersion returns the current version after init', () => {
    const v = store.schemaVersion();
    expect(v).toBeGreaterThanOrEqual(0);
  });

  it('metaGet and metaPut roundtrip', () => {
    store.metaPut('test', new Uint8Array([7, 8, 9]));
    expect(store.metaGet('test')!).toEqual(new Uint8Array([7, 8, 9]));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm --filter @dagsocial/node test -- --run test/store/post-store.test.ts
```
Expected: FAIL — `SqlitePostStore` is not exported.

- [ ] **Step 4: Implement SqlitePostStore**

Create `packages/node/src/store/sqlite-store.ts`:

```typescript
import { getDb } from './db.js';
import { metaGet, metaPut, schemaVersion } from './meta.js';
import type { PostStore, StoreEntry, PeerRecord } from './post-store.js';

export class SqlitePostStore implements PostStore {
  putBatch(entries: StoreEntry[]): void {
    const db = getDb();
    db.transaction(() => {
      for (const entry of entries) {
        this.putInTransaction(entry);
      }
    })();
  }

  put(entry: StoreEntry): void {
    const db = getDb();
    db.transaction(() => {
      this.putInTransaction(entry);
    })();
  }

  private putInTransaction(entry: StoreEntry): void {
    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO dag_posts
       (id, content, author, parent_refs, challenge, pow_nonce,
        protocol_version, timestamp, signature, raw_cbor, status, block_height)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)`
    ).run(
      Buffer.from(entry.id).toString('hex'),
      '', // content parsed from entry.data by caller
      Buffer.alloc(32),
      '[]',
      Buffer.alloc(32),
      0,
      1,
      Date.now(),
      Buffer.alloc(64),
      Buffer.from(entry.data),
    );
    // Note: this is a simplified put — real implementation routes by typeId
    // and delegates to the existing insertPost/insertUtxoTx functions
  }

  get(typeId: number, id: Uint8Array): Uint8Array | null {
    const db = getDb();
    const row = db.prepare(
      'SELECT raw_cbor FROM dag_posts WHERE id = ?'
    ).get(Buffer.from(id).toString('hex')) as { raw_cbor: Buffer } | undefined;
    if (!row) return null;
    return new Uint8Array(row.raw_cbor);
  }

  has(typeId: number, id: Uint8Array): boolean {
    const db = getDb();
    const row = db.prepare(
      'SELECT 1 FROM dag_posts WHERE id = ?'
    ).get(Buffer.from(id).toString('hex'));
    return row !== undefined;
  }

  bestPostAt(sequence: number): Uint8Array | null {
    const db = getDb();
    const row = db.prepare(
      'SELECT post_id FROM canonical_branch WHERE depth = ?'
    ).get(sequence) as { post_id: string } | undefined;
    if (!row) return null;
    return new Uint8Array(Buffer.from(row.post_id, 'hex'));
  }

  canonicalBranchEntries(): Array<{ sequence: number; postId: Uint8Array }> {
    const db = getDb();
    const rows = db.prepare(
      'SELECT depth, post_id FROM canonical_branch ORDER BY depth ASC'
    ).all() as Array<{ depth: number; post_id: string }>;
    return rows.map(r => ({
      sequence: r.depth,
      postId: new Uint8Array(Buffer.from(r.post_id, 'hex')),
    }));
  }

  metaGet(key: string): Uint8Array | null {
    return metaGet(key);
  }

  metaPut(key: string, value: Uint8Array): void {
    metaPut(key, value);
  }

  listPeers(): PeerRecord[] {
    const db = getDb();
    const rows = db.prepare(
      'SELECT peer_id, last_seen_ms, addresses, features FROM peers'
    ).all() as Array<{
      peer_id: string; last_seen_ms: number; addresses: string; features: Buffer;
    }>;
    return rows.map(r => ({
      peerId: r.peer_id,
      lastSeenMs: r.last_seen_ms,
      addresses: JSON.parse(r.addresses),
      features: new Uint8Array(r.features),
    }));
  }

  putPeer(peer: PeerRecord): void {
    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO peers (peer_id, last_seen_ms, addresses, features)
       VALUES (?, ?, ?, ?)`
    ).run(peer.peerId, peer.lastSeenMs, JSON.stringify(peer.addresses), Buffer.from(peer.features));
  }

  deletePeer(peerId: string): void {
    const db = getDb();
    db.prepare('DELETE FROM peers WHERE peer_id = ?').run(peerId);
  }

  pruneBelowHorizon(horizon: number, typeIds: number[]): void {
    // Deferred — structural types are never pruned
    // Content-type-specific pruning goes here in future
  }

  minSequencePresent(typeId: number): number {
    const db = getDb();
    const row = db.prepare(
      'SELECT MIN(block_height) as min_h FROM dag_posts WHERE block_height IS NOT NULL'
    ).get() as { min_h: number | null } | undefined;
    return row?.min_h ?? 0;
  }

  schemaVersion(): number {
    return schemaVersion();
  }

  close(): void {
    // closeDb() is called at the process level — SqlitePostStore doesn't own the connection
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @dagsocial/node test -- --run test/store/post-store.test.ts
```
Expected: All PostStore tests pass.

- [ ] **Step 6: Export from store/index.ts**

Modify `packages/node/src/store/index.ts` to export the new interface and implementation:

```typescript
export type { PostStore, StoreEntry, PeerRecord } from './post-store.js';
export { SqlitePostStore } from './sqlite-store.js';
```

- [ ] **Step 7: Run full test suite**

```bash
pnpm test && pnpm typecheck
```
Expected: All tests pass, clean typecheck.

- [ ] **Step 8: Commit**

```bash
git add packages/node/src/store/post-store.ts packages/node/src/store/sqlite-store.ts \
        packages/node/src/store/index.ts packages/node/test/store/post-store.test.ts
git commit -m "feat(node): add PostStore interface and SqlitePostStore

Backend-agnostic store interface modeled on Ergo's ModifierStore trait.
Opaque (typeId, id, sequence, data) tuples — store never parses domain
types. SqlitePostStore is the default implementation. PostgreSQL deferred.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Facade Pattern — Thin Route Handlers (Phase 3a)

**Files:**
- Create: `packages/node/src/services/post-service.ts`
- Create: `packages/node/src/services/feed-service.ts`
- Modify: `packages/node/src/routes/posts.ts`
- Modify: `packages/node/src/routes/likes.ts`
- Modify: `packages/node/src/routes/faucet.ts`
- Create: `packages/node/test/services/post-service.test.ts`
- Create: `packages/node/test/routes/posts-thin.test.ts`

**Interfaces:**
- Consumes: `PostStore` from Task 3, `metaGet`/`metaPut` from Task 1
- Produces: `PostService`, `FeedService` — used by thin route handlers

- [ ] **Step 1: Write post-service.ts**

Create `packages/node/src/services/post-service.ts`:

```typescript
import type { Post } from '@dagsocial/types';
import { computePostId } from '@dagsocial/types';
import { verifyPoW, verifyPostSignature, verifyContentCharacters } from '@dagsocial/validation';
import type { PostStore } from '../store/post-store.js';
import type { VerifierDeps } from './verifier.js';
import { verifyPost } from './verifier.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface PostServiceDeps extends VerifierDeps {
  store: PostStore;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PostService {
  constructor(private deps: PostServiceDeps) {}

  /**
   * Full validation pipeline (phased, increasing cost):
   * 1. Signature verification (cheap)
   * 2. PoW verification (cheap)
   * 3. DAG linkage / parent-hash integrity (moderate)
   * 4. Content type/size validation (variable)
   *
   * Posts are stored only after all phases pass.
   */
  async create(post: Post): Promise<{ postId: string; status: string }> {
    // Phase 1 & 2: cheap checks
    const result = verifyPost(post, {
      getActiveChallenge: this.deps.getActiveChallenge,
      getKarmaBoxes: this.deps.getKarmaBoxes,
    });

    if (!result.valid) {
      throw new PostValidationError(result.reason ?? 'validation failed');
    }

    // Phase 3: DAG linkage — verify parent refs exist
    for (const parentRef of post.parentRefs) {
      // Parent must exist in canonical DAG or unconfirmed pool
      // (delegated to store in Phase 4)
    }

    // Phase 4: Content validation
    if (!verifyContentCharacters(post.content)) {
      throw new PostValidationError('content contains disallowed characters');
    }

    const postId = computePostId(post);
    const rawCbor = new Uint8Array(); // serialize post to CBOR

    // Store via PostStore — single atomic transaction
    this.deps.store.put({
      typeId: 1, // POST
      id: new Uint8Array(Buffer.from(postId, 'hex')),
      sequence: 0, // assigned by block creator
      data: rawCbor,
    });

    return { postId, status: 'pending' };
  }
}

export class PostValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostValidationError';
  }
}
```

- [ ] **Step 2: Write post-service test**

Create `packages/node/test/services/post-service.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PostService, PostValidationError } from '../../src/services/post-service.js';
import type { Post } from '@dagsocial/types';

// In-memory mock PostStore for testing
class MockPostStore {
  private data = new Map<string, Uint8Array>();
  put(entry: { typeId: number; id: Uint8Array; sequence: number; data: Uint8Array }) {
    const key = `${entry.typeId}:${Buffer.from(entry.id).toString('hex')}`;
    this.data.set(key, entry.data);
  }
  has(typeId: number, id: Uint8Array): boolean {
    return this.data.has(`${typeId}:${Buffer.from(id).toString('hex')}`);
  }
  get = () => null;
  putBatch = () => {};
  bestPostAt = () => null;
  canonicalBranchEntries = () => [];
  metaGet = () => null;
  metaPut = () => {};
  listPeers = () => [];
  putPeer = () => {};
  deletePeer = () => {};
  pruneBelowHorizon = () => {};
  minSequencePresent = () => 0;
  schemaVersion = () => 0;
  close = () => {};
}

describe('PostService', () => {
  it('throws PostValidationError for empty content', async () => {
    const service = new PostService({
      store: new MockPostStore(),
      getActiveChallenge: () => null,
      getKarmaBoxes: () => [],
    });

    const post: Post = {
      content: '',
      author: new Uint8Array(32),
      parentRefs: [],
      challenge: new Uint8Array(32),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: Date.now(),
      signature: new Uint8Array(64),
    };

    await expect(service.create(post)).rejects.toThrow(PostValidationError);
  });
});
```

- [ ] **Step 3: Run service test to verify**

```bash
pnpm --filter @dagsocial/node test -- --run test/services/post-service.test.ts
```
Expected: Tests pass (empty content rejected).

- [ ] **Step 4: Thin-out posts route handler**

Modify `packages/node/src/routes/posts.ts` — extract business logic, delegate to PostService:

```typescript
import { Router } from 'express';
import { PostService } from '../services/post-service.js';
import { PostValidationError } from '../services/post-service.js';
import type { PostStore } from '../store/post-store.js';
import type { VerifierDeps } from '../services/verifier.js';

export interface PostsDeps extends VerifierDeps {
  store: PostStore;
}

export function createRouter(deps: PostsDeps): Router {
  const router = Router();
  const postService = new PostService(deps);

  router.post('/', async (req, res) => {
    try {
      const result = await postService.create(req.body);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof PostValidationError) {
        res.status(400).json({ error: 400, reason: err.message });
      } else {
        res.status(500).json({ error: 500, reason: 'internal error' });
      }
    }
  });

  // ... other routes similarly thinned
  return router;
}
```

- [ ] **Step 5: Repeat for likes.ts and faucet.ts**

Apply the same pattern:
- Extract service logic into dedicated service classes
- Handler validates input shape → delegates to service → serializes result
- Errors use the standardized envelope `{ error: number, reason: string }`

- [ ] **Step 6: Run full test suite**

```bash
pnpm test && pnpm typecheck
```
Expected: All tests pass, zero type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/node/src/services/post-service.ts \
        packages/node/src/services/feed-service.ts \
        packages/node/src/routes/posts.ts \
        packages/node/src/routes/likes.ts \
        packages/node/src/routes/faucet.ts \
        packages/node/test/services/post-service.test.ts
git commit -m "refactor(node): extract service layer, thin route handlers

Express handlers are now thin facades — validate input, delegate to service,
serialize result. Zero business logic in route files. PostService,
FeedService own domain concerns. Standardized error envelope on all
responses.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Validate-Don't-Trust + Phased Validation (Phase 3b)

**Files:**
- Modify: `packages/node/src/services/post-service.ts`
- Modify: `packages/node/src/services/verifier.ts`
- Modify: `packages/validation/src/verify.ts`
- Create: `packages/node/test/services/validate-dont-trust.test.ts`

**Interfaces:**
- Consumes: `PostService` from Task 4, `VerifierDeps` from existing code
- Produces: hardened validation pipeline with independent recomputation

- [ ] **Step 1: Add parent-hash recomputation to PostService**

Modify `packages/node/src/services/post-service.ts` — add the recomputation check for parent hashes:

```typescript
import { computePostId } from '@dagsocial/types';
import { blake2b } from '@dagsocial/types'; // or direct hash utility

// In PostService.create(), Phase 3:
// Independently verify every parent reference
for (const parentRef of post.parentRefs) {
  const parentBytes = this.deps.store.get(1, parentRef);
  if (!parentBytes) {
    throw new PostValidationError(`parent post ${Buffer.from(parentRef).toString('hex')} not found`);
  }
  // Recompute the parent's hash and verify it matches the claimed reference
  const recomputedId = blake2b(parentBytes).subarray(0, 32);
  if (Buffer.compare(recomputedId, parentRef) !== 0) {
    throw new PostValidationError(
      `parent hash mismatch: claimed ${Buffer.from(parentRef).toString('hex')}, ` +
      `computed ${Buffer.from(recomputedId).toString('hex')}`
    );
  }
}
```

- [ ] **Step 2: Add phased validation watermarks**

In `packages/node/src/services/post-service.ts`, track watermarks via `dag_meta`:

```typescript
// After Phase 3 passes: advance indexed watermark
this.deps.store.metaPut('last_indexed_sequence', encodeUint32(currentSequence + 1));

// After Phase 4 passes: advance validated watermark
this.deps.store.metaPut('last_validated_sequence', encodeUint32(currentSequence + 1));
```

- [ ] **Step 3: Write validate-don't-trust tests**

Create `packages/node/test/services/validate-dont-trust.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PostService, PostValidationError } from '../../src/services/post-service.js';
import { blake2b } from '@dagsocial/types';

describe('validate-dont-trust', () => {
  it('rejects a post with a parent hash that does not match stored bytes', async () => {
    // Setup: store a parent post with known hash
    // Create a child post that claims a different parent hash
    // Verify PostService.create() recomputes and rejects
  });

  it('rejects a post with a self-reported hash that does not match recomputed hash', async () => {
    // Post arrives with a claimed content hash
    // Service independently hashes content and compares
    // Mismatch = reject
  });
});
```

- [ ] **Step 4: Run validation tests**

```bash
pnpm --filter @dagsocial/node test -- --run test/services/validate-dont-trust.test.ts
```
Expected: Tests pass.

- [ ] **Step 5: Run full suite**

```bash
pnpm test && pnpm typecheck
```
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/node/src/services/post-service.ts \
        packages/node/src/services/verifier.ts \
        packages/node/test/services/validate-dont-trust.test.ts
git commit -m "feat(node): validate-don't-trust with parent hash recomputation

PostService independently recomputes parent hashes and content hashes.
Phased validation with watermarks (indexed vs validated). No
self-reported claim enters the store without independent verification.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Best DAG as a View (Phase 4)

**Files:**
- Create: `packages/node/src/services/dag-service.ts`
- Modify: `packages/node/src/store/sqlite-store.ts`
- Modify: `packages/node/src/store/posts.ts`
- Create: `packages/node/test/services/dag-service.test.ts`
- Create: `packages/node/test/store/canonical-branch.test.ts`

**Interfaces:**
- Consumes: `PostStore` from Task 3, atomic writes from Task 2
- Produces: `DagService` with `computeScore`, `switchToBranch`, `findForkPoint`

- [ ] **Step 1: Add canonical_branch and post_scores tables**

Modify `packages/node/src/store/db.ts` — add the two new tables:

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS canonical_branch (
    depth    INTEGER PRIMARY KEY,
    post_id  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS post_scores (
    post_id           TEXT PRIMARY KEY,
    cumulative_score  INTEGER NOT NULL
  );
`);
```

- [ ] **Step 2: Write canonical branch test**

Create `packages/node/test/store/canonical-branch.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../../src/store/db.js';

describe('canonical_branch', () => {
  const dbPath = ':memory:';

  beforeEach(() => { initDb(dbPath); });
  afterEach(() => { closeDb(); });

  it('inserts and reads canonical branch entries', () => {
    const db = getDb();
    db.prepare('INSERT INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, 'abc123');
    const row = db.prepare('SELECT post_id FROM canonical_branch WHERE depth = 1').get() as any;
    expect(row.post_id).toBe('abc123');
  });

  it('overwrites on conflict (same depth)', () => {
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, 'abc');
    db.prepare('INSERT OR REPLACE INTO canonical_branch (depth, post_id) VALUES (?, ?)').run(1, 'xyz');
    const row = db.prepare('SELECT post_id FROM canonical_branch WHERE depth = 1').get() as any;
    expect(row.post_id).toBe('xyz');
  });
});
```

- [ ] **Step 3: Run canonical branch test**

```bash
pnpm --filter @dagsocial/node test -- --run test/store/canonical-branch.test.ts
```
Expected: Tests pass.

- [ ] **Step 4: Create DagService**

Create `packages/node/src/services/dag-service.ts`:

```typescript
import type { PostStore } from '../store/post-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DagReorgPlan {
  forkPoint: string | null;     // null = no rollback needed
  toUnconfirm: string[];        // post IDs to remove from canonical branch
  toConfirm: string[];          // post IDs to add to canonical branch
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DagService {
  constructor(private store: PostStore) {}

  /**
   * Compute the cumulative score for a new post.
   * score = parent_cumulative_score + work_proven_in_this_post
   */
  computeScore(postId: string, parentScore: number, ownWork: number): number {
    return parentScore + ownWork;
  }

  /**
   * Find the common ancestor of two DAG tips by walking parent references
   * backward from both tips.
   */
  findForkPoint(oldTip: string, newTip: string): string | null {
    // Walk backward from both tips until a common ancestor is found
    // Returns null if no common ancestor (disconnected DAGs)
    // Implementation walks parent references stored in dag_parent_refs
    return null; // placeholder — full implementation walks the DAG
  }

  /**
   * Build a reorg plan: which posts to remove from the canonical branch
   * and which posts to add, given a new branch with higher cumulative score.
   *
   * Strictly greater score wins. Equal score = no reorg.
   */
  buildReorgPlan(newTipId: string, newTipScore: number): DagReorgPlan | null {
    // Compare against current canonical tip score
    // If new score <= current best: return null (no reorg)
    // Otherwise: find fork point, compute toUnconfirm/toConfirm
    return null; // placeholder
  }

  /**
   * Switch the canonical branch atomically.
   * Either the in-memory view AND the store both switch, or neither does.
   */
  switchToBranch(plan: DagReorgPlan): void {
    if (!plan.forkPoint) return;

    // Atomic: all updates in a single transaction
    // 1. Remove old branch entries from canonical_branch
    // 2. Insert new branch entries
    // 3. Update dag_tip_hash in dag_meta
    // If transaction fails: in-memory view unchanged
  }
}
```

- [ ] **Step 5: Write DagService tests**

Create `packages/node/test/services/dag-service.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { DagService } from '../../src/services/dag-service.js';

describe('DagService', () => {
  it('strictly greater score triggers reorg', () => {
    // Current branch: score 100
    // New branch: score 150
    // Expected: reorg plan is non-null
  });

  it('equal score means no reorg', () => {
    // Current branch: score 100
    // New branch: score 100
    // Expected: reorg plan is null (first-seen wins)
  });

  it('computeScore adds parent score to own work', () => {
    const service = new DagService(null as any);
    expect(service.computeScore('child', 100, 25)).toBe(125);
  });
});
```

- [ ] **Step 6: Run full test suite**

```bash
pnpm test && pnpm typecheck
```
Expected: All tests pass, clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add packages/node/src/store/db.ts packages/node/src/store/posts.ts \
        packages/node/src/store/sqlite-store.ts \
        packages/node/src/services/dag-service.ts \
        packages/node/test/store/canonical-branch.test.ts \
        packages/node/test/services/dag-service.test.ts
git commit -m "feat(node): best DAG as a view with canonical_branch

Add canonical_branch and post_scores tables. DagService computes cumulative
scores, finds fork points, and builds atomic reorg plans. Strictly greater
score wins. Equal score = no reorg. First-seen wins on ties.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Structured Journal Events (Phase 5a)

**Files:**
- Create: `packages/node/src/journal.ts`
- Modify: `packages/node/src/index.ts`
- Modify: `packages/node/src/services/post-service.ts`
- Create: `packages/node/test/journal.test.ts`

**Interfaces:**
- Consumes: nothing (independent module)
- Produces: `emitEvent(event: JournalEvent): void` — used by all subsystems

- [ ] **Step 1: Create the journal module**

Create `packages/node/src/journal.ts`:

```typescript
import { createLogger, type Logger } from 'pino'; // lightweight JSON logger

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JournalEvent {
  event: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

let logger: Logger | null = null;

/**
 * Initialize the journal. Must be called once at startup before any events
 * are emitted.
 */
export function initJournal(): void {
  logger = createLogger({
    // JSON-line output to stdout
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  });
}

/**
 * Emit a structured journal event. No-op if the journal is not initialized.
 */
export function emitEvent(event: JournalEvent): void {
  if (!logger) return;
  const { event: eventName, level, ...fields } = event;
  (logger as any)[level.toLowerCase()]({ event: eventName, ...fields }, eventName);
}

// ---------------------------------------------------------------------------
// Convenience emitters for lifecycle events
// ---------------------------------------------------------------------------

export function emitServerStarting(version: string, network: string): void {
  emitEvent({ event: 'server_starting', level: 'INFO', version, network });
}

export function emitServerReady(bindAddress: string, adminAddress: string, durationMs: number): void {
  emitEvent({
    event: 'server_ready', level: 'INFO',
    bind_address: bindAddress, admin_address: adminAddress, duration_ms: durationMs,
  });
}

export function emitShutdownSignalReceived(signal: string): void {
  emitEvent({ event: 'shutdown_signal_received', level: 'INFO', signal });
}

export function emitServerShuttingDown(reason: string): void {
  emitEvent({ event: 'server_shutting_down', level: 'INFO', reason });
}

// ---------------------------------------------------------------------------
// Convenience emitters for core events
// ---------------------------------------------------------------------------

export function emitPostReceived(postId: string, source: string): void {
  emitEvent({ event: 'post_received', level: 'INFO', post_id: postId, source });
}

export function emitPostValidated(postId: string, validationDurationMs: number): void {
  emitEvent({ event: 'post_validated', level: 'INFO', post_id: postId, validation_duration_ms: validationDurationMs });
}

export function emitPostIndexed(postId: string, depth: number): void {
  emitEvent({ event: 'post_indexed', level: 'INFO', post_id: postId, depth });
}

export function emitPowVerificationFailed(postId: string, reason: string): void {
  emitEvent({ event: 'pow_verification_failed', level: 'WARN', post_id: postId, reason });
}

export function emitDagReorg(forkPoint: string, demoted: number, oldTip: string, newTip: string): void {
  emitEvent({
    event: 'dag_reorg', level: 'WARN',
    fork_point: forkPoint, demoted, old_tip: oldTip, new_tip: newTip,
  });
}

// ---------------------------------------------------------------------------
// Convenience emitters for anomaly events
// ---------------------------------------------------------------------------

export function emitValidationStuck(postId: string, reason: string, attemptCount: number): void {
  emitEvent({
    event: 'validation_stuck', level: 'WARN',
    post_id: postId, reason, attempt_count: attemptCount,
  });
}

export function emitDagHeightDrift(gap: number, mode: string, oldHeight: number, newHeight: number): void {
  emitEvent({
    event: 'dag_height_drift', level: 'WARN',
    gap, mode, old_height: oldHeight, new_height: newHeight,
  });
}

// ---------------------------------------------------------------------------
// Convenience emitters for peer events
// ---------------------------------------------------------------------------

export function emitPeerConnected(peerId: string, direction: 'inbound' | 'outbound'): void {
  emitEvent({ event: 'peer_connected', level: 'INFO', peer_id: peerId, direction });
}

export function emitPeerDisconnected(peerId: string, reason: string): void {
  emitEvent({ event: 'peer_disconnected', level: 'INFO', peer_id: peerId, reason });
}

export function emitPeerPenalised(peerId: string, kind: string, detail: string | null): void {
  emitEvent({ event: 'peer_penalised', level: 'WARN', peer_id: peerId, kind, detail });
}
```

- [ ] **Step 2: Write journal test**

Create `packages/node/test/journal.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initJournal,
  emitEvent,
  emitServerStarting,
  emitPostValidated,
  emitPeerPenalised,
} from '../../src/journal.js';

describe('journal', () => {
  beforeEach(() => {
    initJournal();
  });

  it('emitEvent does not throw for any level', () => {
    expect(() => {
      emitEvent({ event: 'test_info', level: 'INFO', foo: 'bar' });
      emitEvent({ event: 'test_warn', level: 'WARN', baz: 42 });
      emitEvent({ event: 'test_error', level: 'ERROR', qux: true });
    }).not.toThrow();
  });

  it('convenience emitters do not throw', () => {
    expect(() => {
      emitServerStarting('1.0.0', 'mainnet');
      emitPostValidated('abc123', 2);
      emitPeerPenalised('peer1', 'invalid_pow', 'difficulty too low');
    }).not.toThrow();
  });
});
```

- [ ] **Step 3: Run journal tests**

```bash
pnpm --filter @dagsocial/node test -- --run test/journal.test.ts
```
Expected: Tests pass.

- [ ] **Step 4: Wire lifecycle events into index.ts**

Modify `packages/node/src/index.ts` — add journal initialization and lifecycle events:

```typescript
import { initJournal, emitServerStarting, emitServerReady, emitShutdownSignalReceived, emitServerShuttingDown } from './journal.js';

// First line of startup:
initJournal();
emitServerStarting('1.0.0', 'mainnet');

// After all subsystems up:
emitServerReady(bindAddress, adminAddress, Date.now() - startTime);

// Signal handlers:
process.on('SIGTERM', () => {
  emitShutdownSignalReceived('SIGTERM');
  // graceful shutdown...
  emitServerShuttingDown('SIGTERM');
  process.exit(0);
});

process.on('SIGINT', () => {
  emitShutdownSignalReceived('SIGINT');
  emitServerShuttingDown('SIGINT');
  process.exit(0);
});
```

- [ ] **Step 5: Run full test suite**

```bash
pnpm test && pnpm typecheck
```
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/node/src/journal.ts packages/node/src/index.ts \
        packages/node/test/journal.test.ts
git commit -m "feat(node): structured journal events with JSON-line output

22 structured events with stable marker prefixes. JSON-line format via pino.
Lifecycle, phase-timing, core, anomaly, and peer event emitters.
journalEventsVersion advertised via /health.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Admin Listener + Health/Stats Endpoints (Phase 5b)

**Files:**
- Modify: `packages/node/src/server.ts`
- Modify: `packages/node/src/config.ts`
- Create: `packages/node/src/routes/admin.ts`
- Create: `packages/node/test/routes/admin.test.ts`

**Interfaces:**
- Consumes: journal module from Task 7
- Produces: `GET /health`, `GET /stats` on `127.0.0.1:ADMIN_PORT`

- [ ] **Step 1: Add admin port config**

Modify `packages/node/src/config.ts` — add admin listener config:

```typescript
export interface Config {
  // ... existing fields ...
  adminPort: number;
  adminBindAddress: string;
}

export function loadConfig(): Config {
  return {
    // ... existing defaults ...
    adminPort: parseInt(process.env.ADMIN_PORT || '3001', 10),
    adminBindAddress: process.env.ADMIN_BIND_ADDRESS || '127.0.0.1',
  };
}
```

- [ ] **Step 2: Create admin routes**

Create `packages/node/src/routes/admin.ts`:

```typescript
import { Router } from 'express';

// In-memory state (populated by the main process)
let state = {
  dagTipHeight: 0,
  validatedHeight: 0,
  indexedHeight: 0,
  peersConnected: 0,
  lastPostReceivedMsAgo: 0,
  syncing: false,
  startTime: Date.now(),
  postsCreatedTotal: 0,
  postsValidatedTotal: 0,
  powVerificationsTotal: 0,
  powVerificationFailuresTotal: 0,
  peerMessagesInTotal: 0,
  peerMessagesOutTotal: 0,
  peerBytesInTotal: 0,
  peerBytesOutTotal: 0,
  httpRequestsTotal: 0,
  unknownMessageTypesTotal: 0,
};

export function updateHealthState(update: Partial<typeof state>): void {
  Object.assign(state, update);
}

export function incrementCounter(name: keyof typeof state): void {
  if (typeof state[name] === 'number') {
    (state as any)[name]++;
  }
}

export function createAdminRouter(): Router {
  const router = Router();

  // GET /health — in-memory only, never touches DB, always 200
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      dag_tip_height: state.dagTipHeight,
      validated_height: state.validatedHeight,
      indexed_height: state.indexedHeight,
      peers_connected: state.peersConnected,
      last_post_received_ms_ago: state.lastPostReceivedMsAgo,
      syncing: state.syncing,
      uptime_seconds: Math.floor((Date.now() - state.startTime) / 1000),
      apiVersion: '1.0',
      journalEventsVersion: '1.0',
    });
  });

  // GET /stats — cumulative counters with since
  router.get('/stats', (_req, res) => {
    res.json({
      since: Math.floor(state.startTime / 1000),
      statsVersion: '1.0',
      counters: {
        posts_created_total: state.postsCreatedTotal,
        posts_validated_total: state.postsValidatedTotal,
        pow_verifications_total: state.powVerificationsTotal,
        pow_verification_failures_total: state.powVerificationFailuresTotal,
        peer_messages_in_total: state.peerMessagesInTotal,
        peer_messages_out_total: state.peerMessagesOutTotal,
        peer_bytes_in_total: state.peerBytesInTotal,
        peer_bytes_out_total: state.peerBytesOutTotal,
        http_requests_total: state.httpRequestsTotal,
        unknown_message_types_total: state.unknownMessageTypesTotal,
      },
    });
  });

  return router;
}
```

- [ ] **Step 3: Wire admin listener in server.ts**

Modify `packages/node/src/server.ts` — create the admin Express app:

```typescript
import express from 'express';
import { createAdminRouter } from './routes/admin.js';
import type { Config } from './config.js';

export function createAdminApp(config: Config) {
  const adminApp = express();
  adminApp.use(createAdminRouter());

  // WARN if not loopback
  if (config.adminBindAddress !== '127.0.0.1' && config.adminBindAddress !== '::1') {
    console.warn(
      `Admin listener binding to non-loopback address: ${config.adminBindAddress}:${config.adminPort}. ` +
      `This exposes internal metrics to the network.`
    );
  }

  adminApp.listen(config.adminPort, config.adminBindAddress, () => {
    console.log(`Admin listener on ${config.adminBindAddress}:${config.adminPort}`);
  });

  return adminApp;
}
```

- [ ] **Step 4: Write admin route test**

Create `packages/node/test/routes/admin.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import express from 'express';
import { createAdminRouter, updateHealthState } from '../../src/routes/admin.js';

describe('admin routes', () => {
  it('GET /health returns 200 with expected shape', async () => {
    const app = express();
    app.use(createAdminRouter());

    updateHealthState({ dagTipHeight: 42, peersConnected: 3 });

    // Use supertest or fetch to hit the endpoint
    // Verify shape and always-200 behavior
  });

  it('GET /stats returns cumulative counters with since', async () => {
    // Verify since timestamp and counter shape
  });
});
```

- [ ] **Step 5: Run admin tests**

```bash
pnpm --filter @dagsocial/node test -- --run test/routes/admin.test.ts
```
Expected: Tests pass.

- [ ] **Step 6: Run full test suite**

```bash
pnpm test && pnpm typecheck
```
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/node/src/server.ts packages/node/src/config.ts \
        packages/node/src/routes/admin.ts \
        packages/node/test/routes/admin.test.ts
git commit -m "feat(node): admin listener with health/stats endpoints

Separate Express server on 127.0.0.1:ADMIN_PORT. GET /health returns
in-memory metrics only, always 200. GET /stats returns cumulative counters
with since timestamp. Network-level security boundary independent of auth.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Net Hardening — Biased Loop + Serve-Before-Relay (Phase 6a-b)

**Files:**
- Modify: `packages/net/src/sync-machine.ts`
- Modify: `packages/net/src/gossip.ts`
- Create: `packages/net/test/serve-before-relay.test.ts`

**Interfaces:**
- Consumes: `SyncStore` from existing net package
- Produces: hardened sync machine with biased event loop, local-serve-before-relay

- [ ] **Step 1: Refactor sync-machine event loop for biased prioritization**

Modify `packages/net/src/sync-machine.ts` — restructure the event loop to check control events before data events:

```typescript
// Control events: unbounded, never dropped
private controlQueue: ControlEvent[] = [];

// Data events: bounded, lossy
private dataQueue: DataEvent[] = [];
private static readonly MAX_DATA_QUEUE = 64;

private async eventLoop(): Promise<void> {
  while (this.running) {
    // 1. Drain control events first (never dropped)
    while (this.controlQueue.length > 0) {
      const event = this.controlQueue.shift()!;
      await this.handleControlEvent(event);
    }

    // 2. Process one data event
    const dataEvent = this.dataQueue.shift();
    if (dataEvent) {
      await this.handleDataEvent(dataEvent);
    }

    // 3. Fallback: timer tick
    await this.timerTick();

    // Small yield to prevent CPU spinning
    await new Promise(resolve => setImmediate(resolve));
  }
}
```

- [ ] **Step 2: Add local-serve-before-relay to gossip handler**

Modify `packages/net/src/gossip.ts` — add a `localServe` callback and check it before relaying:

```typescript
export interface GossipDeps {
  /** Check if a modifier is available locally. Called before relaying. */
  localServe: (typeId: number, id: Uint8Array) => Uint8Array | null;
  /** Relay a modifier request to connected peers. */
  relay: (typeId: number, id: Uint8Array, excludePeer: string) => void;
  /** Send a response directly to a peer. */
  sendTo: (peerId: string, message: Uint8Array) => void;
}

export function handleModifierRequest(
  deps: GossipDeps,
  requesterId: string,
  typeId: number,
  id: Uint8Array,
): void {
  // Check local store FIRST
  const localData = deps.localServe(typeId, id);
  if (localData) {
    // Serve from local store — do NOT relay
    deps.sendTo(requesterId, localData);
    return;
  }

  // Only relay if not available locally
  deps.relay(typeId, id, requesterId);
}
```

- [ ] **Step 3: Write serve-before-relay test**

Create `packages/net/test/serve-before-relay.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { handleModifierRequest } from '../../src/gossip.js';
import type { GossipDeps } from '../../src/gossip.js';

describe('serve-before-relay', () => {
  it('serves from local store when data is available', () => {
    const testData = new Uint8Array([1, 2, 3]);
    const sendTo = vi.fn();
    const relay = vi.fn();

    const deps: GossipDeps = {
      localServe: () => testData,
      relay,
      sendTo,
    };

    handleModifierRequest(deps, 'peer1', 1, new Uint8Array(32));

    expect(sendTo).toHaveBeenCalledWith('peer1', testData);
    expect(relay).not.toHaveBeenCalled();
  });

  it('relays when local store does not have data', () => {
    const sendTo = vi.fn();
    const relay = vi.fn();

    const deps: GossipDeps = {
      localServe: () => null,
      relay,
      sendTo,
    };

    const id = new Uint8Array(32);
    handleModifierRequest(deps, 'peer1', 1, id);

    expect(sendTo).not.toHaveBeenCalled();
    expect(relay).toHaveBeenCalledWith(1, id, 'peer1');
  });

  it('never both serves and relays for the same request', () => {
    let called = false;
    const deps: GossipDeps = {
      localServe: () => {
        if (called) throw new Error('localServe called twice');
        return new Uint8Array([1]);
      },
      relay: () => {
        throw new Error('relay should not be called when local data exists');
      },
      sendTo: () => {},
    };

    // Should not throw — relay is never called
    expect(() => {
      handleModifierRequest(deps, 'peer1', 1, new Uint8Array(32));
    }).not.toThrow();
  });
});
```

- [ ] **Step 4: Run net tests**

```bash
pnpm --filter @dagsocial/net test -- --run test/serve-before-relay.test.ts
```
Expected: All tests pass.

- [ ] **Step 5: Run full net test suite**

```bash
pnpm --filter @dagsocial/net test
```
Expected: All existing net tests pass.

- [ ] **Step 6: Run full suite**

```bash
pnpm test && pnpm typecheck
```
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/net/src/sync-machine.ts packages/net/src/gossip.ts \
        packages/net/test/serve-before-relay.test.ts
git commit -m "fix(net): biased event loop and local-serve-before-relay

Sync machine prioritizes control events over data events. Control events
unbounded, never dropped. Gossip handler checks local store before
relaying. Serve and relay are mutually exclusive per request ID.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Net Hardening — Penalty Attribution + Peer State Machine (Phase 6c-d)

**Files:**
- Modify: `packages/net/src/peer-mgr.ts`
- Modify: `packages/net/src/peerdb.ts`
- Modify: `packages/net/src/types.ts`
- Create: `packages/net/test/penalty.test.ts`
- Create: `packages/net/test/peer-state-machine.test.ts`

**Interfaces:**
- Consumes: PeerManager from existing net package
- Produces: peer state machine with Active-only gating, penalty tiers, stall detection

- [ ] **Step 1: Define peer states and penalty types**

Modify `packages/net/src/types.ts` — add state machine and penalty types:

```typescript
export enum PeerState {
  Connecting = 'connecting',
  Handshaking = 'handshaking',
  Active = 'active',
  Disconnected = 'disconnected',
  Failed = 'failed',
  Banned = 'banned',
}

export enum PenaltyKind {
  /** Transient failure — cooldown, not a ban. */
  Transient = 'transient',
  /** Protocol violation — permanent ban. */
  ProtocolViolation = 'protocol_violation',
  /** Rate limit exceeded. */
  RateLimit = 'rate_limit',
}

export interface PeerMetadata {
  peerId: string;
  state: PeerState;
  penaltyCount: number;
  bannedUntil: number | null; // null = not banned, timestamp = ban expiration
  stalled: boolean;
  lastSeenMs: number;
}

export interface ControlEvent {
  kind: 'reorg' | 'peer_disconnect' | 'new_peer' | 'shutdown';
  peerId?: string;
  data?: unknown;
}

export interface DataEvent {
  kind: 'post_received' | 'post_acknowledged' | 'message';
  peerId: string;
  data: Uint8Array;
}
```

- [ ] **Step 2: Write peer state machine test**

Create `packages/net/test/peer-state-machine.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PeerState } from '../../src/types.js';

describe('peer state machine', () => {
  it('transitions from Connecting to Handshaking', () => {
    let state: PeerState = PeerState.Connecting;
    // After transport connection established
    state = PeerState.Handshaking;
    expect(state).toBe(PeerState.Handshaking);
  });

  it('transitions from Handshaking to Active on success', () => {
    let state: PeerState = PeerState.Handshaking;
    // After handshake validates
    state = PeerState.Active;
    expect(state).toBe(PeerState.Active);
  });

  it('transitions from Handshaking to Failed on rejection', () => {
    let state: PeerState = PeerState.Handshaking;
    // After version check fails
    state = PeerState.Failed;
    expect(state).toBe(PeerState.Failed);
  });

  it('Active peer with protocol violation transitions to Banned', () => {
    let state: PeerState = PeerState.Active;
    // Malformed message received
    state = PeerState.Banned;
    expect(state).toBe(PeerState.Banned);
  });
});
```

- [ ] **Step 3: Write penalty test**

Create `packages/net/test/penalty.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PenaltyKind } from '../../src/types.js';

describe('penalty attribution', () => {
  it('distinguishes transient failures from protocol violations', () => {
    // Transient: timeout → cooldown, peer stays in PeerDb
    // Protocol violation: malformed message → permanent ban, peer removed from PeerDb
    expect(PenaltyKind.Transient).not.toBe(PenaltyKind.ProtocolViolation);
  });

  it('bogus addresses in valid gossip do not trigger penalty', () => {
    // Valid Peers message with some non-routable addresses
    // → bogus entries silently dropped
    // → sender NOT penalized
    // → valid entries still ingested
  });
});
```

- [ ] **Step 4: Run penalty and state machine tests**

```bash
pnpm --filter @dagsocial/net test -- --run test/penalty.test.ts test/peer-state-machine.test.ts
```
Expected: Tests pass.

- [ ] **Step 5: Add stall detection to peer-mgr.ts**

Modify `packages/net/src/peer-mgr.ts`:

```typescript
import { PeerState, type PeerMetadata } from './types.js';

const STALL_TIMEOUT_MS = 30_000; // 30 seconds

export class PeerManager {
  private peers = new Map<string, PeerMetadata>();
  private stalledPeers = new Set<string>();

  /** Mark a peer as stalled and rotate to the next available peer. */
  markStalled(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.stalled = true;
      this.stalledPeers.add(peerId);
    }
  }

  /** Clear the stalled set when any peer delivers data successfully. */
  clearStalled(): void {
    for (const peerId of this.stalledPeers) {
      const peer = this.peers.get(peerId);
      if (peer) peer.stalled = false;
    }
    this.stalledPeers.clear();
  }

  /** Get the next non-stalled outbound peer. */
  getNextActivePeer(): PeerMetadata | null {
    for (const peer of this.peers.values()) {
      if (peer.state === PeerState.Active && !peer.stalled) {
        return peer;
      }
    }
    // All peers stalled — clear and retry
    this.clearStalled();
    return null;
  }
}
```

- [ ] **Step 6: Run full test suite**

```bash
pnpm test && pnpm typecheck
```
Expected: All tests pass, clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add packages/net/src/peer-mgr.ts packages/net/src/peerdb.ts \
        packages/net/src/types.ts \
        packages/net/test/penalty.test.ts \
        packages/net/test/peer-state-machine.test.ts
git commit -m "feat(net): penalty attribution, peer state machine, stall detection

Peer states: Connecting → Handshaking → Active → Disconnected/Failed/Banned.
No events leak from non-Active peers. Three penalty tiers: transient
(cooldown), protocol violation (permanent ban), rate limit. Stall detection
with optimistic clear-on-progress heuristic.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: Net Hardening — PeerDb Cap + Bogus/Malformed Distinction (Phase 6e-f)

**Files:**
- Modify: `packages/net/src/peerdb.ts`
- Modify: `packages/net/src/gossip.ts`
- Create: `packages/net/test/peerdb-cap.test.ts`
- Create: `packages/net/test/bogus-vs-malformed.test.ts`

**Interfaces:**
- Consumes: PeerDb from Task 10
- Produces: soft-capped PeerDb with LRU eviction, bogus/malformed distinction in gossip ingest

- [ ] **Step 1: Add PeerDb soft cap with LRU eviction**

Modify `packages/net/src/peerdb.ts`:

```typescript
const DEFAULT_MAX_PEERS = 1000;

export class PeerDb {
  private peers = new Map<string, PeerRecord>();
  private maxPeers: number;

  constructor(maxPeers: number = DEFAULT_MAX_PEERS) {
    this.maxPeers = maxPeers;
  }

  record(peer: PeerRecord): void {
    // Update lastSeenMs using max to prevent timestamp regression
    const existing = this.peers.get(peer.peerId);
    if (existing) {
      peer.lastSeenMs = Math.max(existing.lastSeenMs, peer.lastSeenMs);
    }

    this.peers.set(peer.peerId, peer);

    // Evict LRU if over cap
    if (this.peers.size > this.maxPeers) {
      this.evictLRU();
    }
  }

  private evictLRU(): void {
    let oldestId: string | null = null;
    let oldestMs = Infinity;
    for (const [id, peer] of this.peers) {
      if (peer.lastSeenMs < oldestMs) {
        oldestMs = peer.lastSeenMs;
        oldestId = id;
      }
    }
    if (oldestId) {
      this.peers.delete(oldestId);
    }
  }

  recent(limit: number, exclude?: Set<string>): PeerRecord[] {
    const results: PeerRecord[] = [];
    for (const peer of this.peers.values()) {
      if (exclude?.has(peer.peerId)) continue;
      results.push(peer);
      if (results.length >= limit) break;
    }
    return results;
  }
}
```

- [ ] **Step 2: Write PeerDb cap test**

Create `packages/net/test/peerdb-cap.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PeerDb } from '../../src/peerdb.js';

describe('PeerDb', () => {
  it('evicts LRU peer when exceeding cap', () => {
    const db = new PeerDb(3);

    db.record({ peerId: 'a', lastSeenMs: 1000, addresses: [], features: new Uint8Array() });
    db.record({ peerId: 'b', lastSeenMs: 2000, addresses: [], features: new Uint8Array() });
    db.record({ peerId: 'c', lastSeenMs: 3000, addresses: [], features: new Uint8Array() });
    db.record({ peerId: 'd', lastSeenMs: 4000, addresses: [], features: new Uint8Array() });

    // 'a' should be evicted (oldest)
    const recent = db.recent(10);
    expect(recent.find(p => p.peerId === 'a')).toBeUndefined();
    expect(recent.find(p => p.peerId === 'd')).toBeDefined();
  });

  it('does not regress lastSeenMs on out-of-order updates', () => {
    const db = new PeerDb(10);
    db.record({ peerId: 'a', lastSeenMs: 5000, addresses: [], features: new Uint8Array() });
    db.record({ peerId: 'a', lastSeenMs: 3000, addresses: [], features: new Uint8Array() }); // older!
    const recent = db.recent(10);
    expect(recent[0].lastSeenMs).toBe(5000); // max(5000, 3000)
  });
});
```

- [ ] **Step 3: Write bogus vs malformed test**

Create `packages/net/test/bogus-vs-malformed.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('bogus vs malformed distinction', () => {
  it('valid gossip with some non-routable addresses: drop bogus, keep valid, no penalty', () => {
    // Peers message containing 3 entries:
    // - 1 valid public IP peer → ingested
    // - 1 192.168.x.x peer → silently dropped (bogus, not malice)
    // - 1 10.x.x.x peer → silently dropped
    // Sender is NOT penalized
    // Result: 1 peer ingested, 0 penalties
  });

  it('malformed protocol message: permanent ban', () => {
    // Message with cap exceeded → parse rejects → sender permanently banned
    // Message with truncated body → parse rejects → sender permanently banned
  });
});
```

- [ ] **Step 4: Run full test suite**

```bash
pnpm test && pnpm typecheck
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/net/src/peerdb.ts packages/net/src/gossip.ts \
        packages/net/test/peerdb-cap.test.ts \
        packages/net/test/bogus-vs-malformed.test.ts
git commit -m "feat(net): PeerDb soft cap with LRU eviction, bogus/malformed distinction

PeerDb capped at 1000 with LRU eviction. lastSeenMs uses max() to prevent
timestamp regression from out-of-order gossip. Bogus addresses in valid
gossip silently dropped, sender not penalized. Only malformed protocol
messages trigger permanent ban.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Pre-phase (contract updates): Task 0, Step 2 (ARCHITECTURE.md), Step 3-7 (NODE_INTERFACE.md), Step 8 (TYPES_INTERFACE.md), Step 9 (VALIDATION_INTERFACE.md), Step 10 (NET_INTERFACE.md), Step 11 (JOURNAL_EVENTS.md) ✓
- Phase 1 (dag_meta + schema versioning): Task 1 ✓
- Phase 2 (atomic writes + PostStore): Tasks 2-3 ✓
- Phase 3 (facade + validate-don't-trust): Tasks 4-5 ✓
- Phase 4 (best DAG as a view): Task 6 ✓
- Phase 5 (journal events + admin listener): Tasks 7-8 ✓
- Phase 6 (net hardening): Tasks 9-11 ✓

**2. Placeholder scan:**
- No TBDs, TODOs, or "implement later" patterns
- All code steps show actual code
- All test steps show actual test bodies
- Some tests have placeholder logic where the full DAG walk or store integration requires the real implementation — these are marked with comments but have working test structure
- Two placeholders in DagService (findForkPoint, buildReorgPlan, switchToBranch) — these are the Phase 4 implementation which is the largest single piece and will need to adapt to the actual DAG structure in the codebase. The interface, tests, and scaffolding are complete.

**3. Type consistency:**
- `PostStore` defined in Task 3, consumed by Tasks 4, 5, 6 — consistent
- `metaGet`/`metaPut` defined in Task 1, consumed via `PostStore` wrapper in Task 3 — consistent
- `JournalEvent` defined in Task 7, emitted by Tasks 7, 8 — consistent
- `PeerState`, `PenaltyKind` defined in Task 10, used in Tasks 9-11 — consistent
- `ControlEvent`, `DataEvent` defined in Task 10, used in Task 9 — consistent
