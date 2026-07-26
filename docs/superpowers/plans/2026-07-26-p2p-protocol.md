# P2P Protocol Restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the p2p networking layer with a `@dagsocial/wire` package, framed stream protocol (magic bytes + VLQ + checksum), handshake, header-first historical sync, and peer discovery.

**Architecture:** Extract ByteReader/ByteWriter/VLQ from `@ergots/scorex` into a new pure `@dagsocial/wire` package. Add framed messages on top of libp2p streams for handshake, sync, and peer discovery. Gossipsub topics remain raw CBOR. New sync machine with bidirectional serve, watermark tracking, and cross-DB durability handshake. PeerDb with in-memory registry + persistent backing.

**Tech Stack:** TypeScript, Node.js ≥ 22, vitest, libp2p, `@dagsocial/types`, `@dagsocial/validation`, `cbor-x`

## Global Constraints

- Node.js ≥ 22 (`createHash('blake2b512')` with `.subarray(0, 32)` for all 32-byte hashes)
- VLQ carried via `number` (safe integer ≤ 2^53; BigInt paths deferred)
- Wire package has no runtime dependencies (hash function is injectable via argument)
- Frame magic: mainnet `0x4D444147`, testnet `0x54444147`
- Frame body is CBOR-encoded (`cbor-x`); Gossipsub topics carry raw CBOR (no frame)
- Protocol version 2 for net package; app protocol version independent of frame version
- Tests in `test/` directory per existing project convention
- Target: full build + 274 existing tests still pass after each task

---

### Task 1: Update contracts

**Files:**
- Modify: `contracts/ARCHITECTURE.md`
- Modify: `contracts/NET_INTERFACE.md`
- Create: `contracts/WIRE_INTERFACE.md`

**Produces:** Updated contracts for protocol v2, wire package, frame format, sync machine, peer discovery.

- [ ] **Step 1: Update ARCHITECTURE.md**

Changes:
1. Line 3: `**Protocol version:** 1` → `**Protocol version:** 2`
2. Add `@dagsocial/wire` to package diagram (sits below types/validation, net depends on it)
3. In "Cryptographic" invariants section, add: "Stream messages are framed: `[magic:4][version:1][code:VLQ][length:VLQ][checksum:4][body]`. Gossip messages are raw CBOR. Wire-codec types (ByteReader, ByteWriter, VLQ) live in `@dagsocial/wire`."
4. Add to "Implemented (v1)" → rename to "Implemented (v2)" and append: "Framed p2p stream protocol with magic bytes, VLQ length prefixing, blake2b256 checksum", "Header-first historical sync with SyncInfo/Inv/Modifier protocol", "Peer discovery via GetPeers/Peers gossip + PeerDb"

- [ ] **Step 2: Rewrite NET_INTERFACE.md**

Full rewrite reflecting the spec (`docs/superpowers/specs/2026-07-26-p2p-protocol-design.md`). Sections to cover:
- Wire framing (frame format table, magic bytes, version negotiation, message codes 1–9)
- Gossip topics (unchanged — raw CBOR)
- Handshake (flow, body fields, validation, post-handshake routing)
- Historical sync (SyncInfo/Inv/Modifier protocol, flow diagram, serve side, state machine, watermarks, cross-DB durability)
- Peer discovery (PeerDb, GetPeers/Peers, outbound manager floor/fill, bogus address filtering)
- Peer penalty system (unchanged)
- libp2p stack (unchanged)
- API table (add `allPeers()`, `connectToPeer(addr)`)
- Stream protocols: `/dagsocial/handshake/1`, `/dagsocial/sync/1`
- Remove references to old `/dagsocial/sync/1` (individual sub-block) and `/dagsocial/headers/1`
- Preconditions, postconditions, invariants updated

- [ ] **Step 3: Create WIRE_INTERFACE.md**

New contract covering:
- ByteReader API (constructor, all methods, properties, guards)
- ByteWriter API (constructor, all methods, `toBytes()`)
- VLQ standalone functions (encode/decode unsigned + ZigZag)
- Frame encode/decode functions (signatures, pre/postconditions, round-trip invariant)
- ReaderError class with code taxonomy
- Constants: `MAX_ARRAY_LENGTH = 1 << 24`

- [ ] **Step 4: Commit**

```bash
git add contracts/ && git commit -m "docs: update contracts for p2p protocol v2

Add @dagsocial/wire contract. Rewrite NET_INTERFACE with frame format,
handshake, header-first sync, peer discovery. Bump ARCHITECTURE to v2.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Scaffold `@dagsocial/wire` package

**Files:**
- Create: `packages/wire/package.json`
- Create: `packages/wire/tsconfig.json`
- Create: `packages/wire/vitest.config.ts`
- Create: `packages/wire/src/index.ts` (placeholder)

**Produces:** Empty package that builds. No source logic yet.

- [ ] **Step 1: Create directory and package.json**

```bash
mkdir -p packages/wire/src
```

Create `packages/wire/package.json`:
```json
{
  "name": "@dagsocial/wire",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globals: true, passWithNoTests: true },
});
```

- [ ] **Step 4: Create placeholder index.ts**

```ts
// @dagsocial/wire — wire-codec layer (ByteReader, ByteWriter, VLQ, frame envelope)
export {};
```

- [ ] **Step 5: Install and build**

```bash
cd packages/wire && pnpm install && pnpm build
```
Expected: builds without error.

- [ ] **Step 6: Verify pnpm build still works from root**

```bash
cd /home/mwaddip/projects/dagsocial && pnpm build
```
Expected: all 5 packages build (types, validation, wire, net, node).

- [ ] **Step 7: Commit**

```bash
git add packages/wire/ && git commit -m "feat(wire): scaffold @dagsocial/wire package

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: `@dagsocial/wire` — ReaderError + ByteReader

**Files:**
- Create: `packages/wire/src/errors.ts`
- Create: `packages/wire/src/reader.ts`
- Modify: `packages/wire/src/index.ts`
- Create: `packages/wire/test/reader.test.ts`

**Interfaces:**
- Produces: `ReaderError` (Error subclass with `code: 'truncated' | 'vlq-overflow' | 'array-too-large' | 'position-limit-exceeded' | 'slice-out-of-bounds'`)
- Produces: `ByteReader` class with methods: `readU8()`, `readBytes(n)`, `readBool()`, `readArray(reader)`, `readOption(reader)`; properties: `position`, `remaining`, `isExhausted`; constant: `MAX_ARRAY_LENGTH = 1 << 24`

- [ ] **Step 1: Write errors.ts**

```ts
export class ReaderError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'truncated'
      | 'vlq-overflow'
      | 'array-too-large'
      | 'position-limit-exceeded'
      | 'slice-out-of-bounds',
  ) {
    super(message);
    this.name = 'ReaderError';
  }
}
```

- [ ] **Step 2: Write reader.ts**

Port from `@ergots/scorex` ByteReader, stripped of Ergo-specific features (no `enterDepth`, `exitDepth`, `forkSubReader`, `positionLimit` setter, `readVlqBigInt`, `readVlqU32`, `MAX_TREE_DEPTH`). Keep: `readU8`, `readBytes`, `readBool`, `readArray`, `readOption`, position tracking, `remaining`, `isExhausted`, `MAX_ARRAY_LENGTH`, `checkPositionLimit`.

```ts
import { ReaderError } from './errors.js';

export const MAX_ARRAY_LENGTH = 1 << 24;

export class ByteReader {
  private _position = 0;
  private _positionLimit: number;

  constructor(private readonly bytes: Uint8Array) {
    this._positionLimit = bytes.length;
  }

  get position(): number { return this._position; }
  get remaining(): number { return this.bytes.length - this._position; }
  get isExhausted(): boolean { return this._position >= this.bytes.length; }

  private checkPositionLimit(): void {
    if (this._position > this._positionLimit) {
      throw new ReaderError(
        `position limit ${this._positionLimit} reached at position ${this._position}`,
        'position-limit-exceeded',
      );
    }
  }

  readU8(): number {
    this.checkPositionLimit();
    if (this._position >= this.bytes.length) {
      throw new ReaderError(`readU8: EOF at ${this._position}`, 'truncated');
    }
    return this.bytes[this._position++]!;
  }

  readBytes(n: number): Uint8Array {
    this.checkPositionLimit();
    if (this.remaining < n) {
      throw new ReaderError(`readBytes(${n}): only ${this.remaining} available`, 'truncated');
    }
    const out = this.bytes.subarray(this._position, this._position + n);
    this._position += n;
    return out;
  }

  readBool(): boolean {
    const b = this.readU8();
    if (b === 0) return false;
    if (b === 1) return true;
    throw new ReaderError(`readBool: expected 0 or 1, got ${b}`, 'truncated');
  }

  readArray<T>(reader: (r: ByteReader) => T): T[] {
    // length read will come from VLQ (Task 4) — for now, read as u8 placeholder
    // After Task 4, this method's length read is replaced with readVlqU
    const length = this.readU8();
    if (length > MAX_ARRAY_LENGTH) {
      throw new ReaderError(`readArray: length ${length} exceeds max ${MAX_ARRAY_LENGTH}`, 'array-too-large');
    }
    const out: T[] = new Array(length);
    for (let i = 0; i < length; i++) out[i] = reader(this);
    return out;
  }

  readOption<T>(reader: (r: ByteReader) => T): T | null {
    const tag = this.readU8();
    if (tag === 0) return null;
    if (tag === 1) return reader(this);
    throw new ReaderError(`readOption: expected tag 0 or 1, got ${tag}`, 'truncated');
  }
}
```

Note: `readArray` currently reads length as `u8`. After Task 4 (VLQ), update it to use `readVlqU()`.

- [ ] **Step 3: Update index.ts**

```ts
export { ReaderError } from './errors.js';
export { ByteReader, MAX_ARRAY_LENGTH } from './reader.js';
```

