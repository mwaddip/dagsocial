# @dagsocial/net — Component Session Context

You are the **net component session** for **Notis** (repo dir `dagsocial`). This file is your standing
context — read it and the linked docs before touching code.

## Read first, in order
1. `~/projects/OVERRIDES.md` — mechanical overrides (root-cause only, forced verification, blockchain rules).
2. `~/.claude/RTK.md` — RTK proxy rules (`rtk proxy` for completeness-critical searches/diffs).
3. `../../CLAUDE.md` (repo root) — project overview + Design-by-Contract dispatch workflow.
4. `../../contracts/ARCHITECTURE.md` — architecture + invariants.
5. `../../contracts/NET_INTERFACE.md` — this package's contract (plus `WIRE_INTERFACE.md` for framing).
6. Your task's spec in `../../docs/specs/`.

## What Notis is
An invite-only decentralized social network on a **dual-ledger** design: a **Posts DAG** and a **UTXO
ledger** (karma + credits), bound by **stumps**. Consensus is PoW — user sub-blocks + validator ordering
blocks, gossiped and synced peer-to-peer. TypeScript, pnpm workspaces, Node ≥ 22.

## This package (`@dagsocial/net`)
The **libp2p networking layer**: gossip (sub-blocks, ordering blocks, UTXO txs, stumps, peers), the framed
stream sync protocol (SyncInfo/Inv/Modifier), peer management + PeerDb, and handshake. Two-stage validation:
Stage 1 (stateless, via `@dagsocial/validation`) runs **before relay**; Stage 2 (stateful) runs in the node.

- **Owns:** `src/*` (`node.ts`, `sync-machine.ts`, `sync.ts`, `gossip.ts`, `peer-mgr.ts`, `peerdb.ts`,
  `types.ts`).
- **Does NOT own:** chain state / consensus / block application (that's `@dagsocial/node`; net calls into it
  via registered handlers), data structures (`@dagsocial/types`), stateless checks
  (`@dagsocial/validation`), the wire codec (`@dagsocial/wire`, which net uses).

## Component-session rules (Design by Contract)
- **Contracts lead, code follows.** Implement to `NET_INTERFACE.md`; flag contract gaps to main.
- **You own this package only.** Never edit `../node`, `../types`, `../validation`, `../wire`, or `contracts/`.
- **Forced verification before "done":** `pnpm --filter @dagsocial/net typecheck` (zero errors) **and**
  `pnpm --filter @dagsocial/net test` (all pass). State results; never claim done unverified.
- **Phased execution:** ≤5 files per phase; verify between phases. **Report back** via kitty when done.

## Net-relevant invariants (full set in ARCHITECTURE.md)
- **No method panics on untrusted input** — validate every decoded sync/handshake/gossip message's shape
  (field presence, array-ness, `Number.isInteger` + non-negative bounds on heights/counts) at the decode
  boundary; wrap event-loop dispatch so one bad message degrades one message, not the subsystem.
- **Stage-1 validation before relay** — never re-gossip an object that hasn't passed stateless validation
  (structure, PoW, limits).
- **Bounded resources** — enforce max message size, max inbound id counts, and sane height bounds; no
  unbounded stream buffering.
- **On-chain time = block height**, never wall-clock.

## Quick commands
```bash
pnpm --filter @dagsocial/net typecheck
pnpm --filter @dagsocial/net test
pnpm --filter @dagsocial/net build
```
