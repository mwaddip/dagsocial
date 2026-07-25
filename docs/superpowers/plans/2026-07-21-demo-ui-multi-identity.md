# Demo UI — Multi-Identity, Likes, Invites, Debug Tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Overhaul the demo UI for multi-identity management, like/unlike, invite creation/redemption, credential export/import, and a karma faucet, plus three backend endpoints (faucet, likes/remove, like count in posts).

**Architecture:** Seven tasks — six independent backend changes (config, faucet route, likes remove, posts likeCount, status networkMode, identity bootstrap removal) and one UI rewrite that consumes all of them. Backend tasks can run in any order; UI task depends on all six.

**Tech Stack:** Node.js ≥ 22, TypeScript, Express, better-sqlite3, Vitest

## Global Constraints

- Node.js ≥ 22 — `createHash('blake2b512').subarray(0, 32)` for all 32-byte hashes
- `@dagsocial/types` Phase 2 built and importable
- Secret keys never in API responses or DTOs
- Network mode `testnet` gates debug endpoints (faucet, admin UI section)
- Faucet mints karma from nothing (not a transfer) — debug tool only
- Unlike: locked like → refund 2, deduct 1 (net +1). Free like → deduct 1 (net −1)
- Identity import no longer grants bootstrap karma — faucet replaces it
- `likeCount` in post responses = total of locked + free likes

---

### Task 1: Config — add networkMode

**Files:**
- Modify: `packages/node/src/config.ts`
- Modify: `packages/node/test/config.test.ts`

**Interfaces:**
- Produces: `Config` type gains `networkMode: string` field. `loadConfig()` reads `NETWORK_MODE` env var, defaults to `'testnet'`.

**Implementation:**

- [ ] Add `networkMode: string` to `Config` interface
- [ ] Add `NETWORK_MODE` env var read with default `'testnet'` in `loadConfig()`
- [ ] Update test to assert new field
- [ ] Build, test, commit

---

### Task 2: Status route — add networkMode

**Files:**
- Modify: `packages/node/src/routes/blocks.ts` (status lives there)
- Modify: `packages/node/test/routes/blocks.test.ts`

**Interfaces:**
- Consumes: `networkMode` from config (passed via deps)
- Produces: `GET /status` response gains `networkMode` field

Drop the existing hardcoded status deps and accept `networkMode` as a dep.

**Implementation:**

- [ ] Add `networkMode: string` to the blocks route deps interface
- [ ] Add `networkMode` to the `/status` response JSON
- [ ] Update `server.ts` to pass `networkMode: config.networkMode` to blocks route
- [ ] Update test to expect the new field
- [ ] Build, test, commit

---

### Task 3: Identity route — remove bootstrapKarma

**Files:**
- Modify: `packages/node/src/routes/identity.ts`
- Modify: `packages/node/src/server.ts:38-55` (identity wiring)

Remove the `bootstrapKarma` dependency from the identity route. The faucet replaces it.

- [ ] Remove `bootstrapKarma` from `IdentityStore` interface in `identity.ts`
- [ ] Remove `bootstrapKarma(...)` calls from both `POST /` and `POST /import` handlers
- [ ] Remove `bootstrapKarma` from identity route wiring in `server.ts`
- [ ] Update `test/routes/identity.test.ts` and `test/integration/identity.test.ts` to remove `bootstrapKarma` from router creation
- [ ] Build, test, commit

---

### Task 4: Faucet route — `POST /faucet`

**Files:**
- Create: `packages/node/src/routes/faucet.ts`
- Create: `packages/node/test/routes/faucet.test.ts`
- Modify: `packages/node/src/server.ts` (mount route)

Route gated behind `networkMode === 'testnet'`. In production mode, the route returns 403.

**Faucet logic:**
1. Look up identity by userId → publicKey
2. If existing karma box found via `getKarmaBox(publicKey)`: consume it, create new karma box with `value + amount`, same `lastTouchBlock`
3. If no karma box: create new karma box with `value = amount`, `createdAtBlock = getCurrentHeight()`, `lastTouchBlock = getCurrentHeight()`, `proofSource = 'faucet'`
4. Use `computeBoxId` from `@dagsocial/types` for box IDs
5. Return `{ userId, boxId, newBalance }`

**Tests (4 cases):**
- Grants karma to identity with no existing box (201, newBalance = amount)
- Tops up existing karma box (201, newBalance = old + amount)
- Unknown userId → 404
- Network mode != testnet → 403

**Server wiring:** If `config.networkMode === 'testnet'`, mount at `/faucet`. Otherwise, mount a stub that returns 403.

- [ ] Write test file
- [ ] Implement route
- [ ] Wire in server.ts
- [ ] Build, test, commit

---

### Task 5: Likes route — add `POST /likes/remove`

**Files:**
- Modify: `packages/node/src/routes/likes.ts`
- Modify: `packages/node/test/routes/likes.test.ts`

