# WEB Interface Contract

**Component:** `@dagsocial/web`
**Status:** Phase 2 (not implemented)
**Protocol version:** 1

> **This file is correct as written — it is a forward contract for a package that has not
> been built yet, and it says so.** Recorded explicitly because a 2026-08-06 audit
> initially mis-filed it as fiction to be deleted.
>
> **The demo UI (`packages/node/public/index.html`) is deliberately undocumented and is not
> this contract's subject.** It is a throwaway debug interface that exists only during
> development, until the real web client above is a reality. Do not write an interface
> contract for it, and do not treat it as a product surface.
>
> **One thing about the demo UI IS binding, despite it being throwaway:** it hand-rolls
> CBOR, `computeBoxId`, `computeTxId` and `postFieldBytes`, so it is a third implementation
> of consensus-critical encodings and **must stay byte-identical to `@dagsocial/types`**.
> That is pinned by `ui-crypto-mirror.test.ts`, and the mirror was verified sound in the
> audit. Throwaway applies to its *flows and UX*, not to its encoders.

> **Worth noting for the whole `contracts/` directory:** this file is 100% original text
> from the 2026-07-20 bulk-write, and it is one of the few that was never wrong — because
> it carried a `Status:` line from the first day. That is the evidence behind the status
> marker convention in `ARCHITECTURE.md`: aspirational text is not the problem, *unmarked*
> aspirational text is.

## Scope

Browser-based client for DAGsocial. Owns: UI (compose, feed, identity), client-side Ed25519 key management, PoW solving, post construction and signing. Depends on a running `@dagsocial/node` HTTP API and `@dagsocial/types` for shared structures and constants.

## User-Facing Features

- Generate or import Ed25519 identity (keypair stored in browser — localStorage or IndexedDB)
- Compose posts (300-byte limit enforced client-side before submission)
- View feed of confirmed posts (polling or future WebSocket/SSE)
- Full post lifecycle: slot request → Phase 1 PoW → claim → Phase 2 PoW → sign → submit

## Client-Side Operations

| Operation | Algorithm | Notes |
|-----------|-----------|-------|
| Key generation | Web Crypto `crypto.subtle.generateKey('Ed25519')` | Public key exported as raw 32 bytes |
| Signing | Web Crypto `crypto.subtle.sign('Ed25519')` | Raw 64-byte signature, base64-encoded on wire |
| Phase 1 PoW | blake2b512 (blakejs or WASM) against server challenge | Target bits from `/slots/request` response |
| Phase 2 PoW | blake2b512 against post fields | Default 8 bits |
| Post ID | `computePostId()` — same algorithm as types package | Client MAY compute for preview, server is authoritative |

## API Consumption

All endpoints consumed from `@dagsocial/node` HTTP API per NODE_INTERFACE.md:

| Client Action | Endpoint |
|---------------|----------|
| Register identity | `POST /identity/import` |
| Get slot challenge | `POST /slots/request` |
| Claim slot | `POST /slots/claim` |
| Submit post | `POST /posts` |
| Read feed | `GET /posts?limit=30` |
| Node status | `GET /status` |

## Dependencies

- `blakejs` or equivalent pure-JS/WASM blake2b512 implementation (MIT licensed)
- No server-side rendering — static bundle served by node or CDN
- Modern browser with Web Crypto API (Ed25519 support)

## Preconditions
- `@dagsocial/node` HTTP API reachable
- Browser with Web Crypto API (`Ed25519` algorithm support)
- Static assets served (from node's `public/` or external CDN)

## Postconditions
- Ed25519 keypair generated or imported, stored in browser
- Public key registered with node
- User can compose, sign, and submit posts
- Feed displays confirmed posts from the node

## Invariants
- Private key never leaves the browser
- Content length enforced client-side (300 bytes) before submission
- `protocolVersion` is set by the client per the current protocol version imported from types
- PoW is solved client-side (the node never does client PoW)
- All hashing (blake2b512) is client-side; the node verifies, not assists
