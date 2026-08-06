# E2E suite — PARKED 2026-08-06

These three specs are **excluded from `pnpm test`** (`vitest.config.ts` → `exclude`). They are kept
as reference for the rewrite, not maintained. Do not repair them in place.

## Why

Two independent Phase 2 units invalidate the suite, so repairing it now means writing it twice.

**P2-D deletes what the suite tests.** `harness.test.ts`'s "Like accumulation" chapter, and the
`likeTx` / `castLike` helpers it runs on, build `boxType:'like'` boxes with `guard:'epoch_tally'`
and wait on epoch boundaries. The design track (§5.3–§5.5) removes `LikeBox` and the epoch interval
entirely — a like becomes a burn transaction plus a `(liker, post)` record, settled per block.

**P2-A removes how the suite runs at all.** `harness/node-manager.ts` compresses consensus
timescales through environment overrides — `KARMA_DECAY_INTERVAL_BLOCKS=3` against a constant of
1440, `ORDERING_BLOCK_POW_TARGET_BITS=4` against 12. Those reads are being deleted because two
operators holding different values partition permanently. The replacement is a network-profile
table (`mainnet` / `testnet` / `regtest`) selected by one network id, so the rewrite gets its
compressed timescale legitimately rather than by per-process override.

## State at parking

| File | Note |
|---|---|
| `harness.test.ts` | 1 test, 10 chapters. The "Like accumulation" chapter **logs instead of asserting** (`:187-192`) — `likeCount` may be 0 if the epoch never tallied inside the window, and the test passes either way |
| `decay-full-pipeline.test.ts` | 2 tests. **Load-flake, root-caused**: the fixture paces on wall-clock `wait(4000)` while decay advances on block height, so under parallel load decay outruns the budget and the invite change output goes negative. The node is correctly rejecting a malformed tx |
| `delete-pipeline.test.ts` | 1 test. PostLockBox create → delete → karma returned. The only one not directly coupled to likes, but it still builds `guard:'epoch_tally'` boxes |

`.github/workflows/e2e-harness.yml` invokes `--testPathPattern`, which is a **Jest** flag; vitest
has no such option. What that job actually runs is unverified.

## What the rewrite depends on

1. **P2-D landed** — likes are burns, no epoch, per-block settlement.
2. **P2-A landed** — the network-profile table exists, so `regtest` is a selectable network with
   compressed constants rather than an env-override soup.
3. **Pacing on block height, never wall clock.** The current flake is exactly the defect that rule
   exists to prevent, in a fixture rather than in protocol code. Poll the chain tip.
4. **Assertions that fail.** A chapter that logs its headline claim is not coverage.