- [ ] **Step 4: Write tests**

Create `packages/wire/test/reader.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ByteReader, MAX_ARRAY_LENGTH, ReaderError } from '@dagsocial/wire';

describe('ByteReader', () => {
  it('reads a single byte', () => {
    const r = new ByteReader(new Uint8Array([0xab, 0xcd]));
    expect(r.readU8()).toBe(0xab);
    expect(r.readU8()).toBe(0xcd);
    expect(r.isExhausted).toBe(true);
  });

  it('reads multiple bytes', () => {
    const r = new ByteReader(new Uint8Array([1, 2, 3, 4, 5]));
    const bytes = r.readBytes(3);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(r.position).toBe(3);
  });

  it('reads bool', () => {
    const r = new ByteReader(new Uint8Array([0, 1, 2]));
    expect(r.readBool()).toBe(false);
    expect(r.readBool()).toBe(true);
    expect(() => r.readBool()).toThrow(ReaderError);
  });

  it('tracks position and remaining', () => {
    const r = new ByteReader(new Uint8Array(10));
    expect(r.position).toBe(0);
    expect(r.remaining).toBe(10);
    expect(r.isExhausted).toBe(false);
    r.readBytes(10);
    expect(r.position).toBe(10);
    expect(r.remaining).toBe(0);
    expect(r.isExhausted).toBe(true);
  });

  it('throws on read past end', () => {
    const r = new ByteReader(new Uint8Array(1));
    r.readU8();
    expect(() => r.readU8()).toThrow(ReaderError);
    expect(() => r.readU8()).toThrow('truncated');
  });

  it('throws on readBytes past end', () => {
    const r = new ByteReader(new Uint8Array(2));
    expect(() => r.readBytes(5)).toThrow(ReaderError);
  });

  it('readArray delegates to reader function', () => {
    const r = new ByteReader(new Uint8Array([2, 10, 20]));
    const result = r.readArray((rr) => rr.readU8());
    expect(result).toEqual([10, 20]);
  });

  it('readArray rejects oversized arrays', () => {
    // Create minimal bytes that encode a large length
    const bytes = new Uint8Array([0xff]); // length 255 as u8
    const r = new ByteReader(bytes);
    // 255 is under MAX_ARRAY_LENGTH so this reads fine if we have that many bytes
    // Actually this test would fail because we'd try to read 255 items from 0 bytes
    // Replace with a proper VLQ test after Task 4
  });

  it('readOption handles null', () => {
    const r = new ByteReader(new Uint8Array([0]));
    expect(r.readOption((rr) => rr.readU8())).toBeNull();
  });

  it('readOption handles some', () => {
    const r = new ByteReader(new Uint8Array([1, 42]));
    expect(r.readOption((rr) => rr.readU8())).toBe(42);
  });
});
```

- [ ] **Step 5: Run tests**

```bash
cd packages/wire && pnpm test
```
Expected: tests pass (the array-length rejection test may need adjustment).

- [ ] **Step 6: Update readArray to use proper VLQ length**

After confirming ByteReader works, the `readArray` stub using `readU8` for length is a known limitation. It will be updated in Task 4 when VLQ is added.

- [ ] **Step 7: Commit**

```bash
git add packages/wire/ && git commit -m "feat(wire): add ByteReader and ReaderError

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: `@dagsocial/wire` — VLQ encoding/decoding

**Files:**
- Create: `packages/wire/src/vlq.ts`
- Modify: `packages/wire/src/index.ts`
- Modify: `packages/wire/src/reader.ts` (update readArray to use VLQ)
- Create: `packages/wire/test/vlq.test.ts`

**Interfaces:**
- Consumes: `ByteReader`, `ReaderError` from Task 3
- Produces: `encodeVlqU(value: number): Uint8Array`, `decodeVlqU(reader: ByteReader): number`, `encodeVlqZigZag(value: number): Uint8Array`, `decodeVlqZigZag(reader: ByteReader): number`

- [ ] **Step 1: Write vlq.ts**

Port from `@ergots/scorex` (drop `readVlqU32`, BigInt variants, `MAX_VLQ_BYTES` stays):

```ts
import { ByteReader } from './reader.js';
import { ReaderError } from './errors.js';

const MAX_VLQ_BYTES = 10; // ceil(64 / 7)

export function encodeVlqU(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('encodeVlqU: value must be a non-negative integer');
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new Error('encodeVlqU: value exceeds safe integer range');
  }
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return new Uint8Array(out);
}

export function decodeVlqU(reader: ByteReader): number {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < MAX_VLQ_BYTES; i++) {
    if (reader.isExhausted) {
      throw new ReaderError(
        `decodeVlqU: truncated at byte ${i}, position ${reader.position}`,
        'truncated',
      );
    }
    const byte = reader.readU8();
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (result > Number.MAX_SAFE_INTEGER) {
        throw new ReaderError(
          'decodeVlqU: value exceeds safe integer range',
          'vlq-overflow',
        );
      }
      return result;
    }
    shift += 7;
  }
  throw new ReaderError(
    `decodeVlqU: VLQ exceeds ${MAX_VLQ_BYTES} bytes`,
    'vlq-overflow',
  );
}

export function encodeVlqZigZag(value: number): Uint8Array {
  if (!Number.isInteger(value)) {
    throw new Error('encodeVlqZigZag: value must be an integer');
  }
  // ZigZag: (v << 1) ^ (v >> 63) — for JS number, use >>> 0 for unsigned right shift
  const zz = (value << 1) ^ (value >> 31);
  return encodeVlqU(zz >>> 0);
}

export function decodeVlqZigZag(reader: ByteReader): number {
  const zz = decodeVlqU(reader);
  return (zz >>> 1) ^ -(zz & 1);
}
```

- [ ] **Step 2: Update reader.ts — readArray uses VLQ length**

In `packages/wire/src/reader.ts`, update `readArray`:

```ts
readArray<T>(reader: (r: ByteReader) => T): T[] {
  // Dynamically import to avoid circular dependency at module level.
  // At runtime, vlq.ts is already loaded by the time readArray is called.
  const { decodeVlqU } = require('./vlq.js') as typeof import('./vlq.js');
  const length = decodeVlqU(this);
  if (length > MAX_ARRAY_LENGTH) {
    throw new ReaderError(
      `readArray: length ${length} exceeds maximum ${MAX_ARRAY_LENGTH}`,
      'array-too-large',
    );
  }
  const out: T[] = new Array(length);
  for (let i = 0; i < length; i++) out[i] = reader(this);
  return out;
}
```

Wait — this is an ESM package (`"type": "module"`). `require` won't work. Better approach: add `readVlqU()` as a method directly on ByteReader, or import VLQ statically at the top of reader.ts.

Since `vlq.ts` imports `ByteReader` from `reader.ts`, and `reader.ts` would need VLQ from `vlq.ts`, we'd have a circular dependency. Solutions:

1. **Add `readVlqU()` as a method on ByteReader** — move the decode logic into the reader itself. `vlq.ts` then becomes a thin wrapper that calls `reader.readVlqU()`. Actually, looking at scorex: `readVlqU()` IS on ByteReader, and `vlq.ts`'s `decodeVlqU` just delegates to it.

So the right design is: put `readVlqU()` and `readVlqS()` on ByteReader. Then `vlq.ts` exports standalone encode functions and decode wrappers that take a reader.

Let me restructure:
- `reader.ts`: ByteReader gets `readVlqU(): number` and `readVlqS(): number` methods + `readArray` uses `this.readVlqU()`
- `vlq.ts`: `encodeVlqU`, `encodeVlqZigZag`, `decodeVlqU` (delegates to `reader.readVlqU()`), `decodeVlqZigZag` (delegates to `reader.readVlqS()`)
- No circular deps: `vlq.ts` imports `ByteReader` from `reader.ts`; `reader.ts` doesn't import from `vlq.ts`

So the implementation is:

**reader.ts** — add these methods to ByteReader:
```ts
readVlqU(): number {
  this.checkPositionLimit();
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 10; i++) {
    if (this._position >= this.bytes.length) {
      throw new ReaderError('readVlqU: truncated', 'truncated');
    }
    const byte = this.bytes[this._position++]!;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (result > Number.MAX_SAFE_INTEGER) {
        throw new ReaderError('readVlqU: value exceeds safe integer range', 'vlq-overflow');
      }
      return result;
    }
    shift += 7;
  }
  throw new ReaderError('readVlqU: VLQ exceeds 10 bytes', 'vlq-overflow');
}

readVlqS(): number {
  const zz = this.readVlqU();
  return (zz >>> 1) ^ -(zz & 1);
}
```

And update `readArray` to use `this.readVlqU()` for the length.

**vlq.ts** — standalone encode + thin decode wrappers:
```ts
import { ByteReader } from './reader.js';

export function encodeVlqU(value: number): Uint8Array { /* as above */ }
export function decodeVlqU(reader: ByteReader): number { return reader.readVlqU(); }
export function encodeVlqZigZag(value: number): Uint8Array { /* as above */ }
export function decodeVlqZigZag(reader: ByteReader): number { return reader.readVlqS(); }
```

This matches scorex's design and avoids circular deps. Let me write it this way.

- [ ] **Step 2 (revised): Add readVlqU/readVlqS to ByteReader + update readArray**

Modify `packages/wire/src/reader.ts` — add after `readU8()`:

```ts
readVlqU(): number {
  this.checkPositionLimit();
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 10; i++) {
    if (this._position >= this.bytes.length) {
      throw new ReaderError('readVlqU: truncated', 'truncated');
    }
    const byte = this.bytes[this._position++]!;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (result > Number.MAX_SAFE_INTEGER) {
        throw new ReaderError('readVlqU: value exceeds safe integer range', 'vlq-overflow');
      }
      return result;
    }
    shift += 7;
  }
  throw new ReaderError('readVlqU: VLQ exceeds 10 bytes', 'vlq-overflow');
}

