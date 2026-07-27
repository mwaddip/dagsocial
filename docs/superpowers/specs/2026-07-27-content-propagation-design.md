# Content Propagation — Design

**Date:** 2026-07-27
**Status:** draft
**Scope:** `@dagsocial/types`, `@dagsocial/net`, `@dagsocial/node`

Fixes three gaps in content propagation after block/DAG separation, plus two
small integrity and code-quality items.

## 1. Post ID Integrity Check (Defense-in-Depth)

### Problem

`verifyPostForRelay` verifies signature, PoW, structure, and parent hashes, but
never checks that `computePostId(post)` matches the claimed `subBlockId`. A
malicious peer could respond to a content-fetch request with different content
that passes all structural checks (it's a valid post — just not the one
requested). The placeholder for the requested ID would remain unresolved.

This also applies to the gossip relay path: signature and PoW verification
implicitly catch content tampering (both cover content), but the check is
implicit. An explicit cross-check is defense-in-depth.

### Fix

Add a check in `verifyPostForRelay` (or a new thin wrapper) that computes
`computePostId(post)` and compares against the expected ID. Callers that have
a claimed ID (relay handler, content sweep) pass it through. Callers that don't
(parent hash verification, which works differently) skip it.

```typescript
// New function — thin wrapper around verifyPostForRelay
export function verifyPostId(post: Post, expectedId: string): boolean {
  return computePostId(post) === expectedId;
}
```

Call sites:
- **Relay handler** (`index.ts`): after `verifyPostForRelay` passes, also check
  `verifyPostId(sb.post, sb.subBlockId)`. Reject on mismatch.
- **Content sweep**: after receiving a `Posts` response, for each entry check
  `verifyPostId(entry.post, entry.postId)`. Drop mismatched entries.

This is not a new validation rule in `verifyPostForRelay` — it's a separate
check because the expected ID comes from context (SubBlock envelope,
GetPosts response), not from the post itself.

### What Doesn't Change

- `computePostId` already exists and is the canonical ID derivation.
- `verifyPostForRelay` keeps its current signature and checks.
- Parent hash verification (`verifyParentHash`) is unchanged — it already
  recomputes `computePostId` for parent posts and compares.

## 2. Gap 2 — Sync Handler Serves Placeholder Content

### Problem

The sync handler at `index.ts:252` checks:
```typescript
if (!post || !('author' in post)) return null;
```

`insertPostPlaceholder` inserts `author = Buffer.alloc(32)` (32 zero bytes),
not `null`. So `'author' in post` is true for placeholders. The handler
returns a SubBlock with a zeroed-author, empty-content post, and the requesting
peer stores it as valid content.

### Fix

Change the guard to check for non-empty content:
```typescript
if (!post || !post.content) return null;
```

`post.content` is `''` for placeholders, 1–300 UTF-8 bytes for real posts.
This is the canonical "is this post real" check. No schema change needed.

## 3. Gap 5 — Mempool Gossip: Re-broadcast on Relay

### Problem

When a post arrives via gossip relay (`index.ts` onSubBlock handler), the node
inserts it into the store and mempool but does not re-broadcast it to its other
peers. Content only propagates one hop from the origin.

### Fix

After successful insert and mempool queue, re-broadcast:

```typescript
net.onSubBlock((sb) => {
  const result = verifyPostForRelay(deps, sb.post, 0);
  if (!result.valid) {
    console.warn(`Relayed sub-block rejected: ${result.error}`);
    return;
  }
  // NEW: verify post ID matches claimed subBlockId (§1)
  if (!verifyPostId(sb.post, sb.subBlockId)) {
    console.warn(`Relayed sub-block rejected: post ID mismatch`);
    return;
  }
  insertPost(sb.post, encodePost(sb.post));
  const currentHeight = getCurrentHeight();
  insertMempoolSubBlock(sb.subBlockId, currentHeight + MEMPOOL_EXPIRY_BLOCKS);
  // NEW: re-broadcast to other peers
  net.broadcastSubBlock(sb).catch((err: Error) => {
    console.warn(`Failed to relay sub-block ${sb.subBlockId}: ${err.message}`);
  });
  console.log(`Relayed sub-block queued in mempool: ${sb.subBlockId}`);
});
```

