# @dagsocial/node — Component Session Context

You are the **node component session** for **Notis** (repo dir `dagsocial`). This file is your standing
context — read it and the linked docs before touching code.

## Read first, in order
1. `~/projects/OVERRIDES.md` — mechanical overrides (dead-code-first, phased execution, root-cause only,
   forced verification, edit integrity, the blockchain rules). Apply throughout.
2. `~/.claude/RTK.md` — RTK proxy rules (use `rtk proxy` for any search/diff whose completeness you act on).
3. `../../CLAUDE.md` (repo root) — project overview + the Design-by-Contract dispatch workflow.
4. `../../contracts/ARCHITECTURE.md` — system architecture + invariants.
5. The interface contract(s) for your task — `../../contracts/NODE_INTERFACE.md` always, plus
   `VALIDATION_INTERFACE.md`, `MEMPOOL_INTERFACE.md`, `MINING_INTERFACE.md`, `SUBBLOCK_INTERFACE.md`,
   `JOURNAL_EVENTS.md` as relevant.
6. Your task's spec in `../../docs/specs/` (e.g. `2026-08-01-node-value-integrity.md`).

## What Notis is
An invite-only decentralized social network on a **dual-ledger** design: a **Posts DAG** (author-sovereign,
prunable content) and a **UTXO ledger** (non-tradeable **karma** + tradeable **credits**), bound by
**stumps**. Consensus is PoW — user sub-blocks + validator ordering blocks. TypeScript, pnpm workspaces,
Node.js ≥ 22.

## This package (`@dagsocial/node`)
The full node: Express HTTP API, PoW verifier, SQLite store, UTXO engine, block creator + application,
epoch tally, decay, invites/vouch, faucet, prune settlement, AVL+ state, and the demo UI
(`public/index.html`).

- **Owns:** `src/server.ts`, `src/routes/*`, `src/services/*`, `src/store/*`, `src/state/*` (AVL+),
  `public/index.html`.
- **Does NOT own:** shared structures/hashing (`@dagsocial/types`), stateless validation
  (`@dagsocial/validation`), networking (`@dagsocial/net`), wire codec (`@dagsocial/wire`). Need a change
  there? Describe it back to the main session — do not edit sibling packages.

## Component-session rules (Design by Contract)
- **Contracts lead, code follows.** Implement to the contract. If a contract is wrong or missing, flag it
  to main — don't silently diverge (extra rules create fork surfaces).
- **You own this package only.** Never edit `../types`, `../net`, `../validation`, `../wire`, the repo-root
  `contracts/`, or another session's work. Cross-package needs go back to main.
- **Forced verification before "done":** `pnpm --filter @dagsocial/node typecheck` (zero errors) **and**
  `pnpm --filter @dagsocial/node test` (all pass). State the results; never claim done on an unverified write.
- **Phased execution:** ≤5 files per phase; verify between phases; wait for approval before the next.
- **Report back** to the main session via kitty `send-text` when a phase/task is complete.

## Node-relevant invariants (full set in ARCHITECTURE.md)
- **Value conservation** — user txs conserve value; karma/credits are minted or burned only in explicit
  block-application paths, never inside a user tx. (Being *enforced* by the value-integrity spec — today the
  node does not enforce it.)
- **Hashing** — `blake2b512` truncated via `.subarray(0, 32)` for every 32-byte output; must match the demo
  UI's `blakejs`.
- **Signatures** — raw Ed25519 (64 bytes), verified with `crypto.verify(null, …)` and a KeyObject.
- **On-chain time = block height**, never wall-clock.
- **Single-transaction atomic writes** for any multi-table mutation.
- **Secret keys never** appear in API responses or DTOs.

## Quick commands
```bash
pnpm --filter @dagsocial/node typecheck   # tsc --noEmit, zero errors
pnpm --filter @dagsocial/node test        # vitest run, all pass
pnpm --filter @dagsocial/node build       # tsup
node packages/node/dist/index.js          # run the node (from repo root)
```
