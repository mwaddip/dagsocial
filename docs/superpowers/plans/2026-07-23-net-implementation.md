# @dagsocial/net — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@dagsocial/validation` (pure validation functions), `@dagsocial/net` (libp2p networking), and integrate both into `@dagsocial/node`.

**Architecture:** Three packages in a dependency chain: validation (pure functions, depends on types) → net (libp2p, depends on types + validation) → node modifications (depends on types + validation + net). Two-stage validation: Stage 1 (stateless, in net) forwards then fires callbacks; Stage 2 (stateful, in node) validates and stores.

**Tech Stack:** TypeScript ESM, libp2p (@libp2p/tcp, @chainsafe/libp2p-noise, @chainsafe/libp2p-yamux, @chainsafe/libp2p-gossipsub), cbor-x, vitest, tsup, Node.js ≥ 22.

## Global Constraints

- Node.js ≥ 22 (no blake2b256 — use blake2b512.subarray(0, 32))
- All wire messages CBOR-encoded via `cbor-x`
- Secret keys never in wire messages or DTOs crossing package boundaries
- Protocol version on every message (`PROTOCOL_VERSION = 1` for Phase 2)
- Signatures: raw Ed25519 (64 bytes), verified with `crypto.verify(null, ...)` using KeyObject
- Peer identity (libp2p) independent of account identity (Ed25519 keypair)
- Topic names include protocol version (`/dagsocial/subblock/1`, etc.)
- Inbound messages re-verified (Stage 1) before forwarding to mesh
- Each package follows existing pattern: `tsup --format esm --dts`, `vitest`, `tsc --noEmit`

---

## File Structure

### New: `packages/validation/`

```
packages/validation/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts              — re-exports everything
    verify.ts             — all validation functions
  test/
    verify.test.ts        — exhaustive tests for every function
```

### New: `packages/net/`

```
packages/net/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts              — re-exports NetNode + types
    config.ts             — NetConfig loading from env
    node.ts               — NetNode class (lifecycle, wiring)
    gossip.ts             — topic subscription, inbound routing, outbound broadcast
    peer-mgr.ts           — bootstrap, peer tracking, penalty scoring
    sync.ts               — missing sub-block request protocol
    types.ts              — Peer, NetConfig, NetValidators, Penalty interfaces
  test/
    config.test.ts
    peer-mgr.test.ts      — penalty scoring unit tests
    gossip.test.ts        — inbound routing unit tests
    sync.test.ts          — request/response protocol tests
    integration.test.ts   — two real libp2p nodes on localhost
```

### Modified: `packages/types/`

```
packages/types/
  src/
    index.ts              — updated exports (new SubBlock type already defined)
    constants.ts          — add net-specific constants
```

### Modified: `packages/node/`

```
packages/node/
  src/
    index.ts              — net startup + handler registration
    config.ts             — add net config fields
    services/
      verifier.ts         — add verifyPostForRelay, extract stateless helpers
      block-creator.ts    — call net.broadcastOrderingBlock after block creation
    routes/
      posts.ts            — call net.broadcastSubBlock after post submission
      likes.ts            — call net.broadcastTx after like creation
      invites.ts          — call net.broadcastTx after invite/claim/cancel
```

---

### Task 1: Scaffold `@dagsocial/validation` package

**Files:**
- Create: `packages/validation/package.json`
- Create: `packages/validation/tsconfig.json`
- Create: `packages/validation/vitest.config.ts`

**Interfaces:**
- Produces: Package importable as `@dagsocial/validation`, builds clean, typechecks

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@dagsocial/validation",
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
  "dependencies": {
    "@dagsocial/types": "workspace:*"
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

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
  },
});
```

- [ ] **Step 4: Create minimal src/index.ts (empty barrel)**

```typescript
// Validation functions will be added in Task 2
export {};
```

- [ ] **Step 5: Build and verify**

Run: `cd packages/validation && pnpm build`
Expected: Build succeeds, `dist/index.js` and `dist/index.d.ts` exist.

- [ ] **Step 6: Commit**

```bash
git add packages/validation/
git commit -m "feat: scaffold @dagsocial/validation package"
```

---

### Task 2: Implement stateless validation functions

**Files:**
- Create: `packages/validation/src/verify.ts`
- Modify: `packages/validation/src/index.ts`
- Modify: `packages/node/src/services/verifier.ts` (import from validation)
- Modify: `packages/node/src/services/pow.ts` (remove — move to validation)

**Interfaces:**
- Consumes: `@dagsocial/types` types (Post, SubBlock, OrderingBlock, UtxoTransaction, constants)
- Produces:
  ```typescript
  verifyPoW(input: Uint8Array, nonce: number, targetBits: number): boolean
  verifyPostSignature(post: Post, publicKey: Uint8Array): boolean
  verifyProtocolVersion(version: number): boolean
  verifyContentLimits(content: string): { valid: boolean; error?: string }
  verifyParentRefsCount(refs: string[]): { valid: boolean; error?: string }
  verifySubBlockStructure(sb: SubBlock): { valid: boolean; error?: string }
  verifyTxStructure(tx: UtxoTransaction): { valid: boolean; error?: string }
  verifyOrderingBlockStructure(block: OrderingBlock): { valid: boolean; error?: string }
  verifyBlockChainLink(block: OrderingBlock, prevBlock: OrderingBlock): boolean
  ```

- [ ] **Step 1: Write `packages/validation/src/verify.ts`**

```typescript
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
} from '@dagsocial/types';
import { signingHash } from '@dagsocial/types';
import type { Post, SubBlock, OrderingBlock, UtxoTransaction } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// SPKI wrapper (same as node's verifier)
// ---------------------------------------------------------------------------

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function wrapSpki(raw: Uint8Array): Buffer {
  return Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]);
}

// ---------------------------------------------------------------------------
// verifyPoW
// ---------------------------------------------------------------------------

