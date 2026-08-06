# WIRE Interface Contract

**Component:** `@dagsocial/wire`
**Package version:** 1.0.0
**Last updated:** 2026-07-26

## Scope

Pure binary codec package extracted from `@ergots/scorex` (a byte-for-byte
JVM reference port). Provides ByteReader, ByteWriter, VLQ encoding, and
framed message envelope encoding/decoding. Zero runtime dependencies.

The hash function used for frame checksums is injectable.

VLQ values are carried via JavaScript `number` (safe integer range, <= 2^53).
BigInt paths for u64 wire values are deferred to a future version.

---

## Exports

| Export | Purpose |
|--------|---------|
| `ByteReader` | Stateful cursor over a `Uint8Array` |
| `ByteWriter` | Accumulator producing a single `Uint8Array` via `toBytes()` |
| `encodeVlqU` / `decodeVlqU` | Standalone unsigned VLQ |
| `encodeVlqZigZag` / `decodeVlqZigZag` | Standalone signed VLQ (ZigZag) |
| `ReaderError` | Typed error class with code taxonomy |
| `MAX_ARRAY_LENGTH` | `1 << 24` — cap on VLQ-length-prefixed array **counts**. ⚠ Not a resource bound — see below |
| `encodeFrame(magic, code, body, hashFn)` | Encode a framed message |
| `decodeFrame(magic, data, hashFn)` | Decode and validate a framed message |
| `FRAME_VERSION` | `1` — current framing protocol version |

**This package exports no network magic.** `MAGIC_MAINNET`, `MAGIC_TESTNET` and
`MAGIC_DEVNET` live in `@dagsocial/types` beside `NetworkProfile`, together with the
canonical `KNOWN_FRAME_MAGICS` set. Callers pass `magic` in.

**Why here is the wrong home.** `encodeFrame` and `decodeFrame` take `magic` as a
**parameter**; `frame.ts` reads no magic constant. The codec is magic-agnostic by
construction and should not own network identity. **This package keeps zero runtime
dependencies**, which is why the constants moved *out* rather than `NetworkType` moving
*in* — `@dagsocial/types` cannot import from here and this package must not import from
there. The codec stays the lowest layer.

> **Reverses a pre-audit follow-up, deliberately.** A queued note read *"wire should export
> the canonical magic set,"* motivated by `net` hardcoding `KNOWN_FRAME_MAGICS` as a local
> literal that would go stale when a third magic was added. **That defect was real and is
> fixed** — but the canonical set belongs in `@dagsocial/types` beside the profile table.
> The note predates the profile table. Recorded so the reversal is not itself reversed.

---

## ReaderError codes (audit L-15)

Every `ReaderError` carries a `code` naming **what kind of wrong** the
bytes were. Callers switch on `code`; they MUST NOT match on `message`,
which is diagnostic text and may be reworded at any time.

| Code | Meaning |
|------|---------|
| `truncated` | The bytes ran out — EOF, or fewer than `n` remaining. Genuine short read, nothing more. |
| `invalid-tag` | A discriminant byte was outside its allowed set (`readBool` not 0/1, `readOption` not 0/1). The bytes were present and wrong, which is not truncation. |
| `wrong-magic` | Frame magic did not match the expected network. Signals a wrong-network peer, not corruption. |
| `unsupported-version` | Frame version exceeds `FRAME_VERSION`. A newer peer, not corruption. |
| `checksum-mismatch` | The body's checksum failed — corrupted in transit or forged. |
| `vlq-overflow` | A VLQ exceeded the safe-integer range or the byte cap. |
| `array-too-large` | A length prefix exceeded `MAX_ARRAY_LENGTH`. |
| `position-limit-exceeded` | A read passed a caller-imposed position limit. |

The distinction is load-bearing rather than cosmetic. `@dagsocial/net`
decides what to do with a failed frame from the code: a checksum mismatch
or an unsupported version is rejected outright, never retried down
another path.

`wrong-magic` needs one more bit of judgement, because it covers two
unrelated situations. If the leading four bytes are a **recognized
foreign magic** (another `MAGIC_*` constant), the sender is a
wrong-network peer and the stream is closed. If they are not a frame
magic at all — an unframed legacy CBOR handshake begins `0xb9 …`, which
is simply not a frame — the payload may fall back to the legacy
raw-CBOR path. A `truncated` frame may fall back likewise. Consumers
MUST make that split themselves; the code alone cannot, since both cases
are genuinely "these bytes are not the magic I expected".