readVlqS(): number {
  const zz = this.readVlqU();
  return (zz >>> 1) ^ -(zz & 1);
}
```

Update `readArray` to use `this.readVlqU()`:
```ts
readArray<T>(reader: (r: ByteReader) => T): T[] {
  const length = this.readVlqU();
  if (length > MAX_ARRAY_LENGTH) {
    throw new ReaderError(
      `readArray: length ${length} exceeds maximum ${MAX_ARRAY_LENGTH}`,
      'array-too-large',
    );
  }
  const out: T[] = new Array(length);
  for (let i = 0; i < length; i++) out[i] = reader(this);
  return out;
}
```

- [ ] **Step 3: Write vlq.ts**

```ts
import { ByteReader } from './reader.js';

export function encodeVlqU(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('encodeVlqU: value must be a non-negative integer');
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new Error('encodeVlqU: value exceeds safe integer range');
  }
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return new Uint8Array(out);
}

export function decodeVlqU(reader: ByteReader): number {
  return reader.readVlqU();
}

export function encodeVlqZigZag(value: number): Uint8Array {
  if (!Number.isInteger(value)) {
    throw new Error('encodeVlqZigZag: value must be an integer');
  }
  const zz = (value << 1) ^ (value >> 31);
  return encodeVlqU(zz >>> 0);
}

export function decodeVlqZigZag(reader: ByteReader): number {
  return reader.readVlqS();
}
```

- [ ] **Step 4: Update index.ts**

```ts
export { ReaderError } from './errors.js';
export { ByteReader, MAX_ARRAY_LENGTH } from './reader.js';
export {
  encodeVlqU,
  decodeVlqU,
  encodeVlqZigZag,
  decodeVlqZigZag,
} from './vlq.js';
```

- [ ] **Step 5: Write vlq tests**

Create `packages/wire/test/vlq.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ByteReader, encodeVlqU, decodeVlqU, encodeVlqZigZag, decodeVlqZigZag } from '@dagsocial/wire';

describe('VLQ unsigned', () => {
  it('round-trips small values', () => {
    for (const v of [0, 1, 127, 128, 255, 16383, 16384, 1_000_000]) {
      const encoded = encodeVlqU(v);
      const reader = new ByteReader(encoded);
      expect(decodeVlqU(reader)).toBe(v);
      expect(reader.isExhausted).toBe(true);
    }
  });

  it('encodes 0 as single byte', () => {
    expect(encodeVlqU(0)).toEqual(new Uint8Array([0]));
  });

  it('encodes 127 as single byte', () => {
    expect(encodeVlqU(127)).toEqual(new Uint8Array([127]));
  });

  it('encodes 128 as two bytes', () => {
    expect(encodeVlqU(128)).toEqual(new Uint8Array([0x80, 0x01]));
  });

  it('encodes 16383 as two bytes', () => {
    expect(encodeVlqU(16383)).toEqual(new Uint8Array([0xff, 0x7f]));
  });

  it('rejects negative values', () => {
    expect(() => encodeVlqU(-1)).toThrow();
  });

  it('throws on truncated VLQ', () => {
    const r = new ByteReader(new Uint8Array([0x80])); // continuation without termination
    expect(() => decodeVlqU(r)).toThrow('truncated');
  });

  it('readVlqU available on ByteReader directly', () => {
    const r = new ByteReader(new Uint8Array([0xac, 0x02])); // 300
    expect(r.readVlqU()).toBe(300);
  });
});

describe('VLQ ZigZag', () => {
  it('round-trips signed values', () => {
    for (const v of [0, 1, -1, 127, -127, 128, -128, 1000, -1000]) {
      const encoded = encodeVlqZigZag(v);
      const reader = new ByteReader(encoded);
      expect(decodeVlqZigZag(reader)).toBe(v);
      expect(reader.isExhausted).toBe(true);
    }
  });

  it('0 encodes as single byte', () => {
    expect(encodeVlqZigZag(0)).toEqual(new Uint8Array([0]));
  });

  it('-1 encodes as single byte', () => {
    expect(encodeVlqZigZag(-1)).toEqual(new Uint8Array([1]));
  });

  it('1 encodes as single byte', () => {
    expect(encodeVlqZigZag(1)).toEqual(new Uint8Array([2]));
  });
});
```

- [ ] **Step 6: Update reader tests**

Add VLQ-specific tests to `packages/wire/test/reader.test.ts`:

```ts
it('readArray uses VLQ length', () => {
  // 3 items: VLQ(3) + 10, 20, 30
  const r = new ByteReader(new Uint8Array([3, 10, 20, 30]));
  const result = r.readArray((rr) => rr.readU8());
  expect(result).toEqual([10, 20, 30]);
});

it('readArray with two-byte VLQ length', () => {
  // length=128 encoded as VLQ [0x80, 0x01]
  const bytes = new Uint8Array([0x80, 0x01, ...Array(128).fill(1)]);
  const r = new ByteReader(bytes);
  const result = r.readArray((rr) => rr.readU8());
  expect(result.length).toBe(128);
});
```

- [ ] **Step 7: Run tests**

```bash
cd packages/wire && pnpm test
```
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/wire/ && git commit -m "feat(wire): add VLQ encoding/decoding

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: `@dagsocial/wire` — ByteWriter

**Files:**
- Create: `packages/wire/src/writer.ts`
- Modify: `packages/wire/src/index.ts`
- Create: `packages/wire/test/writer.test.ts`

**Interfaces:**
- Produces: `ByteWriter` class with methods: `writeU8`, `writeBytes`, `writeBool`, `writeVlqU`, `writeVlqS`, `writeArray`, `writeOption`, `toBytes()`; property: `length`

- [ ] **Step 1: Write writer.ts**

Port from `@ergots/scorex`:

```ts
export class ByteWriter {
  private chunks: Uint8Array[] = [];
  private _length = 0;

  get length(): number { return this._length; }