**Unlike logic:**
1. Parse body `{ targetPostId, likerId, signature: hex }`
2. Verify signature over `JSON.stringify({ targetPostId, likerId, action: "unlike" })` (blake2b512 truncated, Ed25519)
3. Look up post (must exist and be live)
4. Check for locked like box (utxo_boxes, box_type='like', matching, unspent)
5. If locked: consume like box, use UTXO engine to refund 2 karma to liker, then deduct 1 karma. netKarma = +1.
6. If no locked like: check dag_likes for free like row. If found: delete row, deduct 1 karma from liker. netKarma = −1.
7. If neither: 404
8. Return `{ removed: true, netKarma }`

**Tests (5 cases):**
- Remove locked like → 200, netKarma = 1, karma box increased by 1
- Remove free like → 200, netKarma = −1, karma box decreased by 1
- Like not found → 404
- Post unknown → 400
- Invalid signature → 400

- [ ] Write tests
- [ ] Implement handler
- [ ] Build, test, commit

---

### Task 6: Posts route — add likeCount to responses

**Files:**
- Modify: `packages/node/src/routes/posts.ts`
- Modify: `packages/node/test/routes/posts.test.ts`

Add `likeCount` to each post in `GET /posts` and `GET /posts/:id` responses.
Use `getLikeCount(postId)` from the likes store to compute `{ locked, free }` totals.

**Changes:**
- Add `getLikeCount: (postId: string) => { locked: number; free: number }` to `PostsDeps`
- In `postToJson()`, add `likeCount: likeCount.locked + likeCount.free`
- Update `server.ts` wiring to pass `getLikeCount: store.getLikeCount`
- Update test deps and assertions

- [ ] Update PostsDeps
- [ ] Update postToJson
- [ ] Wire in server.ts
- [ ] Update tests
- [ ] Build, test, commit

---

### Task 7: Demo UI — full rewrite

**Files:**
- Modify: `packages/node/public/index.html`

Full rewrite of the demo UI. Keep existing styling (dark theme). Build these sections:

**Identity management (left panel, top):**
```html
<select id="identitySelect"></select>
<button id="newIdentityBtn">+ New</button>
<button id="importIdentityBtn">Import</button>
<button id="exportIdentityBtn">Export</button>
<div class="id-badge" id="currentUserId"></div>
```

localStorage key: `dagsocial-identities` — `[{ pubKeyHex, privKeyBase64 }]`

JS functions:
- `loadIdentities()`: read from localStorage, populate dropdown, re-import each to server (idempotent)
- `switchIdentity(index)`: set active identity globals (`userId`, `pubKeyRaw`, `privKey`), update UI, reload feed
- `createIdentity()`: generate keypair, import to server, save to localStorage, switch to it
- `exportIdentity()`: build JSON blob, trigger download via `<a>` click
- `importIdentity(file)`: read File, parse JSON, import to server, save to localStorage, refresh dropdown

On load: if localStorage has identities, use them. If empty, auto-generate one (current behavior but storing in the array).

**Left panel layout:**
1. Identity dropdown + buttons
2. Current userId badge
3. Compose (unchanged)
4. Node Status (unchanged, add networkMode display)
5. Admin / Debug (visible only when `networkMode === 'testnet'`):
   - Faucet: amount input + Grant button
   - Invites: Create (amount input + button), Redeem (secret hex input + button)

**Feed (right panel):**
- Like button shows `❤️ Like (N)` or `❤️ Liked (N)` where N = `p.likeCount`
- `likedPosts` Set tracks which posts the active identity has liked (per-session)
- Unlike: if post is in `likedPosts`, clicking calls `POST /likes/remove`, removes from set, refreshes feed

**Invites in admin panel:**
- Create: `POST /invites` with active identity, show secret hex in a `<pre>` block below
- Redeem: `POST /invites/claim` with secret hex → on success, the claimed identity appears in the dropdown (it creates a new identity for the claimer — the demo auto-generates a new keypair for the claimer). Actually simpler: the claimer uses the active identity's public key. On redeem success, the active identity gets a karma box.

**Export/Import:**
- Export: `JSON.stringify({ pubKeyHex: buf2hex(pubKeyRaw), privKeyBase64 })` → download as `dagsocial-identity.json`
- Import: file input (hidden), triggered by button, reads file, adds to localStorage, refreshes

- [ ] Write HTML/CSS layout
- [ ] Implement identity management JS
- [ ] Implement admin/debug section JS
- [ ] Update feed rendering with like counts and unlike
- [ ] Update post/like flows for active identity
- [ ] Manual smoke test
- [ ] Commit

---

### Verification

After all tasks:
```
pnpm build
pnpm test
# Manual: start node, open browser, test:
# - Create 2 identities, switch between them
# - Grant karma via faucet
# - Post from both identities
# - Like a post, verify count increments, verify "Liked" state
# - Unlike, verify count decrements
# - Create invite, copy secret, redeem it as a new identity
# - Export identity, refresh page, import it back
```