Collapsing all of this into one code forces the consumer to guess — or,
worse, to match on message text, which breaks silently the moment the
text changes.

---

## ByteReader

Wraps a `Uint8Array` with a cursor. Reads advance the cursor and throw
`ReaderError` on malformed input.

### Constructor

```
new ByteReader(bytes: Uint8Array)
```

Initializes position to 0, position limit to `bytes.length`.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `position` | `number` (readonly) | Current read cursor position |
| `remaining` | `number` (readonly) | `bytes.length - position` |
| `isExhausted` | `boolean` (readonly) | `position >= bytes.length` |

`_position` and `_positionLimit` are private. `positionLimit` has no public
setter — it is set once from the constructor. (No `forkSubReader`.)

### Methods

#### `readU8(): number`

Reads one byte, advances position by 1.

- **Precondition:** `position <= positionLimit`
- **Throws:** `ReaderError('position-limit-exceeded')` if position exceeds limit
- **Throws:** `ReaderError('truncated')` if at EOF

#### `readBytes(n: number): Uint8Array`

Reads `n` bytes, advances position by `n`.

- **Throws:** `ReaderError('truncated')` if fewer than `n` bytes remain
- **Returns:** A subarray (view, not a copy) of the underlying buffer

#### `readBool(): boolean`

Reads one byte. `0` => `false`, `1` => `true`.

- **Throws:** `ReaderError('invalid-tag')` on any other byte value

#### `readVlqU(): number`

Reads an unsigned variable-length quantity (VLQ) over the full documented
range `[0, Number.MAX_SAFE_INTEGER]`. Accumulates with multiplication, not
bitwise shift (which would coerce to 32 bits and corrupt values ≥ 2³²);
**throws** on out-of-range input rather than clamping.

- **Throws:** `ReaderError('truncated')` if truncated mid-byte
- **Throws:** `ReaderError('vlq-overflow')` if the running value would exceed
  `Number.MAX_SAFE_INTEGER`, or the encoding exceeds 10 bytes

#### `readVlqS(): number`

Reads a signed VLQ (ZigZag-decoded unsigned). Delegates to `readVlqU()`
then applies ZigZag decode arithmetically: `u even → u/2, odd → -(u+1)/2`
(not `(zz >>> 1) ^ -(zz & 1)`, which is 32-bit). Signed domain ≈ ±2⁵².

#### `readArray<T>(reader: (r: ByteReader) => T): T[]`

Reads VLQ length, then calls `reader(this)` that many times.

- **Throws:** `ReaderError('array-too-large')` if length > `MAX_ARRAY_LENGTH`

#### `readOption<T>(reader: (r: ByteReader) => T): T | null`

Reads a tag byte:
- `0` => `null`
- `1` => `reader(this)`

- **Throws:** `ReaderError('invalid-tag')` on any other tag value

### Guards

Every read method calls an internal `checkPositionLimit()` before reading.
This throws `ReaderError('position-limit-exceeded')` if `_position >
_positionLimit`.

### Stripped from scorex

Not carried over:
- `MAX_TREE_DEPTH` constant
- `enterDepth()` / `exitDepth()` depth tracking
- `forkSubReader()` sub-reader creation
- `positionLimit` setter (constructor-only)
- `readVlqU32()` (32-bit variant)
- `readVlqBigInt()` / `readVlqBigIntSigned()` (BigInt paths)

---

## ByteWriter

Accumulates byte chunks and produces a single `Uint8Array` via `toBytes()`.

### Constructor

```
new ByteWriter()
```

Initializes empty chunks and length = 0.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `length` | `number` (readonly) | Total bytes written so far |

### Methods

#### `writeU8(byte: number): void`

Writes one byte.

- **Throws:** `Error` if value not in `[0, 255]`

#### `writeBytes(bytes: Uint8Array): void`

Writes a byte array. Makes a defensive copy via `.slice()`.

#### `writeBool(value: boolean): void`

Writes `1` for `true`, `0` for `false`.