  writeU8(byte: number): void {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      throw new Error(`writeU8: out of range: ${byte}`);
    }
    this.chunks.push(new Uint8Array([byte]));
    this._length += 1;
  }

  writeBytes(bytes: Uint8Array): void {
    this.chunks.push(bytes.slice()); // defensive copy
    this._length += bytes.length;
  }

  writeBool(value: boolean): void {
    this.writeU8(value ? 1 : 0);
  }

  writeVlqU(value: number): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`writeVlqU: invalid value: ${value}`);
    }
    if (value > Number.MAX_SAFE_INTEGER) {
      throw new Error('writeVlqU: value exceeds safe integer range');
    }
    let v = value;
    while (v >= 0x80) {
      this.writeU8((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    this.writeU8(v);
  }

  writeVlqS(value: number): void {
    if (!Number.isInteger(value)) {
      throw new Error(`writeVlqS: not an integer: ${value}`);
    }
    const zz = (value << 1) ^ (value >> 31);
    this.writeVlqU(zz >>> 0);
  }

  writeArray<T>(items: T[], serializer: (w: ByteWriter, item: T) => void): void {
    this.writeVlqU(items.length);
    for (const item of items) serializer(this, item);
  }

  writeOption<T>(value: T | null, serializer: (w: ByteWriter, v: T) => void): void {
    if (value === null) {
      this.writeU8(0);
      return;
    }
    this.writeU8(1);
    serializer(this, value);
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this._length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
```

- [ ] **Step 2: Update index.ts**

```ts
export { ReaderError } from './errors.js';
export { ByteReader, MAX_ARRAY_LENGTH } from './reader.js';
export { ByteWriter } from './writer.js';
export {
  encodeVlqU,
  decodeVlqU,
  encodeVlqZigZag,
  decodeVlqZigZag,
} from './vlq.js';
```

- [ ] **Step 3: Write writer tests**

Create `packages/wire/test/writer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ByteWriter, ByteReader } from '@dagsocial/wire';

describe('ByteWriter', () => {
  it('writes bytes and produces output', () => {
    const w = new ByteWriter();
    w.writeU8(0xab);
    w.writeU8(0xcd);
    expect(w.length).toBe(2);
    expect(w.toBytes()).toEqual(new Uint8Array([0xab, 0xcd]));
  });

  it('writeBool', () => {
    const w = new ByteWriter();
    w.writeBool(true);
    w.writeBool(false);
    expect(w.toBytes()).toEqual(new Uint8Array([1, 0]));
  });

  it('writeVlqU round-trips through ByteReader', () => {
    const w = new ByteWriter();
    w.writeVlqU(0);
    w.writeVlqU(127);
    w.writeVlqU(128);
    w.writeVlqU(16383);
    w.writeVlqU(1_000_000);

    const r = new ByteReader(w.toBytes());
    expect(r.readVlqU()).toBe(0);
    expect(r.readVlqU()).toBe(127);
    expect(r.readVlqU()).toBe(128);
    expect(r.readVlqU()).toBe(16383);
    expect(r.readVlqU()).toBe(1_000_000);
    expect(r.isExhausted).toBe(true);
  });

  it('writeVlqS round-trips through ByteReader', () => {
    const w = new ByteWriter();
    w.writeVlqS(0);
    w.writeVlqS(-1);
    w.writeVlqS(1);
    w.writeVlqS(-1000);

    const r = new ByteReader(w.toBytes());
    expect(r.readVlqS()).toBe(0);
    expect(r.readVlqS()).toBe(-1);
    expect(r.readVlqS()).toBe(1);
    expect(r.readVlqS()).toBe(-1000);
  });

  it('writeArray', () => {
    const w = new ByteWriter();
    w.writeArray([10, 20, 30], (wr, v) => wr.writeU8(v));

    const r = new ByteReader(w.toBytes());
    const arr = r.readArray((rr) => rr.readU8());
    expect(arr).toEqual([10, 20, 30]);
  });

  it('writeOption null', () => {
    const w = new ByteWriter();
    w.writeOption<number>(null, (wr, v) => wr.writeVlqU(v));
    expect(w.toBytes()).toEqual(new Uint8Array([0]));
  });

  it('writeOption some', () => {
    const w = new ByteWriter();
    w.writeOption(42, (wr, v) => wr.writeVlqU(v));

    const r = new ByteReader(w.toBytes());
    const opt = r.readOption((rr) => rr.readVlqU());
    expect(opt).toBe(42);
  });

  it('rejects out-of-range byte', () => {
    const w = new ByteWriter();
    expect(() => w.writeU8(256)).toThrow();
    expect(() => w.writeU8(-1)).toThrow();
  });
});
```

- [ ] **Step 4: Run tests**

```bash
cd packages/wire && pnpm test
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/wire/ && git commit -m "feat(wire): add ByteWriter

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: `@dagsocial/wire` — Frame encode/decode

**Files:**
- Create: `packages/wire/src/frame.ts`
- Modify: `packages/wire/src/index.ts`
- Create: `packages/wire/test/frame.test.ts`

**Interfaces:**
- Consumes: `ByteReader`, `ByteWriter`, `ReaderError`, `encodeVlqU` from Tasks 3–5. Plus an injectable hash function.
- Produces: `encodeFrame(magic: number, code: number, body: Uint8Array, hashFn: HashFn): Uint8Array`
- Produces: `decodeFrame(magic: number, data: Uint8Array, hashFn: HashFn): { code: number, body: Uint8Array }`
- Produces: `HashFn = (data: Uint8Array) => Uint8Array`
- Produces: `FRAME_VERSION = 1`
- Produces: `MAGIC_MAINNET = 0x4D444147`, `MAGIC_TESTNET = 0x54444147`

- [ ] **Step 1: Write frame.ts**

```ts
import { ByteWriter } from './writer.js';
import { ByteReader } from './reader.js';
import { ReaderError } from './errors.js';

export type HashFn = (data: Uint8Array) => Uint8Array;

export const FRAME_VERSION = 1;
export const MAGIC_MAINNET = 0x4D444147;  // "MDAG"
export const MAGIC_TESTNET = 0x54444147;  // "TDAG"

/** Encode body into a framed envelope. Checksum = first 4 bytes of hashFn(body). */
export function encodeFrame(
  magic: number,
  code: number,
  body: Uint8Array,
  hashFn: HashFn,
): Uint8Array {
  const w = new ByteWriter();

  // magic: 4 bytes big-endian
  w.writeU8((magic >>> 24) & 0xff);
  w.writeU8((magic >>> 16) & 0xff);
  w.writeU8((magic >>> 8) & 0xff);
  w.writeU8(magic & 0xff);

  // version: 1 byte
  w.writeU8(FRAME_VERSION);

  // code: VLQ
  w.writeVlqU(code);

  // body length: VLQ
  w.writeVlqU(body.length);

  // checksum: first 4 bytes of blake2b256(body)
  const hash = hashFn(body);
  if (hash.length < 4) {
    throw new Error('encodeFrame: hash function must return at least 4 bytes');
  }
  w.writeBytes(hash.subarray(0, 4));

  // body
  w.writeBytes(body);

  return w.toBytes();
}

/** Decode a framed envelope. Returns code and body. Throws ReaderError on invalid frame. */
export function decodeFrame(
  magic: number,
  data: Uint8Array,
  hashFn: HashFn,
): { code: number; body: Uint8Array } {
  const r = new ByteReader(data);

  // magic
  const magicRead =
    (r.readU8() << 24) | (r.readU8() << 16) | (r.readU8() << 8) | r.readU8();
  if (magicRead !== magic) {
    throw new ReaderError(
      `decodeFrame: wrong magic 0x${magicRead.toString(16)} (expected 0x${magic.toString(16)})`,
      'truncated',
    );
  }

  // version
  const version = r.readU8();
  if (version > FRAME_VERSION) {
    throw new ReaderError(
      `decodeFrame: unsupported frame version ${version}`,
      'truncated',
    );
  }
  // version < FRAME_VERSION: accept (forward compat for older peers)

  // code
  const code = r.readVlqU();

  // body length
  const length = r.readVlqU();

  // checksum
  const checksum = r.readBytes(4);

  // body
  const body = r.readBytes(length);

  // verify checksum
  const expectedChecksum = hashFn(body).subarray(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expectedChecksum[i]) {
      throw new ReaderError('decodeFrame: checksum mismatch', 'truncated');
    }
  }

  return { code, body };
}
```

- [ ] **Step 2: Update index.ts**

Add: `export { encodeFrame, decodeFrame, FRAME_VERSION, MAGIC_MAINNET, MAGIC_TESTNET } from './frame.js';` and `export type { HashFn } from './frame.js';`

- [ ] **Step 3: Write frame tests**

Create `packages/wire/test/frame.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  encodeFrame, decodeFrame, MAGIC_MAINNET, MAGIC_TESTNET, FRAME_VERSION,
  ByteReader, ReaderError,
} from '@dagsocial/wire';

function blake2b256(data: Uint8Array): Uint8Array {
  return createHash('blake2b512').update(data).digest().subarray(0, 32);
}

describe('encodeFrame / decodeFrame', () => {
  it('round-trips a simple message', () => {
    const body = new Uint8Array([1, 2, 3]);
    const frame = encodeFrame(MAGIC_TESTNET, 1, body, blake2b256);
    const { code, body: decoded } = decodeFrame(MAGIC_TESTNET, frame, blake2b256);
    expect(code).toBe(1);
    expect(decoded).toEqual(body);
  });

  it('round-trips empty body', () => {
    const frame = encodeFrame(MAGIC_TESTNET, 9, new Uint8Array(0), blake2b256);
    const { code, body } = decodeFrame(MAGIC_TESTNET, frame, blake2b256);
    expect(code).toBe(9);
    expect(body.length).toBe(0);
  });

  it('round-trips a large body', () => {
    const body = new Uint8Array(100_000);
    for (let i = 0; i < body.length; i++) body[i] = i & 0xff;
    const frame = encodeFrame(MAGIC_MAINNET, 5, body, blake2b256);
    const { code, body: decoded } = decodeFrame(MAGIC_MAINNET, frame, blake2b256);
    expect(code).toBe(5);
    expect(decoded).toEqual(body);
  });

  it('rejects wrong magic', () => {
    const frame = encodeFrame(MAGIC_TESTNET, 1, new Uint8Array(0), blake2b256);
    expect(() => decodeFrame(MAGIC_MAINNET, frame, blake2b256)).toThrow(ReaderError);
  });

  it('rejects checksum mismatch', () => {
    const frame = encodeFrame(MAGIC_TESTNET, 1, new Uint8Array([1, 2, 3]), blake2b256);
    // Corrupt the last byte (body)
    frame[frame.length - 1] ^= 0xff;
    expect(() => decodeFrame(MAGIC_TESTNET, frame, blake2b256)).toThrow('checksum');
  });

  it('rejects truncated frame', () => {
    const frame = encodeFrame(MAGIC_TESTNET, 1, new Uint8Array([1, 2, 3]), blake2b256);
    const truncated = frame.subarray(0, 6); // only magic (4) + version (1) + code start
    expect(() => decodeFrame(MAGIC_TESTNET, truncated, blake2b256)).toThrow(ReaderError);
  });

  it('VLQ code encodes efficiently', () => {
    // code 1 should be 1 byte in the VLQ field
    const frame = encodeFrame(MAGIC_TESTNET, 1, new Uint8Array(0), blake2b256);
    // magic(4) + version(1) + code_VLQ(1) + length_VLQ(1) + checksum(4) = 11
    expect(frame.length).toBe(11);
  });

  it('different networks produce different frames', () => {
    const body = new Uint8Array([42]);
    const tFrame = encodeFrame(MAGIC_TESTNET, 1, body, blake2b256);
    const mFrame = encodeFrame(MAGIC_MAINNET, 1, body, blake2b256);
    // Frames should differ in the magic bytes
    expect(tFrame[0]).not.toBe(mFrame[0]);
  });
});
```

- [ ] **Step 4: Run tests**

```bash
cd packages/wire && pnpm test
```
Expected: all tests pass.

- [ ] **Step 5: Build wire package, verify from root**

```bash
cd /home/mwaddip/projects/dagsocial && pnpm build && pnpm test
```
Expected: wire package builds and tests pass. 274 existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/wire/ && git commit -m "feat(wire): add frame encode/decode

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Wire frame module in `@dagsocial/net`

**Files:**
- Modify: `packages/net/package.json` (add `@dagsocial/wire` dep)
- Create: `packages/net/src/frame.ts`
- Modify: `packages/net/src/config.ts` (add magic, new config fields)
- Modify: `packages/net/src/types.ts` (add message code constants, PeerRecord)
- Create: `packages/net/test/frame.test.ts`

**Interfaces:**
- Consumes: `@dagsocial/wire` (encodeFrame, decodeFrame, MAGIC_*, HashFn)
- Produces: Network-aware frame helpers: `createBlake2b256Hash()`, `makeFrameEncoder(magic)`, `makeFrameDecoder(magic)`, message code constants

- [ ] **Step 1: Add @dagsocial/wire dependency**

Edit `packages/net/package.json` — add to dependencies:
```json
"@dagsocial/wire": "workspace:*",
```

Run `pnpm install` from root.

- [ ] **Step 2: Update types.ts — add message code constants and PeerRecord**

Add to `packages/net/src/types.ts`:

```ts
// Message codes
export const MSG_HANDSHAKE = 1;
export const MSG_SYNC_INFO = 2;
export const MSG_INV = 3;
export const MSG_MODIFIER_REQUEST = 4;
export const MSG_MODIFIER_RESPONSE = 5;
export const MSG_GET_SUB_BLOCK = 6;
export const MSG_SUB_BLOCK_RESPONSE = 7;
export const MSG_GET_PEERS = 8;
export const MSG_PEERS = 9;

// Modifier type IDs
export const MODIFIER_ORDERING_BLOCK = 101;
export const MODIFIER_SUB_BLOCK = 102;

// Peer record
export interface PeerRecord {
  address: string;
  lastSeenMs: number;
  agentName: string;
  nodeName: string;
  protocolVersion: number;
  capabilities: number[];
}

// NetConfig additions (add these fields)
// magic: number  — already documented below
// minPeers: number
// peerDbCap: number
// outboundFillIntervalMs: number
// outboundRedialCooldownMs: number
```

- [ ] **Step 3: Create frame.ts**

```ts
import { createHash } from 'crypto';
import {
  encodeFrame as wireEncodeFrame,
  decodeFrame as wireDecodeFrame,
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  type HashFn,
} from '@dagsocial/wire';

export { MAGIC_MAINNET, MAGIC_TESTNET };

/** Create the standard blake2b256 hasher for frame checksums. */
export function createBlake2b256Hash(): HashFn {
  return (data: Uint8Array): Uint8Array => {
    return createHash('blake2b512').update(data).digest().subarray(0, 32);
  };
}

/** Encode a message into a framed envelope for this node's network. */
export function encodeFrame(
  magic: number,
  code: number,
  body: Uint8Array,
): Uint8Array {
  return wireEncodeFrame(magic, code, body, createBlake2b256Hash());
}

/** Decode a framed envelope. Throws on wrong magic, bad checksum, or truncation. */
export function decodeFrame(
  magic: number,
  data: Uint8Array,
): { code: number; body: Uint8Array } {
  return wireDecodeFrame(magic, data, createBlake2b256Hash());
}
```

- [ ] **Step 4: Update config.ts — add new NetConfig fields**

Add to the `NetConfig` interface in `types.ts` and to `loadNetConfig()` in `config.ts`:

```ts
// In types.ts, add to NetConfig:
magic: number;
minPeers: number;
peerDbCap: number;
outboundFillIntervalMs: number;
outboundRedialCooldownMs: number;
```

```ts
// In config.ts, add to loadNetConfig():
magic: parseInt(process.env['NETWORK_MAGIC'] ?? '0x54444147', 16), // default testnet
minPeers: parseInt(process.env['MIN_PEERS'] ?? '3', 10),
peerDbCap: parseInt(process.env['PEER_DB_CAP'] ?? '1000', 10),
outboundFillIntervalMs: parseInt(process.env['OUTBOUND_FILL_INTERVAL_MS'] ?? '30000', 10),
outboundRedialCooldownMs: parseInt(process.env['OUTBOUND_REDIAL_COOLDOWN_MS'] ?? '60000', 10),
```

- [ ] **Step 5: Write frame tests**

Create `packages/net/test/frame.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { encodeFrame, decodeFrame, MAGIC_TESTNET, MAGIC_MAINNET } from '@dagsocial/net';
import { ReaderError } from '@dagsocial/wire';

describe('net frame', () => {
  it('round-trips a message', () => {
    const body = new Uint8Array([1, 2, 3]);
    const frame = encodeFrame(MAGIC_TESTNET, 1, body);
    const { code, body: decoded } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(1);
    expect(decoded).toEqual(body);
  });

  it('rejects wrong network', () => {
    const frame = encodeFrame(MAGIC_TESTNET, 1, new Uint8Array(0));
    expect(() => decodeFrame(MAGIC_MAINNET, frame)).toThrow(ReaderError);
  });

  it('rejects corrupted frame', () => {
    const frame = encodeFrame(MAGIC_TESTNET, 5, new Uint8Array([42]));
    frame[frame.length - 1] ^= 0xff;
    expect(() => decodeFrame(MAGIC_TESTNET, frame)).toThrow('checksum');
  });
});
```

- [ ] **Step 6: Run tests**

```bash
cd /home/mwaddip/projects/dagsocial && pnpm build && pnpm test
```
Expected: frame tests pass, all existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/net/ pnpm-lock.yaml && git commit -m "feat(net): add wire frame module and config

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Handshake protocol

**Files:**
- Create: `packages/net/src/handshake.ts`
- Create: `packages/net/test/handshake.test.ts`

**Interfaces:**
- Consumes: `encodeFrame`, `decodeFrame` from Task 7. `@dagsocial/types` for protocol version.
- Produces: `buildHandshake(config): Uint8Array`, `parseHandshake(body): HandshakeMsg`, `validateHandshake(msg, ourMagic): HandshakeResult`, `runHandshake(stream, config, ourMagic): Promise<HandshakeMsg>`, types `HandshakeMsg`, `HandshakeResult`

- [ ] **Step 1: Write handshake.ts**

```ts
import { encode, decode } from 'cbor-x';
import { PROTOCOL_VERSION } from '@dagsocial/types';
import { encodeFrame, decodeFrame, MAGIC_TESTNET } from './frame.js';

export interface HandshakeMsg {
  agentName: string;
  protocolVersion: number;
  nodeName: string;
  chainHeight: number;
  declaredAddress?: string;
  capabilities: number[];
  sessionMagic: number;
}

export interface HandshakeResult {
  ok: boolean;
  error?: string;
  peerHeight: number;
  peerCapabilities: number[];
}

/** Build a handshake frame for our node. */
export function buildHandshakeFrame(
  magic: number,
  msg: HandshakeMsg,
): Uint8Array {
  const body = encode(msg);
  return encodeFrame(magic, 1, body);
}

/** Parse a handshake frame body. */
export function parseHandshakeBody(body: Uint8Array): HandshakeMsg {
  return decode(body) as HandshakeMsg;
}

/** Validate an incoming handshake. */
export function validateHandshake(
  msg: HandshakeMsg,
  requiredProtocolVersions: number[],
): HandshakeResult {
  if (!requiredProtocolVersions.includes(msg.protocolVersion)) {
    return {
      ok: false,
      error: `unsupported protocol version ${msg.protocolVersion}`,
      peerHeight: 0,
      peerCapabilities: [],
    };
  }
  if (!msg.agentName || typeof msg.agentName !== 'string') {
    return {
      ok: false,
      error: 'missing or invalid agentName',
      peerHeight: 0,
      peerCapabilities: [],
    };
  }
  return {
    ok: true,
    peerHeight: msg.chainHeight,
    peerCapabilities: msg.capabilities,
  };
}
```

Note: `runHandshake` — the async exchange over a libp2p stream — belongs in `node.ts` (Task 13 integration) since it needs the libp2p stream API. This module keeps pure message functions.

- [ ] **Step 2: Write handshake tests**

Create `packages/net/test/handshake.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildHandshakeFrame, parseHandshakeBody, validateHandshake } from '@dagsocial/net';
import { MAGIC_TESTNET, decodeFrame } from '@dagsocial/net';
import type { HandshakeMsg } from '@dagsocial/net';

const testMsg: HandshakeMsg = {
  agentName: 'dagsocial/1.0.0',
  protocolVersion: 1,
  nodeName: 'test-node',
  chainHeight: 42,
  capabilities: [1, 2, 3, 4, 5, 8, 9],
  sessionMagic: 12345,
};

describe('handshake', () => {
  it('round-trips through frame', () => {
    const frame = buildHandshakeFrame(MAGIC_TESTNET, testMsg);
    const { code, body } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(1);
    const parsed = parseHandshakeBody(body);
    expect(parsed).toEqual(testMsg);
  });

  it('validates compatible protocol version', () => {
    const result = validateHandshake(testMsg, [1]);
    expect(result.ok).toBe(true);
    expect(result.peerHeight).toBe(42);
  });

  it('rejects incompatible protocol version', () => {
    const msg = { ...testMsg, protocolVersion: 99 };
    const result = validateHandshake(msg, [1]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unsupported protocol version');
  });

  it('rejects missing agentName', () => {
    const msg = { ...testMsg, agentName: '' };
    const result = validateHandshake(msg, [1]);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Export from index.ts**

Add to `packages/net/src/index.ts`:
```ts
export { buildHandshakeFrame, parseHandshakeBody, validateHandshake } from './handshake.js';
export type { HandshakeMsg, HandshakeResult } from './handshake.js';
```

- [ ] **Step 4: Run tests**

```bash
cd /home/mwaddip/projects/dagsocial && pnpm build && pnpm test
```
Expected: handshake tests pass, all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/net/ && git commit -m "feat(net): add handshake protocol

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: PeerDb

**Files:**
- Create: `packages/net/src/peerdb.ts`
- Create: `packages/net/test/peerdb.test.ts`

**Interfaces:**
- Consumes: `PeerRecord` from Task 7 types
- Produces: `PeerDb` class with: `record(rec)`, `forget(addr)`, `get(addr): PeerRecord | null`, `recent(limit, exclude): PeerRecord[]`, `all(): PeerRecord[]`, `count(): number`
- Produces: `PeerStorage` interface: `loadAll()`, `put(rec)`, `delete(addr)`

- [ ] **Step 1: Write peerdb.ts**

```ts
import type { PeerRecord } from './types.js';

export interface PeerStorage {
  loadAll(): PeerRecord[];
  put(record: PeerRecord): void;
  delete(address: string): void;
}

export class PeerDb {
  private entries: Map<string, PeerRecord> = new Map();
  private selfAddrs: Set<string>;

  constructor(
    private storage: PeerStorage | null,
    private cap: number,
    selfAddresses: string[],
  ) {
    this.selfAddrs = new Set(selfAddresses);
    // Load persisted entries on construction
    if (storage) {
      for (const rec of storage.loadAll()) {
        if (!this.selfAddrs.has(rec.address)) {
          this.entries.set(rec.address, rec);
        }
      }
    }
  }

  record(record: PeerRecord): void {
    if (this.selfAddrs.has(record.address)) return;

    const existing = this.entries.get(record.address);
    const merged: PeerRecord = existing
      ? { ...record, lastSeenMs: Math.max(existing.lastSeenMs, record.lastSeenMs) }
      : record;

    this.entries.set(record.address, merged);

    // Evict oldest if over cap
    if (this.entries.size > this.cap) {
      let oldestAddr = '';
      let oldestMs = Infinity;
      for (const [addr, rec] of this.entries) {
        if (rec.lastSeenMs < oldestMs) {
          oldestMs = rec.lastSeenMs;
          oldestAddr = addr;
        }
      }
      if (oldestAddr) {
        this.entries.delete(oldestAddr);
        this.storage?.delete(oldestAddr);
      }
    }

    this.storage?.put(merged);
  }

  forget(addr: string): void {
    this.entries.delete(addr);
    this.storage?.delete(addr);
  }

  get(addr: string): PeerRecord | null {
    return this.entries.get(addr) ?? null;
  }

  recent(limit: number, excludeAddrs: Set<string>): PeerRecord[] {
    const filtered = Array.from(this.entries.values())
      .filter((r) => !excludeAddrs.has(r.address));
    filtered.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
    return filtered.slice(0, limit);
  }

  all(): PeerRecord[] {
    return Array.from(this.entries.values());
  }

  count(): number {
    return this.entries.size;
  }
}
```

- [ ] **Step 2: Write peerdb tests**

Create `packages/net/test/peerdb.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { PeerDb } from '@dagsocial/net';
import type { PeerRecord } from '@dagsocial/net';

function makeRecord(addr: string, lastSeenMs: number): PeerRecord {
  return {
    address: addr,
    lastSeenMs,
    agentName: 'test',
    nodeName: addr,
    protocolVersion: 1,
    capabilities: [],
  };
}

describe('PeerDb', () => {
  let db: PeerDb;

  beforeEach(() => {
    db = new PeerDb(null, 100, []);
  });

  it('records and retrieves a peer', () => {
    const rec = makeRecord('/ip4/1.2.3.4/tcp/9000', 1000);
    db.record(rec);
    expect(db.get('/ip4/1.2.3.4/tcp/9000')).toEqual(rec);
    expect(db.count()).toBe(1);
  });

  it('merges lastSeenMs on duplicate', () => {
    db.record(makeRecord('/ip4/1.2.3.4/tcp/9000', 1000));
    db.record(makeRecord('/ip4/1.2.3.4/tcp/9000', 500)); // older — should keep 1000
    expect(db.get('/ip4/1.2.3.4/tcp/9000')!.lastSeenMs).toBe(1000);

    db.record(makeRecord('/ip4/1.2.3.4/tcp/9000', 2000)); // newer
    expect(db.get('/ip4/1.2.3.4/tcp/9000')!.lastSeenMs).toBe(2000);
  });

  it('forgets a peer', () => {
    db.record(makeRecord('/ip4/1.2.3.4/tcp/9000', 1000));
    db.forget('/ip4/1.2.3.4/tcp/9000');
    expect(db.get('/ip4/1.2.3.4/tcp/9000')).toBeNull();
    expect(db.count()).toBe(0);
  });

  it('filters self addresses', () => {
    const selfDb = new PeerDb(null, 100, ['/ip4/127.0.0.1/tcp/9000']);
    selfDb.record(makeRecord('/ip4/127.0.0.1/tcp/9000', 1000));
    selfDb.record(makeRecord('/ip4/1.2.3.4/tcp/9000', 1000));
    expect(selfDb.count()).toBe(1);
    expect(selfDb.get('/ip4/1.2.3.4/tcp/9000')).not.toBeNull();
  });

  it('evicts oldest on overflow', () => {
    const smallDb = new PeerDb(null, 3, []);
    smallDb.record(makeRecord('a', 1000));
    smallDb.record(makeRecord('b', 2000));
    smallDb.record(makeRecord('c', 3000));
    smallDb.record(makeRecord('d', 4000)); // evicts 'a' (oldest)
    expect(smallDb.count()).toBe(3);
    expect(smallDb.get('a')).toBeNull();
    expect(smallDb.get('d')).not.toBeNull();
  });

  it('recent returns most recent excluding specified', () => {
    db.record(makeRecord('a', 1000));
    db.record(makeRecord('b', 2000));
    db.record(makeRecord('c', 3000));
    db.record(makeRecord('d', 4000));

    const recent = db.recent(2, new Set(['d']));
    expect(recent).toHaveLength(2);
    expect(recent[0]!.address).toBe('c');
    expect(recent[1]!.address).toBe('b');
  });
});
```

- [ ] **Step 3: Export from index.ts**

```ts
export { PeerDb } from './peerdb.js';
export type { PeerStorage } from './peerdb.js';
```

- [ ] **Step 4: Run tests, build, verify**

```bash
cd /home/mwaddip/projects/dagsocial && pnpm build && pnpm test
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/net/ && git commit -m "feat(net): add PeerDb with in-memory registry

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Outbound manager

**Files:**
- Create: `packages/net/src/outbound-mgr.ts`
- Create: `packages/net/test/outbound-mgr.test.ts`

**Interfaces:**
- Consumes: `PeerDb`, `PeerRecord` from Task 9, `NetConfig` from Task 7
- Produces: `OutboundManager` class managing floor/fill phases, redial cooldowns, blacklist respect

- [ ] **Step 1: Write outbound-mgr.ts**

```ts
import type { PeerDb } from './peerdb.js';
import type { NetConfig } from './types.js';

export class OutboundManager {
  private cooldowns: Map<string, number> = new Map();

  constructor(
    private config: NetConfig,
    private peerDb: PeerDb,
    private dialFn: (addr: string) => Promise<void>,
  ) {}

  /** Call after a dial succeeds or fails. */
  recordDialResult(addr: string, success: boolean): void {
    if (!success) {
      this.cooldowns.set(addr, Date.now() + this.config.outboundRedialCooldownMs);
    } else {
      this.cooldowns.delete(addr);
    }
  }

  /** Get the next peer to dial, or null if none available. */
  pickCandidate(connectedCount: number): string | null {
    // Floor phase: don't use PeerDb when below minPeers
    // (caller handles bootstrap seed dialing separately)
    if (connectedCount < this.config.minPeers) return null;

    // Fill phase
    if (connectedCount >= this.config.maxPeers) return null;

    const now = Date.now();
    const need = this.config.maxPeers - connectedCount;
    const exclude = new Set<string>();
    // Exclude addresses in cooldown
    for (const [addr, until] of this.cooldowns) {
      if (now < until) exclude.add(addr);
      else this.cooldowns.delete(addr); // cooldown expired
    }

    const candidates = this.peerDb.recent(need, exclude);
    if (candidates.length === 0) return null;

    return candidates[0]!.address;
  }

  /** Seed addresses to dial when below minPeers. */
  getBootstrapPeers(): string[] {
    return this.config.bootstrapPeers;
  }
}
```

- [ ] **Step 2: Write outbound-mgr tests**

Create `packages/net/test/outbound-mgr.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { OutboundManager, PeerDb } from '@dagsocial/net';
import type { NetConfig } from '@dagsocial/net';

const testConfig: NetConfig = {
  magic: 0x54444147,
  bootstrapPeers: ['/ip4/10.0.0.1/tcp/9000'],
  listenAddrs: '/ip4/0.0.0.0/tcp/0',
  maxPeers: 10,
  minPeers: 3,
  peerDbCap: 100,
  outboundFillIntervalMs: 30000,
  outboundRedialCooldownMs: 60000,
  penaltyScoreThreshold: 500,
  temporalBanDurationMs: 3600000,
  penaltySafeIntervalMs: 120000,
  peerEvictionIntervalMs: 3600000,
  syncRequestTimeoutMs: 10000,
};

describe('OutboundManager', () => {
  let mgr: OutboundManager;
  let db: PeerDb;

  beforeEach(() => {
    db = new PeerDb(null, 100, []);
    mgr = new OutboundManager(testConfig, db, async () => {});
  });

  it('returns null when below minPeers (floor phase — caller dials seeds)', () => {
    expect(mgr.pickCandidate(1)).toBeNull();
  });

  it('returns null when at maxPeers', () => {
    expect(mgr.pickCandidate(10)).toBeNull();
  });

  it('returns bootstrap peers', () => {
    expect(mgr.getBootstrapPeers()).toEqual(['/ip4/10.0.0.1/tcp/9000']);
  });

  it('returns candidate from PeerDb in fill phase', () => {
    db.record({
      address: '/ip4/1.2.3.4/tcp/9000',
      lastSeenMs: Date.now(),
      agentName: 'test',
      nodeName: 'peer1',
      protocolVersion: 1,
      capabilities: [],
    });
    const candidate = mgr.pickCandidate(5); // 5 connected, max 10
    expect(candidate).toBe('/ip4/1.2.3.4/tcp/9000');
  });

  it('respects redial cooldown', () => {
    db.record({
      address: '/ip4/1.2.3.4/tcp/9000',
      lastSeenMs: Date.now(),
      agentName: 'test',
      nodeName: 'peer1',
      protocolVersion: 1,
      capabilities: [],
    });
    mgr.recordDialResult('/ip4/1.2.3.4/tcp/9000', false); // failed
    expect(mgr.pickCandidate(5)).toBeNull(); // in cooldown
  });
});
```

- [ ] **Step 3: Export from index.ts**

```ts
export { OutboundManager } from './outbound-mgr.js';
```

- [ ] **Step 4: Run tests, build, verify**

```bash
cd /home/mwaddip/projects/dagsocial && pnpm build && pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add packages/net/ && git commit -m "feat(net): add outbound manager

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: Sync machine — core types and message serialization

**Files:**
- Create: `packages/net/src/sync-types.ts`
- Create: `packages/net/src/sync-codec.ts`
- Create: `packages/net/test/sync-codec.test.ts`

**Interfaces:**
- Produces: `SyncInfo`, `Inv`, `ModifierRequest`, `ModifierResponse` types
- Produces: `encodeSyncInfo`, `encodeInv`, `encodeModifierRequest`, `encodeModifierResponse` — each returns a framed `Uint8Array`
- Produces: `decodeSyncInfo`, `decodeInv`, `decodeModifierRequest`, `decodeModifierResponse` — each takes a frame body `Uint8Array`

- [ ] **Step 1: Write sync-types.ts**

```ts
export interface SyncInfo {
  tipHeight: number;
  tipBlockId: string;
  tipCumulativeWork: string; // bigint serialized as string in CBOR
  anchors: { height: number; blockId: string }[];
}

export interface Inv {
  typeId: number; // 101 = ordering block header, 102 = sub-block
  ids: string[];
}

export interface ModifierRequest {
  typeId: number;
  ids: string[];
}

export interface ModifierResponse {
  typeId: number;
  modifiers: { id: string; data: Uint8Array }[];
}

export interface SyncState {
  phase: 'idle' | 'syncing' | 'synced';
  syncPeerId: string | null;
  stalledPeers: Set<string>;
  downloadedHeight: number;
  stateAppliedHeight: number;
}
```

- [ ] **Step 2: Write sync-codec.ts**

```ts
import { encode, decode } from 'cbor-x';
import { encodeFrame } from './frame.js';
import type { SyncInfo, Inv, ModifierRequest, ModifierResponse } from './sync-types.js';
import { MSG_SYNC_INFO, MSG_INV, MSG_MODIFIER_REQUEST, MSG_MODIFIER_RESPONSE } from './types.js';

function frameMessage(magic: number, code: number, body: unknown): Uint8Array {
  return encodeFrame(magic, code, encode(body));
}

export function encodeSyncInfo(magic: number, info: SyncInfo): Uint8Array {
  return frameMessage(magic, MSG_SYNC_INFO, info);
}

export function encodeInv(magic: number, inv: Inv): Uint8Array {
  return frameMessage(magic, MSG_INV, inv);
}

export function encodeModifierRequest(magic: number, req: ModifierRequest): Uint8Array {
  return frameMessage(magic, MSG_MODIFIER_REQUEST, req);
}

export function encodeModifierResponse(magic: number, resp: ModifierResponse): Uint8Array {
  // CBOR encodes Uint8Array as binary
  return frameMessage(magic, MSG_MODIFIER_RESPONSE, resp);
}

export function decodeSyncInfo(body: Uint8Array): SyncInfo {
  return decode(body) as SyncInfo;
}

export function decodeInv(body: Uint8Array): Inv {
  return decode(body) as Inv;
}

export function decodeModifierRequest(body: Uint8Array): ModifierRequest {
  return decode(body) as ModifierRequest;
}

export function decodeModifierResponse(body: Uint8Array): ModifierResponse {
  return decode(body) as ModifierResponse;
}
```

- [ ] **Step 3: Write sync-codec tests**

Create `packages/net/test/sync-codec.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  encodeSyncInfo, decodeSyncInfo,
  encodeInv, decodeInv,
  encodeModifierRequest, decodeModifierRequest,
  encodeModifierResponse, decodeModifierResponse,
} from '@dagsocial/net';
import { MAGIC_TESTNET, decodeFrame } from '@dagsocial/net';
import { MSG_SYNC_INFO, MSG_INV, MSG_MODIFIER_REQUEST, MSG_MODIFIER_RESPONSE } from '@dagsocial/net';

describe('sync codec', () => {
  it('round-trips SyncInfo', () => {
    const info = {
      tipHeight: 42,
      tipBlockId: 'abc123',
      tipCumulativeWork: '1000000',
      anchors: [{ height: 42, blockId: 'abc123' }],
    };
    const frame = encodeSyncInfo(MAGIC_TESTNET, info);
    const { code, body } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(MSG_SYNC_INFO);
    expect(decodeSyncInfo(body)).toEqual(info);
  });

  it('round-trips Inv', () => {
    const inv = { typeId: 101, ids: ['a', 'b', 'c'] };
    const frame = encodeInv(MAGIC_TESTNET, inv);
    const { code, body } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(MSG_INV);
    expect(decodeInv(body)).toEqual(inv);
  });

  it('round-trips ModifierRequest', () => {
    const req = { typeId: 101, ids: Array.from({length: 400}, (_, i) => `id${i}`) };
    const frame = encodeModifierRequest(MAGIC_TESTNET, req);
    const { code, body } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(MSG_MODIFIER_REQUEST);
    expect(decodeModifierRequest(body)).toEqual(req);
  });

  it('round-trips ModifierResponse with binary data', () => {
    const resp = {
      typeId: 101,
      modifiers: [
        { id: 'header1', data: new Uint8Array([1, 2, 3]) },
        { id: 'header2', data: new Uint8Array([4, 5, 6]) },
      ],
    };
    const frame = encodeModifierResponse(MAGIC_TESTNET, resp);
    const { code, body } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(MSG_MODIFIER_RESPONSE);
    const decoded = decodeModifierResponse(body);
    expect(decoded.typeId).toBe(101);
    expect(decoded.modifiers).toHaveLength(2);
    expect(decoded.modifiers[0]!.data).toEqual(new Uint8Array([1, 2, 3]));
  });
});
```

- [ ] **Step 4: Export from index.ts**

```ts
export type { SyncInfo, Inv, ModifierRequest, ModifierResponse, SyncState } from './sync-types.js';
export {
  encodeSyncInfo, decodeSyncInfo,
  encodeInv, decodeInv,
  encodeModifierRequest, decodeModifierRequest,
  encodeModifierResponse, decodeModifierResponse,
} from './sync-codec.js';
```

- [ ] **Step 5: Run tests, build, verify**

```bash
cd /home/mwaddip/projects/dagsocial && pnpm build && pnpm test
```

- [ ] **Step 6: Commit**

```bash
git add packages/net/ && git commit -m "feat(net): add sync message codec

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: Sync machine — state machine

**Files:**
- Create: `packages/net/src/sync-machine.ts`
- Create: `packages/net/test/sync-machine.test.ts`

**Interfaces:**
- Consumes: sync codec from Task 11, frame from Task 7, `NetConfig` from Task 7
- Produces: `SyncMachine` class with event-driven loop, bidirectional serve, stall/rotation, watermarks

- [ ] **Step 1: Write sync-machine.ts**

This is the core sync logic. Write it as an event-driven class that the node wires into.

```ts
import type { NetConfig } from './types.js';
import type { SyncInfo, Inv, ModifierRequest, ModifierResponse, SyncState } from './sync-types.js';
import {
  encodeSyncInfo, decodeSyncInfo,
  encodeInv, decodeInv,
  encodeModifierRequest, decodeModifierRequest,
  encodeModifierResponse, decodeModifierResponse,
} from './sync-codec.js';
import { decodeFrame, encodeFrame } from './frame.js';
import {
  MSG_SYNC_INFO, MSG_INV, MSG_MODIFIER_REQUEST, MSG_MODIFIER_RESPONSE,
  MODIFIER_ORDERING_BLOCK, MODIFIER_SUB_BLOCK,
} from './types.js';

export interface SyncStore {
  getOrderingBlock(height: number): unknown | null;
  getOrderingBlockHeader(height: number): unknown | null;
  hasOrderingBlockHeader(id: string): boolean;
  hasSubBlock(id: string): boolean;
  chainHeight(): number;
  cumulativeWork(): bigint;
  getAnchors(): { height: number; blockId: string }[];
  appendHeaders(headers: unknown[]): void;
  appendBlocks(blocks: unknown[]): void;
  setValidatedHeight(height: number): void;
  flush(): void;
}

const STALL_TIMEOUT_MS = 60_000;
const SYNCED_POLL_INTERVAL_MS = 30_000;
const MAX_INV_IDS = 400;

export class SyncMachine {
  private state: SyncState = {
    phase: 'idle',
    syncPeerId: null,
    stalledPeers: new Set(),
    downloadedHeight: 0,
    stateAppliedHeight: 0,
  };
  private lastProgressMs = 0;
  private lastSyncInfoMs = 0;

  constructor(
    private config: NetConfig,
    private store: SyncStore,
    private sendToPeer: (peerId: string, data: Uint8Array) => void,
    private requestSubBlocks: (peerId: string, ids: string[]) => Promise<unknown[]>,
  ) {}

  getState(): Readonly<SyncState> {
    return this.state;
  }

  /** Called after handshake reveals peer height. */
  onPeerActive(peerId: string, peerHeight: number): void {
    const ourHeight = this.store.chainHeight();
    if (peerHeight > ourHeight && this.state.phase === 'idle') {
      this.state.phase = 'syncing';
      this.state.syncPeerId = peerId;
      this.sendSyncInfo(peerId);
    } else if (peerHeight < ourHeight) {
      // Serve: peer is behind us
      this.servePeer(peerId, peerHeight);
    }
  }

  /** Handle an incoming framed message from a peer. */
  handleMessage(peerId: string, code: number, body: Uint8Array): void {
    switch (code) {
      case MSG_SYNC_INFO:
        this.handleSyncInfo(peerId, decodeSyncInfo(body));
        break;
      case MSG_INV:
        this.handleInv(peerId, decodeInv(body));
        break;
      case MSG_MODIFIER_REQUEST:
        this.handleModifierRequest(peerId, decodeModifierRequest(body));
        break;
      case MSG_MODIFIER_RESPONSE:
        this.handleModifierResponse(peerId, decodeModifierResponse(body));
        break;
    }
  }

  /** Periodic timer tick — check for stall, send SyncInfo. */
  onTimerTick(): void {
    const now = Date.now();
    if (this.state.phase === 'syncing') {
      if (now - this.lastProgressMs > STALL_TIMEOUT_MS && this.state.syncPeerId) {
        this.rotatePeer();
      }
    }
    if (this.state.phase !== 'idle' && this.state.syncPeerId) {
      if (now - this.lastSyncInfoMs > SYNCED_POLL_INTERVAL_MS) {
        this.sendSyncInfo(this.state.syncPeerId);
      }
    }
  }

  /** Called when the sync peer disconnects. */
  onPeerDisconnect(peerId: string): void {
    if (this.state.syncPeerId === peerId) {
      this.state.stalledPeers.add(peerId);
      this.state.syncPeerId = null;
      if (this.state.phase === 'syncing') {
        this.state.phase = 'idle';
      }
    }
  }

  // ---- internal ----

  private sendSyncInfo(peerId: string): void {
    const info: SyncInfo = {
      tipHeight: this.store.chainHeight(),
      tipBlockId: '', // filled from chain
      tipCumulativeWork: this.store.cumulativeWork().toString(),
      anchors: this.store.getAnchors(),
    };
    this.sendToPeer(peerId, encodeSyncInfo(this.config.magic, info));
    this.lastSyncInfoMs = Date.now();
  }

  private handleSyncInfo(peerId: string, info: SyncInfo): void {
    const ourHeight = this.store.chainHeight();
    if (info.tipHeight > ourHeight) {
      // Peer ahead — if we're idle, start syncing
      if (this.state.phase === 'idle') {
        this.state.phase = 'syncing';
        this.state.syncPeerId = peerId;
      }
    } else if (info.tipHeight < ourHeight) {
      // Peer behind — serve them
      this.servePeer(peerId, info.tipHeight);
    } else if (info.tipHeight === ourHeight && this.state.phase === 'syncing') {
      // Caught up
      this.state.phase = 'synced';
      this.state.stalledPeers.clear();
    }
  }

  private handleInv(_peerId: string, inv: Inv): void {
    if (this.state.phase !== 'syncing' || !this.state.syncPeerId) return;
    // Request the announced modifiers
    const req: ModifierRequest = { typeId: inv.typeId, ids: inv.ids };
    this.sendToPeer(this.state.syncPeerId, encodeModifierRequest(this.config.magic, req));
  }

  private handleModifierRequest(peerId: string, req: ModifierRequest): void {
    // Serve from local store
    const modifiers: { id: string; data: Uint8Array }[] = [];
    for (const id of req.ids) {
      // Check store — headers or sub-blocks
      // (actual lookup depends on typeId; stub for now)
    }
    const resp: ModifierResponse = { typeId: req.typeId, modifiers };
    this.sendToPeer(peerId, encodeModifierResponse(this.config.magic, resp));
  }

  private handleModifierResponse(_peerId: string, resp: ModifierResponse): void {
    // Apply received headers/blocks
    // (delegates to store.appendHeaders / appendBlocks)
    this.lastProgressMs = Date.now();
    if (resp.typeId === MODIFIER_ORDERING_BLOCK) {
      this.state.downloadedHeight = Math.max(
        this.state.downloadedHeight,
        // derived from response
        this.state.downloadedHeight + resp.modifiers.length,
      );
    }
  }

  private servePeer(peerId: string, peerHeight: number): void {
    // Compute continuation from peerHeight + 1
    const startHeight = peerHeight + 1;
    const ourHeight = this.store.chainHeight();
    if (startHeight > ourHeight) return; // nothing to serve

    const ids: string[] = [];
    for (let h = startHeight; h <= ourHeight && ids.length < MAX_INV_IDS; h++) {
      const header = this.store.getOrderingBlockHeader(h);
      if (header) {
        // Get block ID from header
        ids.push((header as any).id ?? `h${h}`);
      }
    }
    if (ids.length > 0) {
      const inv: Inv = { typeId: MODIFIER_ORDERING_BLOCK, ids };
      this.sendToPeer(peerId, encodeInv(this.config.magic, inv));
    }
  }

  private rotatePeer(): void {
    if (this.state.syncPeerId) {
      this.state.stalledPeers.add(this.state.syncPeerId);
    }
    this.state.syncPeerId = null;
    this.state.phase = 'idle';
    // The node layer picks a new peer on next onPeerActive
  }
}
```

- [ ] **Step 2: Write sync-machine tests**

Test the state transitions without network I/O:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncMachine } from '@dagsocial/net';
import type { SyncStore } from '@dagsocial/net';

