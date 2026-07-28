# E2E Test Harness — Design Spec

**Date:** 2026-07-28
**Status:** draft
**Phase:** 2

## Overview

A shared test harness that spawns multiple DAGsocial nodes as child processes and
exercises every state-affecting feature against a single continuous chain from
genesis. Three nodes (2 mining, 1 sync-only), 11 role-based identities, 10
sequential scenario chapters. Designed to run in GitHub CI on a self-hosted
runner in under 8 minutes.

The harness lives in `packages/node/test/harness/` as reusable modules. The
existing E2E tests (`decay-full-pipeline.test.ts`, `delete-pipeline.test.ts`)
continue to work as-is and can be ported to the harness later.

## Motivation

Current E2E tests are single-file, two-node, and duplicate node lifecycle
management (spawn, wait-for-ready, kill). Each tests one or two features. No
existing test covers the full system under sustained multi-identity activity,
sync-only node behavior, like-threshold unlocks, or non-root subtree deletes.

The harness solves three problems:
1. **Coverage** — one test exercises every state-affecting feature in sequence
2. **Reusability** — NodeManager, ApiClient, and IdentityPool are imported, not copy-pasted
3. **CI-readiness** — deterministic ports, compressed constants, timeout reporting

## Design

### 1. Harness modules

Four files in `packages/node/test/harness/`:

**`node-manager.ts`** — Node lifecycle.

- `spawnNode(index, config)` — spawns `node packages/node/dist/index.js` with
  env vars for port, DB path, mining mode, block interval, and compressed
  protocol constants. Returns a `NodeProcess` handle.
- `waitForReady(node, timeoutMs)` — polls `GET /status` with exponential
  backoff. Resolves when the node responds. Rejects with stderr tail on timeout.
- `killAll(nodes)` — SIGTERM → wait 5s → SIGKILL → wait for exit.
- Port allocation is deterministic: node N gets HTTP port `10300 + N` and
  libp2p port `10400 + N`.
- Node 0 is the bootstrap seed. Node 1 and 2 receive `BOOTSTRAP_PEERS` pointing
  at node 0's libp2p multiaddr.
- All nodes use `:memory:` DB.

**`api-client.ts`** — Typed HTTP wrappers.

- Constructor takes `baseUrl`. Every method returns typed responses.
- Wraps `fetch` with 3 retries (1s backoff) for transient failures.
- Composed helpers: `createPost(content, author, parents?)` handles the full
  pipeline — challenge fetch → PoW solve → karma lock tx build → submit.
  `castLike(liker, targetPostId)` handles the like UTXO transaction.
  `deletePost(author, postId)` handles challenge-sign → delete.
- Query helpers: `getKarma(userId)`, `getPost(postId)`, `getStatus()`,
  `queryPosts(opts)`, `getBlock(height)`.

**`identity-pool.ts`** — Keypair management.

- `createPool(roles: string[])` — generates an Ed25519 keypair per role using
  the existing `generateKeyPair()` from `@dagsocial/types`.
- Each identity returned as `{ role, publicKey, secretKey, userId }` where
  `userId` is the 32-byte public key in hex (the canonical identity string).
- `fundAll(pool, api)` — faucets every identity in the pool. Records the
  expected karma balance for later assertions.
- Tracks state: funded flag, last activity block, expected karma balance.

**`chapter-runner.ts`** — Sequential execution.

- `runChapters(chapters, state)` — runs `Chapter[]` sequentially. Each chapter
  is `{ name: string, fn: (state) => Promise<void>, timeoutMs: number }`.
- A chapter throws on assertion failure (vitest `expect`). The runner catches
  it, collects every node's stderr (last 30s), and re-throws with context.
- A `teardown` chapter always runs (kill nodes, print summary).
- Overall deadline: 8 minutes. On expiry, collects logs and fails with a
  timeout report naming the stuck chapter.

### 2. Identity roles

Eleven identities, all funded via faucet in chapter 1:

