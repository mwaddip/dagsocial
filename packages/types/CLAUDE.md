# @dagsocial/types — Component Session Context

You are the **types component session** for **Notis** (repo dir `dagsocial`). This file is your standing
context — read it and the linked docs before touching code.

## Read first, in order
1. `~/projects/OVERRIDES.md` — mechanical overrides (root-cause only, forced verification, exhaustive rename
   search, blockchain rules). Apply throughout.
2. `~/.claude/RTK.md` — RTK proxy rules (`rtk proxy` for completeness-critical searches/diffs).
3. `../../CLAUDE.md` (repo root) — project overview + Design-by-Contract dispatch workflow.
4. `../../contracts/ARCHITECTURE.md` — architecture + invariants.
5. `../../contracts/TYPES_INTERFACE.md` — this package's contract.
6. Your task's spec in `../../docs/specs/`.

## What Notis is
An invite-only decentralized social network on a **dual-ledger** design: a **Posts DAG** (author-sovereign,
prunable) and a **UTXO ledger** (non-tradeable **karma** + tradeable **credits**), bound by **stumps**.
Consensus is PoW. TypeScript, pnpm workspaces, Node.js ≥ 22.

## This package (`@dagsocial/types`)
The shared data model and cryptographic/encoding primitives: posts, blocks, stumps, boxes, identity,
base58, merkle, CBOR serialization, protocol constants, and the hash/id helpers (`computePostId`,
`computeBoxId`, `computeTxId`, `signingHash`, `postPowPreimage`). **Pure functions only** — no I/O, no state.

- **Owns:** `src/*` (post, block, stump, utxo, identity, base58, merkle, serialization, constants, index).
- **Does NOT own:** node logic, networking, stateless validation, wire codec. Depends only on Node `crypto`
  and `cbor-x`. A consumer needs a change? It comes back through the main session.

## Component-session rules (Design by Contract)
- **Contracts lead, code follows.** Implement to `TYPES_INTERFACE.md`; flag contract gaps to main.
- **You own this package only.** Never edit `../node`, `../net`, `../validation`, `../wire`, or `contracts/`.
- **Forced verification before "done":** `pnpm --filter @dagsocial/types typecheck` (zero errors) **and**
  `pnpm --filter @dagsocial/types test` (all pass). State results; never claim done unverified.
- **Exhaustive rename search** — a hash/id/encoding change here ripples into node, validation, and the demo
  UI. Grep every consumer (code, types, strings, tests) before changing a primitive; report the blast radius.
- **Phased execution:** ≤5 files per phase; verify between phases. **Report back** via kitty when done.

## Types-relevant invariants (full set in ARCHITECTURE.md)
- **Pure functions only** — no filesystem, network, DB, or global state.
- **Hashing** — `blake2b512` truncated via `.subarray(0, 32)` for every 32-byte output; must produce output
  identical to `@dagsocial/validation` and the demo UI's `blakejs`.
- **Deterministic CBOR** — `cbor-x` insertion-order encoding; box/tx ids must be reproducible byte-for-byte.
- **Canonical encoding** — a post/box/tx has exactly one id; distinct objects never collide. (The
  canonicalization spec changes `computePostId`'s field encoding — coordinate with validation + demo UI.)
- **No dependencies above this package's abstraction level.**

## Quick commands
```bash
pnpm --filter @dagsocial/types typecheck
pnpm --filter @dagsocial/types test
pnpm --filter @dagsocial/types build
```