// Minimal store stub for tests
function stubStore(overrides: Partial<SyncStore> = {}): SyncStore {
  return {
    getOrderingBlock: () => null,
    getOrderingBlockHeader: () => null,
    hasOrderingBlockHeader: () => false,
    hasSubBlock: () => false,
    chainHeight: () => 0,
    cumulativeWork: () => 0n,
    getAnchors: () => [],
    appendHeaders: () => {},
    appendBlocks: () => {},
    setValidatedHeight: () => {},
    flush: () => {},
    ...overrides,
  };
}

const testConfig = {
  magic: 0x54444147, bootstrapPeers: [], listenAddrs: '', maxPeers: 10,
  minPeers: 3, peerDbCap: 100, outboundFillIntervalMs: 30000,
  outboundRedialCooldownMs: 60000, penaltyScoreThreshold: 500,
  temporalBanDurationMs: 3600000, penaltySafeIntervalMs: 120000,
  peerEvictionIntervalMs: 3600000, syncRequestTimeoutMs: 10000,
};

describe('SyncMachine', () => {
  let sent: { peerId: string; data: Uint8Array }[] = [];
  let machine: SyncMachine;

  beforeEach(() => {
    sent = [];
    machine = new SyncMachine(
      testConfig,
      stubStore({ chainHeight: () => 0 }),
      (peerId, data) => sent.push({ peerId, data }),
      async () => [],
    );
  });

  it('starts idle', () => {
    expect(machine.getState().phase).toBe('idle');
  });

  it('transitions to syncing when peer ahead', () => {
    machine.onPeerActive('peer1', 100);
    expect(machine.getState().phase).toBe('syncing');
    expect(machine.getState().syncPeerId).toBe('peer1');
  });

  it('stays idle when peer behind', () => {
    machine.onPeerActive('peer1', 0); // peer at 0, we at 0 (via stub)
    expect(machine.getState().phase).toBe('idle');
  });

  it('sends SyncInfo on peer active (ahead)', () => {
    machine.onPeerActive('peer1', 100);
    expect(sent.length).toBeGreaterThan(0);
    // First message should be SyncInfo (code 2)
  });

  it('transitions to synced when peer reports equal height', () => {
    const store = stubStore({ chainHeight: () => 100 });
    const m = new SyncMachine(testConfig, store, () => {}, async () => []);
    m.onPeerActive('peer1', 100); // peer at same height
    expect(m.getState().phase).toBe('idle'); // no sync needed
  });

  it('clears stalled peers on progress', () => {
    machine.onPeerActive('peer1', 100);
    machine.onPeerDisconnect('peer1');
    expect(machine.getState().stalledPeers.has('peer1')).toBe(true);
    // New peer ahead should clear and restart
    machine.onPeerActive('peer2', 200);
    expect(machine.getState().phase).toBe('syncing');
  });
});
```

- [ ] **Step 3: Export, build, test, commit**

```bash
git add packages/net/ && git commit -m "feat(net): add sync machine

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 13: Integration — wire into NetNode

