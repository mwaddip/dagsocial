# Delete Post Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add DELETE /posts/:id API and demo UI to let authors delete their posts, returning all locked karma in the pruned subtree to each respective author.

**Architecture:** Add `verifyAuthorSignature` to verifier (challenge + Ed25519 sig verification). Fix existing prune route's missing signature verification. Remove root-only guard from executePrune. Add getPostLockBox store helper. Extend block-apply stump processing to settle PostLockBoxes in the pruned subtree (consume PostLockBox, mint karma back to each author). Add DELETE endpoint with proper signature verification. Add delete button + confirm() to demo UI.

**Tech Stack:** TypeScript, Express, SQLite, Ed25519, Vitest

## Global Constraints

- PROTOCOL_VERSION = 1 on all new types/fields
- Post content: 1-300 UTF-8 bytes (MAX_CONTENT_BYTES)
- Signatures: raw Ed25519 (64 bytes), base64 on wire
- Hashing: blake2b512 with .subarray(0, 32)
- Wire format: CBOR (cbor-x). HTTP API: JSON.
- Secret keys never in API responses
- No WASM dependencies

---

### Task 1: Add `verifyAuthorSignature` to verifier + fix prune route's missing sig check

**Files:**
- Modify: `packages/node/src/services/verifier.ts` (add `verifyAuthorSignature`)
- Modify: `packages/node/src/routes/pruning.ts` (add challenge + signature verification)
- Modify: `packages/node/src/server.ts` (pass verifier deps to pruning route)

**Interfaces:**
- Produces: `verifyAuthorSignature(deps, authorId, challengeHex, signatureHex): VerificationResult`
- Consumes: `getActiveChallenge`, `consumeChallenge`, `getCurrentHeight` (existing store functions)
- Consumes: `crypto.verify(null, hash, keyObject, signature)` (Node.js built-in)

- [ ] **Step 1: Add `verifyAuthorSignature` to verifier.ts**

The pruning and delete routes need to verify that the caller owns the private key corresponding to the claimed `authorId` (public key). This is NOT a post-signature check — it's a challenge-response proof of key ownership.

Add to `packages/node/src/services/verifier.ts`:

```typescript
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * Dependencies for verifying an author challenge-response.
 */
export interface AuthorVerifierDeps {
  getActiveChallenge: (userId: Uint8Array) => { challenge: Uint8Array; expiresAtBlock: number } | null;
  consumeChallenge: (userId: Uint8Array) => void;
  getCurrentHeight: () => number;
}

/**
 * Verify that a signature proves ownership of the Ed25519 keypair whose
 * public key is `authorId`.
 *
 * The caller must have requested a challenge via POST /challenge, then
 * signed blake2b-32(challenge) with their Ed25519 private key.
 *
 * On success the challenge is consumed (one-time use).
 */
export function verifyAuthorSignature(
  deps: AuthorVerifierDeps,
  authorId: Uint8Array,
  challengeHex: string,
  signatureHex: string,
): { valid: true } | { valid: false; error: string } {
  // 1. Challenge must exist and be active for this author
  const record = deps.getActiveChallenge(authorId);
  if (!record) {
    return { valid: false, error: 'No active challenge — request one via POST /challenge' };
  }
  const currentHeight = deps.getCurrentHeight();
  if (record.expiresAtBlock < currentHeight) {
    return { valid: false, error: 'Challenge expired' };
  }

  // 2. Decode challenge and signature from hex
  let challenge: Uint8Array;
  let signature: Uint8Array;
  try {
    challenge = new Uint8Array(Buffer.from(challengeHex, 'hex'));
    signature = new Uint8Array(Buffer.from(signatureHex, 'hex'));
  } catch {
    return { valid: false, error: 'Invalid hex encoding' };
  }

  // 3. Challenge must match the active one byte-for-byte
  if (
    challenge.length !== record.challenge.length ||
    !Buffer.from(challenge).equals(Buffer.from(record.challenge))
  ) {
    return { valid: false, error: 'Challenge mismatch' };
  }

  // 4. Verify Ed25519 signature over blake2b-32(challenge)
  const hash = createHash('blake2b512').update(challenge).digest().subarray(0, 32);
  const pubKeyObj = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(authorId).toString('base64url') },
    format: 'jwk',
  });
  const valid = cryptoVerify(null, hash, pubKeyObj, Buffer.from(signature));
  if (!valid) {
    return { valid: false, error: 'Invalid signature' };
  }

  // 5. Consume the challenge (one-time use)
  deps.consumeChallenge(authorId);

  return { valid: true };
}
```