export function verifyPoW(input: Uint8Array, nonce: number, targetBits: number): boolean {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));
  const buf = Buffer.concat([Buffer.from(input), nonceBuf]);
  const hash = createHash('blake2b512').update(buf).digest().subarray(0, 32);
  for (let i = 0; i < targetBits; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    if ((hash[byteIdx]! & (1 << bitIdx)) !== 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// verifyPostSignature
// ---------------------------------------------------------------------------

export function verifyPostSignature(post: Post, publicKey: Uint8Array): boolean {
  const pubDer = wrapSpki(publicKey);
  const pubKeyObj = createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
  const sigBuf = Buffer.from(post.signature);
  return cryptoVerify(null, signingHash(post), pubKeyObj, sigBuf);
}

// ---------------------------------------------------------------------------
// verifyProtocolVersion
// ---------------------------------------------------------------------------

export function verifyProtocolVersion(version: number): boolean {
  return version === PROTOCOL_VERSION;
}

// ---------------------------------------------------------------------------
// verifyContentLimits
// ---------------------------------------------------------------------------

export function verifyContentLimits(content: string): { valid: boolean; error?: string } {
  const byteLen = Buffer.byteLength(content, 'utf8');
  if (byteLen === 0) return { valid: false, error: 'Content is empty' };
  if (byteLen > MAX_CONTENT_BYTES) return { valid: false, error: 'Content exceeds max length' };
  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifyParentRefsCount
// ---------------------------------------------------------------------------

export function verifyParentRefsCount(refs: string[]): { valid: boolean; error?: string } {
  if (refs.length > MAX_PARENT_REFS) {
    return { valid: false, error: `Too many parent refs (max ${MAX_PARENT_REFS})` };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifySubBlockStructure
// ---------------------------------------------------------------------------

export function verifySubBlockStructure(sb: SubBlock): { valid: boolean; error?: string } {
  if (!sb.post) return { valid: false, error: 'Sub-block missing post' };
  if (!sb.subBlockId) return { valid: false, error: 'Sub-block missing subBlockId' };
  if (!Array.isArray(sb.likeBoxes)) return { valid: false, error: 'Sub-block likeBoxes must be an array' };
  if (typeof sb.protocolVersion !== 'number') return { valid: false, error: 'Sub-block missing protocolVersion' };
  if (!sb.producerId) return { valid: false, error: 'Sub-block missing producerId' };
  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifyTxStructure
// ---------------------------------------------------------------------------

export function verifyTxStructure(tx: UtxoTransaction): { valid: boolean; error?: string } {
  if (!Array.isArray(tx.inputs) || tx.inputs.length === 0) {
    return { valid: false, error: 'Transaction must have at least one input' };
  }
  if (!Array.isArray(tx.outputs) || tx.outputs.length === 0) {
    return { valid: false, error: 'Transaction must have at least one output' };
  }
  // Check for duplicate inputs
  const seen = new Set<string>();
  for (const input of tx.inputs) {
    if (seen.has(input)) return { valid: false, error: 'Duplicate input in transaction' };
    seen.add(input);
  }
  if (typeof tx.protocolVersion !== 'number') {
    return { valid: false, error: 'Transaction missing protocolVersion' };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifyOrderingBlockStructure
// ---------------------------------------------------------------------------

export function verifyOrderingBlockStructure(
  block: OrderingBlock,
): { valid: boolean; error?: string } {
  if (!block.prevBlockHash) return { valid: false, error: 'Ordering block missing prevBlockHash' };
  if (!Array.isArray(block.subBlockRefs)) return { valid: false, error: 'Ordering block missing subBlockRefs' };
  if (!block.validatorSignature || block.validatorSignature.length !== 64) {
    return { valid: false, error: 'Ordering block missing or invalid validatorSignature' };
  }
  if (typeof block.height !== 'number' || block.height < 1) {
    return { valid: false, error: 'Ordering block invalid height' };
  }
  if (typeof block.protocolVersion !== 'number') {
    return { valid: false, error: 'Ordering block missing protocolVersion' };
  }
  if (!block.hash) return { valid: false, error: 'Ordering block missing hash' };
  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifyBlockChainLink
// ---------------------------------------------------------------------------

export function verifyBlockChainLink(
  block: OrderingBlock,
  prevBlock: OrderingBlock,
): boolean {
  return block.prevBlockHash === prevBlock.hash && block.height === prevBlock.height + 1;
}
```

- [ ] **Step 2: Update `packages/validation/src/index.ts`**

```typescript
export {
  verifyPoW,
  verifyPostSignature,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifySubBlockStructure,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyBlockChainLink,
} from './verify.js';
```

- [ ] **Step 3: Update node verifier to re-export from validation**

Edit `packages/node/src/services/verifier.ts` — replace PoW import:

```typescript
import { verifyPoW } from '@dagsocial/validation';
```

Remove the local `wrapSpki` and `ED25519_SPKI_PREFIX` (these are now in validation). Import `verifyPostSignature` from validation and use it in `verifyPost`.

- [ ] **Step 4: Update `packages/node/src/services/pow.ts` to re-export**

Replace the entire content:

```typescript
import { randomBytes } from 'crypto';

export { verifyPoW } from '@dagsocial/validation';

export function generateChallenge(): Uint8Array {
  return randomBytes(32);
}
```

- [ ] **Step 5: Build, typecheck, and run existing tests**

```bash
pnpm build
pnpm typecheck
pnpm test
```

Expected: All 198 tests pass, builds clean.

- [ ] **Step 6: Commit**

```bash
git add packages/validation/src/verify.ts packages/validation/src/index.ts
git add packages/node/src/services/verifier.ts packages/node/src/services/pow.ts
git commit -m "feat: implement validation functions, migrate pow/verifier to use @dagsocial/validation"
```

---

### Task 3: Tests for `@dagsocial/validation`

**Files:**
- Create: `packages/validation/test/verify.test.ts`

**Interfaces:**
- Consumes: All exports from `packages/validation/src/verify.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  verifyPoW,
  verifyPostSignature,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifySubBlockStructure,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyBlockChainLink,
} from '../src/verify.js';
import { generateKeyPair, getUserId, computePostId } from '@dagsocial/types';
import type { Post, SubBlock, OrderingBlock, UtxoTransaction } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// verifyPoW
// ---------------------------------------------------------------------------

describe('verifyPoW', () => {
  it('accepts a valid PoW solution', () => {
    const input = Buffer.from('test input');
    let nonce = 0;
    const targetBits = 4;
    // Find a valid nonce
    while (nonce < 100000) {
      if (verifyPoW(input, nonce, targetBits)) break;
      nonce++;
    }
    expect(verifyPoW(input, nonce, targetBits)).toBe(true);
  });

  it('rejects an invalid PoW solution', () => {
    const input = Buffer.from('test input');
    expect(verifyPoW(input, 0, 20)).toBe(false);
  });

  it('verifies the same solution consistently', () => {
    const input = Buffer.from('hello world');
    let nonce = 0;
    while (nonce < 100000 && !verifyPoW(input, nonce, 4)) nonce++;
    for (let i = 0; i < 5; i++) {
      expect(verifyPoW(input, nonce, 4)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// verifyPostSignature
// ---------------------------------------------------------------------------

describe('verifyPostSignature', () => {
  it('accepts a valid Ed25519 signature', () => {
    const kp = generateKeyPair();
    const userId = getUserId(kp.publicKey);
    const post: Post = {
      content: 'hello',
      author: userId,
      parentRefs: [],
      challenge: new Uint8Array(32),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: Date.now(),
      signature: new Uint8Array(64), // placeholder
    };
    // Sign the post
    const { signingHash } = require('@dagsocial/types');
    const { sign } = require('crypto');
    const sig = sign(null, signingHash(post), kp.privateKey);
    post.signature = new Uint8Array(sig);
    expect(verifyPostSignature(post, kp.publicKey)).toBe(true);
  });

  it('rejects a signature with wrong public key', () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    const post: Post = {
      content: 'hello',
      author: getUserId(kp1.publicKey),
      parentRefs: [],
      challenge: new Uint8Array(32),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: Date.now(),
      signature: new Uint8Array(64),
    };
    const { signingHash } = require('@dagsocial/types');
    const { sign } = require('crypto');
    const sig = sign(null, signingHash(post), kp1.privateKey);
    post.signature = new Uint8Array(sig);
    expect(verifyPostSignature(post, kp2.publicKey)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const kp = generateKeyPair();
    const post: Post = {
      content: 'hello',
      author: getUserId(kp.publicKey),
      parentRefs: [],
      challenge: new Uint8Array(32),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: Date.now(),
      signature: new Uint8Array(64),
    };
    const { signingHash } = require('@dagsocial/types');
    const { sign } = require('crypto');
    const sig = sign(null, signingHash(post), kp.privateKey);
    // Tamper with one byte
    const tampered = new Uint8Array(sig);
    tampered[0] = (tampered[0]! + 1) % 256;
    post.signature = tampered;
    expect(verifyPostSignature(post, kp.publicKey)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyProtocolVersion
// ---------------------------------------------------------------------------

describe('verifyProtocolVersion', () => {
  it('accepts version 1', () => {
    expect(verifyProtocolVersion(1)).toBe(true);
  });

  it('rejects version 0', () => {
    expect(verifyProtocolVersion(0)).toBe(false);
  });

  it('rejects version 2', () => {
    expect(verifyProtocolVersion(2)).toBe(false);
  });

  it('rejects version 999', () => {
    expect(verifyProtocolVersion(999)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyContentLimits
// ---------------------------------------------------------------------------

describe('verifyContentLimits', () => {
  it('accepts content within limits', () => {
    expect(verifyContentLimits('hello')).toEqual({ valid: true });
  });

  it('rejects empty content', () => {
    expect(verifyContentLimits('')).toEqual({ valid: false, error: 'Content is empty' });
  });

  it('rejects content exceeding 300 bytes', () => {
    const long = 'x'.repeat(301);
    expect(verifyContentLimits(long)).toEqual({ valid: false, error: 'Content exceeds max length' });
  });

  it('accepts exactly 300 bytes', () => {
    const exact = 'x'.repeat(300);
    expect(verifyContentLimits(exact)).toEqual({ valid: true });
  });

  it('accepts 1-byte content', () => {
    expect(verifyContentLimits('x')).toEqual({ valid: true });
  });

  it('counts UTF-8 bytes not characters', () => {
    // '€' is 3 bytes in UTF-8
    const euros = '€'.repeat(100); // 300 bytes
    expect(verifyContentLimits(euros)).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// verifyParentRefsCount
// ---------------------------------------------------------------------------

describe('verifyParentRefsCount', () => {
  it('accepts 0 parent refs', () => {
    expect(verifyParentRefsCount([])).toEqual({ valid: true });
  });

  it('accepts up to 8 parent refs', () => {
    const refs = Array.from({ length: 8 }, (_, i) => `ref${i}`);
    expect(verifyParentRefsCount(refs)).toEqual({ valid: true });
  });

  it('rejects 9 parent refs', () => {
    const refs = Array.from({ length: 9 }, (_, i) => `ref${i}`);
    expect(verifyParentRefsCount(refs).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifySubBlockStructure
// ---------------------------------------------------------------------------

describe('verifySubBlockStructure', () => {
  const makeBasePost = (): Post => ({
    content: 'test',
    author: 'user1',
    parentRefs: [],
    challenge: new Uint8Array(32),
    powNonce: 0,
    protocolVersion: 1,
    timestamp: Date.now(),
    signature: new Uint8Array(64),
  });

  it('accepts a valid sub-block', () => {
    const sb: SubBlock = {
      subBlockId: computePostId(makeBasePost()),
      post: makeBasePost(),
      likeBoxes: [],
      producerId: 'user1',
      protocolVersion: 1,
    };
    expect(verifySubBlockStructure(sb)).toEqual({ valid: true });
  });

  it('rejects sub-block missing post', () => {
    const sb = {
      subBlockId: 'abc',
      likeBoxes: [],
      producerId: 'user1',
      protocolVersion: 1,
    } as unknown as SubBlock;
    expect(verifySubBlockStructure(sb).valid).toBe(false);
  });

  it('rejects sub-block with non-array likeBoxes', () => {
    const sb = {
      subBlockId: 'abc',
      post: makeBasePost(),
      likeBoxes: 'not-an-array',
      producerId: 'user1',
      protocolVersion: 1,
    } as unknown as SubBlock;
    expect(verifySubBlockStructure(sb).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyTxStructure
// ---------------------------------------------------------------------------

describe('verifyTxStructure', () => {
  it('accepts a valid transaction', () => {
    const tx: UtxoTransaction = {
      inputs: ['input1'],
      outputs: [{ boxType: 'karma', value: 5, createdAtBlock: 1, owner: new Uint8Array(32), guard: 'owner_signature', proofSource: 'abc', lastTouchBlock: 1 }],
      signatures: {},
      protocolVersion: 1,
    };
    expect(verifyTxStructure(tx)).toEqual({ valid: true });
  });

  it('rejects transaction with no inputs', () => {
    const tx: UtxoTransaction = {
      inputs: [],
      outputs: [{ boxType: 'karma', value: 5, createdAtBlock: 1, owner: new Uint8Array(32), guard: 'owner_signature', proofSource: 'abc', lastTouchBlock: 1 }],
      signatures: {},
      protocolVersion: 1,
    };
    expect(verifyTxStructure(tx).valid).toBe(false);
  });

  it('rejects transaction with no outputs', () => {
    const tx: UtxoTransaction = {
      inputs: ['input1'],
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    };
    expect(verifyTxStructure(tx).valid).toBe(false);
  });

  it('rejects transaction with duplicate inputs', () => {
    const tx: UtxoTransaction = {
      inputs: ['input1', 'input1'],
      outputs: [{ boxType: 'karma', value: 5, createdAtBlock: 1, owner: new Uint8Array(32), guard: 'owner_signature', proofSource: 'abc', lastTouchBlock: 1 }],
      signatures: {},
      protocolVersion: 1,
    };
    expect(verifyTxStructure(tx).valid).toBe(false);
  });

  it('rejects transaction missing protocolVersion', () => {
    const tx = {
      inputs: ['input1'],
      outputs: [{ boxType: 'karma', value: 5 }],
      signatures: {},
    } as unknown as UtxoTransaction;
    expect(verifyTxStructure(tx).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyOrderingBlockStructure
// ---------------------------------------------------------------------------

describe('verifyOrderingBlockStructure', () => {
  const makeValidBlock = (): OrderingBlock => ({
    height: 1,
    hash: 'abc123',
    prevBlockHash: '0000',
    subBlockRefs: [],
    likeBoxIds: [],
    utxoTxIds: [],
    stumpIds: [],
    validatorId: 'validator1',
    validatorSignature: new Uint8Array(64),
    protocolVersion: 1,
    createdAt: Date.now(),
  });

  it('accepts a valid ordering block', () => {
    expect(verifyOrderingBlockStructure(makeValidBlock())).toEqual({ valid: true });
  });

  it('rejects block missing prevBlockHash', () => {
    const block = { ...makeValidBlock(), prevBlockHash: '' };
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects block with invalid validatorSignature length', () => {
    const block = { ...makeValidBlock(), validatorSignature: new Uint8Array(32) };
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects block with height 0', () => {
    const block = { ...makeValidBlock(), height: 0 };
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects block missing protocolVersion', () => {
    const block = { ...makeValidBlock(), protocolVersion: undefined } as unknown as OrderingBlock;
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects block with empty hash', () => {
    const block = { ...makeValidBlock(), hash: '' };
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyBlockChainLink
// ---------------------------------------------------------------------------

describe('verifyBlockChainLink', () => {
  const makeBlock = (height: number, hash: string, prevHash: string): OrderingBlock => ({
    height,
    hash,
    prevBlockHash: prevHash,
    subBlockRefs: [],
    likeBoxIds: [],
    utxoTxIds: [],
    stumpIds: [],
    validatorId: 'validator1',
    validatorSignature: new Uint8Array(64),
    protocolVersion: 1,
    createdAt: Date.now(),
  });

  it('accepts a valid chain link', () => {
    const prev = makeBlock(1, 'hash1', '0000');
    const next = makeBlock(2, 'hash2', 'hash1');
    expect(verifyBlockChainLink(next, prev)).toBe(true);
  });

  it('rejects mismatched prevBlockHash', () => {
    const prev = makeBlock(1, 'hash1', '0000');
    const next = makeBlock(2, 'hash2', 'wronghash');
    expect(verifyBlockChainLink(next, prev)).toBe(false);
  });

  it('rejects non-sequential height', () => {
    const prev = makeBlock(1, 'hash1', '0000');
    const next = makeBlock(3, 'hash2', 'hash1');
    expect(verifyBlockChainLink(next, prev)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd packages/validation && pnpm test
```

Expected: All tests pass (approximately 23 tests).

- [ ] **Step 3: Commit**

```bash
git add packages/validation/test/
git commit -m "test: add exhaustive tests for @dagsocial/validation"
```

---

### Task 4: Scaffold `@dagsocial/net` package

**Files:**
- Create: `packages/net/package.json`
- Create: `packages/net/tsconfig.json`
- Create: `packages/net/vitest.config.ts`

**Interfaces:**
- Produces: Package importable as `@dagsocial/net`, builds clean, typechecks

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@dagsocial/net",
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
  "dependencies": {
    "@dagsocial/types": "workspace:*",
    "@dagsocial/validation": "workspace:*",
    "@chainsafe/libp2p-gossipsub": "^13.0.0",
    "@chainsafe/libp2p-noise": "^15.0.0",
    "@chainsafe/libp2p-yamux": "^7.0.0",
    "@libp2p/identify": "^2.0.0",
    "@libp2p/ping": "^2.0.0",
    "@libp2p/tcp": "^9.0.0",
    "cbor-x": "^1.6.0",
    "libp2p": "^1.0.0"
  },
  "devDependencies": {
    "@libp2p/interface": "^1.0.0",
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

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 15000, // libp2p tests may need more time
  },
});
```

- [ ] **Step 4: Create minimal src/index.ts**

```typescript
// Net package — implementation in subsequent tasks
export {};
```

- [ ] **Step 5: Install dependencies, build, verify**

```bash
pnpm install
cd packages/net && pnpm build
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/net/package.json packages/net/tsconfig.json packages/net/vitest.config.ts packages/net/src/index.ts
git add pnpm-lock.yaml
git commit -m "feat: scaffold @dagsocial/net package"
```

---

### Task 5: Net types and config

**Files:**
- Create: `packages/net/src/types.ts`
- Create: `packages/net/src/config.ts`

**Interfaces:**
- Produces:
  ```typescript
  // types.ts
  interface Peer { id: string; multiaddrs: string[]; protocols: string[]; connectedAt: number }
  type PenaltyType = 'misbehavior' | 'spam' | 'non-delivery' | 'permanent';
  interface PenaltyRecord { type: PenaltyType; score: number; timestamp: number; reason: string }
  interface NetConfig {
    bootstrapPeers: string[];
    listenAddrs: string;
    maxPeers: number;
    penaltyScoreThreshold: number;
    temporalBanDurationMs: number;
    penaltySafeIntervalMs: number;
    peerEvictionIntervalMs: number;
    syncRequestTimeoutMs: number;
  }
  interface NetValidators {
    verifyPoW: (input: Uint8Array, nonce: number, targetBits: number) => boolean;
    verifyPostSignature: (post: Post, publicKey: Uint8Array) => boolean;
    verifyProtocolVersion: (version: number) => boolean;
    verifyContentLimits: (content: string) => { valid: boolean; error?: string };
    verifyParentRefsCount: (refs: string[]) => { valid: boolean; error?: string };
    verifySubBlockStructure: (sb: SubBlock) => { valid: boolean; error?: string };
    verifyTxStructure: (tx: UtxoTransaction) => { valid: boolean; error?: string };
    verifyOrderingBlockStructure: (block: OrderingBlock) => { valid: boolean; error?: string };
  }
  ```

- [ ] **Step 1: Write `packages/net/src/types.ts`**

```typescript
import type { SubBlock, OrderingBlock, UtxoTransaction, Post } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Peer
// ---------------------------------------------------------------------------

export interface Peer {
  id: string;
  multiaddrs: string[];
  protocols: string[];
  connectedAt: number;
}

// ---------------------------------------------------------------------------
// Penalty
// ---------------------------------------------------------------------------

export type PenaltyType = 'misbehavior' | 'spam' | 'non-delivery' | 'permanent';

export interface PenaltyRecord {
  type: PenaltyType;
  score: number;
  timestamp: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// NetConfig
// ---------------------------------------------------------------------------

export interface NetConfig {
  bootstrapPeers: string[];
  listenAddrs: string;
  maxPeers: number;
  penaltyScoreThreshold: number;
  temporalBanDurationMs: number;
  penaltySafeIntervalMs: number;
  peerEvictionIntervalMs: number;
  syncRequestTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// NetValidators — passed at construction, provided by @dagsocial/validation
// ---------------------------------------------------------------------------

export interface NetValidators {
  verifyPoW: (input: Uint8Array, nonce: number, targetBits: number) => boolean;
  verifyPostSignature: (post: Post, publicKey: Uint8Array) => boolean;
  verifyProtocolVersion: (version: number) => boolean;
  verifyContentLimits: (content: string) => { valid: boolean; error?: string };
  verifyParentRefsCount: (refs: string[]) => { valid: boolean; error?: string };
  verifySubBlockStructure: (sb: SubBlock) => { valid: boolean; error?: string };
  verifyTxStructure: (tx: UtxoTransaction) => { valid: boolean; error?: string };
  verifyOrderingBlockStructure: (block: OrderingBlock) => { valid: boolean; error?: string };
}
```

- [ ] **Step 2: Write `packages/net/src/config.ts`**

```typescript
import type { NetConfig } from './types.js';

export function loadNetConfig(): Readonly<NetConfig> {
  const cfg: NetConfig = {
    bootstrapPeers: parseBootstrapPeers(process.env['BOOTSTRAP_PEERS'] ?? ''),
    listenAddrs: process.env['LISTEN_ADDRS'] ?? '/ip4/0.0.0.0/tcp/0',
    maxPeers: parseInt(process.env['MAX_PEERS'] ?? '50', 10),
    penaltyScoreThreshold: parseInt(process.env['PENALTY_SCORE_THRESHOLD'] ?? '500', 10),
    temporalBanDurationMs: parseInt(process.env['TEMPORAL_BAN_DURATION_MS'] ?? '3600000', 10),
    penaltySafeIntervalMs: parseInt(process.env['PENALTY_SAFE_INTERVAL_MS'] ?? '120000', 10),
    peerEvictionIntervalMs: parseInt(process.env['PEER_EVICTION_INTERVAL_MS'] ?? '3600000', 10),
    syncRequestTimeoutMs: parseInt(process.env['SYNC_REQUEST_TIMEOUT_MS'] ?? '10000', 10),
  };
  return Object.freeze(cfg);
}

function parseBootstrapPeers(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}
```

- [ ] **Step 3: Write test `packages/net/test/config.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadNetConfig } from '../src/config.js';

describe('loadNetConfig', () => {
  beforeEach(() => {
    // Clear relevant env vars
    delete process.env['BOOTSTRAP_PEERS'];
    delete process.env['LISTEN_ADDRS'];
    delete process.env['MAX_PEERS'];
    delete process.env['PENALTY_SCORE_THRESHOLD'];
    delete process.env['TEMPORAL_BAN_DURATION_MS'];
    delete process.env['PENALTY_SAFE_INTERVAL_MS'];
    delete process.env['PEER_EVICTION_INTERVAL_MS'];
    delete process.env['SYNC_REQUEST_TIMEOUT_MS'];
  });

  afterEach(() => {
    delete process.env['BOOTSTRAP_PEERS'];
  });

  it('returns defaults with no env vars set', () => {
    const cfg = loadNetConfig();
    expect(cfg.bootstrapPeers).toEqual([]);
    expect(cfg.listenAddrs).toBe('/ip4/0.0.0.0/tcp/0');
    expect(cfg.maxPeers).toBe(50);
    expect(cfg.penaltyScoreThreshold).toBe(500);
    expect(cfg.temporalBanDurationMs).toBe(3600000);
    expect(cfg.penaltySafeIntervalMs).toBe(120000);
    expect(cfg.peerEvictionIntervalMs).toBe(3600000);
    expect(cfg.syncRequestTimeoutMs).toBe(10000);
  });

  it('parses comma-separated bootstrap peers', () => {
    process.env['BOOTSTRAP_PEERS'] = '/ip4/1.2.3.4/tcp/9001,/ip4/5.6.7.8/tcp/9002';
    const cfg = loadNetConfig();
    expect(cfg.bootstrapPeers).toEqual([
      '/ip4/1.2.3.4/tcp/9001',
      '/ip4/5.6.7.8/tcp/9002',
    ]);
  });

  it('handles empty bootstrap peers string', () => {
    process.env['BOOTSTRAP_PEERS'] = '';
    const cfg = loadNetConfig();
    expect(cfg.bootstrapPeers).toEqual([]);
  });

  it('honors overridden values', () => {
    process.env['MAX_PEERS'] = '10';
    process.env['PENALTY_SCORE_THRESHOLD'] = '100';
    const cfg = loadNetConfig();
    expect(cfg.maxPeers).toBe(10);
    expect(cfg.penaltyScoreThreshold).toBe(100);
  });
});
```

- [ ] **Step 4: Run tests**

```bash
cd packages/net && pnpm test
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/net/src/types.ts packages/net/src/config.ts packages/net/test/config.test.ts
git commit -m "feat: net types and config with env-based loading"
```

---

### Task 6: Peer manager

**Files:**
- Create: `packages/net/src/peer-mgr.ts`

**Interfaces:**
- Consumes: `NetConfig`, `Peer`, `PenaltyType`, `PenaltyRecord` from types.ts
- Produces:
  ```typescript
  class PeerManager {
    constructor(config: NetConfig)
    getPeers(): Peer[]
    getPeerCount(): number
    recordPenalty(peerId: string, type: PenaltyType, score: number, reason: string): void
    isBanned(peerId: string): boolean
    addPeer(peer: Peer): void
    removePeer(peerId: string): void
    evictRandom(): string | null
  }
  ```

- [ ] **Step 1: Write `packages/net/src/peer-mgr.ts`**

```typescript
import type { NetConfig, Peer, PenaltyType, PenaltyRecord } from './types.js';

interface PeerEntry {
  peer: Peer;
  penaltyScore: number;
  lastPenaltyTime: number;
  banExpiresAt: number | null;
}

interface BanEntry {
  peerId: string;
  bannedAt: number;
  banExpiresAt: number | null; // null = permanent
}

export class PeerManager {
  private peers: Map<string, PeerEntry> = new Map();
  private bans: Map<string, BanEntry> = new Map();
  private config: NetConfig;

  constructor(config: NetConfig) {
    this.config = config;
  }

  // -----------------------------------------------------------------------
  // Peer tracking
  // -----------------------------------------------------------------------

  getPeers(): Peer[] {
    return Array.from(this.peers.values()).map((e) => e.peer);
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  addPeer(peer: Peer): void {
    if (this.isBanned(peer.id)) return;
    this.peers.set(peer.id, {
      peer,
      penaltyScore: 0,
      lastPenaltyTime: 0,
      banExpiresAt: null,
    });
  }

  removePeer(peerId: string): void {
    this.peers.delete(peerId);
  }

  getPeer(peerId: string): Peer | undefined {
    return this.peers.get(peerId)?.peer;
  }

  // -----------------------------------------------------------------------
  // Penalty system
  // -----------------------------------------------------------------------

  recordPenalty(type: PenaltyType, peerId: string, score: number, reason: string): void {
    const now = Date.now();
    const entry = this.peers.get(peerId);
    if (!entry) return;

    // Respect safe interval for non-permanent penalties
    if (type !== 'permanent') {
      if (now - entry.lastPenaltyTime < this.config.penaltySafeIntervalMs) {
        return; // within cooldown, skip
      }
    }

    if (type === 'permanent') {
      // Instant permanent ban
      this.bans.set(peerId, { peerId, bannedAt: now, banExpiresAt: null });
      this.peers.delete(peerId);
      return;
    }

    entry.penaltyScore += score;
    entry.lastPenaltyTime = now;

    if (entry.penaltyScore >= this.config.penaltyScoreThreshold) {
      // Temporal ban
      this.bans.set(peerId, {
        peerId,
        bannedAt: now,
        banExpiresAt: now + this.config.temporalBanDurationMs,
      });
      this.peers.delete(peerId);
    }
  }

  isBanned(peerId: string): boolean {
    const ban = this.bans.get(peerId);
    if (!ban) return false;
    if (ban.banExpiresAt === null) return true; // permanent
    if (Date.now() >= ban.banExpiresAt) {
      // Ban expired, clean up
      this.bans.delete(peerId);
      return false;
    }
    return true;
  }

  // -----------------------------------------------------------------------
  // Eviction
  // -----------------------------------------------------------------------

  evictRandom(): string | null {
    if (this.peers.size === 0) return null;
    const ids = Array.from(this.peers.keys());
    const idx = Math.floor(Math.random() * ids.length);
    const id = ids[idx]!;
    this.peers.delete(id);
    return id;
  }
}
```

- [ ] **Step 2: Write test `packages/net/test/peer-mgr.test.ts`**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PeerManager } from '../src/peer-mgr.js';
import type { NetConfig, Peer } from '../src/types.js';

function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return {
    bootstrapPeers: [],
    listenAddrs: '/ip4/0.0.0.0/tcp/0',
    maxPeers: 50,
    penaltyScoreThreshold: 500,
    temporalBanDurationMs: 3600000,
    penaltySafeIntervalMs: 120000,
    peerEvictionIntervalMs: 3600000,
    syncRequestTimeoutMs: 10000,
    ...overrides,
  };
}

function makePeer(id: string): Peer {
  return { id, multiaddrs: [`/ip4/127.0.0.1/tcp/${9000 + parseInt(id)}`], protocols: [], connectedAt: Date.now() };
}

describe('PeerManager', () => {
  let mgr: PeerManager;
  let config: NetConfig;

  beforeEach(() => {
    config = makeConfig();
    mgr = new PeerManager(config);
  });

  it('starts with no peers', () => {
    expect(mgr.getPeerCount()).toBe(0);
    expect(mgr.getPeers()).toEqual([]);
  });

  it('adds and tracks peers', () => {
    mgr.addPeer(makePeer('peer1'));
    mgr.addPeer(makePeer('peer2'));
    expect(mgr.getPeerCount()).toBe(2);
    expect(mgr.getPeer('peer1')?.id).toBe('peer1');
  });

  it('does not add banned peers', () => {
    mgr.recordPenalty('permanent', 'peer1', 0, 'test');
    mgr.addPeer(makePeer('peer1'));
    expect(mgr.getPeerCount()).toBe(0);
  });

  it('removes peers', () => {
    mgr.addPeer(makePeer('peer1'));
    mgr.removePeer('peer1');
    expect(mgr.getPeerCount()).toBe(0);
  });

  it('accumulates penalty scores', () => {
    mgr.addPeer(makePeer('peer1'));
    // Override safe interval
    vi.spyOn(Date, 'now').mockReturnValue(0);
    mgr.recordPenalty('misbehavior', 'peer1', 100, 'bad message');
    vi.spyOn(Date, 'now').mockReturnValue(config.penaltySafeIntervalMs + 1);
    mgr.recordPenalty('misbehavior', 'peer1', 100, 'bad message again');
    // Peer should still be tracked (not banned yet at 200 < 500)
    expect(mgr.getPeerCount()).toBe(1);
  });

  it('bans peer when threshold exceeded', () => {
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(0);
    mgr.recordPenalty('misbehavior', 'peer1', 499, 'bad');
    vi.spyOn(Date, 'now').mockReturnValue(config.penaltySafeIntervalMs + 1);
    mgr.recordPenalty('misbehavior', 'peer1', 1, 'one more');
    expect(mgr.getPeerCount()).toBe(0);
    expect(mgr.isBanned('peer1')).toBe(true);
  });

  it('permanent penalty bans instantly regardless of score', () => {
    mgr.addPeer(makePeer('peer1'));
    mgr.recordPenalty('permanent', 'peer1', 0, 'wrong magic');
    expect(mgr.isBanned('peer1')).toBe(true);
    expect(mgr.getPeerCount()).toBe(0);
  });

  it('respects penalty safe interval (cooldown)', () => {
    mgr.addPeer(makePeer('peer1'));
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    mgr.recordPenalty('misbehavior', 'peer1', 100, 'first');
    mgr.recordPenalty('misbehavior', 'peer1', 100, 'too soon — should be ignored');
    // Only first penalty should count
    const entry = (mgr as any).peers.get('peer1');
    expect(entry.penaltyScore).toBe(100);
  });

  it('evicts a random peer', () => {
    mgr.addPeer(makePeer('peer1'));
    mgr.addPeer(makePeer('peer2'));
    const evicted = mgr.evictRandom();
    expect(evicted).toBeDefined();
    expect(mgr.getPeerCount()).toBe(1);
  });

  it('returns null when evicting from empty set', () => {
    expect(mgr.evictRandom()).toBeNull();
  });

  it('temporal ban expires', () => {
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(0);
    mgr.recordPenalty('misbehavior', 'peer1', 500, 'ban');
    expect(mgr.isBanned('peer1')).toBe(true);

    // Fast-forward past ban duration
    vi.spyOn(Date, 'now').mockReturnValue(config.temporalBanDurationMs + 1);
    expect(mgr.isBanned('peer1')).toBe(false);
    // Should be cleaned from bans map
    expect((mgr as any).bans.has('peer1')).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd packages/net && pnpm test
```

Expected: 10 tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/net/src/peer-mgr.ts packages/net/test/peer-mgr.test.ts
git commit -m "feat: peer manager with penalty scoring and banning"
```

---

### Task 7: Gossip — topic subscription and message routing

**Files:**
- Create: `packages/net/src/gossip.ts`

**Interfaces:**
- Consumes: `NetValidators` from types.ts, `SubBlock`, `OrderingBlock`, `UtxoTransaction` from types, libp2p node, PeerManager
- Produces:
  ```typescript
  const TOPICS: { subblock: string; orderingBlock: string; tx: string }
  function subscribeTopics(libp2p: Libp2p, validators: NetValidators, peerMgr: PeerManager, handlers: GossipHandlers): void
  function broadcastSubBlock(libp2p: Libp2p, sb: SubBlock): void
  function broadcastOrderingBlock(libp2p: Libp2p, block: OrderingBlock): void
  function broadcastTx(libp2p: Libp2p, tx: UtxoTransaction): void
  ```

- [ ] **Step 1: Write `packages/net/src/gossip.ts`**

```typescript
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { decodeSubBlock, decodeOrderingBlock, decodeTx } from '@dagsocial/types';
import { encodeSubBlock, encodeOrderingBlock, encodeTx } from '@dagsocial/types';
import {
  verifyContentLimits,
  verifyParentRefsCount,
} from '@dagsocial/validation';
import type { SubBlock, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import type { Libp2p } from 'libp2p';
import type { NetValidators } from './types.js';
import type { PeerManager } from './peer-mgr.js';

// ---------------------------------------------------------------------------
// Topic constants
// ---------------------------------------------------------------------------

export const TOPICS = {
  subblock: '/dagsocial/subblock/1',
  orderingBlock: '/dagsocial/ordering-block/1',
  tx: '/dagsocial/tx/1',
} as const;

// ---------------------------------------------------------------------------
// Handlers registered by node
// ---------------------------------------------------------------------------

export interface GossipHandlers {
  onSubBlock: (sb: SubBlock) => void;
  onOrderingBlock: (block: OrderingBlock) => void;
  onTx: (tx: UtxoTransaction) => void;
}

// ---------------------------------------------------------------------------
// Gossipsub options
// ---------------------------------------------------------------------------

function createGossipsub() {
  return gossipsub({
    fallbackToFloodsub: false,
    floodPublish: false,
    // Score thresholds — conservative defaults
    scoreThresholds: {
      gossipThreshold: -4000,
      publishThreshold: -8000,
      graylistThreshold: -16000,
    },
  });
}

// ---------------------------------------------------------------------------
// Subscribe
// ---------------------------------------------------------------------------

export async function subscribeTopics(
  libp2p: Libp2p,
  validators: NetValidators,
  peerMgr: PeerManager,
  handlers: GossipHandlers,
): Promise<void> {
  const gs = createGossipsub();
  await libp2p.register('/pur/libp2p/gossipsub/1.0.0', gs);
  gs.start();

  // --- Sub-block topic ---
  gs.addEventListener('gossipsub:message', (evt: any) => {
    const { detail } = evt;
    if (!detail?.msg) return;

    const { topic, data } = detail.msg;
    const peerId = detail.msg.from?.toString() ?? 'unknown';
    const raw = Buffer.from(data);

    try {
      if (topic === TOPICS.subblock) {
        const sb = decodeSubBlock(raw);
        const vr = runStage1SubBlock(sb, validators);
        if (!vr.valid) {
          peerMgr.recordPenalty('misbehavior', peerId, 100, vr.error ?? 'invalid sub-block');
          return;
        }
        // Forward to mesh (gossipsub handles this automatically via mesh)
        handlers.onSubBlock(sb);
      } else if (topic === TOPICS.orderingBlock) {
        const block = decodeOrderingBlock(raw);
        const vr = validators.verifyOrderingBlockStructure(block);
        if (!vr.valid) {
          peerMgr.recordPenalty('misbehavior', peerId, 100, vr.error ?? 'invalid ordering block');
          return;
        }
        if (!validators.verifyProtocolVersion(block.protocolVersion)) {
          peerMgr.recordPenalty('misbehavior', peerId, 100, 'unsupported protocol version');
          return;
        }
        handlers.onOrderingBlock(block);
      } else if (topic === TOPICS.tx) {
        const tx = decodeTx(raw);
        const vr = validators.verifyTxStructure(tx);
        if (!vr.valid) {
          peerMgr.recordPenalty('misbehavior', peerId, 100, vr.error ?? 'invalid tx');
          return;
        }
        if (!validators.verifyProtocolVersion(tx.protocolVersion)) {
          peerMgr.recordPenalty('misbehavior', peerId, 100, 'unsupported protocol version');
          return;
        }
        handlers.onTx(tx);
      }
    } catch (err) {
      // CBOR decode failure — structural invalidity
      peerMgr.recordPenalty('misbehavior', peerId, 100, `decode error: ${String(err)}`);
    }
  });

  // Subscribe to all three topics
  gs.subscribe(TOPICS.subblock);
  gs.subscribe(TOPICS.orderingBlock);
  gs.subscribe(TOPICS.tx);
}

// ---------------------------------------------------------------------------
// Stage 1 validation for sub-blocks
// ---------------------------------------------------------------------------

function runStage1SubBlock(
  sb: SubBlock,
  v: NetValidators,
): { valid: boolean; error?: string } {
  const struct = v.verifySubBlockStructure(sb);
  if (!struct.valid) return struct;

  const post = sb.post;

  const content = verifyContentLimits(post.content);
  if (!content.valid) return content;

  const refs = verifyParentRefsCount(post.parentRefs);
  if (!refs.valid) return refs;

  if (!v.verifyProtocolVersion(post.protocolVersion)) {
    return { valid: false, error: 'Unsupported protocol version' };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

export async function broadcastSubBlock(libp2p: Libp2p, sb: SubBlock): Promise<void> {
  const data = encodeSubBlock(sb);
  await libp2p.services.pubsub?.publish(TOPICS.subblock, data);
}

export async function broadcastOrderingBlock(libp2p: Libp2p, block: OrderingBlock): Promise<void> {
  const data = encodeOrderingBlock(block);
  await libp2p.services.pubsub?.publish(TOPICS.orderingBlock, data);
}

export async function broadcastTx(libp2p: Libp2p, tx: UtxoTransaction): Promise<void> {
  const data = encodeTx(tx);
  await libp2p.services.pubsub?.publish(TOPICS.tx, data);
}
```

- [ ] **Step 2: Build and typecheck**

```bash
cd packages/net && pnpm build && pnpm typecheck
```

Expected: Clean build, no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/net/src/gossip.ts
git commit -m "feat: gossip topic subscription, Stage 1 routing, and broadcast helpers"
```

---

### Task 8: Sync — missing sub-block request protocol

**Files:**
- Create: `packages/net/src/sync.ts`

**Interfaces:**
- Consumes: libp2p node, `NetConfig`, `PeerManager`, `@dagsocial/types`
- Produces:
  ```typescript
  function requestSubBlock(libp2p: Libp2p, subBlockId: string, peerId: string, config: NetConfig): Promise<SubBlock>
  ```

- [ ] **Step 1: Write `packages/net/src/sync.ts`**

```typescript
import { pipe } from 'it-pipe';
import { decodeSubBlock } from '@dagsocial/types';
import type { SubBlock } from '@dagsocial/types';
import type { Libp2p, Stream } from 'libp2p';
import type { NetConfig } from './types.js';
import { TOPICS } from './gossip.js';

export const SYNC_PROTOCOL = '/dagsocial/sync/1';

/**
 * Request a specific sub-block from a peer via a direct stream.
 *
 * Protocol:
 *   Request:  subBlockId as hex string (64 chars)
 *   Response: CBOR-encoded SubBlock, or single byte 0x00 (not found)
 *
 * Throws on timeout, not-found, or decode failure.
 */
export async function requestSubBlock(
  libp2p: Libp2p,
  subBlockId: string,
  peerId: string,
  config: NetConfig,
): Promise<SubBlock> {
  const peer = libp2p.getPeers().find((p) => p.toString() === peerId);
  if (!peer) {
    throw new Error(`Peer ${peerId} not connected`);
  }

  let stream: Stream | undefined;
  try {
    stream = await libp2p.dialProtocol(peer, SYNC_PROTOCOL, {
      signal: AbortSignal.timeout(config.syncRequestTimeoutMs),
    });

    // Send request
    const encoder = new TextEncoder();
    await stream.sink([encoder.encode(subBlockId)]);

    // Read response
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.source) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer));
    }

    if (chunks.length === 0) {
      throw new Error('Empty response from peer');
    }

    const response = Buffer.concat(chunks.map((c) => Buffer.from(c)));

    // Check for not-found marker
    if (response.length === 1 && response[0] === 0x00) {
      throw new Error(`Sub-block ${subBlockId} not found on peer ${peerId}`);
    }

    return decodeSubBlock(response);
  } finally {
    if (stream) {
      await stream.close();
    }
  }
}

/**
 * Register the sync protocol handler — serves sub-block data to requesting peers.
 */
export function registerSyncHandler(
  libp2p: Libp2p,
  getSubBlock: (id: string) => SubBlock | null,
): void {
  libp2p.handle(SYNC_PROTOCOL, async ({ stream }) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream.source) {
        chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer));
      }

      if (chunks.length === 0) {
        await stream.sink([new Uint8Array([0x00])]);
        return;
      }

      const request = new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
      const subBlock = getSubBlock(request);

      if (!subBlock) {
        await stream.sink([new Uint8Array([0x00])]);
        return;
      }

      const { encodeSubBlock } = await import('@dagsocial/types');
      await stream.sink([encodeSubBlock(subBlock)]);
    } catch {
      await stream.sink([new Uint8Array([0x00])]);
    }
  });
}
```

- [ ] **Step 2: Write test `packages/net/test/sync.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';

// Note: Full integration test for sync is in Task 11 (integration tests).
// This file tests the protocol constants and error handling patterns.

import { SYNC_PROTOCOL } from '../src/sync.js';

describe('sync protocol', () => {
  it('has the correct protocol string', () => {
    expect(SYNC_PROTOCOL).toBe('/dagsocial/sync/1');
  });
});
```

- [ ] **Step 3: Build and typecheck**

```bash
cd packages/net && pnpm build && pnpm typecheck
```

Expected: Clean.

- [ ] **Step 4: Commit**

```bash
git add packages/net/src/sync.ts packages/net/test/sync.test.ts
git commit -m "feat: missing sub-block request/response protocol"
```

---

### Task 9: NetNode — wiring everything together

**Files:**
- Create: `packages/net/src/node.ts`
- Modify: `packages/net/src/index.ts`

**Interfaces:**
- Consumes: Gossip module, PeerManager, sync module, config, types
- Produces: `NetNode` class (the public API of @dagsocial/net)

- [ ] **Step 1: Write `packages/net/src/node.ts`**

```typescript
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';

import type { Libp2p } from 'libp2p';
import type { SubBlock, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import type { NetConfig, NetValidators, Peer } from './types.js';
import { PeerManager } from './peer-mgr.js';
import { subscribeTopics, broadcastSubBlock, broadcastOrderingBlock, broadcastTx } from './gossip.js';
import type { GossipHandlers } from './gossip.js';
import { requestSubBlock, registerSyncHandler } from './sync.js';

type SubBlockCallback = (sb: SubBlock) => void;
type OrderingBlockCallback = (block: OrderingBlock) => void;
type TxCallback = (tx: UtxoTransaction) => void;

export class NetNode {
  private libp2p: Libp2p | null = null;
  private peerMgr: PeerManager;
  private config: NetConfig;
  private validators: NetValidators;
  private subBlockHandlers: SubBlockCallback[] = [];
  private orderingBlockHandlers: OrderingBlockCallback[] = [];
  private txHandlers: TxCallback[] = [];
  private started = false;

  constructor(config: NetConfig, validators: NetValidators) {
    this.config = config;
    this.validators = validators;
    this.peerMgr = new PeerManager(config);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;

    this.libp2p = await createLibp2p({
      addresses: {
        listen: [this.config.listenAddrs],
      },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        ping: ping(),
      },
      connectionManager: {
        maxConnections: this.config.maxPeers,
      },
    });

    // Track peers on connect/disconnect
    this.libp2p.addEventListener('peer:connect', (evt: any) => {
      const peerId = evt.detail?.toString() ?? 'unknown';
      this.peerMgr.addPeer({
        id: peerId,
        multiaddrs: [],
        protocols: [],
        connectedAt: Date.now(),
      });
    });

    this.libp2p.addEventListener('peer:disconnect', (evt: any) => {
      const peerId = evt.detail?.toString() ?? 'unknown';
      this.peerMgr.removePeer(peerId);
    });

    // Subscribe to gossip topics
    const handlers: GossipHandlers = {
      onSubBlock: (sb) => { for (const cb of this.subBlockHandlers) cb(sb); },
      onOrderingBlock: (block) => { for (const cb of this.orderingBlockHandlers) cb(block); },
      onTx: (tx) => { for (const cb of this.txHandlers) cb(tx); },
    };

    await subscribeTopics(this.libp2p, this.validators, this.peerMgr, handlers);

    // Register sync handler (serves sub-blocks to requesting peers)
    registerSyncHandler(this.libp2p, (_id: string) => {
      // This will be overridden by node — net doesn't own storage
      return null;
    });

    // Connect to bootstrap peers
    for (const addr of this.config.bootstrapPeers) {
      try {
        await this.libp2p.dial(addr);
      } catch {
        // Bootstrap peer unreachable — not fatal
        console.warn(`Bootstrap peer unreachable: ${addr}`);
      }
    }

    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started || !this.libp2p) return;
    await this.libp2p.stop();
    this.libp2p = null;
    this.started = false;
  }

  // -----------------------------------------------------------------------
  // Identity + peers
  // -----------------------------------------------------------------------

  peerId(): string {
    if (!this.libp2p) throw new Error('NetNode not started');
    return this.libp2p.peerId.toString();
  }

  peers(): Peer[] {
    return this.peerMgr.getPeers();
  }

  // -----------------------------------------------------------------------
  // Outbound broadcast
  // -----------------------------------------------------------------------

  async broadcastSubBlock(sb: SubBlock): Promise<void> {
    if (!this.libp2p) return;
    await broadcastSubBlock(this.libp2p, sb);
  }

  async broadcastOrderingBlock(block: OrderingBlock): Promise<void> {
    if (!this.libp2p) return;
    await broadcastOrderingBlock(this.libp2p, block);
  }

  async broadcastTx(tx: UtxoTransaction): Promise<void> {
    if (!this.libp2p) return;
    await broadcastTx(this.libp2p, tx);
  }

  // -----------------------------------------------------------------------
  // Inbound handlers
  // -----------------------------------------------------------------------

  onSubBlock(cb: SubBlockCallback): void {
    this.subBlockHandlers.push(cb);
  }

  onOrderingBlock(cb: OrderingBlockCallback): void {
    this.orderingBlockHandlers.push(cb);
  }

  onTx(cb: TxCallback): void {
    this.txHandlers.push(cb);
  }

  // -----------------------------------------------------------------------
  // Sync
  // -----------------------------------------------------------------------

  async requestSubBlock(id: string, peerId: string): Promise<SubBlock> {
    if (!this.libp2p) throw new Error('NetNode not started');
    return requestSubBlock(this.libp2p, id, peerId, this.config);
  }

  // Expose for node to register storage-backed handler
  get libp2pNode(): Libp2p | null {
    return this.libp2p;
  }
}
```

- [ ] **Step 2: Update `packages/net/src/index.ts`**

```typescript
export { NetNode } from './node.js';
export { loadNetConfig } from './config.js';
export { PeerManager } from './peer-mgr.js';
export { SYNC_PROTOCOL } from './sync.js';
export { TOPICS } from './gossip.js';
export type { NetConfig, NetValidators, Peer, PenaltyType, PenaltyRecord } from './types.js';
```

- [ ] **Step 3: Build and typecheck**

```bash
cd packages/net && pnpm build && pnpm typecheck
```

Expected: Clean.

- [ ] **Step 4: Commit**

```bash
git add packages/net/src/node.ts packages/net/src/index.ts
git commit -m "feat: NetNode class — lifecycle, broadcast, handlers, sync"
```

---

### Task 10: Net unit tests (mocked libp2p)

**Files:**
- Create: `packages/net/test/gossip.test.ts`

**Interfaces:**
- Consumes: Gossip module, PeerManager, mock validators

- [ ] **Step 1: Write `packages/net/test/gossip.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  verifyContentLimits,
  verifyParentRefsCount,
  verifyProtocolVersion,
} from '@dagsocial/validation';
import type { NetValidators } from '../src/types.js';

// Unit tests for Stage 1 validation logic (extracted for testability)

function runStage1SubBlock(
  sb: any,
  v: NetValidators,
): { valid: boolean; error?: string } {
  const struct = v.verifySubBlockStructure(sb);
  if (!struct.valid) return struct;
  const post = sb.post;
  const content = verifyContentLimits(post.content);
  if (!content.valid) return content;
  const refs = verifyParentRefsCount(post.parentRefs || []);
  if (!refs.valid) return refs;
  if (!v.verifyProtocolVersion(post.protocolVersion || 1)) {
    return { valid: false, error: 'Unsupported protocol version' };
  }
  return { valid: true };
}

function makeMockValidators(): NetValidators {
  return {
    verifyPoW: vi.fn().mockReturnValue(true),
    verifyPostSignature: vi.fn().mockReturnValue(true),
    verifyProtocolVersion: (v: number) => v === 1,
    verifyContentLimits,
    verifyParentRefsCount,
    verifySubBlockStructure: (sb: any) => {
      if (!sb.post) return { valid: false, error: 'Sub-block missing post' };
      if (!Array.isArray(sb.likeBoxes)) return { valid: false, error: 'likeBoxes must be array' };
      if (typeof sb.protocolVersion !== 'number') return { valid: false, error: 'missing protocolVersion' };
      return { valid: true };
    },
    verifyTxStructure: vi.fn().mockReturnValue({ valid: true }),
    verifyOrderingBlockStructure: vi.fn().mockReturnValue({ valid: true }),
  };
}

describe('Stage 1 sub-block validation', () => {
  const validators = makeMockValidators();

  it('accepts a valid sub-block', () => {
    const sb = {
      post: { content: 'hello', author: 'user1', parentRefs: [], challenge: new Uint8Array(32), powNonce: 0, protocolVersion: 1, timestamp: Date.now(), signature: new Uint8Array(64) },
      subBlockId: 'abc123',
      likeBoxes: [],
      producerId: 'user1',
      protocolVersion: 1,
    };
    expect(runStage1SubBlock(sb, validators)).toEqual({ valid: true });
  });

  it('rejects empty content', () => {
    const sb = {
      post: { content: '', author: 'user1', parentRefs: [], protocolVersion: 1 },
      subBlockId: 'abc',
      likeBoxes: [],
      producerId: 'user1',
      protocolVersion: 1,
    };
    const result = runStage1SubBlock(sb, validators);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Content is empty');
  });

  it('rejects content exceeding 300 bytes', () => {
    const sb = {
      post: { content: 'x'.repeat(301), author: 'user1', parentRefs: [], protocolVersion: 1 },
      subBlockId: 'abc',
      likeBoxes: [],
      producerId: 'user1',
      protocolVersion: 1,
    };
    expect(runStage1SubBlock(sb, validators).valid).toBe(false);
  });

  it('rejects too many parent refs', () => {
    const sb = {
      post: { content: 'hello', author: 'user1', parentRefs: Array.from({ length: 9 }, (_, i) => `ref${i}`), protocolVersion: 1 },
      subBlockId: 'abc',
      likeBoxes: [],
      producerId: 'user1',
      protocolVersion: 1,
    };
    expect(runStage1SubBlock(sb, validators).valid).toBe(false);
  });

  it('rejects unsupported protocol version', () => {
    const sb = {
      post: { content: 'hello', author: 'user1', parentRefs: [], protocolVersion: 999 },
      subBlockId: 'abc',
      likeBoxes: [],
      producerId: 'user1',
      protocolVersion: 1,
    };
    expect(runStage1SubBlock(sb, validators).valid).toBe(false);
  });

  it('rejects sub-block with missing post', () => {
    const sb = {
      subBlockId: 'abc',
      likeBoxes: [],
      producerId: 'user1',
      protocolVersion: 1,
    };
    expect(runStage1SubBlock(sb, validators).valid).toBe(false);
  });

  it('rejects sub-block with non-array likeBoxes', () => {
    const sb = {
      post: { content: 'hello', author: 'user1', parentRefs: [], protocolVersion: 1 },
      subBlockId: 'abc',
      likeBoxes: 'not-array',
      producerId: 'user1',
      protocolVersion: 1,
    };
    expect(runStage1SubBlock(sb, validators).valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd packages/net && pnpm test
```

Expected: All tests pass (config + peer-mgr + sync + gossip = approximately 22 tests).

- [ ] **Step 3: Commit**

```bash
git add packages/net/test/gossip.test.ts
git commit -m "test: Stage 1 sub-block validation unit tests"
```

---

### Task 11: Net integration tests (two real libp2p nodes)

**Files:**
- Create: `packages/net/test/integration.test.ts`

**Interfaces:**
- Consumes: NetNode, NetConfig, types

- [ ] **Step 1: Write `packages/net/test/integration.test.ts`**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPair, getUserId, computePostId } from '@dagsocial/types';
import type { Post, SubBlock, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import {
  verifyPoW,
  verifyPostSignature,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifySubBlockStructure,
  verifyTxStructure,
  verifyOrderingBlockStructure,
} from '@dagsocial/validation';
import { NetNode } from '../src/node.js';
import { loadNetConfig } from '../src/config.js';
import type { NetConfig, NetValidators } from '../src/types.js';

function makeConfig(port: number): NetConfig {
  return {
    bootstrapPeers: [`/ip4/127.0.0.1/tcp/${port}`],
    listenAddrs: `/ip4/0.0.0.0/tcp/0`,
    maxPeers: 10,
    penaltyScoreThreshold: 500,
    temporalBanDurationMs: 3600000,
    penaltySafeIntervalMs: 120000,
    peerEvictionIntervalMs: 3600000,
    syncRequestTimeoutMs: 10000,
  };
}

const validators: NetValidators = {
  verifyPoW,
  verifyPostSignature,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifySubBlockStructure,
  verifyTxStructure,
  verifyOrderingBlockStructure,
};

// Increase timeout for integration tests
const TIMEOUT = 20000;

describe('Two-node integration', () => {
  let nodeA: NetNode;
  let nodeB: NetNode;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
  });

  it('node A starts and gets a peer ID', async () => {
    nodeA = new NetNode(makeConfig(0), validators);
    await nodeA.start();
    const id = nodeA.peerId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  }, TIMEOUT);

  it('two nodes connect to each other', async () => {
    // Start node A first
    nodeA = new NetNode(makeConfig(0), validators);
    await nodeA.start();

    // Get node A's listen addresses
    const multiaddrs = nodeA.libp2pNode?.getMultiaddrs() ?? [];
    expect(multiaddrs.length).toBeGreaterThan(0);

    // Start node B with A as bootstrap
    const configB = makeConfig(0);
    configB.bootstrapPeers = [multiaddrs[0]!.toString()];
    nodeB = new NetNode(configB, validators);
    await nodeB.start();

    // Give them a moment to establish the connection
    await new Promise((r) => setTimeout(r, 2000));

    // Both should see at least 1 peer (each other)
    expect(nodeA.peers().length).toBeGreaterThanOrEqual(1);
    expect(nodeB.peers().length).toBeGreaterThanOrEqual(1);
  }, TIMEOUT);

  it('sub-block propagates from A to B via gossip', async () => {
    // Start node A
    nodeA = new NetNode(makeConfig(0), validators);
    await nodeA.start();
    const multiaddrs = nodeA.libp2pNode?.getMultiaddrs() ?? [];

    // Start node B with A as bootstrap
    const configB = makeConfig(0);
    configB.bootstrapPeers = [multiaddrs[0]!.toString()];
    nodeB = new NetNode(configB, validators);
    await nodeB.start();

    // Wait for connection
    await new Promise((r) => setTimeout(r, 2000));

    // Register handler on B
    let receivedSubBlock: SubBlock | null = null;
    nodeB.onSubBlock((sb) => {
      receivedSubBlock = sb;
    });

    // Create a valid sub-block and broadcast from A
    const kp = generateKeyPair();
    const post: Post = {
      content: 'hello from integration test',
      author: getUserId(kp.publicKey),
      parentRefs: [],
      challenge: new Uint8Array(32),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: Date.now(),
      signature: new Uint8Array(64),
    };
    const sb: SubBlock = {
      subBlockId: computePostId(post),
      post,
      likeBoxes: [],
      producerId: post.author,
      protocolVersion: 1,
    };

    await nodeA.broadcastSubBlock(sb);

    // Wait for gossip propagation
    await new Promise((r) => setTimeout(r, 3000));

    expect(receivedSubBlock).not.toBeNull();
    expect(receivedSubBlock!.subBlockId).toBe(sb.subBlockId);
    expect(receivedSubBlock!.post.content).toBe('hello from integration test');
  }, TIMEOUT);

  it('ordering block propagates from A to B', async () => {
    nodeA = new NetNode(makeConfig(0), validators);
    await nodeA.start();
    const multiaddrs = nodeA.libp2pNode?.getMultiaddrs() ?? [];
    const configB = makeConfig(0);
    configB.bootstrapPeers = [multiaddrs[0]!.toString()];
    nodeB = new NetNode(configB, validators);
    await nodeB.start();
    await new Promise((r) => setTimeout(r, 2000));

    let receivedBlock: OrderingBlock | null = null;
    nodeB.onOrderingBlock((block) => { receivedBlock = block; });

    const block: OrderingBlock = {
      height: 1,
      hash: 'test-hash-123',
      prevBlockHash: '00000000000000000000000000000000',
      subBlockRefs: [],
      likeBoxIds: [],
      utxoTxIds: [],
      stumpIds: [],
      validatorId: 'validator-1',
      validatorSignature: new Uint8Array(64),
      protocolVersion: 1,
      createdAt: Date.now(),
    };

    await nodeA.broadcastOrderingBlock(block);
    await new Promise((r) => setTimeout(r, 3000));

    expect(receivedBlock).not.toBeNull();
    expect(receivedBlock!.height).toBe(1);
    expect(receivedBlock!.hash).toBe('test-hash-123');
  }, TIMEOUT);

  it('invalid sub-block does NOT trigger handler on B', async () => {
    nodeA = new NetNode(makeConfig(0), validators);
    await nodeA.start();
    const multiaddrs = nodeA.libp2pNode?.getMultiaddrs() ?? [];
    const configB = makeConfig(0);
    configB.bootstrapPeers = [multiaddrs[0]!.toString()];
    nodeB = new NetNode(configB, validators);
    await nodeB.start();
    await new Promise((r) => setTimeout(r, 2000));

    let received = false;
    nodeB.onSubBlock(() => { received = true; });

    // Broadcast an invalid sub-block (empty content)
    const invalidSb = {
      subBlockId: 'bad',
      post: { content: '', author: 'user1', parentRefs: [], protocolVersion: 1 },
      likeBoxes: [],
      producerId: 'user1',
      protocolVersion: 1,
    } as unknown as SubBlock;

    await nodeA.broadcastSubBlock(invalidSb);
    await new Promise((r) => setTimeout(r, 3000));

    expect(received).toBe(false);
  }, TIMEOUT);
});
```

- [ ] **Step 2: Run integration tests**

```bash
cd packages/net && pnpm test
```

Expected: Integration tests pass (may take ~30 seconds for libp2p to negotiate connections).

- [ ] **Step 3: Commit**

```bash
git add packages/net/test/integration.test.ts
git commit -m "test: two-node libp2p integration tests"
```

---

### Task 12: Create net instance singleton module

**Files:**
- Create: `packages/node/src/services/net-instance.ts`

**Interfaces:**
- Produces: `getNet(): NetNode | null`, `setNet(n: NetNode): void`

A simple singleton holder so route handlers and services can access the NetNode without circular imports from index.ts.

- [ ] **Step 1: Write `packages/node/src/services/net-instance.ts`**

```typescript
import type { NetNode } from '@dagsocial/net';

let netInstance: NetNode | null = null;

export function getNet(): NetNode | null {
  return netInstance;
}

export function setNet(n: NetNode): void {
  netInstance = n;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/node/src/services/net-instance.ts
git commit -m "feat: net instance singleton for cross-module access"
```

---

### Task 14: Update node config to include net settings

**Files:**
- Modify: `packages/node/src/config.ts`

**Interfaces:**
- Consumes: Existing Config interface
- Produces: Config extended with net fields

- [ ] **Step 1: Update `packages/node/src/config.ts`**

Add net configuration fields:

```typescript
import {
  POST_POW_TARGET_BITS,
  CHALLENGE_WINDOW_BLOCKS,
  EPOCH_BLOCKS,
} from '@dagsocial/types';

export interface Config {
  port: number;
  dbPath: string;
  networkMode: string;
  postPowTargetBits: number;
  challengeWindowBlocks: number;
  orderingBlockIntervalMs: number;
  orderingBlockMinSubBlocks: number;
  maxSubBlocksPerBlock: number;
  epochBlocks: number;
  // Net settings
  bootstrapPeers: string[];
  listenAddrs: string;
  maxPeers: number;
}

export function loadConfig(): Readonly<Config> {
  const cfg: Config = {
    port: parseInt(process.env['PORT'] ?? '3000', 10),
    dbPath: process.env['DB_PATH'] ?? 'dagsocial.db',
    networkMode: process.env['NETWORK_MODE'] ?? 'testnet',
    postPowTargetBits: parseInt(
      process.env['POST_POW_TARGET_BITS'] ?? String(POST_POW_TARGET_BITS),
      10,
    ),
    challengeWindowBlocks: parseInt(
      process.env['CHALLENGE_WINDOW_BLOCKS'] ?? String(CHALLENGE_WINDOW_BLOCKS),
      10,
    ),
    orderingBlockIntervalMs: parseInt(
      process.env['ORDERING_BLOCK_INTERVAL_MS'] ?? '60000',
      10,
    ),
    orderingBlockMinSubBlocks: parseInt(
      process.env['ORDERING_BLOCK_MIN_SUB_BLOCKS'] ?? '1',
      10,
    ),
    maxSubBlocksPerBlock: parseInt(
      process.env['MAX_SUB_BLOCKS_PER_BLOCK'] ?? '1000',
      10,
    ),
    epochBlocks: parseInt(
      process.env['EPOCH_BLOCKS'] ?? String(EPOCH_BLOCKS),
      10,
    ),
    // Net settings
    bootstrapPeers: parseBootstrapPeers(process.env['BOOTSTRAP_PEERS'] ?? ''),
    listenAddrs: process.env['LISTEN_ADDRS'] ?? '/ip4/0.0.0.0/tcp/0',
    maxPeers: parseInt(process.env['MAX_PEERS'] ?? '50', 10),
  };

  return Object.freeze(cfg);
}

function parseBootstrapPeers(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = loadConfig();
```

- [ ] **Step 2: Build and typecheck**

```bash
cd packages/node && pnpm build && pnpm typecheck
```

Expected: Clean.

- [ ] **Step 3: Commit**

```bash
git add packages/node/src/config.ts
git commit -m "feat: add net configuration fields to node config"
```

---

### Task 15: Add verifyPostForRelay to verifier

**Files:**
- Modify: `packages/node/src/services/verifier.ts`

**Interfaces:**
- Produces: `verifyPostForRelay(deps, post, currentBlockHeight): VerificationResult`

- [ ] **Step 1: Add `verifyPostForRelay` to verifier**

After the existing `verifyPost` function, add:

```typescript
/**
 * Verify a relayed post (received via gossip). Same as verifyPost but skips
 * the challenge check — the challenge was local to the origin node.
 *
 * Stage 2 validation: runs after Stage 1 (stateless checks in net package)
 * has already passed. Adds stateful checks: parent refs exist, karma
 * sufficient.
 */
export function verifyPostForRelay(
  deps: VerifierDeps,
  post: Post,
  currentBlockHeight: number,
): VerificationResult {
  // 1. Content: already checked by Stage 1, but re-verify
  const contentBytes = Buffer.byteLength(post.content, 'utf8');
  if (contentBytes === 0) {
    return { valid: false, error: 'Content is empty' };
  }
  if (contentBytes > MAX_CONTENT_BYTES) {
    return { valid: false, error: 'Content exceeds max length' };
  }

  // 2. Parent refs count
  if (post.parentRefs.length > MAX_PARENT_REFS) {
    return { valid: false, error: `Too many parent refs (max ${MAX_PARENT_REFS})` };
  }

  // 3. Protocol version
  if (post.protocolVersion !== PROTOCOL_VERSION) {
    return { valid: false, error: 'Unsupported protocol version' };
  }

  // 4. Challenge is NOT checked — challenge was node-local to origin

  // 5. PoW: re-verify (stateless, cheap)
  const powInput = Buffer.concat([
    Buffer.from(post.content),
    Buffer.from(post.author),
    ...post.parentRefs.map((r) => Buffer.from(r)),
    Buffer.from(post.challenge),
    Buffer.from(String(post.protocolVersion)),
    Buffer.from(String(post.timestamp)),
  ]);
  if (!verifyPoW(powInput, post.powNonce, POST_POW_TARGET_BITS)) {
    return { valid: false, error: 'Proof of Work invalid' };
  }

  // 6. Signature
  const identity = deps.getIdentity(post.author);
  if (!identity) {
    return { valid: false, error: 'Author identity not found on this node' };
  }
  // verifyPostSignature is from @dagsocial/validation
  if (!verifyPostSignature(post, identity.publicKey)) {
    return { valid: false, error: 'Signature invalid' };
  }

  // 7. Karma
  const karmaBox = deps.getKarmaBox(identity.publicKey);
  if (!karmaBox) {
    return { valid: false, error: 'No karma box found' };
  }
  const requiredKarma =
    post.parentRefs.length === 0 ? POST_LOCK_THREAD_COST : POST_LOCK_REPLY_COST;
  if (karmaBox.value < requiredKarma) {
    return {
      valid: false,
      error: `Insufficient karma: need ${requiredKarma} (have ${karmaBox.value})`,
    };
  }

  // 8. Parent refs exist
  for (const parentId of post.parentRefs) {
    if (!deps.getPost(parentId)) {
      return { valid: false, error: `Parent post not found: ${parentId}` };
    }
  }

  return { valid: true };
}
```

And update the imports to add:

```typescript
import { verifyPoW, verifyPostSignature } from '@dagsocial/validation';
```

- [ ] **Step 2: Build, typecheck, run tests**

```bash
pnpm build && pnpm typecheck && pnpm test
```

Expected: All 198+ tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/node/src/services/verifier.ts
git commit -m "feat: add verifyPostForRelay for Stage 2 validation of gossiped posts"
```

---

### Task 16: Wire net into node startup

**Files:**
- Modify: `packages/node/src/index.ts`
- Modify: `packages/node/package.json` (add @dagsocial/net dependency)

**Interfaces:**
- Consumes: NetNode from @dagsocial/net, all validation functions, config

- [ ] **Step 1: Update `packages/node/package.json`**

Add to dependencies:
```json
"@dagsocial/net": "workspace:*",
"@dagsocial/validation": "workspace:*"
```

- [ ] **Step 2: Rewrite `packages/node/src/index.ts`**

```typescript
import { loadConfig } from './config.js';
import { initDb, closeDb } from './store/db.js';
import { startBlockCreator, stopBlockCreator } from './services/block-creator.js';
import { createApp } from './server.js';
import { NetNode } from '@dagsocial/net';
import * as validation from '@dagsocial/validation';
import { verifyPostForRelay } from './services/verifier.js';
import { setNet } from './services/net-instance.js';
import { getIdentity } from './store/identities.js';
import { getKarmaBox, getPost, insertPost, insertSubBlock, insertBox } from './store/index.js';

const config = loadConfig();

// 1. Init DB
initDb(config.dbPath);

// 2. Create NetNode
const net = new NetNode(
  {
    bootstrapPeers: config.bootstrapPeers,
    listenAddrs: config.listenAddrs,
    maxPeers: config.maxPeers,
    penaltyScoreThreshold: parseInt(process.env['PENALTY_SCORE_THRESHOLD'] ?? '500', 10),
    temporalBanDurationMs: parseInt(process.env['TEMPORAL_BAN_DURATION_MS'] ?? '3600000', 10),
    penaltySafeIntervalMs: parseInt(process.env['PENALTY_SAFE_INTERVAL_MS'] ?? '120000', 10),
    peerEvictionIntervalMs: parseInt(process.env['PEER_EVICTION_INTERVAL_MS'] ?? '3600000', 10),
    syncRequestTimeoutMs: parseInt(process.env['SYNC_REQUEST_TIMEOUT_MS'] ?? '10000', 10),
  },
  validation,
);
setNet(net);

// 3. Register Stage 2 handlers
net.onSubBlock((sb) => {
  const result = verifyPostForRelay(
    {
      getActiveChallenge: () => null,
      getIdentity,
      getKarmaBox: (pubKey) => getKarmaBox(pubKey),
      getPost,
    },
    sb.post,
    0,
  );
  if (!result.valid) {
    console.warn(`Relayed sub-block rejected: ${result.error}`);
    return;
  }
  // Store post and sub-block
  insertPost(sb.post, Buffer.from(encodePost(sb.post)));
  insertSubBlock(sb);
  // Store like boxes
  for (const lb of sb.likeBoxes) {
    insertBox(lb);
  }
});

net.onOrderingBlock((block) => {
  console.log(`Received ordering block height=${block.height} hash=${block.hash}`);
  // Full block application (chain fork handling) deferred to future task.
  // Local block creator owns ordering block production for now.
});

net.onTx((tx) => {
  const { validateAndApplyTx } = require('./services/utxo-engine.js');
  const result = validateAndApplyTx(tx, 0);
  if (!result.valid) {
    console.warn(`Relayed tx rejected: ${result.error}`);
    return;
  }
  console.log(`Relayed tx accepted: ${tx.inputs.length} inputs`);
});

// 4. Start net
try {
  await net.start();
  console.log(`Net node started, peer ID: ${net.peerId()}`);
} catch (err) {
  console.warn(`Net startup failed (continuing without networking): ${String(err)}`);
}

// 5. Start HTTP server and block creator
startBlockCreator(config);
const app = createApp(config);
const server = app.listen(config.port, () => {
  console.log(`DAGsocial node listening on :${config.port}`);
});

// 6. Graceful shutdown
process.on('SIGINT', async () => {
  stopBlockCreator();
  await net.stop();
  closeDb();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  stopBlockCreator();
  await net.stop();
  closeDb();
  server.close();
  process.exit(0);
});
```

Note: Also add `import { encodePost } from '@dagsocial/types';` to the imports.

- [ ] **Step 3: Build and typecheck**

```bash
cd packages/node && pnpm build && pnpm typecheck
```

Expected: May have type errors from the async imports — resolve them.

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/index.ts packages/node/package.json
git commit -m "feat: wire NetNode into node startup with Stage 2 handlers"
```

---

### Task 17: Update route handlers to broadcast

**Files:**
- Modify: `packages/node/src/routes/posts.ts`
- Modify: `packages/node/src/routes/likes.ts`
- Modify: `packages/node/src/routes/invites.ts`
- Modify: `packages/node/src/services/block-creator.ts`

**Interfaces:**
- Consumes: `net` from index.ts (or passed via app locals)

- [ ] **Step 1: Update `packages/node/src/routes/posts.ts`**

After the post is created and the sub-block is assembled, add a broadcast call. Find the line after `insertSubBlock` in the POST handler and add:

```typescript
// After sub-block is stored and challenge consumed:
import { getNet } from '../services/net-instance.js';
const net = getNet();
if (net) {
  net.broadcastSubBlock(subBlock).catch((err: Error) => {
    console.warn(`Failed to broadcast sub-block: ${err.message}`);
  });
}
```

- [ ] **Step 2: Update `packages/node/src/routes/likes.ts`**

Add `import { getNet } from '../services/net-instance.js';` at the top.
After a like box is created (for locked likes), broadcast:

```typescript
const net = getNet();
if (net && likeBox) {
  net.broadcastTx({
    inputs: [karmaBoxId],
    outputs: [newKarmaBox, likeBox],
    signatures: {},
    protocolVersion: 1,
  }).catch((err: Error) => {
    console.warn(`Failed to broadcast like tx: ${err.message}`);
  });
}
```

- [ ] **Step 3: Update `packages/node/src/routes/invites.ts`**

Add `import { getNet } from '../services/net-instance.js';` at the top.
After invite creation, claim, or cancel, broadcast the UTXO transaction:

```typescript
const net = getNet();
if (net) {
  net.broadcastTx(tx).catch((err: Error) => {
    console.warn(`Failed to broadcast invite tx: ${err.message}`);
  });
}
```

- [ ] **Step 4: Update `packages/node/src/services/block-creator.ts`**

Add `import { getNet } from './net-instance.js';` at the top.
After an ordering block is created and stored, broadcast it:

```typescript
const net = getNet();
if (net) {
  net.broadcastOrderingBlock(block).catch((err: Error) => {
    console.warn(`Failed to broadcast ordering block: ${err.message}`);
  });
}
```

- [ ] **Step 5: Build, typecheck, and run tests**

```bash
pnpm build && pnpm typecheck && pnpm test
```

Expected: All tests pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add packages/node/src/routes/posts.ts packages/node/src/routes/likes.ts
git add packages/node/src/routes/invites.ts packages/node/src/services/block-creator.ts
git commit -m "feat: broadcast sub-blocks, txs, and ordering blocks to peers"
```

---

### Task 18: Final integration — end-to-end smoke test

**Files:**
- Modify: None (manual verification)
- Run: Full test suite

- [ ] **Step 1: Run full test suite**

```bash
pnpm build
pnpm typecheck
pnpm test
```

Expected: All tests pass. Validation tests (~23), net tests (~22 config + peer-mgr + gossip + sync + integration), existing node tests (134). No regressions.

- [ ] **Step 2: Manual smoke test**

Start two nodes:

Terminal 1:
```bash
PORT=3001 DB_PATH=node-a.db LISTEN_ADDRS=/ip4/0.0.0.0/tcp/9001 node packages/node/dist/index.js
```

Terminal 2:
```bash
PORT=3002 DB_PATH=node-b.db LISTEN_ADDRS=/ip4/0.0.0.0/tcp/9002 BOOTSTRAP_PEERS=/ip4/127.0.0.1/tcp/9001 node packages/node/dist/index.js
```

Verify:
- Both nodes start and show peer IDs
- Node B connects to node A (check logs)
- Create a post on node A via the API
- Check that node B receives it (log output)

- [ ] **Step 3: Update `contracts/NET_INTERFACE.md`**

Add the following changes:
- Add `@dagsocial/validation` to dependency list in Scope section
- Document two-stage validation split (Stage 1 stateless, Stage 2 stateful)
- Add penalty parameters to configuration table
- Add sync protocol specification (`/dagsocial/sync/1`)
- Update preconditions to include `@dagsocial/validation`

- [ ] **Step 4: Final commit**

```bash
git add contracts/NET_INTERFACE.md
git commit -m "docs: update NET_INTERFACE.md with validation split and sync protocol"
```

---

## Post-Plan Verification

After implementing all tasks:
- `pnpm build` — all three packages build cleanly
- `pnpm typecheck` — zero type errors across all packages
- `pnpm test` — all tests pass (validation + net + node)
- Two nodes can connect via libp2p, gossip sub-blocks, ordering blocks, and UTXO txs
- Node gracefully degrades when bootstrap peers are unreachable
- Invalid gossip messages are dropped and peers penalized