| Role | Purpose |
|------|---------|
| **alice** | Root thread author, accumulates 10 likes → tests PostLockBox unlock |
| **bob** | Root thread author, carol and dave reply under him → multi-author tree |
| **carol** | Replies under bob → reply creation, parent refs |
| **dave** | Replies under carol, also replies under frank → multi-level chains |
| **eve** | Root + self-reply, then deletes the root → cascading delete with karma return |
| **frank** | Root thread, dave replies, frank deletes dave's reply → non-root subtree prune |
| **grace** | Single post then inactive → primary decay subject |
| **heidi** | Single post then inactive → second decay data point |
| **liker-1** | Likes alice's post → contributes to unlock threshold |
| **liker-2** | Likes alice's post → contributes to unlock threshold |
| **liker-3** | Likes alice's post → contributes to unlock threshold |

The 7 non-dedicated-liker identities (bob, carol, dave, eve, frank, grace,
heidi) also like alice's post, bringing the total to 10 likes. This crosses
`POST_LOCK_UNLOCK_PER_LIKES = 10`, unlocking 1 of the 5 locked karma back to
alice. Alice also earns 2 karma in author rewards (10 likes / LIKE_THRESHOLD=5).

### 3. Test chapters

All chapters run against a single continuous chain. Nodes are never restarted.

**Chapter 0 — Genesis.** Launch node-0 (miner, bootstrap seed). Wait for first
block. Assert `blockHeight ≥ 1`.

**Chapter 1 — Faucet all identities.** Fund all 11 identities. Wait 2 blocks
for confirmation. Assert `GET /karma/:userId` → 100 for each.

**Chapter 2 — Launch node-1.** Spawn node-1 (miner, bootstraps from node-0).
Wait for handshake + sync-complete by polling `/status` on both nodes until
heights match. Assert both agree on block height and all karma balances.

**Chapter 3 — Root threads.** alice, bob, eve, frank each create a root thread.
grace and heidi each create a single post (will go inactive after this). Wait 2
blocks. Assert all 6 posts visible on both nodes via `GET /posts/:id`.

**Chapter 4 — Reply trees.** carol replies to bob's post. dave replies to
carol's reply (chain: bob → carol → dave). eve replies to her own root. dave
replies to frank's root. Wait 2 blocks. Assert all replies visible, parentRefs
verified.

**Chapter 5 — Launch node-2 (sync-only).** Spawn node-2 (mining disabled,
bootstraps from node-0). Wait for sync-complete + content sweep. Assert node-2
sees all posts and karma balances match node-0.

**Chapter 6 — Like accumulation.** 10 identities each cast a like on alice's
root thread (all except alice herself). Wait for epoch boundary to process
likes (EPOCH_BLOCKS compressed to 10 → ~20s at 2s blocks). Assert:
- alice's post has ≥10 total likes across all 3 nodes
- alice's PostLockBox unlocked 1 karma (10 likes / POST_LOCK_UNLOCK_PER_LIKES)
- alice received author reward (10 likes / LIKE_THRESHOLD=5 = 2 karma)

**Chapter 7 — Root-level delete.** eve deletes her root thread via
`DELETE /posts/eve-root-id`. Wait for stump settlement in blocks. Assert:
- eve's root and reply both return 404 on all nodes
- eve gets PostLockBox karma back (5 root + 3 reply = 8)
- eve's LikeBox karma on alice's post is returned

**Chapter 8 — Subtree delete (non-root).** frank deletes dave's reply under his
thread via `DELETE /posts/dave-reply-id`. Wait for stump settlement. Assert:
- dave's reply is gone, frank's root survives
- dave gets PostLockBox karma back (3 for reply)

**Chapter 9 — Karma decay.** grace and heidi have been inactive since chapter
3. Wait for `KARMA_STALE_THRESHOLD_BLOCKS` (compressed to 5) +
`KARMA_DECAY_INTERVAL_BLOCKS` (compressed to 3) blocks to pass. Assert:
- grace's karma decreased by KARMA_DECAY_AMOUNT (5), not below KARMA_MINIMUM (10)
- heidi's karma decreased by KARMA_DECAY_AMOUNT (5)
- alice (active, received likes + unlocks) has NOT decayed