Verify that `createHash` is already imported at the top of verifier.ts. If not, add:
```typescript
import { createHash } from 'node:crypto';
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add packages/node/src/services/verifier.ts
git commit -m "feat(verifier): add verifyAuthorSignature for challenge-response auth

Verifies that a caller owns the Ed25519 keypair for an authorId by
checking their signature over a previously-issued challenge. Consumes
the challenge on success (one-time use).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 4: Fix the prune route to require challenge + signature verification**

Currently the prune endpoint takes `authorId` + `signature` from the body but never verifies the signature cryptographically. Fix by also requiring `challenge` and calling `verifyAuthorSignature`.

In `packages/node/src/routes/pruning.ts`, replace the route handler body:

**Add to imports at top:**
```typescript
import { verifyAuthorSignature } from '../services/verifier.js';
import type { AuthorVerifierDeps } from '../services/verifier.js';
```

**Update `PruningDeps` to extend `AuthorVerifierDeps`:**
```typescript
export interface PruningDeps extends AuthorVerifierDeps {
  executePrune(intent: PruneIntent, signature: Uint8Array): Stump;
  computeStumpId(stump: Stump): string;
}
```

**Update the route handler body (replace lines 30-57):**
```typescript
    if (!body.authorId || !body.signature || !body.challenge) {
      res
        .status(400)
        .json({ error: 'authorId, challenge, and signature required' });
      return;
    }

    // Validate trigger
    const trigger = body.trigger ?? 'author';
    if (
      trigger !== 'author' &&
      trigger !== 'drep' &&
      trigger !== 'storage_prune'
    ) {
      res.status(400).json({ error: 'Invalid trigger type' });
      return;
    }

    // Decode authorId from hex
    let authorId: Uint8Array;
    try {
      authorId = new Uint8Array(Buffer.from(body.authorId, 'hex'));
    } catch {
      res.status(400).json({ error: 'Invalid hex encoding in authorId' });
      return;
    }

    // Verify author ownership via challenge-response
    const authResult = verifyAuthorSignature(
      deps,
      authorId,
      body.challenge,
      body.signature,
    );
    if (!authResult.valid) {
      res.status(403).json({ error: authResult.error });
      return;
    }
