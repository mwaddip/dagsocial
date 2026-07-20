# DAGsocial Phase 2 — Node Implementation

**Date:** 2026-07-20
**Status:** Design approved
**Scope:** Clean-slate rewrite of `@dagsocial/node` against Phase 2 contracts (dual-ledger: Posts DAG + UTXO). Types package already done. 5-phase pipeline execution with parallel subagents per phase.

## Stack (unchanged)

| Concern | Choice |
|---------|--------|
| Runtime | Node.js ≥ 22 |
| HTTP | Express |
| SQLite | `better-sqlite3` |
| Serialization | `cbor-x` (CBOR) |
| Testing | Vitest |
| Build | `tsup` |

## Preconditions

- `@dagsocial/types` Phase 2 built and importable (63 tests, green)
- Contracts approved: `ARCHITECTURE.md`, `NODE_INTERFACE.md`, `TYPES_INTERFACE.md`
- Clean slate — no Phase 1 migration, fresh SQLite schema

## Phases

### Phase 1: Foundation
**1 file, 1 subagent (~30 LOC)**

`config.ts` — environment variable parsing with defaults from `@dagsocial/types` constants plus node-specific config (PORT, DB_PATH, ORDERING_BLOCK_INTERVAL_MS, etc.).

### Phase 2: Store
**9 files, 8 subagents in parallel (~400 LOC)**

All modules behind the Store interface. Table prefixes: `dag_`, `utxo_`, `sub_`, `block_`. The `index.ts` barrel is written by the `db.ts` agent (trivial re-export + `initDb` orchestrator).

| File | Scope |
|------|-------|
| `db.ts` | `initDb(path)`, `getDb()`, `closeDb()`, WAL mode |
| `identities.ts` | `insertIdentity`, `getIdentity` (carried forward, adapted) |
| `challenges.ts` | `createChallenge`, `getActiveChallenge`, `consumeChallenge` (replaces slots) |
| `posts.ts` | DAG store: `insertPost`, `getPost`, `queryPosts`, `getPendingPosts`, `confirmPost`, `getParentRefs`, `getSubtree`, `pruneSubtree` |
| `utxo.ts` | Boxes: `getBox`, `getUnspentBoxes`, `getKarmaBox`, `getCreditBox`, `getPendingInvites`, `getPendingInviteCount`, `getBondBoxes`, `getLikeBoxes`, `getUnprocessedLikeBoxes`, `insertBox`, `consumeBox`, `markLikeBoxesTallied` |
| `subblocks.ts` | `insertSubBlock`, `getPendingSubBlocks`, `confirmSubBlock` |
| `ordering.ts` | `createOrderingBlock`, `getOrderingBlock`, `getCurrentHeight` |
| `stumps.ts` | `insertStump`, `getStump` |

### Phase 3: Services
**7 files, 7 subagents in parallel (~500 LOC)**

| File | Scope |
|------|-------|
| `verifier.ts` | `verifyPost(post, currentBlockHeight)` — 7 checks fail-fast: challenge, PoW, signature, parent refs, content limit, protocol version, karma |
| `pow.ts` | Challenge-response PoW: generate 32-byte challenge, verify PoW solution against `POST_POW_TARGET_BITS` |
| `utxo-engine.ts` | `validateAndApplyTx(tx, currentBlockHeight)` — stateless validation (box existence, value conservation, guards), stateful validation (decay, legal transitions), apply |
| `block-creator.ts` | `start/stop/onSubBlockReceived` — timer-driven + count-driven ordering block creation, epoch tally (like rewards + author rewards + liker refunds) |
| `stump-engine.ts` | Subtree walk, karma delta aggregation, merkle root, stump construction |
| `invites.ts` | Create (karma+bond split, secret hash), claim (hash preimage verify, new account karma box), cancel (signature verify, refund) |
| `likes.ts` | Signature verify, karma check, UTXO transaction construction for like boxes |

### Phase 4: Routes
**8 files, 8 subagents in parallel (~350 LOC)**

Express route handlers. All responses JSON. Each route file owns one resource area:

| File | Endpoints |
|------|-----------|
| `identity.ts` | `POST /identity`, `POST /identity/import`, `GET /identity/:userId` |
| `challenges.ts` | `POST /challenge` |
| `posts.ts` | `POST /posts`, `GET /posts/:id`, `GET /posts` |
| `likes.ts` | `POST /likes` |
| `invites.ts` | `POST /invites`, `POST /invites/claim`, `POST /invites/cancel` |
| `pruning.ts` | `POST /posts/:id/prune` |
| `utxo.ts` | `GET /karma/:userId`, `GET /credits/:userId`, `GET /invites/:userId` |
| `blocks.ts` | `GET /blocks/:height`, `GET /blocks/current`, `GET /status` |

### Phase 5: Integration
**2 files, 1 subagent (~80 LOC)**

| File | Scope |
|------|-------|
| `server.ts` | Express app assembly: middleware (JSON parse, error handler), mount all route modules, serve demo UI at `/` |
| `index.ts` | Entry point: initDb → start block creator → start server → graceful shutdown handlers |

## Verification per phase

| Phase | Command | Gate |
|-------|---------|------|
| 1 | `tsc --noEmit` on config.ts | Pass before Phase 2 |
| 2 | `tsc --noEmit` + store unit tests | Pass before Phase 3 |
| 3 | `tsc --noEmit` + service unit tests (mocked store) | Pass before Phase 4 |
| 4 | `tsc --noEmit` + route integration tests | Pass before Phase 5 |
| 5 | Full `pnpm test` (types + node), `pnpm build`, manual smoke test | Done |

## File layout

```
packages/node/src/
├── config.ts
├── index.ts
├── server.ts
├── store/
│   ├── index.ts (barrel + initDb orchestrator)
│   ├── db.ts
│   ├── identities.ts
│   ├── challenges.ts
│   ├── posts.ts
│   ├── utxo.ts
│   ├── subblocks.ts
│   ├── ordering.ts
│   └── stumps.ts
├── services/
│   ├── verifier.ts
│   ├── pow.ts
│   ├── utxo-engine.ts
│   ├── block-creator.ts
│   ├── stump-engine.ts
│   ├── invites.ts
│   └── likes.ts
└── routes/
    ├── identity.ts
    ├── challenges.ts
    ├── posts.ts
    ├── likes.ts
    ├── invites.ts
    ├── pruning.ts
    ├── utxo.ts
    └── blocks.ts
```

## Test layout

```
packages/node/test/
├── store/
│   ├── db.test.ts
│   ├── identities.test.ts
│   ├── challenges.test.ts
│   ├── posts.test.ts
│   ├── utxo.test.ts
│   ├── subblocks.test.ts
│   ├── ordering.test.ts
│   └── stumps.test.ts
├── services/
│   ├── verifier.test.ts
│   ├── pow.test.ts
│   ├── utxo-engine.test.ts
│   ├── block-creator.test.ts
│   ├── stump-engine.test.ts
│   ├── invites.test.ts
│   └── likes.test.ts
└── routes/
    ├── identity.test.ts
    ├── challenges.test.ts
    ├── posts.test.ts
    ├── likes.test.ts
    ├── invites.test.ts
    ├── pruning.test.ts
    ├── utxo.test.ts
    └── blocks.test.ts
```

## Subagent contract

Each subagent receives:
1. `~/projects/OVERRIDES.md` — mechanical overrides
2. `~/projects/dagsocial/CLAUDE.md` — project conventions
3. `contracts/NODE_INTERFACE.md` — relevant section
4. `contracts/ARCHITECTURE.md` — invariants
5. `packages/types/src/index.ts` — available types/functions
6. For store agents: store interface contract from NODE_INTERFACE.md + other store files for consistency
7. For service agents: verifier/UTXO engine/block creator contract + store interface for dependency signatures
8. For route agents: HTTP API contract + service signatures

Each agent writes: source file + test file. Agent output is validated by phase-level `tsc --noEmit` before the phase is considered complete.