Gossip message-ID dedup (`seenCache` in libp2p gossipsub) prevents infinite
loops. Each message has a deterministic message ID; a node that receives its
own re-broadcast silently drops it. The topic validator
(`gossip.ts:67-84`) already checks structural validity before forwarding to
mesh peers.

Broadcast happens *after* insert succeeds. If insert fails, we don't propagate.

## 4. Gap 6 — Replace `as SubBlock` Cast

### Problem

The sync handler casts a plain object to `SubBlock`:
```typescript
return {
  subBlockId,
  post,
  likeBoxes: [],
  producerId: post.author,
  protocolVersion: post.protocolVersion,
} as SubBlock;
```

Structurally correct but brittle — if `SubBlock` gains required fields, this
silently produces incomplete objects.

### Fix

Add a typed factory to `@dagsocial/types`:

```typescript
export function subBlockFromPost(
  post: Post,
  subBlockId: string,
  likeBoxes: AnyBox[] = [],
): SubBlock {
  return {
    subBlockId,
    post,
    likeBoxes,
    producerId: post.author,
    protocolVersion: post.protocolVersion,
  };
}
```

The sync handler becomes:
```typescript
return subBlockFromPost(post, subBlockId);
```

Single source of truth. Any new required SubBlock field breaks at the factory,
not at each call site.

## 5. Gap 1 — Content Sweep (Pull-Based Fetch After Block Sync)

### Problem

When a node syncs blocks from a peer, it receives topology (`subBlockEntries`)
and creates placeholder posts via `insertPostPlaceholder`. But the sub-block
gossip messages containing the actual post content were broadcast before the
syncing node connected. No pull-based content fetch exists to backfill.

Result: a synced node has complete topology but placeholder content for all
posts it didn't see via live gossip.

### Design

#### New Message Pair

Two new framed stream messages (same framing as existing messages:
`[magic:4][version:1][code:VLQ][length:VLQ][checksum:4][body]`):

```
GetPosts {
  postIds: string[]   // hex-encoded 32-byte post IDs, max 100 per request
}

Posts {
  entries: {
    postId: string    // hex-encoded 32-byte post ID
    post: Post        // full Post object, CBOR-encoded
    likeBoxes: AnyBox[]  // associated like boxes (may be empty)
  }[]
}
```

- Max 100 IDs per `GetPosts` request.
- Responder looks up each ID in `dag_posts`, skips placeholders (`content = ''`),
  and returns only posts it actually has.
- No error for missing posts — the requester retries from another peer.
- Responder validates IDs are 64-char hex before querying (reject malformed).
- Requester validates each returned post: `verifyPostForRelay` + `verifyPostId`
  (§1) before calling `insertPost`.

#### Content Sweep Algorithm

New file: `packages/node/src/services/content-sweep.ts`.

```
sweepPlaceholders(maxRetries: number = 5):
  retries = 0
  delay = 2s

  while retries < maxRetries:
    placeholders = query(
      "SELECT id FROM dag_posts WHERE status='pending' AND content=''"
    )
    if placeholders is empty: return { success: true, remaining: 0 }

    batches = chunk(placeholders, 50)
    for batch in batches:
      // Send to up to 3 connected peers (or all if fewer than 3)
      send GetPosts(batch) to up to 3 randomly selected connected peers
      for each Posts response:
        for each entry:
          if !verifyPostId(entry.post, entry.postId): continue
          // Reuse existing relay validation (same PostStore deps as relay handler)
          result = verifyPostForRelay(postStoreDeps, entry.post, 0)
          if !result.valid: continue
          insertPost(entry.post, encodePost(entry.post))
          // insertPost upgrades the placeholder (content, author, signature,
          // PoW, CBOR are filled in; parent_refs unchanged; status stays
          // 'pending' until confirmed in a block)

    remaining = count of remaining placeholders
    if remaining == 0: return { success: true, remaining: 0 }
    retries++
    sleep(delay * retries)  // 2s, 4s, 8s, ...

  return { success: false, remaining }
```

