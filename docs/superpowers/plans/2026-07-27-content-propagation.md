# Content Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix content propagation after block/DAG separation — pull-based content sweep, re-broadcast relay, placeholder guard, post ID integrity, and typed SubBlock factory.

**Architecture:** Five small fixes (gaps 2, 5, 6, §1 integrity check) and one new subsystem (content sweep). The sweep runs after block sync completes, batch-fetches missing posts from peers using a new GetPosts/Posts request/response pair over the existing framed sync stream protocol. Re-broadcast leverages gossip message-ID dedup to prevent loops.

**Tech Stack:** TypeScript, Node.js ≥ 22, SQLite (better-sqlite3), libp2p, CBOR (cbor-x), blake2b512

## Global Constraints

- Protocol version 2 on all messages
- Hashing: blake2b512 with `.subarray(0, 32)` for 32-byte outputs
- Post content: 1–300 UTF-8 bytes
- Max 100 post IDs per GetPosts request
- Max 50 IDs per sweep batch
- Max 3 peers contacted per batch
- Max 5 retry rounds, exponential backoff from 2s
- Wire format: CBOR via cbor-x, framed with magic/version/code/length/checksum

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/types/src/block.ts` | Modify | Add `subBlockFromPost` factory |
| `packages/types/src/post.ts` | Modify | Add `verifyPostId` function |
| `packages/types/src/index.ts` | Modify | Export new functions |
| `packages/net/src/types.ts` | Modify | Add `MSG_GET_POSTS`, `MSG_POSTS` constants, `GetPostsMsg`, `PostsMsg` types |
| `packages/net/src/sync-codec.ts` | Modify | Add encode/decode for GetPosts/Posts |
| `packages/net/src/node.ts` | Modify | Add `registerPostsHandler`, `onSyncComplete`, `requestPosts`; handle MSG_GET_POSTS in stream handler |
| `packages/net/src/sync-machine.ts` | Modify | Fire `onSynced` callback on phase transition to `synced` |
| `packages/net/src/index.ts` | Modify | Export new types and constants |
| `packages/node/src/index.ts` | Modify | Fix sync handler guard, use factory, add re-broadcast + verifyPostId in relay handler, wire sweep triggers |
| `packages/node/src/services/content-sweep.ts` | Create | Content sweep algorithm |

---

### Task 1: Types Package — `subBlockFromPost` Factory and `verifyPostId`

**Files:**
- Modify: `packages/types/src/block.ts`
- Modify: `packages/types/src/post.ts`
- Modify: `packages/types/src/index.ts`

**Interfaces:**
- Produces: `subBlockFromPost(post: Post, subBlockId: string, likeBoxes?: AnyBox[]): SubBlock`
- Produces: `verifyPostId(post: Post, expectedId: string): boolean`

- [ ] **Step 1: Add `subBlockFromPost` to block.ts**

Read `packages/types/src/block.ts` to find the `SubBlock` interface and a good insertion point after it.

Add this function after the `SubBlock` interface definition:

```typescript
/** Construct a SubBlock from a Post, deriving producerId and protocolVersion. */
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

- [ ] **Step 2: Add `verifyPostId` to post.ts**

Read `packages/types/src/post.ts`. The `computePostId` function already exists there (around line 60). Add this function immediately after `computePostId`:

```typescript
/** Verify that a post's computed ID matches an expected ID. */
export function verifyPostId(post: Post, expectedId: string): boolean {
  return computePostId(post) === expectedId;
}
```

- [ ] **Step 3: Export both from barrel**

Read `packages/types/src/index.ts` to find where `SubBlock` and `computePostId` are exported. Add to the appropriate sections:

- In the block-related exports section, add `subBlockFromPost` alongside existing `SubBlock` exports.
- In the post-related exports section, add `verifyPostId` alongside the existing `computePostId` export.

- [ ] **Step 4: Build and typecheck**

Run: `pnpm build --filter @dagsocial/types`
Expected: Clean build, no errors.

Run: `pnpm typecheck`
Expected: No new type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/block.ts packages/types/src/post.ts packages/types/src/index.ts
git commit -m "feat(types): add subBlockFromPost factory and verifyPostId

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Net Package — GetPosts/Posts Message Types and Codec

**Files:**
- Modify: `packages/net/src/types.ts`
- Modify: `packages/net/src/sync-codec.ts`
- Modify: `packages/net/src/index.ts`