#### `writeVlqU(value: number): void`

Encodes unsigned integer as VLQ bytes.

- **Throws:** `Error` if negative or non-integer
- **Throws:** `Error` if exceeds `Number.MAX_SAFE_INTEGER`

#### `writeVlqS(value: number): void`

Encodes signed integer via ZigZag then VLQ.
ZigZag transform (arithmetic, not the 32-bit `((value << 1) ^ (value >> 31))`):
`value >= 0 ? value * 2 : -value * 2 - 1`, then `writeVlqU`. A magnitude large
enough to push the doubled value past `Number.MAX_SAFE_INTEGER` throws in
`writeVlqU` rather than truncating (signed domain ≈ ±2⁵²).

- **Throws:** `Error` if non-integer

#### `writeArray<T>(items: T[], serializer: (w: ByteWriter, item: T) => void): void`

Writes VLQ length, then calls `serializer(this, item)` for each item.

#### `writeOption<T>(value: T | null, serializer: (w: ByteWriter, v: T) => void): void`

- If `null`: writes tag byte `0`
- If non-null: writes tag byte `1`, then `serializer(this, value)`

#### `toBytes(): Uint8Array`

Concatenates all accumulated chunks into a single `Uint8Array` and returns it.

---

## VLQ Standalone Functions

> ⚠ **VLQ decoding accepts non-minimal encodings, and no canonicality rule is stated or
> enforced.** A value has multiple valid byte forms — redundant continuation bytes decode to
> the same number — so wire bytes are **malleable**: the same message can be re-encoded to
> different bytes that decode identically.
>
> **Why this is `trap` and not `fork-risk` today: no frame bytes are ever hashed.** Frame
> and VLQ encodings sit outside every consensus preimage — ids and roots are computed over
> CBOR structures, never over wire framing. **If that ever stops being true — if any framed
> byte enters a hash, a signature, or a Merkle leaf — VLQ malleability becomes a consensus
> fork and this must be fixed first.** Recorded as a premise so the dependency is visible
> rather than rediscovered.

### `encodeVlqU(value: number): Uint8Array`

Encodes a non-negative integer as VLQ bytes.

- **Precondition:** `value >= 0`, integer, `<= Number.MAX_SAFE_INTEGER`
- **Throws:** `Error` if precondition violated

### `decodeVlqU(reader: ByteReader): number`

Thin wrapper: returns `reader.readVlqU()`.

> ⚠ **`MAX_ARRAY_LENGTH` bounds the count, not the memory, and the two differ by ~128 MB.**
> `readArray` checks `length > MAX_ARRAY_LENGTH` and then does `new Array(length)` — a
> pre-allocation of up to 16,777,216 slots (~128 MB on 64-bit V8) **before reading a single
> element.** So a 4-byte VLQ inside the cap buys 128 MB of heap from any peer.
>
> **A declared length must be cross-checked against the bytes actually remaining.** An
> `N`-element array cannot decode from fewer than `N` bytes, so `length > remaining()` is a
> tighter bound than `MAX_ARRAY_LENGTH`, costs nothing, and makes the declared-vs-available
> mismatch unrepresentable. The current cap is a value-space limit doing a resource-limit's
> job. (Currently unreachable — `readArray` has no callers — which is why this is latent.)

### `encodeVlqZigZag(value: number): Uint8Array`

ZigZag-encodes a signed integer, then VLQ-encodes.

- **Precondition:** integer (any sign)
- **Throws:** `Error` if non-integer

### `decodeVlqZigZag(reader: ByteReader): number`

Thin wrapper: returns `reader.readVlqS()`.

---

## Frame Encode/Decode

### Type

```typescript
type HashFn = (data: Uint8Array) => Uint8Array
```

### `encodeFrame(magic: number, code: number, body: Uint8Array, hashFn: HashFn): Uint8Array`

Encodes a framed message.

**Format produced:**
```
[magic:4][version:1][code:VLQ][length:VLQ][checksum:4][body]
```

- **magic:** 4-byte big-endian network magic
- **version:** `FRAME_VERSION` (1)
- **code:** VLQ-encoded message type
- **length:** VLQ-encoded body length
- **checksum:** first 4 bytes of `hashFn(body)`
- **body:** raw bytes (unchanged)