**Chapter 10 — Cross-node consistency.** Query all 11 karma balances, all
surviving posts, and all like counts on all 3 nodes. Assert all three nodes
agree on every value. This is the final state snapshot — any divergence means
sync or replay has a bug.

### 4. Compressed constants

The following are set via environment variables to make the test CI-feasible:

| Constant | Real value | Test value | Reason |
|----------|-----------|------------|--------|
| `POW_SLOT_TARGET_BITS` | 20 | 4 | Fast PoW |
| `ORDERING_BLOCK_POW_TARGET_BITS` | 12 | 4 | Fast block mining |
| `ORDERING_BLOCK_INTERVAL_MS` | 60000 | 2000 | 2s blocks |
| `KARMA_STALE_THRESHOLD_BLOCKS` | 20160 | 5 | Decay observable |
| `KARMA_DECAY_INTERVAL_BLOCKS` | 720 | 3 | Decay observable |
| `KARMA_MINIMUM` | 10 | 10 | Same (needed for test) |
| `KARMA_DECAY_AMOUNT` | 5 | 5 | Same |
| `EPOCH_BLOCKS` | 60 | 10 | Like processing observable |
| `CHALLENGE_WINDOW_BLOCKS` | 10 | 100 | Long-lived challenges for delete auth |
| `INVITE_PROBATION_BLOCKS` | 1000 | 5 | Not tested in this harness |

Estimated runtime: ~5-7 minutes (dominated by chapter 6 epoch wait of ~20s and
chapter 9 decay wait of ~16-20s).

### 5. Error handling

Three failure modes handled explicitly:

1. **Node fails to start.** `waitForReady` timeout (30s). Dumps last 100 lines
   of the node's stderr. Fails with `"node-N failed to reach /status within 30s"`.

2. **Chapter assertion fails.** The chapter's `expect()` throws. ChapterRunner
   catches it, collects all three nodes' stderr (last 30s), dumps them into
   vitest output alongside the assertion error. The node log dump is the
   primary debugging artifact.

3. **Node crashes mid-test.** Next API call gets `ECONNREFUSED`. Harness
   detects child process exited, reports exit code + final stderr burst.
   Other nodes are left running so their state can be queried for diagnosis.

The overall 8-minute deadline is enforced by vitest's `testTimeout`. On expiry,
the harness collects whatever logs are available from still-running nodes and
fails with the name of the stuck chapter.

### 6. CI integration

```yaml
# .github/workflows/e2e-harness.yml
name: E2E Harness
on: [push, workflow_dispatch]
jobs:
  e2e:
    runs-on: self-hosted
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm test packages/node/test/e2e/harness.test.ts
```

The harness test file has its own vitest project config (or inline config) with
`testTimeout: 600000` (10 minutes). The CI job timeout of 15 minutes provides
headroom for build + install.

### 7. Non-goals

- **No invite testing** — invites are a multi-step flow involving bond boxes,
  probation periods, and commit/claim/cancel. Adding them would double the
  chapter count. Invites have their own route tests and integration tests.
- **No credit transfer testing** — credits are orthogonal to the DAG/social
  features this harness targets.
- **No fork resolution testing** — two miners on a fast interval will naturally
  produce forks, and the harness will observe them in logs, but active fork
  testing (intentional partition + heal) is out of scope.
- **No porting existing E2E tests** — the existing `decay-full-pipeline.test.ts`
  and `delete-pipeline.test.ts` continue as-is. Porting them is follow-up work.

## Testing the harness

The harness IS the test, so "testing the test" means:

1. Run it locally first (`pnpm test packages/node/test/e2e/harness.test.ts`)
2. Verify all 10 chapters pass
3. Intentionally break one assertion, verify the log dump works
4. Run it twice back-to-back to verify port cleanup
5. Run it via GitHub CI on the self-hosted runner

## Open questions

- Are `EPOCH_BLOCKS` and `POST_LOCK_UNLOCK_PER_LIKES` overridable via env vars?
  If not, the harness implementation must add those config knobs to the node
  package. This will be verified as the first implementation step.