**Interfaces:**
- Produces: `MSG_GET_POSTS = 10`, `MSG_POSTS = 11` (numeric constants)
- Produces: `GetPostsMsg { postIds: string[] }`, `PostsMsg { entries: PostsEntry[] }` with `PostsEntry { postId: string; post: Post; likeBoxes: AnyBox[] }`
- Produces: `encodeGetPosts(msg: GetPostsMsg): Uint8Array`, `decodeGetPosts(body: Uint8Array): GetPostsMsg`
- Produces: `encodePosts(msg: PostsMsg): Uint8Array`, `decodePosts(body: Uint8Array): PostsMsg`

- [ ] **Step 1: Add message code constants and types**

Read `packages/net/src/types.ts`. Add after the existing `MSG_PEERS = 9`:

```typescript
export const MSG_GET_POSTS = 10;
export const MSG_POSTS = 11;
```

Add type interfaces after existing types (after `PeersMsg`):

```typescript
export interface GetPostsMsg {
  postIds: string[];
}

export interface PostsEntry {
  postId: string;
  post: Post;
  likeBoxes: AnyBox[];
}

export interface PostsMsg {
  entries: PostsEntry[];
}
```

Check imports: `Post` and `AnyBox` are from `@dagsocial/types`. If not already imported at the top, add:
```typescript
import type { Post, AnyBox } from '@dagsocial/types';
```

- [ ] **Step 2: Add encode/decode to sync-codec.ts**

Read `packages/net/src/sync-codec.ts`. The encode/decode functions are grouped in pairs. Add after the last existing pair (Peers):

```typescript
export function encodeGetPosts(msg: GetPostsMsg, magic: number): Uint8Array {
  // GetPostsMsg is a simple object — CBOR handles it natively
  return frameMessage(magic, MSG_GET_POSTS, msg);
}

export function decodeGetPosts(body: Uint8Array): GetPostsMsg {
  return decode(body) as GetPostsMsg;
}

export function encodePosts(msg: PostsMsg, magic: number): Uint8Array {
  return frameMessage(magic, MSG_POSTS, msg);
}

export function decodePosts(body: Uint8Array): PostsMsg {
  return decode(body) as PostsMsg;
}
```

Note: `PostsMsg.entries[].post` is a `Post` object. CBOR serializes it as-is since `Post` is a plain object with Uint8Array fields (which cbor-x handles natively). No custom serializer needed.

- [ ] **Step 3: Export from barrel**

Read `packages/net/src/index.ts`. Add the new exports:

```typescript
export {
  MSG_GET_POSTS,
  MSG_POSTS,
  type GetPostsMsg,
  type PostsEntry,
  type PostsMsg,
} from './types.js';
export {
  encodeGetPosts,
  decodeGetPosts,
  encodePosts,
  decodePosts,
} from './sync-codec.js';
```

- [ ] **Step 4: Build and typecheck**

Run: `pnpm build --filter @dagsocial/net`
Expected: Clean build. Check for any import issues with `Post`/`AnyBox` types.

- [ ] **Step 5: Commit**