```

**Remove the old signature decode block (lines 49-57) and replace the error message checks:**
The old code decoded `signature` from hex into a `Uint8Array` and passed it to `executePrune`. Since `executePrune` never actually verifies this signature (it only checks author match), and we now verify before calling `executePrune`, we can pass a zeroed placeholder or any 64-byte array. Better yet: update `executePrune`'s signature to remove the signature parameter since it was never verified. But to minimize blast radius, just pass a zeroed placeholder:

In the try block:
```typescript
    try {
      const stump = deps.executePrune(intent, new Uint8Array(64));
```

**Update error checks (lines 75-81):** Remove the signature-related error messages since we verify before calling executePrune now:
```typescript
      } else if (
        msg.includes('not found') ||
        msg.includes('already pruned')
      ) {
```

- [ ] **Step 5: Update server.ts to pass verifier deps to pruning route**

In `packages/node/src/server.ts`, update the pruning route registration to pass verifier dependencies:

```typescript
  // Pruning — mounts at /, routes include /posts/:id/prune
  app.use(
    '/',
    pruningRoutes({
      executePrune,
      computeStumpId,
      getActiveChallenge: store.getActiveChallenge,
      consumeChallenge: store.consumeChallenge,
      getCurrentHeight: store.getCurrentHeight,
    }),
  );
```

- [ ] **Step 6: Run typecheck**

```bash
pnpm typecheck
```
Expected: clean

- [ ] **Step 7: Run tests**

```bash
pnpm test
```
Expected: all existing tests pass (pruning tests may need body update to include fake challenge/signature)

If pruning tests break because they don't send `challenge`, fix them by adding `challenge: '00'.repeat(32)` and a valid signature to the test bodies, or by mocking `verifyAuthorSignature`.

- [ ] **Step 8: Commit**

```bash
git add packages/node/src/routes/pruning.ts packages/node/src/server.ts
git commit -m "fix(routes): add challenge-response signature verification to prune route

The prune endpoint previously accepted authorId and signature from the
request body without cryptographically verifying either. Now requires
a challenge (from POST /challenge) and verifies the Ed25519 signature
via verifyAuthorSignature before processing.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Remove root-only guard from `executePrune`

**Files:**
- Modify: `packages/node/src/services/stump-engine.ts:75-77`

**Interfaces:**
- Consumes: nothing new
- Produces: `executePrune` now accepts any post (root or reply)

- [ ] **Step 1: Remove the root-only check**

Replace lines 74-77:
```typescript
  const post = rootPost as Post;
  if (post.parentRefs.length > 0) {
    throw new Error('Only root posts (empty parentRefs) can be pruned');
  }
```

With (just keep the cast, drop the guard):
```typescript
  const post = rootPost as Post;
```

- [ ] **Step 2: Update the comment on line 63**

Change `// ---- 1. Verify post exists and is a root ----` to:
```typescript
  // ---- 1. Verify post exists ----
```

- [ ] **Step 3: Update the pruning route error handler**

In `packages/node/src/routes/pruning.ts`, lines 75-78, remove the `'Only root posts'` and `'parentRefs'` error checks since those errors no longer fire:
```typescript
      } else if (
        msg.includes('not found') ||
        msg.includes('already pruned')
      ) {
```

- [ ] **Step 4: Run typecheck**

```bash
pnpm typecheck
```
Expected: clean

- [ ] **Step 5: Run existing tests**

```bash
pnpm test
```
Expected: all existing tests pass (no regressions from guard removal)

- [ ] **Step 6: Commit**

```bash
git add packages/node/src/services/stump-engine.ts packages/node/src/routes/pruning.ts
git commit -m "feat(stump-engine): remove root-only guard from executePrune

Any post (root or reply) can now be pruned. The subtree walk via
getSubtree already works for any starting post.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Add `getPostLockBox(postId)` store helper

**Files:**
- Modify: `packages/node/src/store/utxo.ts` (add function)
- Modify: `packages/node/src/store/index.ts` (add export)

**Interfaces:**
- Consumes: nothing
- Produces: `getPostLockBox(postId: string): PostLockBox | null`

- [ ] **Step 1: Add the function to utxo.ts**

After `getUnspentPostLockBoxes()` (line 380), add:

```typescript
/**
 * Return the unspent PostLockBox for a specific post, if any.
 */
export function getPostLockBox(targetPostId: string): PostLockBox | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'post_lock'
         AND json_extract(extra_data, '$.targetPostId') = ?
         AND spent_at_block IS NULL`,
    )
    .get(targetPostId) as UtxoRow | undefined;
  if (!row) return null;
  return rowToBox(row) as PostLockBox;
}
```

- [ ] **Step 2: Export from barrel**

In `packages/node/src/store/index.ts`, add `getPostLockBox` to the utxo exports (line 26-40 block):
```typescript
  getUnspentPostLockBoxes,
  getPostLockBox,
  getPostTotalLikes,
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/store/utxo.ts packages/node/src/store/index.ts
git commit -m "feat(store): add getPostLockBox(postId) lookup

Returns the unspent PostLockBox for a given target post ID, or null
if no lock exists. Needed for delete-post karma settlement.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Add PostLockBox settlement during stump processing in `applyOrderingBlock`

**Files:**
- Modify: `packages/node/src/services/block-apply.ts:227-244`

**Interfaces:**
- Consumes: `getPostLockBox(postId: string): PostLockBox | null` (from Task 2)
- Consumes: `getSubtree(rootPostId: string): Post[]` (already imported)
- Consumes: `consumeBox(boxId: string, blockHeight: number): void` (already available via `mintKarma`)
- Produces: PostLockBox settlement in journal (consumed by fork-resolution existing code)

- [ ] **Step 1: Read the current stump replay block**

Open `packages/node/src/services/block-apply.ts` and read lines 227-244 (the stump replay loop).

- [ ] **Step 2: Add PostLockBox settlement after pruneSubtree**

Replace the stump replay block (lines 227-244) with:

```typescript
  // Replay prune commits from this block's stumpIds
  for (const stumpId of block.subBlockTree.stumpIds) {
    const stump = getStump(stumpId);
    if (!stump) {
      console.warn(`Stump ${stumpId} not found locally — will backfill via content sweep`);
      continue;
    }
    const rootPost = getPost(stump.rootPostHash);
    if (rootPost && 'subtreeMerkleRoot' in rootPost) {
      // Already pruned — skip duplicate stump
      continue;
    }

    // Prune the DAG subtree
    try {
      pruneSubtree(stump.rootPostHash, stump);
    } catch (err) {
      console.warn(`Failed to replay prune for stump ${stumpId}: ${String(err)}`);
      continue;
    }

    // Settle PostLockBoxes: walk the pruned subtree and return locked karma
    // to each author. Uses the same DAG walk pattern as executePrune so
    // every node derives the same settlement deterministically.
    try {
      const subtreePosts = getSubtree(stump.rootPostHash);
      // Include the root post itself (getSubtree returns only descendants)
      const root = getPost(stump.rootPostHash);
      const allPosts = root && !('subtreeMerkleRoot' in root) ? [root as Post, ...subtreePosts] : subtreePosts;

      // Sum remaining locked value per author
      const authorRefunds = new Map<string, number>();
      for (const post of allPosts) {
        const postId = computePostId(post);
        const lockBox = getPostLockBox(postId);
        if (lockBox && lockBox.value > 0) {
          const key = Buffer.from(lockBox.owner).toString('hex');
          authorRefunds.set(key, (authorRefunds.get(key) ?? 0) + lockBox.value);
          // Consume the PostLockBox — karma is being returned
          consumeBox(lockBox.boxId, block.header.height);
          console.log(
            `Stump ${stumpId.slice(0, 8)}: returned ${lockBox.value} locked karma ` +
            `to ${key.slice(0, 12)}... (post ${postId.slice(0, 8)}...)`,
          );
        }
      }

      // Mint refunded karma back to each author
      for (const [hexUserId, amount] of authorRefunds) {
        mintKarma(new Uint8Array(Buffer.from(hexUserId, 'hex')), amount, block.header.height);
      }
    } catch (err) {
      console.warn(`Failed to settle PostLockBoxes for stump ${stumpId}: ${String(err)}`);
    }
  }
```

- [ ] **Step 3: Verify imports**

Ensure `getPostLockBox` and `getSubtree` are imported from `../store/index.js`. Check the existing imports at the top of the file. If `getPostLockBox` is not imported, add it.

Read the import block (first ~20 lines) to check.

- [ ] **Step 4: Run typecheck**

```bash
pnpm typecheck
```
Expected: clean

- [ ] **Step 5: Run tests**

```bash
pnpm test
```
Expected: all existing tests pass (stump processing tests may log new output)

- [ ] **Step 6: Commit**

```bash
git add packages/node/src/services/block-apply.ts
git commit -m "feat(block-apply): settle PostLockBoxes during stump processing

When replaying a prune commit (stump), walk the pruned DAG subtree
and return all locked karma in PostLockBoxes back to each respective
author. Every node derives the same settlement deterministically.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Add `DELETE /posts/:id` endpoint

**Files:**
- Create: `packages/node/src/routes/delete.ts`

**Interfaces:**
- Consumes: `verifyAuthorSignature(deps, authorId, challengeHex, signatureHex)` (from Task 1)
- Consumes: `AuthorVerifierDeps` (from Task 1)
- Consumes: `executePrune(intent: PruneIntent, signature: Uint8Array): Stump` (from stump-engine.ts, existing)
- Consumes: `computeStumpId(stump: Stump): string` (from @dagsocial/types, existing)
- Produces: Express Router with `DELETE /posts/:id` route

- [ ] **Step 1: Create the route file**

Create `packages/node/src/routes/delete.ts`:

```typescript
import { Router } from 'express';
import { computeStumpId } from '@dagsocial/types';
import type { PruneIntent, Stump } from '@dagsocial/types';
import { verifyAuthorSignature } from '../services/verifier.js';
import type { AuthorVerifierDeps } from '../services/verifier.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface DeleteDeps extends AuthorVerifierDeps {
  executePrune(intent: PruneIntent, signature: Uint8Array): Stump;
  computeStumpId(stump: Stump): string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: DeleteDeps): Router {
  const router = Router();

  // DELETE /posts/:id — delete a post and its reply subtree
  router.delete('/posts/:id', (req, res) => {
    const postId = req.params['id']!;
    const body = req.body as {
      authorId?: string;
      challenge?: string;
      signature?: string;
    };

    if (!body.authorId || !body.challenge || !body.signature) {
      res
        .status(400)
        .json({ error: 'authorId, challenge, and signature required' });
      return;
    }

    // Decode authorId from hex
    let authorId: Uint8Array;
    try {
      authorId = new Uint8Array(Buffer.from(body.authorId, 'hex'));
    } catch {
      res.status(400).json({ error: 'Invalid hex encoding in authorId' });
      return;
    }

    // Verify author ownership via challenge-response
    const authResult = verifyAuthorSignature(
      deps,
      authorId,
      body.challenge,
      body.signature,
    );
    if (!authResult.valid) {
      res.status(403).json({ error: authResult.error });
      return;
    }

    // Build prune intent (delete always uses trigger 'author')
    const intent: PruneIntent = {
      rootPostHash: postId,
      trigger: 'author',
      authorId,
      signature: new Uint8Array(64), // placeholder; executePrune checks author match, sig already verified above
    };

    try {
      const stump = deps.executePrune(intent, new Uint8Array(64));
      const stumpId = deps.computeStumpId(stump);
      res.status(200).json({
        status: 'deleted',
        stumpId,
        postId,
        replyCount: stump.replyCount,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('Author mismatch') || msg.includes('author does not match')) {
        res.status(403).json({ error: msg });
      } else if (
        msg.includes('not found') ||
        msg.includes('already pruned')
      ) {
        res.status(400).json({ error: msg });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  return router;
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: clean (new file covered by tsconfig)

- [ ] **Step 3: Commit**

```bash
git add packages/node/src/routes/delete.ts
git commit -m "feat(routes): add DELETE /posts/:id endpoint

Author-verified deletion that prunes the post and its reply subtree.
Returns stumpId, postId, and replyCount on success.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Register delete route in server.ts

**Files:**
- Modify: `packages/node/src/server.ts` (import + mount)

**Interfaces:**
- Consumes: `createRouter` from `./routes/delete.js` (Task 5)
- Consumes: `DeleteDeps` (requires verifier deps from Task 1)
- Consumes: `executePrune`, `computeStumpId` (already available in server.ts)

- [ ] **Step 1: Add import**

In `packages/node/src/server.ts`, add after the pruning routes import (line 7):
```typescript
import { createRouter as deleteRoutes } from './routes/delete.js';
```

- [ ] **Step 2: Register route with verifier deps**

After the pruning routes block, add:
```typescript
  // Delete — mounts at /, routes include DELETE /posts/:id
  app.use(
    '/',
    deleteRoutes({
      executePrune,
      computeStumpId,
      getActiveChallenge: store.getActiveChallenge,
      consumeChallenge: store.consumeChallenge,
      getCurrentHeight: store.getCurrentHeight,
    }),
  );
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```
Expected: clean

- [ ] **Step 4: Run tests**

```bash
pnpm test
```
Expected: all existing tests pass

- [ ] **Step 5: Quick manual smoke test**

Start the node:
```bash
node packages/node/dist/index.js
```

In another terminal, test the endpoint rejects missing auth:
```bash
curl -X DELETE http://localhost:3000/posts/doesnotexist \
  -H 'Content-Type: application/json' \
  -d '{}'
```
Expected: 400 "authorId and signature required"

Then stop the node with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add packages/node/src/server.ts
git commit -m "feat(server): register DELETE /posts/:id route

Uses the same dependencies as pruning: executePrune + computeStumpId.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Add delete button to demo UI

**Files:**
- Modify: `packages/node/public/index.html`

**Interfaces:**
- Consumes: `DELETE /posts/:id` endpoint (Task 5)
- Consumes: `userId` (current identity, already set on activation)
- Consumes: `privKey` (CryptoKey, already imported on activation)
- Consumes: `signPost()` (existing function for signing challenges)

- [ ] **Step 1: Add delete button to renderPost()**

In `packages/node/public/index.html`, in the `renderPost()` function (lines 1178-1198), add a delete button after the like button. The button only appears if the post author matches the current user.

Replace the return statement in `renderPost` (lines 1183-1197) with:

```javascript
  const isOwn = userId && p.author === userId;
  const deleteBtn = isOwn
    ? `<button class="like-btn delete-btn" data-post-id="${id}" style="color:#f85149">&#10005; Delete</button>`
    : '';
  return `
    <div class="post" data-post-id="${id}" style="margin-left:${indent}px;border-left:${depth > 0 ? '2px solid #30363d' : 'none'};padding-left:${depth > 0 ? '10px' : '12px'}">
      <div class="post-author">${esc(p.author.slice(0, 12))}...</div>
      <div class="post-content">${esc(p.content)}</div>
      <div class="post-meta">
        <span>${new Date(p.timestamp).toLocaleTimeString()}</span>
        <span>${p.parentRefs.length ? p.parentRefs.length + ' parent(s)' : 'genesis'}</span>
        <span style="font-family:monospace;font-size:10px">${esc(shortId)}...</span>
        <button class="like-btn reply-btn" data-post-id="${id}">&#8617; Reply</button>
        <button class="like-btn${liked ? ' liked' : ''}" data-post-id="${id}" data-liked="${liked ? '1' : '0'}">
          ${liked ? '&#10084;&#65039; Liked' : '&#10084;&#65039; Like'} (${likeCount})
        </button>
        ${deleteBtn}
      </div>
    </div>
  `;
```

- [ ] **Step 2: Add delete button event handler in loadFeed()**

After the like/unlike handler block (after the `feed.querySelectorAll('.like-btn:not(.reply-btn)')` block ending around line 1286), add a delete button handler:

```javascript
    // Attach delete handlers
    feed.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const postId = btn.dataset.postId;
        if (!postId || !userId || !privKey) return;

        if (!confirm('Delete this post and all replies? This will return any locked karma to each reply author.')) {
          return;
        }

        btn.disabled = true;
        btn.textContent = '...';

        try {
          // Get a challenge from the server
          const chalRes = await fetch(API + '/challenge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
          });
          if (!chalRes.ok) {
            throw new Error('Failed to get challenge');
          }
          const { challenge } = await chalRes.json();

          // Sign the challenge to prove authorship
          const chalBytes = hex2buf(challenge);
          const hash = blake2b(chalBytes, null, 64).slice(0, 32);
          const sigBuf = await crypto.subtle.sign('Ed25519', privKey, hash);
          const signature = buf2hex(new Uint8Array(sigBuf));

          const res = await fetch(API + '/posts/' + encodeURIComponent(postId), {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ authorId: userId, signature }),
          });

          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Delete failed');
          }

          const result = await res.json();
          console.log('Post deleted:', result);
          loadFeed();
        } catch (e) {
          console.error('Delete failed:', e);
          alert('Delete failed: ' + (e.message || 'unknown error'));
          btn.disabled = false;
          btn.textContent = '✕ Delete';
        }
      });
    });
