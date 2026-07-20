# DAGsocial Architecture

**Protocol version:** 1 (Phase 1)
**Last updated:** 2026-07-20

## Components

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  types   │◄────│   node   │◄────│   net    │     │   web    │
│ (shared) │     │ (server) │     │ (libp2p) │     │ (client) │
└──────────┘     └────┬─────┘     └──────────┘     └────┬─────┘
                      │                                 │
                      └──────── HTTP API ───────────────┘
```

| Component | Scope | Depends on | Status |
|-----------|-------|------------|--------|
| **types** | Data structures, serialization, base58, hash functions, protocol constants | Node.js ≥ 22 | Implemented |
| **node** | HTTP server, PoW, verifier, store, block creator, demo UI | types | Implemented |
| **net** | libp2p peer discovery, post gossip, validator peering, DAG sync | node, types | Phase 2 |
| **web** | React client, client-side keygen/signing/PoW, feed UI | node HTTP API, types | Phase 2 |

## Data Flow

1. **web** generates Ed25519 keypair, registers public key with **node** via HTTP
2. **web** requests slot challenge from **node**, solves Phase 1 PoW client-side, claims slot
3. **web** constructs post, signs with private key, solves Phase 2 PoW, submits to **node**
4. **node** verifies post (sig → slot → PoW → parents), inserts into DAG, confirms in a block
5. **net** (future) gossips confirmed blocks between nodes; each node re-verifies inbound posts
6. **web** polls **node** HTTP API for feed

## Protocol Versioning

Every post and block carries a `protocolVersion` field. Validation rules are keyed to this version:

- **Version 1:** Phase 1 rules (this contract). Content limit 300 bytes. blake2b512 PoW. Ed25519 raw signatures.
- Future versions may change PoW algorithm, content limits, signature format, or block structure. An old post with version 1 is validated against version 1 rules forever.

A node rejects posts with an unsupported protocol version.

## Invariants (cross-component)

### Identifiers
- **Post ID:** `blake2b512(content || author || parentRefs || slotHash || powNonce || protocolVersion || timestamp).subarray(0,32).toString('hex')`
- **User ID:** `base58btc(blake2b512(rawPublicKey))` — 32 raw bytes from Ed25519 public key
- **Block height:** auto-incrementing integer, starting from 1

### Limits
- Post content: 1–300 UTF-8 bytes
- Parent refs: 0–8 per post
- Request body: max 1MB
- Slot validity: `slotWindowBlocks` (default 100) measured in block height, not wall clock

### Encoding
- Wire format: CBOR (`cbor-x`)
- HTTP API: JSON (debuggability)
- Signatures: raw Ed25519 (64 bytes), base64-encoded on wire
- Public keys: raw 32 bytes, hex-encoded on wire

### Runtime
- Node.js ≥ 22 (all components)
- ESM only (`"type": "module"`, `.js` import extensions)
- Secret keys never in API responses or DTOs crossing component boundaries

### Store abstraction
The node defines a `Store` interface for persistence. SQLite is the Phase 1 implementation. The interface — not the backend — is the contract. Consumers call the interface; never the backend directly.