```bash
git add packages/net/src/types.ts packages/net/src/sync-codec.ts packages/net/src/index.ts
git commit -m "feat(net): add GetPosts/Posts message types and codec

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Net Package — `requestPosts`, Posts Handler, and `onSyncComplete`

**Files:**
- Modify: `packages/net/src/node.ts`
- Modify: `packages/net/src/sync-machine.ts`

**Interfaces:**
- Consumes: `MSG_GET_POSTS`, `MSG_POSTS`, `GetPostsMsg`, `PostsMsg`, `encodeGetPosts`, `decodeGetPosts`, `encodePosts`, `decodePosts` (from Task 2)
- Produces: `NetNode.requestPosts(peerId: string, postIds: string[]): Promise<PostsMsg>`
- Produces: `NetNode.getConnectedPeers(): string[]`
- Produces: `NetNode.onSyncComplete(cb: () => void): void`
- Produces: `NetNode.onPeerActive(cb: (peerId: string) => void): void`
- Produces: `NetNode.setPostsHandler(handler: (postIds: string[]) => PostsEntry[]): void`

- [ ] **Step 1: Add posts handler field and setter to NetNode**

In `packages/net/src/node.ts`, find the existing `syncHandler` field (near other private fields). Add alongside it:

```typescript
private postsHandler: ((postIds: string[]) => PostsEntry[]) | null = null;
```

Add the setter method near `setSyncHandler`:

```typescript
setPostsHandler(handler: (postIds: string[]) => PostsEntry[]): void {
  this.postsHandler = handler;
}
```

Import `PostsEntry` from `./types.js` at the top of the file.

- [ ] **Step 2: Add MSG_GET_POSTS handler in stream handler**

In the `registerSyncStreamHandler` method, find the block that dispatches by message code (the if/else chain for MSG_GET_SUB_BLOCK, MSG_HANDSHAKE, etc.). Add after the MSG_GET_SUB_BLOCK handler block, before the else block that delegates to syncMachine:

```typescript
} else if (code === MSG_GET_POSTS) {
  if (!this.postsHandler) {
    // No handler registered — silently ignore (peer will time out)
    return;
  }
  const request = decodeGetPosts(body);
  const entries = this.postsHandler(request.postIds);
  const response = encodePosts({ entries }, this.magic);
  await stream.sink([response]);
```

Import `MSG_GET_POSTS`, `decodeGetPosts`, `encodePosts` at the top of node.ts.

- [ ] **Step 3: Add `requestPosts` method to NetNode**

Add this method near the existing `requestSubBlock` pattern or near `sendToPeer`:

```typescript
async requestPosts(peerId: string, postIds: string[]): Promise<PostsMsg> {
  const request = encodeGetPosts({ postIds }, this.magic);
  const stream = await this.libp2p.dialProtocol(peerId, SYNC_PROTOCOL);
  try {
    await stream.sink([request]);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.source) {
      chunks.push(new Uint8Array(chunk.slice()));
    }
    if (chunks.length === 0) {
      return { entries: [] };
    }
    const merged = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const frame = decodeFrame(this.magic, merged);
    if (frame.code !== MSG_POSTS) {
      console.warn(`[net] requestPosts: unexpected response code ${frame.code}`);
      return { entries: [] };
    }
    return decodePosts(frame.body);
  } catch (err) {
    console.warn(`[net] requestPosts failed for peer ${peerId}: ${String(err)}`);
    return { entries: [] };
  } finally {
    await stream.close().catch(() => {});
  }
}
```

Import `encodeGetPosts`, `decodePosts`, `MSG_POSTS`, `decodeFrame`, `SYNC_PROTOCOL`, and `PostsMsg` at the top.

- [ ] **Step 4: Add `getConnectedPeers` helper**

Add a public method to get connected peer IDs for the content sweep:

```typescript
getConnectedPeers(): string[] {
  return this.peerMgr.getPeers()
    .filter(p => p.state === PeerState.Active)
    .map(p => p.id);
}
```

- [ ] **Step 5: Add `onSyncComplete` and `onPeerActive` callbacks**

Add fields near other handler fields:

```typescript
private syncCompleteHandlers: Array<() => void> = [];
private peerActiveHandlers: Array<(peerId: string) => void> = [];
```

Add registration methods:

```typescript
onSyncComplete(cb: () => void): void {
  this.syncCompleteHandlers.push(cb);
}

onPeerActive(cb: (peerId: string) => void): void {
  this.peerActiveHandlers.push(cb);
}
```

Fire `peerActiveHandlers` in both handshake paths (inbound and outbound) after `this.syncMachine?.onPeerActive(...)`. Add after that line:

```typescript
for (const cb of this.peerActiveHandlers) {
  try { cb(peerId); } catch (err) {
    console.warn(`[net] peerActive handler error: ${String(err)}`);
  }
}
```

- [ ] **Step 6: Wire sync machine to fire callback**

In `packages/net/src/sync-machine.ts`, the sync machine needs a way to notify when it reaches `synced` phase. The cleanest approach: give the sync machine an `onSynced` callback.

Find the `SyncMachine` class fields. Add:

```typescript
private onSyncedCallbacks: Array<() => void> = [];
```

Add registration:

```typescript
onSynced(cb: () => void): void {
  this.onSyncedCallbacks.push(cb);
}
```

Find the phase transition in `handleSyncInfoMsg` where `this.state.phase = 'synced'` is set (around the `info.tipHeight === ourHeight` check). After setting phase to `synced`, fire callbacks:

```typescript
if (info.tipHeight === ourHeight && this.state.phase === 'syncing') {
  this.state.phase = 'synced';
  this.state.stalledPeers.clear();
  // Fire sync-complete callbacks
  for (const cb of this.onSyncedCallbacks) {
    try { cb(); } catch (err) {
      console.warn(`[sync-machine] onSynced callback error: ${String(err)}`);
    }
  }
}
```

Back in `node.ts`, find where the sync machine is created (in `start()`). After creating the sync machine (or when it's set), add:

```typescript
this.syncMachine?.onSynced(() => {
  for (const cb of this.syncCompleteHandlers) {
    try { cb(); } catch (err) {
      console.warn(`[net] syncComplete handler error: ${String(err)}`);
    }
  }
});
```

- [ ] **Step 7: Build and typecheck**

Run: `pnpm build --filter @dagsocial/net`
Expected: Clean build.

- [ ] **Step 8: Commit**

```bash
git add packages/net/src/node.ts packages/net/src/sync-machine.ts
git commit -m "feat(net): add requestPosts, posts handler, and onSyncComplete

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Node — Fix Sync Handler (Gaps 2 + 6)

