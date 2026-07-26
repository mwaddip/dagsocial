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
| `MAX_ARRAY_LENGTH` | `1 << 24` — hard cap on VLQ-length-prefixed arrays |
| `encodeFrame(magic, code, body, hashFn)` | Encode a framed message |
| `decodeFrame(magic, data, hashFn)` | Decode and validate a framed message |
| `FRAME_VERSION` | `1` — current framing protocol version |
| `MAGIC_MAINNET` | `0x4D444147` ("MDAG") |
| `MAGIC_TESTNET` | `0x54444147` ("TDAG") |

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

- **Throws:** `ReaderError('truncated')` on any other byte value

#### `readVlqU(): number`

Reads an unsigned variable-length quantity (VLQ). Result clamped to
`Number.MAX_SAFE_INTEGER`.

- **Throws:** `ReaderError('truncated')` if truncated mid-byte
- **Throws:** `ReaderError('vlq-overflow')` if exceeds 10 bytes or safe
  integer range

#### `readVlqS(): number`

Reads a signed VLQ (ZigZag-decoded unsigned). Delegates to `readVlqU()`
then applies ZigZag decode: `(zz >>> 1) ^ -(zz & 1)`.

#### `readArray<T>(reader: (r: ByteReader) => T): T[]`

Reads VLQ length, then calls `reader(this)` that many times.

- **Throws:** `ReaderError('array-too-large')` if length > `MAX_ARRAY_LENGTH`

#### `readOption<T>(reader: (r: ByteReader) => T): T | null`

Reads a tag byte:
- `0` => `null`
- `1` => `reader(this)`

- **Throws:** `ReaderError('truncated')` on any other tag value

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
ZigZag transform: `((value << 1) ^ (value >> 31)) >>> 0`, then `writeVlqU`.

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

### `encodeVlqU(value: number): Uint8Array`

Encodes a non-negative integer as VLQ bytes.

- **Precondition:** `value >= 0`, integer, `<= Number.MAX_SAFE_INTEGER`
- **Throws:** `Error` if precondition violated

### `decodeVlqU(reader: ByteReader): number`

Thin wrapper: returns `reader.readVlqU()`.

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
- `magic` is a valid network magic (`MAGIC_MAINNET` or `MAGIC_TESTNET`)
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
   Mismatch throws `ReaderError('truncated')` with message indicating wrong
   network.
2. Read version byte (1 byte). If `> FRAME_VERSION`, throws `ReaderError`.
   If `< FRAME_VERSION`, accepted (forward-compat).
3. Read VLQ code.
4. Read VLQ length.
5. Read checksum (4 bytes).
6. Read body (`length` bytes).
7. Compute `hashFn(body)`, verify first 4 bytes match checksum.
   Mismatch throws `ReaderError('truncated')` with message indicating
   checksum failure.

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
  | 'vlq-overflow'           // VLQ exceeded 10 bytes or safe integer range
  | 'array-too-large'        // Array length > MAX_ARRAY_LENGTH
  | 'position-limit-exceeded' // Position advanced beyond position limit
  | 'slice-out-of-bounds'    // Requested slice extends past buffer end
```

---

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_ARRAY_LENGTH` | `1 << 24` (16,777,216) | Hard cap on VLQ-length-prefixed array reads |
| `FRAME_VERSION` | `1` | Current framing protocol version |
| `MAGIC_MAINNET` | `0x4D444147` | Mainnet magic bytes ("MDAG") |
| `MAGIC_TESTNET` | `0x54444147` | Testnet magic bytes ("TDAG") |

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
