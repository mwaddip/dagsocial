# Demo UI — Multi-Identity, Likes, Invites, and Debug Tools

**Date:** 2026-07-21
**Status:** Design approved
**Scope:** Demo UI (`public/index.html`) overhaul plus three new backend endpoints.

## Goals

A single developer can test the full protocol surface from one browser tab:
create and switch identities, post, like/unlike, create and redeem invites,
export credentials, and use a karma faucet.

## Demo UI

### Identity management

- localStorage key `dagsocial-identities`: JSON array of `{ pubKeyHex, privKeyBase64 }`
- On load: restore all identities, re-import each to the server (idempotent `POST /identity/import`)
- Active identity tracked in memory. `<select>` dropdown in the left panel.
- `[+ New]` button: generates Ed25519 keypair, imports to server, saves to localStorage, switches to it.
- `[Export]` button: downloads active identity as `dagsocial-identity.json` (triggers browser download).
- `[Import]` button: `<input type="file">` accepts a `.json` file, parses, imports, saves.
- Server-side: identity import does NOT grant karma anymore. The faucet replaces the bootstrap karma mechanism. On first page load, the active identity will have 0 karma until the user clicks the faucet.

### Left panel layout

1. **Identity row** — `<select>` dropdown + `[+ New]` `[Import]` `[Export]`
2. **Current ID** — full userId monospace
3. **Compose** — unchanged (textarea, parent refs, Post button)
4. **Node Status** — unchanged (block height, posts, karma, credits)
5. **Admin / Debug** (visible only when `GET /status` returns `networkMode: "testnet"`)
   - **Karma Faucet** — text input (amount, default 100) + `[Grant]` button → `POST /faucet`
   - **Invites** — `[Create Invite]` with karma amount input; creates invite, displays secret hex in a modal
   - **Redeem Invite** — text input for secret hex + `[Redeem]` → `POST /invites/claim`; if successful, new identity appears in dropdown

### Like changes in feed

- Each post card shows `❤️ Like (N)` or `❤️ Liked (N)`
- N = total like count from `GET /posts` (new field `likeCount` on each post)
- Liked state: client tracks per-session (same approach as today's `likedPosts` Set)
- Clicking a `Liked` button: calls `POST /likes/remove`, button changes to `❤️ Like (N−1)`

## Backend changes

### `POST /faucet`

Request: `{ userId, amount: number }`
Response 200: `{ userId, boxId, newBalance }`
Error 400: `{ error: "..." }`

Logic:
1. Look up identity → get publicKey
2. If existing karma box: consume it, create new box with `value + amount`
3. If no karma box: create new karma box with `value = amount`
4. Apply via UTXO transaction (karma created from nothing — mint, not transfer)
5. Return new box ID and balance

Gated: only available when `network_mode=testnet` (config value). In other
modes, the route is not mounted / returns 403.

### `POST /likes/remove`

Request: `{ targetPostId, likerId, signature: hex }`
Response 200: `{ removed: true, netKarma: number }`
Error 400/404: `{ error: "..." }`

Logic:
1. Verify post exists and is live
2. Check for locked like box (utxo_boxes, box_type='like', matching likerId + targetPostId, unspent)
3. If locked like: consume like box (burn the 2 karma), refund 2 karma to liker's karma box, then deduct 1 karma from liker (net +1 to liker)
4. If no locked like: check dag_likes for free like. If free like: delete the row, deduct 1 karma from liker (net −1)
5. If neither: return 404
6. Verify signature over `{ targetPostId, likerId, action: "unlike" }`

### `GET /status` extension

Add `networkMode` field to the status response (value from config).

### Config

New env var `NETWORK_MODE`, default `testnet`. Parsed by `loadConfig()`.
When `network_mode != "testnet"`, faucet route returns 403 and the demo UI
hides the Admin / Debug section.

### `GET /posts` extension

Each post in the array now includes `likeCount: number` (total of locked +
free likes). The posts route queries like counts for the returned posts.

## File changes

| File | Change |
|------|--------|
| `packages/node/public/index.html` | Full rewrite — multi-identity, like counts, unlike, admin panel, invites UI |
| `packages/node/src/config.ts` | Add `networkMode` field (`NETWORK_MODE` env, default `testnet`) |
| `packages/node/src/routes/faucet.ts` | New — `POST /faucet` endpoint |
| `packages/node/src/routes/likes.ts` | Add `POST /likes/remove` handler |
| `packages/node/src/routes/posts.ts` | Add `likeCount` to post responses |
| `packages/node/src/routes/status.ts` | Add `networkMode` to status response |
| `packages/node/src/server.ts` | Mount faucet route, conditionally; pass new config; update identity bootstrap |
| `packages/node/test/routes/faucet.test.ts` | New |
| `packages/node/test/routes/likes.test.ts` | Add unlike tests |