**Files:**
- Modify: `packages/node/src/index.ts`

**Interfaces:**
- Consumes: `subBlockFromPost` from `@dagsocial/types` (Task 1)
- Consumes: `setPostsHandler` from `@dagsocial/net` (Task 3)

- [ ] **Step 1: Read the current sync handler code**

Read `packages/node/src/index.ts` lines 250-262 to confirm the current state.

- [ ] **Step 2: Fix the guard and use the factory**

Replace the sync handler block. Current code (approximate):
```typescript
net.setSyncHandler((subBlockId: string) => {
  const post = getPost(subBlockId);
  if (!post || !('author' in post)) return null;
  return {
    subBlockId,
    post,
    likeBoxes: [],
    producerId: post.author,
    protocolVersion: post.protocolVersion,
  } as SubBlock;
});
```

Replace with:
```typescript
net.setSyncHandler((subBlockId: string) => {
  const post = getPost(subBlockId);
  if (!post || !post.content) return null;
  return subBlockFromPost(post, subBlockId);
});
```

Remove the now-unused `as SubBlock` import if `SubBlock` is only imported for this cast. Check other usages of `SubBlock` in this file first.

- [ ] **Step 3: Register the posts handler for GetPosts requests**

Add after the `setSyncHandler` call. The posts handler needs to look up multiple posts and return non-placeholder entries:

```typescript
net.setPostsHandler((postIds: string[]) => {
  const entries: Array<{ postId: string; post: Post; likeBoxes: any[] }> = [];
  for (const postId of postIds) {
    const post = getPost(postId);
    if (!post || !post.content) continue; // skip missing and placeholders
    entries.push({ postId, post, likeBoxes: [] });
  }
  return entries;
});
```

Check imports: `Post` is likely already imported. If `PostsEntry` type is needed, import from `@dagsocial/net`.

- [ ] **Step 4: Build and typecheck**

Run: `pnpm build --filter @dagsocial/node`
Expected: Clean build. Verify no unused imports remain.

- [ ] **Step 5: Commit**

