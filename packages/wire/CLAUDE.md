# @dagsocial/wire — Component Session Context

You are the **wire component session** for **Notis** (repo dir `dagsocial`). This file is your standing
context — read it and the linked docs before touching code.

## Read first, in order
1. `~/projects/OVERRIDES.md` — mechanical overrides (root-cause only, forced verification, truncation
   suspicion, blockchain rules).
2. `~/.claude/RTK.md` — RTK proxy rules (`rtk proxy` for completeness-critical searches/diffs).
3. `../../CLAUDE.md` (repo root) — project overview + Design-by-Contract dispatch workflow.
4. `../../contracts/ARCHITECTURE.md` — architecture + invariants.
5. `../../contracts/WIRE_INTERFACE.md` — this package's contract.
6. Your task's spec in `../../docs/specs/`.

## What Notis is
An invite-only decentralized social network on a **dual-ledger** design: a **Posts DAG** and a **UTXO
ledger** (karma + credits), bound by **stumps**. Consensus is PoW. TypeScript, pnpm workspaces, Node ≥ 22.

## This package (`@dagsocial/wire`)
The low-level **wire codec**: the framed stream format, VLQ encoding, and `ByteReader`/`ByteWriter`. Frames
are `[magic:4][version:1][code:VLQ][length:VLQ][checksum:4][body]` (checksum = 32-byte blake2b, truncated).

- **Owns:** `src/*` (`frame.ts`, `reader.ts`, `writer.ts`, `vlq.ts`, `errors.ts`, `index.ts`).
- **Does NOT own:** transport/gossip/sync (`@dagsocial/net`, which uses this), data structures
  (`@dagsocial/types`), node logic.

## Component-session rules (Design by Contract)
- **Contracts lead, code follows.** Implement to `WIRE_INTERFACE.md`; flag contract gaps to main.
- **You own this package only.** Never edit `../net`, `../node`, `../types`, `../validation`, or `contracts/`.
- **Forced verification before "done":** `pnpm --filter @dagsocial/wire typecheck` (zero errors) **and**
  `pnpm --filter @dagsocial/wire test` (all pass). State results; never claim done unverified.
- **Phased execution:** ≤5 files per phase; verify between phases. **Report back** via kitty when done.

## Wire-relevant invariants (full set in ARCHITECTURE.md)
- **No panic on adversarial bytes** — every read bounds-checks against remaining length before slicing; an
  attacker-controlled length/count field can never cause an over-read or an unbounded allocation.
- **VLQ correctness** — encode/decode round-trips across the full documented range (up to 2⁵³); no silent
  32-bit truncation; reader and writer agree on bounds.
- **Deterministic encoding** — the same value always produces the same bytes.
- **Checksum integrity** — computed over the body and verified before the body is trusted.

## Quick commands
```bash
pnpm --filter @dagsocial/wire typecheck
pnpm --filter @dagsocial/wire test
pnpm --filter @dagsocial/wire build
```
