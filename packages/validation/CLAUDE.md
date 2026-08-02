# @dagsocial/validation — Component Session Context

You are the **validation component session** for **Notis** (repo dir `dagsocial`). This file is your
standing context — read it and the linked docs before touching code.

## Read first, in order
1. `~/projects/OVERRIDES.md` — mechanical overrides (root-cause only, forced verification, blockchain rules).
2. `~/.claude/RTK.md` — RTK proxy rules (`rtk proxy` for completeness-critical searches/diffs).
3. `../../CLAUDE.md` (repo root) — project overview + Design-by-Contract dispatch workflow.
4. `../../contracts/ARCHITECTURE.md` — architecture + invariants.
5. `../../contracts/VALIDATION_INTERFACE.md` — this package's contract.
6. Your task's spec in `../../docs/specs/`.

## What Notis is
An invite-only decentralized social network on a **dual-ledger** design: a **Posts DAG** (author-sovereign,
prunable) and a **UTXO ledger** (non-tradeable **karma** + tradeable **credits**), bound by **stumps**.
Consensus is PoW. TypeScript, pnpm workspaces, Node.js ≥ 22.

## This package (`@dagsocial/validation`)
**Pure, stateless validation** — the Stage-1 checks that run before an object enters the store or is
relayed: PoW verification, Ed25519 signature checks, hash/id recomputation, content byte-limits, parent-ref
counts, protocol version, and block structure. No DB, no network, no chain state.

- **Owns:** `src/*` (`verify.ts`, `index.ts`).
- **Does NOT own:** stateful checks (that's `@dagsocial/node` — UTXO liveness, guard evaluation), data
  structures (`@dagsocial/types`), networking (`@dagsocial/net`), wire codec (`@dagsocial/wire`).

## Component-session rules (Design by Contract)
- **Contracts lead, code follows.** Implement to `VALIDATION_INTERFACE.md`; flag contract gaps to main.
- **You own this package only.** Never edit `../node`, `../types`, `../net`, `../wire`, or `contracts/`.
- **Forced verification before "done":** `pnpm --filter @dagsocial/validation typecheck` (zero errors) **and**
  `pnpm --filter @dagsocial/validation test` (all pass). State results; never claim done unverified.
- **Phased execution:** ≤5 files per phase; verify between phases. **Report back** via kitty when done.

## Validation-relevant invariants (full set in ARCHITECTURE.md)
- **No method panics on untrusted input** — every function returns a result/`false`, never throws, on
  malformed or adversarial input (guard integers with `Number.isInteger`/`isFinite`, byte lengths, array-ness).
- **Validate, don't trust** — independently recompute every self-reported claim (PostId, PoW, signature)
  rather than accepting the object's own values.
- **Never add checks the reference lacks** — an extra rule beyond the protocol spec is a fork surface. Every
  rule is protocol-spec or explicitly local-policy-only.
- **Deterministic** — the same input yields the same verdict on every node and Node.js version.
- **Pure/stateless** — no I/O, no chain state; hashing must match `@dagsocial/types` and the demo UI.

## Quick commands
```bash
pnpm --filter @dagsocial/validation typecheck
pnpm --filter @dagsocial/validation test
pnpm --filter @dagsocial/validation build
```