```bash
git add packages/node/src/index.ts
git commit -m "fix(node): sync handler uses content check and typed factory

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Node — Relay Handler Re-broadcast and Post ID Integrity (Gap 5 + §1)

**Files:**
- Modify: `packages/node/src/index.ts`

**Interfaces:**
- Consumes: `verifyPostId` from `@dagsocial/types` (Task 1)

- [ ] **Step 1: Read the current relay handler**

Read `packages/node/src/index.ts` lines 95-113 to confirm current state. Note the `deps` variable used by `verifyPostForRelay` — it should be defined earlier in the startup sequence.

- [ ] **Step 2: Add verifyPostId check and re-broadcast**

Replace the relay handler block. Current code:
```typescript
net.onSubBlock((sb) => {
  const result = verifyPostForRelay(deps, sb.post, 0);
  if (!result.valid) {
    console.warn(`Relayed sub-block rejected: ${result.error}`);
    return;
  }
  insertPost(sb.post, encodePost(sb.post));
  const currentHeight = getCurrentHeight();
  insertMempoolSubBlock(sb.subBlockId, currentHeight + MEMPOOL_EXPIRY_BLOCKS);
  console.log(`Relayed sub-block queued in mempool: ${sb.subBlockId}`);
});
```

Replace with:
```typescript
net.onSubBlock((sb) => {
  const result = verifyPostForRelay(deps, sb.post, 0);
  if (!result.valid) {
    console.warn(`Relayed sub-block rejected: ${result.error}`);
    return;
  }
  // Verify post ID matches claimed subBlockId (defense-in-depth)
  if (!verifyPostId(sb.post, sb.subBlockId)) {
    console.warn(`Relayed sub-block rejected: post ID mismatch for ${sb.subBlockId}`);
    return;
  }
  insertPost(sb.post, encodePost(sb.post));
  const currentHeight = getCurrentHeight();
  insertMempoolSubBlock(sb.subBlockId, currentHeight + MEMPOOL_EXPIRY_BLOCKS);
  // Re-broadcast to other peers (gap 5)
  net.broadcastSubBlock(sb).catch((err: Error) => {
    console.warn(`Failed to relay sub-block ${sb.subBlockId}: ${err.message}`);
  });
  console.log(`Relayed sub-block queued in mempool: ${sb.subBlockId}`);
});
```

Add `verifyPostId` to the imports from `@dagsocial/types`.

- [ ] **Step 3: Build and typecheck**

Run: `pnpm build --filter @dagsocial/node`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/index.ts
git commit -m "fix(node): verify post ID on relay and re-broadcast sub-blocks

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Node — Content Sweep Service (Gap 1)

**Files:**
- Create: `packages/node/src/services/content-sweep.ts`

**Interfaces:**
- Consumes: `verifyPostId`, `computePostId` from `@dagsocial/types` (Task 1)
- Consumes: `NetNode.requestPosts` from `@dagsocial/net` (Task 3)
- Consumes: `verifyPostForRelay` from local verifier
- Consumes: `insertPost`, `encodePost` from local store
- Consumes: `getDb` from local store/db
- Produces: `sweepPlaceholders(net: NetNode, deps: PostStore, maxRetries?: number): Promise<SweepResult>`
- Produces: `hasPlaceholders(): boolean`

- [ ] **Step 1: Create the content sweep module**

Write `packages/node/src/services/content-sweep.ts`:

```typescript
import { verifyPostId } from '@dagsocial/types';
import { encodePost } from '@dagsocial/types';
import type { Post } from '@dagsocial/types';
import type { NetNode } from '@dagsocial/net';
import type { PostStore } from '../store/post-store.js';
import { verifyPostForRelay } from './verifier.js';
import { insertPost } from '../store/posts.js';
import { getDb } from '../store/db.js';

export interface SweepResult {
  success: boolean;
  remaining: number;
}

const BATCH_SIZE = 50;
const MAX_PEERS_PER_BATCH = 3;
const DEFAULT_MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;

/** Check if any placeholder posts exist (content is empty, status is pending). */
export function hasPlaceholders(): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as count FROM dag_posts WHERE status = 'pending' AND content = ''")
    .get() as { count: number } | undefined;
  return (row?.count ?? 0) > 0;
}

