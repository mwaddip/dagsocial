# TYPES Interface Contract

**Component:** `@dagsocial/types`
**Status:** Implemented (Phase 1)
**Protocol version:** 1

## Scope

Shared data structures, serialization, base58 encoding, hash functions, and protocol constants. Pure functions only — no side effects, no I/O, no imports from other DAGsocial packages.

## Exports

### Identity (`identity.ts`)

| Export | Signature | Description |
|--------|-----------|-------------|
| `KeyPair` | `{ publicKey: Uint8Array, secretKey: Uint8Array }` | Ed25519 keypair (public: 32 raw bytes, secret: PKCS8 DER) |
| `UserId` | `string` | `base58btc(blake2b512(rawPublicKey))` — no truncation |
| `generateKeyPair()` | `() => KeyPair` | Node `crypto.generateKeyPairSync('ed25519')` |
| `getUserId(pub)` | `(Uint8Array) => UserId` | Deterministic, full 64-byte hash |

### Post & Block Types (`post.ts`)

| Export | Fields | Description |
|--------|--------|-------------|
| `SlotToken` | `userId, issuedAtBlock, expiresAtBlock, nonce, hash` | Time-limited PoW proof. Validity in block height. |
| `UnsignedPost` | `content, author, parentRefs, slotHash, powNonce, protocolVersion, timestamp` | Pre-signature post |
| `Post` | extends `UnsignedPost` + `id, signature, status, blockHeight?` | Full signed post |
| `Block` | `height, hash, postIds, postCount, protocolVersion, createdAt` | Confirmed block |
| `signingHash(post)` | `(UnsignedPost) => Buffer` | `blake2b512(content \|\| author \|\| parents \|\| slotHash \|\| protocolVersion \|\| timestamp).subarray(0,32)` — what the author signs |
| `computePostId(post)` | `(UnsignedPost) => string` | `blake2b512(content \|\| author \|\| parents \|\| slotHash \|\| powNonce \|\| protocolVersion \|\| timestamp).subarray(0,32).toString('hex')` |

### Serialization (`serialization.ts`)

| Export | Signature | Description |
|--------|-----------|-------------|
| `encodePost(post)` | `(Post) => Uint8Array` | CBOR encode via `cbor-x` |
| `decodePost(bytes)` | `(Uint8Array) => Post` | CBOR decode via `cbor-x` |
| `encodeSlotToken(token)` | `(SlotToken) => Uint8Array` | CBOR encode |
| `decodeSlotToken(bytes)` | `(Uint8Array) => SlotToken` | CBOR decode |

### Base58 (`base58.ts`)

| Export | Signature | Description |
|--------|-----------|-------------|
| `base58Encode(buf)` | `(Uint8Array) => string` | Bitcoin-style base58 (alphabet: `123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`) |
| `base58Decode(str)` | `(string) => Uint8Array` | Throws on invalid characters |

## Protocol Constants (v1)

```typescript
export const PROTOCOL_VERSION = 1;
export const MAX_CONTENT_BYTES = 300;
export const MAX_PARENT_REFS = 8;
export const DEFAULT_SLOT_WINDOW_BLOCKS = 100;
export const DEFAULT_SLOT_TARGET_BITS = 20;
export const DEFAULT_SUBMIT_TARGET_BITS = 8;
```

These constants live in the types package. All components import them — no component defines its own copy.

## Preconditions
- Node.js ≥ 22
- `cbor-x` installed (only runtime dependency)
- No other DAGsocial packages needed at build time

## Postconditions
- Build produces `dist/index.js` (ESM) + `dist/index.d.ts`
- All functions are pure — no side effects, no module-level state
- Types are importable by consumers without runtime cost (type-only imports)

## Invariants
- Must not import from `@dagsocial/node`, `@dagsocial/net`, or `@dagsocial/web`
- Hash algorithm: `blake2b512` with `.subarray(0, 32)` for all 32-byte outputs
- Base58 alphabet: Bitcoin-style (no `0OIl`)
- CBOR is the canonical wire format
- `protocolVersion` field present on all Post and Block types