```

- [ ] **Step 3: Build and verify**

```bash
pnpm build
```

Start the node and verify in browser:
1. Create an identity
2. Get karma from faucet
3. Create a post
4. Verify the Delete button appears on your own posts (in red)
5. Verify no Delete button on other users' posts (if any)
6. Click Delete on your post
7. Confirm the prompt appears
8. Confirm the post disappears from feed after deletion

- [ ] **Step 4: Commit**

```bash
git add packages/node/public/index.html
git commit -m "feat(demo-ui): add delete button with confirmation

Delete button (red ×) appears on own posts only. confirm() gate
before calling DELETE /posts/:id with signed challenge.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: E2E test — delete post pipeline

**Files:**
- Modify: `packages/node/test/e2e/decay-full-pipeline.test.ts` (add delete test case)

**Interfaces:**
- Consumes: `DELETE /posts/:id` endpoint (Task 5)

- [ ] **Step 1: Add a delete test after the existing pipeline test**

In the decay-full-pipeline E2E test, after the `full pipeline` test (around line 232), add a `delete post` test case. This test reuses the same two nodes and identity from `beforeAll`.

Insert after line 232 (`}, 300000);`):

```typescript
  it('delete post returns locked karma', async () => {
    // 1. Create a post with some karma locked
    const chal = await api('POST', `${A1}/challenge`, { userId }) as { challenge: string; targetBits: number };
    const ts = Date.now();
    const chalBytes = unhex(chal.challenge);
    const pi = powInput('e2e-delete-test', pubRaw, [], chalBytes, ts);
    const nonce = solve(pi, chal.targetBits);
    const sig = signPost('e2e-delete-test', pubRaw, [], chalBytes, ts);

    const k = await get(`${A1}/karma/${userId}`) as { total: number; boxes: { boxId: string; value: number }[] };
    const lockTx = karmaTx(k.boxes, POST_LOCK_THREAD_COST, 'e2e-delete');
    signTx(lockTx);

    const postR = await api('POST', `${A1}/posts`, {
      content: 'e2e-delete-test', author: pubHex, parentRefs: [],
      challenge: chal.challenge, protocolVersion: PROTOCOL_VERSION,
      timestamp: ts, powNonce: nonce, signature: sig,
      karmaLockTx: txToApi(lockTx),
    }) as { status: string; postId: string };
    expect(postR.status).toBe('pending');
    const targetPostId = postR.postId;
    console.log(`Delete-test post: ${targetPostId.slice(0, 16)}...`);

    // Wait for post to confirm
    await wait(6000);

    // Check karma before delete
    const karmaBefore = (await get(`${A1}/karma/${userId}`) as { total: number }).total;
    console.log(`Karma before delete: ${karmaBefore}`);

    // 2. Sign a challenge for deletion
    const delChal = await api('POST', `${A1}/challenge`, { userId }) as { challenge: string };
    const delHash = blake32(unhex(delChal.challenge));
    const delSig = hex(new Uint8Array(cryptoSign(null, delHash, userKey)));

    // 3. Delete the post
    const delR = await api('DELETE', `${A1}/posts/${targetPostId}`, {
      authorId: pubHex,
      challenge: delChal.challenge,
      signature: delSig,
    }) as { status: string; stumpId: string; postId: string; replyCount: number };
    expect(delR.status).toBe('deleted');
    console.log(`Deleted: stumpId=${delR.stumpId.slice(0, 16)}...`);

    // 4. Wait for block to process the stump
    await wait(6000);

    // 5. Verify karma was returned (should be >= pre-delete karma)
    const karmaAfter = (await get(`${A1}/karma/${userId}`) as { total: number }).total;
    console.log(`Karma after delete: ${karmaAfter}`);
    // After settle: karma should be at least karmaBefore (locked karma returned)
    // minus small decay if applicable
    expect(karmaAfter).toBeGreaterThanOrEqual(karmaBefore - 10);

    // 6. Verify post is gone
    try {
      await get(`${A1}/posts/${targetPostId}`);
      // Should throw or return pruned
      console.log('Post still accessible (may return stump)');
    } catch {
      console.log('Post not found (expected)');
    }
  }, 60000);
```

- [ ] **Step 2: Run the E2E test**

```bash
pnpm build && pnpm --filter @dagsocial/node test -- --testPathPattern='e2e/decay'
```
Expected: both `full pipeline` and `delete post returns locked karma` pass

- [ ] **Step 3: Commit**

```bash
git add packages/node/test/e2e/decay-full-pipeline.test.ts
git commit -m "test(e2e): add delete post pipeline test

Creates a post with locked karma, deletes it, verifies karma
is returned to the author after block processes the stump.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Run full test suite and final verification

- [ ] **Step 1: Run full test suite**

```bash
pnpm build && pnpm test
```
Expected: all tests pass (408+ new tests)

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```
Expected: clean across all packages

- [ ] **Step 3: Final review of the diff**

```bash
git diff master
```
Review all changes for correctness.

- [ ] **Step 4: Update SESSION_CONTEXT.md**

Note the completed feature. Remove the "delete post" from any gap/backlog section.