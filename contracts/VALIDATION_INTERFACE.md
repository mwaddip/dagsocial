# VALIDATION Interface Contract

**Component:** `@dagsocial/validation`
**Protocol version:** 1
**Last updated:** 2026-07-24

## Scope

Stateless validation functions for DAGsocial. Pure functions — no I/O, no
database access, no side effects. Shared by `@dagsocial/net` (Stage 1 checks
before gossip forwarding) and `@dagsocial/node` (Stage 2 verification for
both local and relayed objects). Depends only on `@dagsocial/types`.

Exports from `packages/validation/src/index.ts`.

---

## PoW Verification

### verifyPoW

```
verifyPoW(input: Uint8Array, nonce: number, targetBits: number): boolean
```

Encodes `nonce` as an 8-byte little-endian unsigned integer, concatenates
`input || nonceBytes`, hashes with blake2b512, takes first 32 bytes, checks
that the result has at least `targetBits` leading zero bits.

Used for post PoW verification in both Stage 1 (gossip) and Stage 2 (node).

### verifyOrderingBlockPoW

```
verifyOrderingBlockPoW(header: BlockHeader): boolean
```

Computes the PoW preimage via `computePowHash(header)`, encodes `header.powNonce`
as u64 LE, hashes `preimage || nonceBytes` with blake2b512, takes the first 32
bytes, and checks that the result has at least `header.powTargetBits` leading zero
bits. Guards its inputs (M-5 / M-6): returns `false` — never throws — if the
header is not CBOR-encodable, or if `powNonce` / `powTargetBits` is not a
non-negative safe integer.

Checks the solution against the header's **own** `powTargetBits` only. It does
**not** enforce a floor or the height-scheduled target: the
`ORDERING_BLOCK_POW_TARGET_FLOOR` lower bound is a gossip pre-filter inside
`verifyOrderingBlockStructure`, and the authoritative height-scheduled target is
enforced at block apply (`@dagsocial/node`, audit M-2 — see NODE_INTERFACE
"Ordering block apply-time authorization"). A producer that writes a low target
into its own header still passes this function; the apply-time check is what
rejects it.

Used by nodes to verify ordering-block PoW before applying a relayed block, and by
the block creator to verify externally-submitted mining solutions.

### computePowHash

```
computePowHash(header: BlockHeader): Buffer
```

Computes the preimage the PoW nonce hashes against: takes the header with
`powNonce` set to `0`, CBOR-encodes it (`encodeHeader`), and returns
`blake2b512(encoded).subarray(0, 32)`. The preimage is over the **header**, not a
separate "block body" — it covers `protocolVersion`, `height`, `prevBlockHash`,
`subBlockRoot`, `utxoTxRoot`, `stateRoot`, `validatorId`, `powTargetBits`, and
`createdAt`, with `powNonce` zeroed. The block *body* (sub-blocks, UTXO txs,
coinbase outputs) is committed **transitively**: `subBlockRoot` / `utxoTxRoot` are
Merkle roots over it and `stateRoot` is the AVL+ digest, so any body change alters
a root and therefore the preimage. `validatorSignature` is not a header field, so
it never enters the preimage. Exposed to external miners (hex) at
`GET /mining/template` as `powPreimage`.

### blockHash

```
blockHash(header: BlockHeader): string
```

The canonical block hash: `blake2b512(encodeHeader(header)).subarray(0, 32)` as a
64-char hex string — the header with its **solved** `powNonce` (unlike the PoW
preimage, which zeroes it). Used as the next block's `prevBlockHash` chain link,
and as the message the validator signs — `verifyValidatorSignature` recomputes it.
Because `validatorSignature` lives on the block and not in the header, `blockHash`
is stable before and after signing.

---

## Signature Verification

### verifyPostSignature

```
verifyPostSignature(post: Post, publicKey: Uint8Array): boolean
```