#### Trigger Hooks

1. **Sync complete:** The sync machine signals "caught up" — all known headers
   and blocks downloaded. New callback `onSyncComplete` registered via
   `NetNode.onSyncComplete(cb)`. The sync machine already tracks whether it's
   at tip (no more headers to request); this callback fires when that state is
   reached after at least one block was downloaded. When it fires,
   `sweepPlaceholders()` runs.

2. **Peer connected:** If the node has unresolved placeholders and gains a new
   peer, re-run `sweepPlaceholders()`. Uses the existing `peer:connect` event
   already emitted by the net layer. This handles the case where sync completed
   with no peers that had the content, and a new peer joins later.

3. **Manual trigger (future):** Admin endpoint to force a sweep. Not in this
   design — deferred to admin API work.

#### Edge Cases

| Scenario | Behavior |
|----------|----------|
| No peers connected | Sweep returns immediately. Re-runs on next peer connection. |
| Post genuinely unavailable (author deleted, offline) | Placeholder persists. Logged at warning level. DAG topology preserved. |
| Race with incoming gossip | `insertPost` handles upgrade atomically. Duplicate insert is no-op. |
| Reorg during sweep | New placeholders added — picked up on next retry pass. Already-resolved posts that get unconformed stay as full posts in `dag_posts`. |
| Request to peer that also only has placeholder | Peer omits the post from `Posts` response. Requester tries next peer. |
| Malformed response | Individual entries that fail `verifyPostId` or `verifyPostForRelay` are dropped. Other entries in the same response still processed. |
| Large DAG (thousands of placeholders) | Batched at 50 IDs per request. Sweep completes in multiple rounds. |

### What Doesn't Change

- Block sync (header-first, Inv/Modifier protocol) — no changes.
- `insertPost` / `insertPostPlaceholder` — no changes.
- Gossip topic validators — no changes.
- Existing sync handler message types — no changes.

## Test Plan

### Post ID Integrity
- `verifyPostId` returns true when `computePostId(post) === expectedId`.
- `verifyPostId` returns false on content, author, or parentRefs mismatch.
- Relay handler rejects sub-blocks with mismatched `subBlockId`.
- Content sweep drops `Posts` entries with mismatched `postId`.

### Sync Handler Guard
- Placeholder post (`content = ''`) → handler returns null.
- Real post (`content = 'hello'`) → handler returns SubBlock.
- Deleted/pruned post (null from getPost) → handler returns null.

### Re-broadcast
- Valid incoming sub-block → `broadcastSubBlock` is called after insert.
- Invalid incoming sub-block → `broadcastSubBlock` is NOT called.
- `broadcastSubBlock` failure is caught and logged, doesn't crash handler.

### Content Sweep
- All placeholders resolved → sweep returns success with remaining=0.
- Some placeholders unresolvable after max retries → returns remaining count.
- Malformed response (bad postId) → entry dropped, other entries processed.
- No peers → sweep returns immediately (not stuck in retry loop).
- New peer connection triggers re-sweep when placeholders exist.

### SubBlock Factory
- `subBlockFromPost(post, id)` returns a valid SubBlock with all fields.
- `subBlockFromPost(post, id, likeBoxes)` includes provided like boxes.
- Sync handler uses factory instead of `as SubBlock` cast.

### Integration
- Two-node test: N1 mines blocks with posts. N2 connects and syncs blocks.
  After sync, N2 has content for all posts (via content sweep). N2 can serve
  posts to a third node.
- Three-hop relay: N1 creates post, broadcasts to N2. N2 relays to N3. N3
  has the post content (not just placeholder).