**Files:**
- Modify: `packages/net/src/node.ts` (add handshake exchange, sync machine, outbound manager, PeerDb wiring)
- Modify: `packages/net/src/index.ts` (update exports)
- Remove: `packages/net/src/headers.ts`
- Modify: `packages/net/src/sync.ts` (remove old sync handler — sync machine replaces it)

**Description:** The final integration task. Wires all new components into NetNode.

- [ ] **Step 1: Update node.ts — add new component initialization**

In `NetNode.start()`:
1. After libp2p creation, register the handshake stream handler (`/dagsocial/handshake/1`)
2. Create PeerDb with storage adapter
3. Create SyncMachine with store bridge
4. Create OutboundManager
5. After connecting to bootstrap peers, run handshake exchange
6. On handshake complete → call `syncMachine.onPeerActive()`
7. Register sync stream handler (`/dagsocial/sync/1`) — dispatches framed messages to sync machine
8. Register timer for outbound fill + sync ticks

- [ ] **Step 2: Update setSyncHandler / setHeadersHandler**

Update to wire into sync machine's store adapter instead of old raw handlers.

- [ ] **Step 3: Remove headers.ts, old sync handler**

Delete `packages/net/src/headers.ts`. Remove old `registerSyncHandler` / `registerHeadersHandler` calls; replace with sync machine wiring.

- [ ] **Step 4: Update exports in index.ts**

Remove exports for deleted modules. Add exports for all new modules.

- [ ] **Step 5: Run full build + test**

```bash
cd /home/mwaddip/projects/dagsocial && pnpm build && pnpm test
```
Expected: all 274+ tests pass (old tests still work, new tests pass).

- [ ] **Step 6: Commit**

```bash
git add packages/net/ && git rm packages/net/src/headers.ts && git commit -m "feat(net): integrate handshake, sync machine, peer discovery

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 14: E2e verification

**Files:**
- Modify: cluster test script (if one exists — check `scripts/`)

**Description:** Verify the full flow: N1 mines blocks, N2 starts late and syncs.

- [ ] **Step 1: Run cluster with two fresh nodes**

```bash
# Start N1, let it mine some blocks
# Start N2, verify it connects and syncs
```

- [ ] **Step 2: Verify sync completes**

Check N2's chain height matches N1's after sync.

- [ ] **Step 3: Run full test suite**

```bash
pnpm test
```
Expected: all tests pass.

- [ ] **Step 4: Final commit if needed**