Wraps the 32 raw Ed25519 public key bytes in an SPKI DER envelope
(`302a300506032b6570032100` prefix), creates a `KeyObject` via
`crypto.createPublicKey`, and calls `crypto.verify(null, signingHash(post),
keyObj, signature)`. Returns `true` iff the signature is valid.

The caller is responsible for looking up the author's public key — this
function receives it as a parameter and performs no I/O.

### verifyValidatorSignature

```
verifyValidatorSignature(header: BlockHeader, signature: Uint8Array): boolean
```

Verifies that `signature` is a valid raw Ed25519 signature over the block hash,
made by the key declared in `header.validatorId`. Recomputes the signed message
as `Buffer.from(blockHash(header), 'hex')` — the 32 raw bytes of
`blake2b512(encodeHeader(header))[:32]`, the exact value the block creator signs
(`crypto.sign(null, Buffer.from(blockHash(header), 'hex'), validatorPrivKey)`).
Wraps the 32-byte `header.validatorId` in an SPKI DER envelope, builds a
`KeyObject`, and calls `crypto.verify(null, message, keyObj, signature)`. Returns
`true` iff the signature verifies.

`validatorSignature` lives on the block, **not** in the header, so
`blockHash(header)` is stable before and after signing — verification recomputes
it from the received header and checks the signature against `header.validatorId`.
A block whose `validatorId` names a key the producer does not hold (a forged
authorship) fails this check. Mirrors `verifyPostSignature`; like it, the caller
supplies the public key (here the header's own `validatorId`) and the function
performs no I/O.

**No-panic (M-5).** Returns `false` — never throws — on malformed input: a header
that is not CBOR-encodable (so `blockHash` / `encodeHeader` cannot run), a
`validatorId` that is not exactly 32 bytes (the SPKI wrap / `createPublicKey`
would otherwise throw), or a `signature` that is not a byte view. A wrong-*length*
signature is left to `crypto.verify`, which rejects it cleanly, matching
`verifyPostSignature`.

---

## Protocol Version

### verifyProtocolVersion

```
verifyProtocolVersion(version: number): boolean
```

Returns `true` iff `version === PROTOCOL_VERSION` (currently `1`).
Rejects all other versions.

---

## Content Limits

### verifyContentLimits

```
verifyContentLimits(content: string): { valid: boolean; error?: string }
```

Rejects empty content and content exceeding `MAX_CONTENT_BYTES` (300)
in UTF-8 byte length. Accepts 1–300 bytes inclusive.

### verifyParentRefsCount

```
verifyParentRefsCount(refs: string[]): { valid: boolean; error?: string }
```

Rejects if `refs.length > MAX_PARENT_REFS` (8). Accepts 0–8 refs.

### verifyContentCharacters

```
verifyContentCharacters(content: string): { valid: boolean; error?: string }
```

Rejects content containing any character in Unicode categories `Cc` (control),
`Cf` (format), `Cs` (surrogate), or `Co` (private use), with the single
exception of `\n` (U+000A, line feed). This blocks zero-width characters
(ZWSP U+200B, ZWNJ U+200C, ZWJ U+200D), bidi controls (U+200E–200F,
U+202A–202E, U+2060–2064, U+2066–206F), tag characters (U+E0000–E007F),
BOM/interlinear/soft-hyphen and other format codepoints, control characters
(null, backspace, `\r`, `\t`, escape sequences), surrogates, and private-use
codepoints. Allows all letters, marks, numbers, punctuation, symbols,
separators, emoji, unassigned codepoints, and `\n`.

**Version-independence (M-4).** This is a **consensus Stage-1 check**, so every
node must reach the same verdict for the same bytes. It therefore may **not** be
implemented with runtime Unicode general-category escapes (`\p{C}` / `\P{C}`):
`\P{C}` excludes `\p{Cn}` (unassigned), whose membership shifts as each Node/V8
build ships a newer Unicode data version, so two nodes on different builds would
diverge on any codepoint that has since been assigned. Instead the check is a
table of **explicit numeric codepoint ranges** — the union of `Cc`/`Cf`/`Cs`/`Co`
enumerated at one **pinned Unicode version** (documented in code), minus U+000A.
`Cn` (unassigned) is deliberately **not** rejected; allowing it is what removes
the version dependence. The verdict is then identical on every runtime regardless
of its Unicode data version. Pure stateless check, applied unconditionally to all
post content; covered by a test asserting the ranges match the pinned version and
that the verdict does not consult runtime category data.

---

## Structural Validation

### verifySubBlockStructure

```
verifySubBlockStructure(sb: SubBlock): { valid: boolean; error?: string }
```

Checks: `post` present, `subBlockId` present, `likeBoxes` is an array,
`protocolVersion` is a number, `producerId` present. Returns `{ valid, error }`.

### verifyTxStructure

```
verifyTxStructure(tx: UtxoTransaction): { valid: boolean; error?: string }
```

Checks: `inputs` is a non-empty array, `outputs` is a non-empty array,
no duplicate inputs, `protocolVersion` is a number. Does NOT check UTXO
conservation or guard satisfaction — those are Stage 2 (stateful) checks.

### verifyOrderingBlockStructure

```
verifyOrderingBlockStructure(block: OrderingBlock): { valid: boolean; error?: string }
```

Checks: `prevBlockHash` present and non-empty, `subBlockRefs` is an array,
`subBlockEntries` is an array aligned 1:1 with `subBlockRefs` where every entry
has a 64-char `postId`, a `parentRefs` array of ≤ 8 64-char strings, and a
64-char `author` (the consensus-carried authorship claim, audit H-3),
`validatorSignature` is 64 bytes, `height` ≥ 1, `protocolVersion` is a number,
`hash` present and non-empty, `powNonce` is a non-negative number,
`powTargetBits` ≥ `ORDERING_BLOCK_POW_TARGET_FLOOR` (4), `coinbaseOutputs` is
an array with each output having a 32-byte `owner` and non-negative `value`
and `lockedUntilBlock` ≥ `block.height`.

Structure-only: `author` is checked for shape here, not truth — binding it to
the real post (when content is locally present) and to prune authorization is
stateful and lives in `@dagsocial/node` (see `NODE_INTERFACE.md`).

### verifyBlockChainLink

```
verifyBlockChainLink(block: OrderingBlock, prevBlock: OrderingBlock): boolean
```

Returns `true` iff `block.prevBlockHash === prevBlock.hash` and
`block.height === prevBlock.height + 1`. Pure chain-link check — does
not verify PoW, signatures, or UTXO state transitions.

---

## Phased Validation Pipeline

Validation runs in order of increasing cost. A post failing phase N is
rejected before phase N+1 executes.

**Phase 1 — Structural (cheapest):**
- Post deserializes without error
- All required fields present
- `protocolVersion` is supported
- `content.length` within [1, MAX_CONTENT_BYTES]
- `parentRefs.length` within [0, MAX_PARENT_REFS]

**Phase 2 — Cryptographic (cheap):**
- `verifyPostSignature(post)` passes
- `verifyPoW(post, targetBits)` passes

**Phase 3 — DAG integrity (moderate):**
- Every `parentRefs[i]` exists in local DAG or unconfirmed pool
- Parent linkage consistent with canonical branch at that depth
- No duplicate post in local DAG (idempotent — treated as no-op, not error)

**Phase 4 — Content (variable cost, deferrable):**
- `verifyContentCharacters(content)` passes (no Unicode category C except \n)
- Content-specific validation (future: homoglyph detection, media checks)

**Watermarks:**
- `post_indexed_height`: advanced after Phase 3
- `post_validated_height`: advanced after Phase 4

Invariant: `post_validated_height <= post_indexed_height <= dag_tip_height`.
External queries serve only up to `post_validated_height`.

**Protocol vs. local-policy rules:**
- Phases 1-3 are protocol rules — all nodes must enforce identically
- Phase 4 may include local-policy rules — configurable, non-consensus
- Local-policy rules are explicitly documented as such

---

## Usage in the Validation Pipeline

```
Stage 1 (@dagsocial/net — topic validators, before mesh forwarding)
  ├── verifySubBlockStructure
  ├── verifyContentLimits
  ├── verifyContentCharacters
  ├── verifyParentRefsCount
  ├── verifyProtocolVersion
  ├── verifyPoW
  └── (signature deferred to Stage 2 — requires DB lookup for public key)

Stage 2 (@dagsocial/node — on* callbacks, after gossip receipt)
  ├── All Stage 1 checks re-run (defense in depth)
  ├── verifyPostSignature (now with public key from identity store)
  ├── Parent ref existence (DB lookup)
  └── Karma sufficiency (UTXO state)

Block receipt (@dagsocial/node)
  ├── verifyOrderingBlockStructure
  ├── verifyBlockChainLink (against previous block)
  ├── verifyOrderingBlockPoW
  ├── verifyValidatorSignature (blockHash(header) signed with validatorId's key)
  │     — enforced inside applyOrderingBlock, the funnel every apply path
  │       (gossip, sync, reorg) passes through, so no path can skip it
  └── State application (UTXO, sub-block confirmation, mempool cleanup)
```

PoW is verified in both stages for posts — Stage 1 blocks invalid-PoW spam from
propagating; Stage 2 re-verifies for defense in depth. Ordering block PoW is
verified at receipt time only.

---

## Preconditions
- Node.js ≥ 22 (blake2b512 via `crypto.createHash`)
- `@dagsocial/types` package built and importable
- `crypto.createPublicKey` and `crypto.verify` available for Ed25519

## Postconditions
- All exported functions are pure: same inputs → same outputs, no side effects
- No I/O, no DB access, no network calls
- Callable from any context (gossip event handler, HTTP route handler, test)
- **No-panic (M-5).** No exported verify function throws on malformed or
  adversarial input — each returns `false` / `{ valid: false }` instead. Inputs
  arrive straight off the wire and may be wrongly typed or out of range
  (non-string `content`, non-array `parentRefs`, a public key or `validatorId`
  that is not 32 bytes, a block header that is not CBOR-encodable, a nonce that
  is negative / `NaN` / float / beyond `u64`). Every such case is a clean
  rejection, never an exception. Guard the throwing operations
  (`Buffer.byteLength`, `createPublicKey`, `encodeHeader`,
  `BigInt`/`writeBigUInt64LE`, `.length`) with type/shape checks first.

## Invariants
- All hashing uses `blake2b512.digest().subarray(0, 32)` — Node.js v22
  lacks blake2b256
- Signatures verified with `crypto.verify(null, signingHash, keyObj, sig)`
  using a `KeyObject` created via `crypto.createPublicKey`
- SPKI DER prefix for Ed25519: `302a300506032b6570032100`
- PoW nonce encoded as 8-byte little-endian unsigned integer, after an
  integer-range guard (M-6): a nonce or `targetBits` that is not a non-negative
  safe integer within `u64` yields `false`, never a thrown `RangeError` from
  `BigInt` / `writeBigUInt64LE`. Validate with `Number.isInteger` (not a loose
  `typeof === 'number'`, which admits `NaN` and floats)
- Content limits measured in UTF-8 bytes, not characters
- All functions are synchronous — no Promises, no callbacks
- Protocol version `PROTOCOL_VERSION` from `@dagsocial/types`
- Ordering-block hashing is over the **header**. The PoW preimage
  (`computePowHash`) is the encoded header with `powNonce` zeroed; the canonical
  `blockHash` is the encoded header with the solved `powNonce`. Neither includes
  `validatorSignature` — it is not a header field. The body binds via the header's
  `subBlockRoot` / `utxoTxRoot` / `stateRoot`.