**Preconditions:**
- `magic` is a valid network magic — supplied by the caller from the network profile
  (`@dagsocial/types`). This package does not know the set and does not validate against it
- `code` is a non-negative safe integer
- `body` is a `Uint8Array` (empty body is valid: `new Uint8Array(0)`)

**Postconditions:**
- Returns a single `Uint8Array` containing the full frame
- `decodeFrame(magic, result, hashFn)` produces `{ code, body }` matching
  the inputs

### `decodeFrame(magic: number, data: Uint8Array, hashFn: HashFn): { code: number; body: Uint8Array }`

Decodes and validates a framed message.

**Validation steps:**
1. Read and validate magic bytes (4 bytes) — must match `magic` parameter.
   Mismatch throws `ReaderError('wrong-magic')`. The four bytes are
   assembled **unsigned**: a magic with its high bit set must compare
   equal, so the assembly cannot use a signed `<<` chain, whose result is
   negative for any value ≥ `0x80000000` and would never match.
2. Read version byte (1 byte). If `> FRAME_VERSION`, throws
   `ReaderError('unsupported-version')`. If `< FRAME_VERSION`, accepted
   (forward-compat).
3. Read VLQ code.
4. Read VLQ length.
5. Read checksum (4 bytes).
6. Read body (`length` bytes).
7. Compute `hashFn(body)`, verify first 4 bytes match checksum.
   Mismatch throws `ReaderError('checksum-mismatch')`.

A frame that ends early at any step throws `ReaderError('truncated')`
from the underlying read, unchanged.

**Preconditions:**
- `magic` is a valid network magic
- `data` is a `Uint8Array`
- `hashFn` produces at least 4 bytes of output

**Postconditions:**
- Returns `{ code, body }` where `body` is a subarray of `data`
- Magic bytes, version, length, and checksum all validated

### Round-Trip Invariant

For any valid `magic`, `code`, and `body`:
```
decodeFrame(magic, encodeFrame(magic, code, body, hashFn), hashFn)
  ≡ { code, body }
```

---

## ReaderError

```typescript
class ReaderError extends Error {
  constructor(message: string, code: ReaderErrorCode)
  readonly code: ReaderErrorCode
  readonly name: 'ReaderError'
}

type ReaderErrorCode =
  | 'truncated'              // Unexpected EOF mid-read
  | 'invalid-tag'            // Discriminant byte outside its allowed set
  | 'wrong-magic'            // Frame magic did not match the expected network
  | 'unsupported-version'    // Frame version > FRAME_VERSION
  | 'checksum-mismatch'      // Body checksum failed
  | 'vlq-overflow'           // VLQ exceeded 10 bytes or safe integer range
  | 'array-too-large'        // Array length > MAX_ARRAY_LENGTH
  | 'position-limit-exceeded' // Position advanced beyond position limit
```

See "ReaderError codes (audit L-15)" above for the normative meanings.

---

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_ARRAY_LENGTH` | `1 << 24` (16,777,216) | Hard cap on VLQ-length-prefixed array reads |
| `FRAME_VERSION` | `1` | Current framing protocol version |

The network magics are **not** constants of this package — see §Exports.

---

## Preconditions

- Node.js >= 22
- No runtime dependencies

## Postconditions

- All read operations advance the cursor and throw `ReaderError` on invalid
  input — never return garbage
- All write operations validate inputs and throw `Error` on out-of-range
  values
- VLQ round-trip: `decodeVlqU(reader)` reproduces the original value for
  any non-negative safe integer
- Frame round-trip: `decodeFrame(magic, encodeFrame(magic, code, body, h), h)`
  reproduces `{ code, body }`
- Frame checksum catches single-byte corruption with probability
  `1 - 1/2^32`

## Invariants

- ByteReader is read-only: never mutates the underlying `Uint8Array`
- ByteWriter accumulates via defensive copies: callers retain ownership of
  passed buffers
- VLQ values fit in `Number.MAX_SAFE_INTEGER` (2^53 - 1) — no silent
  truncation
- Frame version is independent of application `protocolVersion` — they
  evolve separately
- Frame magic bytes detect wrong-network connections before any body parsing
- Frame checksum is validated before returning body bytes to the caller
