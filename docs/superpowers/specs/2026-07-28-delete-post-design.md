# Delete Post — Design Spec

**Date:** 2026-07-28
**Status:** draft
**Phase:** 2

## Overview

`DELETE /posts/:id` — author-verified, atomic call that prunes a post and its
entire reply subtree, unlocking and returning all PostLockBox karma locked
anywhere in the pruned subtree back to each respective author.

The call is atomic and deterministic: the API handler executes the prune,
produces the stump, and mempools it. Every syncing node replays the same
subtree walk during block application and derives the same PostLockBox
settlement. Nothing in the block application trusts a pre-computed list from
the intent — the UTXO movement is derived from the DAG deterministically.

## Motivation

Currently no way to delete a post. Authors who post content they later want to
remove have no mechanism to do so. The prune/stump infrastructure was built
specifically to support this feature — it compacts the pruned subtree into a
Stump that preserves karma and like history for all affected posts.

## Design

### 1. API endpoint — `DELETE /posts/:id`

Same author-verification pattern as `POST /posts/:id/prune`:

- Body: `{ authorId: string, signature: string }`
- Signature over a challenge (hex-encoded Ed25519)
- Returns: the stump and settlement details as a preview

**Verification steps:**
1. Post exists, not already pruned
2. Author matches
3. Signature valid

### 2. `executePrune` — remove root-only guard

Currently `executePrune` rejects posts with `parentRefs.length > 0`. This
guard is removed. Any post — root thread or reply — can be pruned.

The existing subtree walk via `getSubtree` already works for any post; the
only change is dropping the `parentRefs.length > 0` error.

### 3. PostLockBox settlement — during block application

When `applyOrderingBlock` processes a stump, after the existing karma delta
application (like-box aggregation), add a PostLockBox settlement pass:

```
for each post in the pruned subtree:
  lookup PostLockBox where targetPostId = post.id, status = unspent
  if found:
    sum remaining value per author

for each author with locked karma:
  mint that karma back to the author (consume PostLockBox, produce karma box)
  record in journal
```

Uses the same karma-minting path as the existing `postLockKarmaUnlocked`
mechanism in epoch tally. The lock box is consumed; karma is returned to the
author rather than burned.

### 4. No new mempool entry type

The stump, mempooled by `executePrune`, is the sole signal. The block
application processes it deterministically. No separate delete-intent or
burn-tx entry type is needed.

### 5. Deterministic replay

Every node, when applying a block containing stumps, walks the DAG subtree
from the stump's `rootPostHash` and derives the PostLockBox settlement
independently. If the DAG data for that subtree is missing (not yet synced),
the block application skips the settlement for that stump — it will be
replayed when the content sweep fills in the missing posts. The block is
NOT rejected for missing DAG data.

The DAG is read at block-apply time for discovery only. The UTXO mutations
are gated on UTXO-authoritative data (PostLockBox existence, owner identity).
An adversary feeding bogus DAG data cannot:
- Create fake PostLockBoxes (must exist in UTXO set)
- Redirect karma (owner is UTXO-authoritative)
- Double-consume (UTXO validation rejects spent inputs)
- Pull unrelated PostLockBoxes into scope (parent-child links are signed by
  each child's author)

### 6. Journal and fork resolution

PostLockBox consumption during stump processing is journaled via the existing
`consumeUtxoBox`/`unconsumeBox` pattern. Fork resolution automatically handles
revert-and-reapply of these mutations during reorgs.

### 7. Demo UI

- Delete button rendered per post when `post.author === currentUser`
- `confirm('Delete this post and all replies?')` gate
- Calls `DELETE /posts/:id` with signed challenge
- On success, refreshes the feed

## Data Flow

```
User clicks Delete
  → confirm()
  → sign challenge
  → DELETE /posts/:id
    → verify author + signature
    → executePrune:
        walk subtree
        collect like boxes
        compute karma deltas
        build Merkle root over pruned post IDs
        create Stump
        mempool stump
        prune posts in store (mark status = 'pruned')
    → return stump + settlement preview
  → next ordering block
    → drain stump from mempool
    → applyOrderingBlock per stump:
        walk DAG subtree (deterministic replay)
        process karma deltas from like boxes
        settle PostLockBoxes (consume, mint karma back to authors)
        journal UTXO mutations
```

## Changes Required

| Component | File | Change |
|-----------|------|--------|
| Types | — | No new types; Stump unchanged |
| Stump engine | `packages/node/src/services/stump-engine.ts` | Remove root-only guard (line 75-77) |
| Block apply | `packages/node/src/services/block-apply.ts` | Add PostLockBox settlement pass during stump processing |
| API routes | `packages/node/src/routes/posts.ts` (or new file) | Add `DELETE /posts/:id` endpoint |
| Server | `packages/node/src/server.ts` | Register delete route |
| Store (posts) | `packages/node/src/store/posts.ts` | No changes needed; `pruneSubtree` works for any post |
| Store (utxo) | `packages/node/src/store/utxo.ts` | May need `getPostLockBox(postId)` helper if not already present |
| Demo UI | `packages/node/public/index.html` | Delete button + confirm + API call |

## Test Plan

- **Unit: `executePrune` accepts reply post** — verify it no longer throws for `parentRefs.length > 0`
- **Unit: `executePrune` rejects pruned post** — idempotency guard still works
- **Unit: `executePrune` rejects wrong author** — author mismatch still caught
- **Unit: PostLockBox settlement during stump processing** — mock DAG data, verify karma minted to correct author
- **Unit: Settlement with no PostLockBox** — post without lock (pre-separation era) doesn't error
- **Integration: `DELETE /posts/:id`** — author verification, signature validation
- **Integration: full delete pipeline** — create post with lock, delete, verify karma returned
- **E2E: delete in multi-node** — delete on node A, verify node B replays settlement

## Open Questions

None.