function getPlaceholderIds(): string[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT id FROM dag_posts WHERE status = 'pending' AND content = ''")
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch missing post content from peers after block sync.
 *
 * Scans dag_posts for placeholders (content='', status='pending') and
 * requests the actual content from connected peers. Retries with
 * exponential backoff until all placeholders are resolved or maxRetries
 * is exhausted.
 */
export async function sweepPlaceholders(
  net: NetNode,
  deps: PostStore,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): Promise<SweepResult> {
  let retries = 0;

  while (retries < maxRetries) {
    const placeholderIds = getPlaceholderIds();
    if (placeholderIds.length === 0) {
      return { success: true, remaining: 0 };
    }

    const peerIds = net.getConnectedPeers();
    if (peerIds.length === 0) {
      // No peers to request from — return early, will retry on next
      // peer connection trigger.
      return { success: false, remaining: placeholderIds.length };
    }

    const batches = chunk(placeholderIds, BATCH_SIZE);
    for (const batch of batches) {
      // Pick up to MAX_PEERS_PER_BATCH random peers
      const selected = peerIds.slice(0, MAX_PEERS_PER_BATCH);
      const results = await Promise.all(
        selected.map((peerId) =>
          net.requestPosts(peerId, batch).catch(() => ({ entries: [] })),
        ),
      );

      const seen = new Set<string>();
      for (const response of results) {
        for (const entry of response.entries) {
          // Avoid processing the same post twice from different peers
          if (seen.has(entry.postId)) continue;
          seen.add(entry.postId);

          // Verify post ID matches claimed ID (§1)
          if (!verifyPostId(entry.post, entry.postId)) {
            console.warn(
              `[content-sweep] post ID mismatch for claimed ${entry.postId}, dropping`,
            );
            continue;
          }

          // Verify post structure, PoW, signature
          const result = verifyPostForRelay(deps, entry.post, 0);
          if (!result.valid) {
            console.warn(
              `[content-sweep] post validation failed for ${entry.postId}: ${result.error}`,
            );
            continue;
          }

          // Insert — upgrades placeholder to real content
          insertPost(entry.post, encodePost(entry.post));
        }
      }
    }

    const remaining = getPlaceholderIds().length;
    if (remaining === 0) {
      return { success: true, remaining: 0 };
    }

    retries++;
    if (retries < maxRetries) {
      await sleep(BASE_DELAY_MS * retries); // 2s, 4s, 8s, ...
    }
  }

  const remaining = getPlaceholderIds().length;
  return { success: false, remaining };
}
```

- [ ] **Step 2: Build and typecheck**

Run: `pnpm build --filter @dagsocial/node`
Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add packages/node/src/services/content-sweep.ts
# Add any net layer fixes if getConnectedPeers was missing
git commit -m "feat(node): add content sweep service for post-sync backfill

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Node — Wire Sweep Triggers

**Files:**
- Modify: `packages/node/src/index.ts`

**Interfaces:**
- Consumes: `sweepPlaceholders`, `hasPlaceholders` from content-sweep (Task 6)
- Consumes: `NetNode.onSyncComplete`, `NetNode.getConnectedPeers` from `@dagsocial/net` (Task 3)

- [ ] **Step 1: Wire sync-complete trigger**

In `packages/node/src/index.ts`, find where the net layer handlers are registered (after `net.start()`). Add after the existing handler registrations:

```typescript
// Register content sweep on sync completion (gap 1)
net.onSyncComplete(() => {
  if (hasPlaceholders()) {
    console.log('[content-sweep] Sync complete, sweeping placeholders...');
    sweepPlaceholders(net, deps).then((result) => {
      if (result.success) {
        console.log('[content-sweep] All placeholders resolved.');
      } else {
        console.warn(
          `[content-sweep] Sweep incomplete: ${result.remaining} placeholders remain after retries.`,
        );
      }
    }).catch((err: Error) => {
      console.error(`[content-sweep] Sweep failed: ${err.message}`);
    });
  }
});
```

- [ ] **Step 2: Wire peer-active trigger**

`onPeerActive` was added to NetNode in Task 3. Wire it in index.ts:

```typescript
// Re-run content sweep when a new peer becomes active and we have pending placeholders
net.onPeerActive((_peerId: string) => {
  if (hasPlaceholders()) {
    console.log('[content-sweep] New peer active, retrying placeholder sweep...');
    sweepPlaceholders(net, deps).catch((err: Error) => {
      console.error(`[content-sweep] Sweep failed: ${err.message}`);
    });
  }
});
```

- [ ] **Step 3: Build and typecheck**

Run: `pnpm build --filter @dagsocial/node`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/index.ts
# Add net layer changes if onPeerActive was added
git commit -m "feat(node): wire content sweep triggers on sync-complete and peer-active

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Integration Verification

**Files:** None (manual verification)

- [ ] **Step 1: Full build**

```bash
pnpm build
```
Expected: All 5 packages build clean.

- [ ] **Step 2: Full typecheck**

```bash
pnpm typecheck
```
Expected: Zero type errors.

- [ ] **Step 3: Full test suite**

```bash
pnpm test
```
Expected: All tests pass (806/807, 1 pre-existing E2E flake acceptable).

- [ ] **Step 4: Manual E2E smoke test**

Start two nodes (N1 miner on :3011, N2 server on :3012). Create posts on N1. Verify:
- N2 syncs blocks and gets post content (not placeholders).
- Create a post on N2 — verify N1 sees it (re-broadcast working).

If the existing e2e scripts support this, use `e2e-runner.ts`.

- [ ] **Step 5: Commit any remaining changes**

```bash
git status
# Commit any uncommitted fixes from verification
```
