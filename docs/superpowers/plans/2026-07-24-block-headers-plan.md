# Block Headers: Header/Body Split with Merkle Roots — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the monolithic `OrderingBlock` with a formal header/body split using two Merkle roots (subBlockRoot + utxoTxRoot), plus a reserved stateRoot slot.

**Architecture:** Extract `buildMerkleRoot` from the stump engine into `@dagsocial/types` as a public export. Introduce `BlockHeader`, `SubBlockTree`, `UtxoTxTree` types. The header IS the block hash target — PoW hashes the header (with nonce zeroed), the validator signs the header hash. The old `computeBlockBodyHash` is removed.

**Tech Stack:** TypeScript, pnpm workspaces, `@dagsocial/types` → `@dagsocial/validation` → `@dagsocial/net` → `@dagsocial/node`. Node.js ≥ 22, `blake2b512` truncated to 32 bytes.

## Global Constraints

- Node.js ≥ 22 (no blake2b256; use `blake2b512` → `.subarray(0, 32)`)
- Hashes on wire: hex strings (64 chars for 32 bytes, 66 chars for 33 bytes)
- Public keys: `Uint8Array` (32 bytes) internally, hex on JSON wire
- Signatures: `Uint8Array` (64 bytes) internally, hex on JSON wire
- CBOR codec for on-disk and gossip serialization
- Fresh DB required — no migration path
- 353 tests must pass when complete

---

### Task 1: Extract Merkle tree + leafHash to @dagsocial/types

**Files:**
- Create: `packages/types/src/merkle.ts`
- Modify: `packages/types/src/index.ts`
- Modify: `packages/node/src/services/stump-engine.ts`

**Interfaces:**
- Consumes: nothing (new file, depends only on Node.js `crypto`)
- Produces:
  - `buildMerkleRoot(leafHashes: Uint8Array[]): Uint8Array`
  - `leafHash(domain: string, data: Uint8Array): Uint8Array`
  - `nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array`

- [ ] **Step 1: Create `packages/types/src/merkle.ts`**

```ts
import { createHash } from 'crypto';

/**
 * Domain-separated leaf hash for Merkle trees.
 * Prevents cross-tree collision (a subBlock ID hash can't collide with a
 * UTXO tx ID hash even if the underlying bytes match).
 */
export function leafHash(domain: string, data: Uint8Array): Uint8Array {
  const domainBytes = Buffer.from(domain + '\0', 'utf8');
  return createHash('blake2b512')
    .update(domainBytes)
    .update(Buffer.from(data))
    .digest()
    .subarray(0, 32);
}

/**
 * Hash of two child nodes in the Merkle tree.
 */
export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return createHash('blake2b512')
    .update(Buffer.from(left))
    .update(Buffer.from(right))
    .digest()
    .subarray(0, 32);
}

/**
 * Build a standard binary Merkle root from an ordered list of leaf hashes.
 * Empty tree → 32 zero bytes. Single leaf → that leaf IS the root.
 */
export function buildMerkleRoot(leafHashes: Uint8Array[]): Uint8Array {
  if (leafHashes.length === 0) {
    return new Uint8Array(32);
  }
  if (leafHashes.length === 1) {
    return leafHashes[0]!;
  }

  let level = leafHashes;

  while (level.length > 1) {
    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        nextLevel.push(nodeHash(level[i]!, level[i + 1]!));
      } else {
        nextLevel.push(level[i]!);
      }
    }
    level = nextLevel;
  }

  return level[0]!;
}
```

- [ ] **Step 2: Run types tests to verify the new file compiles**

```bash
pnpm --filter @dagsocial/types test
```

Expected: types tests pass (new file is additive, no breakage yet).

- [ ] **Step 3: Update `packages/types/src/index.ts` — add merkle exports**

Insert after the base58 exports (line 47 area):

```ts
// Merkle tree
export { leafHash, nodeHash, buildMerkleRoot } from './merkle.js';
```

- [ ] **Step 4: Update `packages/node/src/services/stump-engine.ts` — import from types**

Replace the private `leafHash`, `nodeHash`, and `buildMerkleRoot` functions (lines 23-70) with imports from `@dagsocial/types`.

Old code to remove (lines 1-70, the Merkle helpers and their `createHash` import if no longer needed):

```ts
import { createHash } from 'crypto';
import {
  computePostId,
  PROTOCOL_VERSION,
  leafHash,
  nodeHash,
  buildMerkleRoot,
} from '@dagsocial/types';
```

The `createHash` import can be removed from stump-engine.ts if it's only used by the Merkle helpers — check if any other function in the file uses `createHash` directly. In the current file, `createHash` is only used in the Merkle helpers (lines 23-69) and nowhere else. Remove the import.

The stump engine's use of `leafHash(postId)` changes to `leafHash('stump', Buffer.from(postId))`:

In `executePrune()` (around line 140 in current file), find the line:
```ts
const leafHashes = allPostIds.map(leafHash);
```
Change to:
```ts
const leafHashes = allPostIds.map((id) => leafHash('stump', Buffer.from(id, 'hex')));
```

- [ ] **Step 5: Run node tests to verify stump engine still works**

```bash
pnpm --filter @dagsocial/node test
```

Expected: all tests pass (same Merkle root computation, just different file).

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/merkle.ts packages/types/src/index.ts packages/node/src/services/stump-engine.ts
git commit -m "refactor: extract Merkle tree helpers to @dagsocial/types

leafHash now takes a domain tag for cross-tree collision resistance.
Stump engine updated to use domain 'stump'.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: New block types in @dagsocial/types

**Files:**
- Modify: `packages/types/src/block.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `BlockHeader`, `SubBlockTree`, `UtxoTxTree`, updated `OrderingBlock`, `EMPTY_STATE_ROOT` constant

- [ ] **Step 1: Rewrite `packages/types/src/block.ts`**

Replace the entire file content:

```ts
import type { UserId } from './identity.js';
import type { Post, PostId } from './post.js';
import type { BoxId, TxId, LikeBox } from './utxo.js';
import type { StumpId } from './stump.js';

// ---------------------------------------------------------------------------
// Like reward (computed during epoch tally)
// ---------------------------------------------------------------------------

export interface LikeReward {
  targetPostId: PostId;
  likeCount: number;
  authorReward: number;
  likerRefunds: Record<string, number>;  // likerId → net karma refund
  postLockKarmaUnlocked?: number;         // Karma released from post lock this epoch
}

// ---------------------------------------------------------------------------
// Sub-block (user-produced)
// ---------------------------------------------------------------------------

export interface SubBlock {
  subBlockId: PostId;         // = post.postId (the post IS the sub-block)
  post: Post;                 // The post (with PoW = sub-block proof)
  likeBoxes: LikeBox[];       // Pending likes riding as sidecars
  producerId: UserId;         // = post.author
  protocolVersion: number;
}

// ---------------------------------------------------------------------------
// Epoch tally
// ---------------------------------------------------------------------------

export interface EpochTally {
  rewards: Record<PostId, LikeReward>;
}

// ---------------------------------------------------------------------------
// Coinbase output (block reward)
// ---------------------------------------------------------------------------

export interface CoinbaseOutput {
  owner: UserId;              // 32-byte recipient public key
  value: number;              // Credits minted
  lockedUntilBlock: number;   // Height at which credits become spendable
  isTreasury: boolean;        // Treasury or miner output
}

// ---------------------------------------------------------------------------
// Block header — what gets hashed for block ID and PoW
// ---------------------------------------------------------------------------

export interface BlockHeader {
  protocolVersion: number;
  height: number;
  prevBlockHash: string;        // hex(32) — hash of previous header
  subBlockRoot: string;         // hex(32) — Merkle root over DAG content
  utxoTxRoot: string;           // hex(32) — Merkle root over UTXO content
  stateRoot: string;            // hex(33) — AVL+ digest (zeroed for MVP)
  validatorId: UserId;
  powNonce: number;
  powTargetBits: number;
  createdAt: number;            // unix ms
}

/** 33 zero bytes — placeholder for future AVL+ state root. */
export const EMPTY_STATE_ROOT = '00'.repeat(33);

// ---------------------------------------------------------------------------
// Body sections (independently requestable)
// ---------------------------------------------------------------------------

export interface SubBlockTree {
  subBlockRefs: PostId[];       // sub-blocks anchored in this block
  stumpIds: StumpId[];          // stumps committed in this block
}

export interface UtxoTxTree {
  utxoTxIds: TxId[];            // UTXO transactions
  likeBoxIds: BoxId[];          // standalone likes (no sub-block to ride)
  coinbaseOutputs: CoinbaseOutput[];
  epochTallyResults?: EpochTally;
}

// ---------------------------------------------------------------------------
// Ordering block (validator-produced)
// ---------------------------------------------------------------------------

export interface OrderingBlock {
  header: BlockHeader;
  subBlockTree: SubBlockTree;
  utxoTxTree: UtxoTxTree;
  validatorSignature: Uint8Array;  // 64 bytes — Ed25519 over header hash
}
```

- [ ] **Step 2: Run typecheck to verify no immediate downstream breakage**

```bash
pnpm typecheck 2>&1 | head -50
```

Expected: many type errors (all consumers of `OrderingBlock` still reference flat fields). We fix these in subsequent tasks. This step confirms the types file itself compiles.

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/block.ts
git commit -m "feat: add BlockHeader, SubBlockTree, UtxoTxTree types

Replace flat OrderingBlock with nested header/body structure.
EMPTY_STATE_ROOT constant for the 33-byte zeroed state root slot.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Serialization for new block types

**Files:**
- Modify: `packages/types/src/serialization.ts`
- Modify: `packages/types/src/index.ts`

**Interfaces:**
- Consumes: `BlockHeader`, `SubBlockTree`, `UtxoTxTree`, `OrderingBlock` from block.ts
- Produces:
  - `encodeHeader(h: BlockHeader): Uint8Array`
  - `decodeHeader(buf: Uint8Array): BlockHeader`
  - `encodeSubBlockTree(t: SubBlockTree): Uint8Array`
  - `decodeSubBlockTree(buf: Uint8Array): SubBlockTree`
  - `encodeUtxoTxTree(t: UtxoTxTree): Uint8Array`
  - `decodeUtxoTxTree(buf: Uint8Array): UtxoTxTree`
  - Updated `encodeOrderingBlock(b: OrderingBlock): Uint8Array`
  - Updated `decodeOrderingBlock(buf: Uint8Array): OrderingBlock`

- [ ] **Step 1: Rewrite serialization.ts block section**

In `packages/types/src/serialization.ts`, replace the Ordering block section (lines 66-75) and add new encode/decode functions before it:

```ts
import { encode, decode } from 'cbor-x';
import type { Post } from './post.js';
import type { AnyBox, UtxoTransaction } from './utxo.js';
import type { Stump } from './stump.js';
import type {
  SubBlock,
  BlockHeader,
  SubBlockTree,
  UtxoTxTree,
  OrderingBlock,
} from './block.js';

// ... keep existing helpers toBuffer/fromBuffer ...

// ... keep existing encodePost/decodePost, encodeStump/decodeStump,
//     encodeSubBlock/decodeSubBlock, serializeBox, serializeTx/encodeTx/decodeTx ...

// ---------------------------------------------------------------------------
// Block header
// ---------------------------------------------------------------------------

export function encodeHeader(h: BlockHeader): Uint8Array {
  return toBuffer(h);
}

export function decodeHeader(bytes: Uint8Array): BlockHeader {
  return fromBuffer<BlockHeader>(bytes);
}

// ---------------------------------------------------------------------------
// Sub-block tree
// ---------------------------------------------------------------------------

export function encodeSubBlockTree(t: SubBlockTree): Uint8Array {
  return toBuffer(t);
}

export function decodeSubBlockTree(bytes: Uint8Array): SubBlockTree {
  return fromBuffer<SubBlockTree>(bytes);
}

// ---------------------------------------------------------------------------
// UTXO transaction tree
// ---------------------------------------------------------------------------

export function encodeUtxoTxTree(t: UtxoTxTree): Uint8Array {
  return toBuffer(t);
}

export function decodeUtxoTxTree(bytes: Uint8Array): UtxoTxTree {
  return fromBuffer<UtxoTxTree>(bytes);
}

// ---------------------------------------------------------------------------
// Ordering block — length-prefixed wire format
// ---------------------------------------------------------------------------

/**
 * Encode a full ordering block for the wire / on-disk storage.
 *
 * Wire format:
 *   u32BE(headerLen) || headerCbor || u32BE(subTreeLen) || subTreeCbor
 *   || u32BE(utxoTxTreeLen) || utxoTxTreeCbor || validatorSignature (64 bytes)
 */
export function encodeOrderingBlock(block: OrderingBlock): Uint8Array {
  const headerBytes = Buffer.from(encodeHeader(block.header));
  const subBytes = Buffer.from(encodeSubBlockTree(block.subBlockTree));
  const utxoBytes = Buffer.from(encodeUtxoTxTree(block.utxoTxTree));

  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32BE(headerBytes.length);
  const subLen = Buffer.alloc(4);
  subLen.writeUInt32BE(subBytes.length);
  const utxoLen = Buffer.alloc(4);
  utxoLen.writeUInt32BE(utxoBytes.length);

  return new Uint8Array(Buffer.concat([
    headerLen, headerBytes,
    subLen, subBytes,
    utxoLen, utxoBytes,
    Buffer.from(block.validatorSignature),
  ]));
}

/**
 * Decode a length-prefixed ordering block from the wire.
 */
export function decodeOrderingBlock(bytes: Uint8Array): OrderingBlock {
  const buf = Buffer.from(bytes);
  let offset = 0;

  const headerLen = buf.readUInt32BE(offset); offset += 4;
  const header = decodeHeader(buf.subarray(offset, offset + headerLen)); offset += headerLen;

  const subLen = buf.readUInt32BE(offset); offset += 4;
  const subBlockTree = decodeSubBlockTree(buf.subarray(offset, offset + subLen)); offset += subLen;

  const utxoLen = buf.readUInt32BE(offset); offset += 4;
  const utxoTxTree = decodeUtxoTxTree(buf.subarray(offset, offset + utxoLen)); offset += utxoLen;

  const validatorSignature = new Uint8Array(buf.subarray(offset, offset + 64));

  return { header, subBlockTree, utxoTxTree, validatorSignature };
}
```

- [ ] **Step 2: Update index.ts exports**

In `packages/types/src/index.ts`, update the serialization exports:

Replace:
```ts
export {
  serializeBox,
  serializeTx,
  encodePost,
  decodePost,
  encodeStump,
  decodeStump,
  encodeSubBlock,
  decodeSubBlock,
  encodeOrderingBlock,
  decodeOrderingBlock,
  encodeTx,
  decodeTx,
} from './serialization.js';
```

With:
```ts
export {
  serializeBox,
  serializeTx,
  encodePost,
  decodePost,
  encodeStump,
  decodeStump,
  encodeSubBlock,
  decodeSubBlock,
  encodeHeader,
  decodeHeader,
  encodeSubBlockTree,
  decodeSubBlockTree,
  encodeUtxoTxTree,
  decodeUtxoTxTree,
  encodeOrderingBlock,
  decodeOrderingBlock,
  encodeTx,
  decodeTx,
} from './serialization.js';
```

Also update the block type exports to include the new types:

Replace:
```ts
export type { SubBlock, OrderingBlock, CoinbaseOutput, EpochTally, LikeReward } from './block.js';
```

With:
```ts
export {
  EMPTY_STATE_ROOT,
} from './block.js';
export type {
  SubBlock,
  BlockHeader,
  SubBlockTree,
  UtxoTxTree,
  OrderingBlock,
  CoinbaseOutput,
  EpochTally,
  LikeReward,
} from './block.js';
```

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/serialization.ts packages/types/src/index.ts
git commit -m "feat: add serialization for header/body block types

Length-prefixed wire format: u32BE(header) || u32BE(subTree)
|| u32BE(utxoTxTree) || sig(64). Independent section encode/decode
functions exported.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Update @dagsocial/validation

**Files:**
- Modify: `packages/validation/src/verify.ts`
- Modify: `packages/validation/src/index.ts`

**Interfaces:**
- Consumes: `BlockHeader`, `encodeHeader` from types; existing `verifyPoW`
- Produces:
  - `blockHash(header: BlockHeader): string`
  - `computePowHash(header: BlockHeader): Buffer`
  - Updated `verifyOrderingBlockPoW(header: BlockHeader): boolean`
  - Updated `verifyOrderingBlockStructure(block: OrderingBlock): { valid: boolean; error?: string }`
  - Updated `verifyBlockChainLink(block: OrderingBlock, prevBlock: OrderingBlock): boolean`
  - REMOVED: `computeBlockBodyHash`

- [ ] **Step 1: Update imports in `packages/validation/src/verify.ts`**

Replace the import line:
```ts
import { encodeOrderingBlock } from '@dagsocial/types';
import type { Post, SubBlock, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
```

With:
```ts
import { encodeHeader } from '@dagsocial/types';
import type { Post, SubBlock, BlockHeader, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
```

- [ ] **Step 2: Add blockHash and computePowHash, remove computeBlockBodyHash**

In verify.ts, replace the entire block verification section (lines 116-204) with:

```ts
// ---------------------------------------------------------------------------
// verifyOrderingBlockStructure
// ---------------------------------------------------------------------------

export function verifyOrderingBlockStructure(
  block: OrderingBlock,
): { valid: boolean; error?: string } {
  const h = block.header;
  if (!h) return { valid: false, error: 'Ordering block missing header' };
  if (!h.prevBlockHash || h.prevBlockHash.length !== 64) {
    return { valid: false, error: 'Ordering block header missing or invalid prevBlockHash' };
  }
  if (!Array.isArray(block.subBlockTree?.subBlockRefs)) {
    return { valid: false, error: 'Ordering block missing subBlockTree.subBlockRefs' };
  }
  if (!block.validatorSignature || block.validatorSignature.length !== 64) {
    return { valid: false, error: 'Ordering block missing or invalid validatorSignature' };
  }
  if (typeof h.height !== 'number' || h.height < 1) {
    return { valid: false, error: 'Ordering block invalid height' };
  }
  if (typeof h.protocolVersion !== 'number') {
    return { valid: false, error: 'Ordering block header missing protocolVersion' };
  }
  if (typeof h.powNonce !== 'number' || h.powNonce < 0) {
    return { valid: false, error: 'Ordering block missing or invalid powNonce' };
  }
  if (typeof h.powTargetBits !== 'number' || h.powTargetBits < ORDERING_BLOCK_POW_TARGET_FLOOR) {
    return { valid: false, error: 'Ordering block missing or invalid powTargetBits' };
  }
  if (!Array.isArray(block.utxoTxTree?.coinbaseOutputs)) {
    return { valid: false, error: 'Ordering block missing utxoTxTree.coinbaseOutputs' };
  }
  for (const out of block.utxoTxTree.coinbaseOutputs) {
    if (!out.owner || out.owner.length !== 32) {
      return { valid: false, error: 'Coinbase output missing or invalid owner' };
    }
    if (typeof out.value !== 'number' || out.value < 0) {
      return { valid: false, error: 'Coinbase output invalid value' };
    }
    if (typeof out.lockedUntilBlock !== 'number' || out.lockedUntilBlock < h.height) {
      return { valid: false, error: 'Coinbase output invalid lockedUntilBlock' };
    }
  }
  if (!h.subBlockRoot || h.subBlockRoot.length !== 64) {
    return { valid: false, error: 'Ordering block header missing subBlockRoot' };
  }
  if (!h.utxoTxRoot || h.utxoTxRoot.length !== 64) {
    return { valid: false, error: 'Ordering block header missing utxoTxRoot' };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Block hash
// ---------------------------------------------------------------------------

/**
 * The block hash IS the hash of the serialized header.
 */
export function blockHash(header: BlockHeader): string {
  return createHash('blake2b512')
    .update(Buffer.from(encodeHeader(header)))
    .digest()
    .subarray(0, 32)
    .toString('hex');
}

/**
 * Compute the PoW preimage — the serialized header with powNonce=0.
 * The miner hashes this against candidate nonces.
 */
export function computePowHash(header: BlockHeader): Buffer {
  const template = { ...header, powNonce: 0 };
  return createHash('blake2b512')
    .update(Buffer.from(encodeHeader(template)))
    .digest()
    .subarray(0, 32);
}

// ---------------------------------------------------------------------------
// verifyOrderingBlockPoW
// ---------------------------------------------------------------------------

export function verifyOrderingBlockPoW(header: BlockHeader): boolean {
  const preimage = computePowHash(header);
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(header.powNonce));
  const hash = createHash('blake2b512')
    .update(preimage)
    .update(nonceBuf)
    .digest()
    .subarray(0, 32);
  for (let i = 0; i < header.powTargetBits; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    if ((hash[byteIdx]! & (1 << bitIdx)) !== 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// verifyBlockChainLink
// ---------------------------------------------------------------------------

export function verifyBlockChainLink(
  block: OrderingBlock,
  prevBlock: OrderingBlock,
): boolean {
  return (
    block.header.prevBlockHash === blockHash(prevBlock.header) &&
    block.header.height === prevBlock.header.height + 1
  );
}
```

- [ ] **Step 3: Update `packages/validation/src/index.ts` exports**

Replace:
```ts
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
  verifyOrderingBlockPoW,
  computeBlockBodyHash,
} from './verify.js';
```

With:
```ts
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
  verifyOrderingBlockPoW,
  blockHash,
  computePowHash,
} from './verify.js';
```

- [ ] **Step 4: Run validation tests**

```bash
pnpm --filter @dagsocial/validation test
```

Expected: type errors (tests reference the old flat OrderingBlock structure). These get fixed in Task 12.

- [ ] **Step 5: Commit**

```bash
git add packages/validation/src/verify.ts packages/validation/src/index.ts
git commit -m "feat: update validation for header-based block verification

blockHash(header) replaces block.hash. verifyOrderingBlockPoW takes
BlockHeader instead of OrderingBlock. computeBlockBodyHash removed.
verifyBlockChainLink uses blockHash() for chain comparison.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Node DB schema + store/ordering.ts

**Files:**
- Modify: `packages/node/src/store/db.ts`
- Modify: `packages/node/src/store/ordering.ts`

**Interfaces:**
- Consumes: `OrderingBlock`, `BlockHeader`, `SubBlockTree`, `UtxoTxTree` from types; `encodeHeader`, `encodeSubBlockTree`, `encodeUtxoTxTree`, `decodeHeader`, `decodeSubBlockTree`, `decodeUtxoTxTree` from types
- Produces: updated `createOrderingBlock(block)`, `getOrderingBlock(height)`, `getCurrentHeight()`

- [ ] **Step 1: Update `packages/node/src/store/db.ts` — ordering_blocks schema**

Replace the `ordering_blocks` CREATE TABLE statement (lines 111-127):

```ts
  `CREATE TABLE IF NOT EXISTS ordering_blocks (
    height INTEGER PRIMARY KEY,
    header_cbor BLOB NOT NULL,
    subblock_tree_cbor BLOB NOT NULL,
    utxotx_tree_cbor BLOB NOT NULL,
    validator_signature BLOB NOT NULL,  -- 64 bytes
    created_at INTEGER NOT NULL
  )`,
```

Also update the DROP TABLE at the top:
```ts
  'DROP TABLE IF EXISTS ordering_blocks',
```

(No change needed — it's already there. Just ensure the table name hasn't changed.)

- [ ] **Step 2: Rewrite `packages/node/src/store/ordering.ts`**

Replace the entire file:

```ts
import { getDb } from './db.js';
import {
  encodeHeader,
  decodeHeader,
  encodeSubBlockTree,
  decodeSubBlockTree,
  encodeUtxoTxTree,
  decodeUtxoTxTree,
} from '@dagsocial/types';
import type { OrderingBlock } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Row shape (blob-based)
// ---------------------------------------------------------------------------

interface OrderingBlockRow {
  height: number;
  header_cbor: Buffer;
  subblock_tree_cbor: Buffer;
  utxotx_tree_cbor: Buffer;
  validator_signature: Buffer;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToOrderingBlock(row: OrderingBlockRow): OrderingBlock {
  return {
    header: decodeHeader(new Uint8Array(row.header_cbor)),
    subBlockTree: decodeSubBlockTree(new Uint8Array(row.subblock_tree_cbor)),
    utxoTxTree: decodeUtxoTxTree(new Uint8Array(row.utxotx_tree_cbor)),
    validatorSignature: new Uint8Array(row.validator_signature),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new ordering block.
 */
export function createOrderingBlock(block: OrderingBlock): void {
  const db = getDb();

  db.prepare(
    `INSERT INTO ordering_blocks
       (height, header_cbor, subblock_tree_cbor, utxotx_tree_cbor,
        validator_signature, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    block.header.height,
    Buffer.from(encodeHeader(block.header)),
    Buffer.from(encodeSubBlockTree(block.subBlockTree)),
    Buffer.from(encodeUtxoTxTree(block.utxoTxTree)),
    Buffer.from(block.validatorSignature),
    block.header.createdAt,
  );
}

/**
 * Retrieve an ordering block by height.
 * Returns null if no block exists at that height.
 */
export function getOrderingBlock(height: number): OrderingBlock | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM ordering_blocks WHERE height = ?')
    .get(height) as OrderingBlockRow | undefined;
  return row ? rowToOrderingBlock(row) : null;
}

/**
 * Return the current chain height (max height in ordering_blocks).
 * Returns 0 if no blocks exist yet.
 */
export function getCurrentHeight(): number {
  const db = getDb();
  const row = db
    .prepare('SELECT COALESCE(MAX(height), 0) AS h FROM ordering_blocks')
    .get() as { h: number };
  return row.h;
}
```

- [ ] **Step 3: Delete any test databases**

```bash
rm -f /home/mwaddip/projects/dagsocial/packages/node/dagsocial.db /home/mwaddip/projects/dagsocial/packages/node/test*.db
```

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/store/db.ts packages/node/src/store/ordering.ts
git commit -m "feat: switch ordering_blocks to CBOR blob storage

Replace 15 flat columns with 3 CBOR blob columns + signature + created_at.
Row mapping uses decodeHeader/decodeSubBlockTree/decodeUtxoTxTree.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Node block-creator.ts — createOrderingBlock

**Files:**
- Modify: `packages/node/src/services/block-creator.ts`

**Interfaces:**
- Consumes: New block types, `encodeHeader`, `blockHash`, `computePowHash` from validation, `leafHash`, `buildMerkleRoot` from types, `EMPTY_STATE_ROOT` from types
- Produces: updated `createOrderingBlock()`

- [ ] **Step 1: Update imports in `packages/node/src/services/block-creator.ts`**

Replace the relevant imports (top of file):

Old:
```ts
import {
  PROTOCOL_VERSION,
  CREDIT_FIXED_RATE_BLOCKS,
  CREDIT_INITIAL_REWARD,
  CREDIT_EPOCH_BLOCKS,
  CREDIT_REWARD_REDUCTION,
  CREDIT_TAIL_REWARD,
  CREDIT_MINER_REWARD_DELAY,
  CREDIT_TREASURY_PCT,
  ORDERING_BLOCK_POW_TARGET_BITS,
  LIKE_THRESHOLD,
  LIKE_MAX_AUTHOR_REWARD,
  LIKE_COST,
  POST_LOCK_UNLOCK_PER_LIKES,
  encodeOrderingBlock,
  decodeSubBlock,
  decodeTx,
  encodePost,
  computeBoxId,
  computeTxId,
} from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  computeBlockBodyHash,
} from '@dagsocial/validation';
import type { OrderingBlock, CoinbaseOutput, EpochTally, LikeReward, SubBlock, Post, LikeBox, AnyBox, UserId } from '@dagsocial/types';
```

New:
```ts
import {
  PROTOCOL_VERSION,
  CREDIT_FIXED_RATE_BLOCKS,
  CREDIT_INITIAL_REWARD,
  CREDIT_EPOCH_BLOCKS,
  CREDIT_REWARD_REDUCTION,
  CREDIT_TAIL_REWARD,
  CREDIT_MINER_REWARD_DELAY,
  CREDIT_TREASURY_PCT,
  ORDERING_BLOCK_POW_TARGET_BITS,
  LIKE_THRESHOLD,
  LIKE_MAX_AUTHOR_REWARD,
  LIKE_COST,
  POST_LOCK_UNLOCK_PER_LIKES,
  EMPTY_STATE_ROOT,
  encodeHeader,
  decodeSubBlock,
  decodeTx,
  encodePost,
  computeBoxId,
  computeTxId,
  leafHash,
  buildMerkleRoot,
} from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  blockHash,
  computePowHash,
} from '@dagsocial/validation';
import type {
  OrderingBlock,
  BlockHeader,
  SubBlockTree,
  UtxoTxTree,
  CoinbaseOutput,
  EpochTally,
  LikeReward,
  SubBlock,
  Post,
  LikeBox,
  AnyBox,
  UserId,
} from '@dagsocial/types';
```

- [ ] **Step 2: Add Merkle root computation helpers**

Insert after the imports, before any existing functions:

```ts
// ---------------------------------------------------------------------------
// Merkle root computation
// ---------------------------------------------------------------------------

function computeSubBlockRoot(tree: SubBlockTree): string {
  const leaves = [
    ...tree.subBlockRefs.map((id) =>
      leafHash('subblock', Buffer.from(id, 'hex'))),
    ...tree.stumpIds.map((id) =>
      leafHash('stump', Buffer.from(id, 'hex'))),
  ];
  return Buffer.from(buildMerkleRoot(leaves)).toString('hex');
}

function computeUtxoTxRoot(tree: UtxoTxTree): string {
  const leaves: Uint8Array[] = [
    ...tree.utxoTxIds.map((id) =>
      leafHash('utxotx', Buffer.from(id, 'hex'))),
    ...tree.likeBoxIds.map((id) =>
      leafHash('likebox', Buffer.from(id, 'hex'))),
    ...tree.coinbaseOutputs.map((o) =>
      leafHash('coinbase', Buffer.from(JSON.stringify({
        owner: Array.from(o.owner),
        value: o.value,
        lockedUntilBlock: o.lockedUntilBlock,
        isTreasury: o.isTreasury,
      })))),
  ];
  if (tree.epochTallyResults) {
    leaves.push(
      leafHash('epoch', Buffer.from(JSON.stringify(tree.epochTallyResults))),
    );
  }
  return Buffer.from(buildMerkleRoot(leaves)).toString('hex');
}
```

- [ ] **Step 3: Rewrite createOrderingBlock to build nested structure**

Replace the block template construction in `createOrderingBlock()` (lines 415-470).

Find the `// 17. Build block template` section and replace through the end of `createOrderingBlock()`:

```ts
  // 17. Build the body trees
  const subBlockTree: SubBlockTree = {
    subBlockRefs,
    stumpIds: [],
  };
  const utxoTxTree: UtxoTxTree = {
    utxoTxIds,
    likeBoxIds: allLikeBoxIds,
    coinbaseOutputs,
  };
  if (epochTallyResults) {
    utxoTxTree.epochTallyResults = epochTallyResults;
  }

  // 18. Compute Merkle roots
  const subBlockRoot = computeSubBlockRoot(subBlockTree);
  const utxoTxRoot = computeUtxoTxRoot(utxoTxTree);

  // 19. Build header template (powNonce=0)
  const headerTemplate: BlockHeader = {
    protocolVersion: PROTOCOL_VERSION,
    height: newHeight,
    prevBlockHash,
    subBlockRoot,
    utxoTxRoot,
    stateRoot: EMPTY_STATE_ROOT,
    validatorId,
    powNonce: 0,
    powTargetBits,
    createdAt: Date.now(),
  };

  // 20. Internal vs external mining
  if (config.miningMode === 'external') {
    // Store the full block template (header + bodies) for external miners
    const template: OrderingBlock = {
      header: headerTemplate,
      subBlockTree,
      utxoTxTree,
      validatorSignature: new Uint8Array(64),
    };
    currentTemplate = template;
    return null; // Block not finalized yet
  }

  // 21. Internal: mine PoW against the header
  const powPreimage = computePowHash(headerTemplate);
  const powNonce = solvePoW(powPreimage, powTargetBits);

  const header: BlockHeader = {
    ...headerTemplate,
    powNonce,
  };

  // 22. Sign the header hash
  const hh = blockHash(header);
  const sig = cryptoSign(null, Buffer.from(hh, 'hex'), validatorPrivKey);

  const block: OrderingBlock = {
    header,
    subBlockTree,
    utxoTxTree,
    validatorSignature: new Uint8Array(sig),
  };

  // 23. Finalize
  finalizeBlock(block);

  return block;
```

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/services/block-creator.ts
git commit -m "feat: update createOrderingBlock for header/body structure

Builds BlockHeader, SubBlockTree, UtxoTxTree separately. Computes
subBlockRoot and utxoTxRoot Merkle roots. Signs header hash instead
of body hash. computeBlockBodyHash usage removed.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Node block-creator.ts — submitMinedBlock, getCurrentTemplate, finalizeBlock

**Files:**
- Modify: `packages/node/src/services/block-creator.ts` (same file as Task 6)

**Interfaces:**
- Consumes: work from Task 6
- Produces: updated `submitMinedBlock()`, `getCurrentTemplate()`, `finalizeBlock()`

- [ ] **Step 1: Update `submitMinedBlock`**

Replace the function (lines 147-181):

```ts
export function submitMinedBlock(powNonce: number, submittedHeight: number): string | null {
  const tpl = currentTemplate;
  if (!tpl || tpl.header.height !== submittedHeight || getCurrentHeight() >= submittedHeight) {
    return null;
  }

  // Build header with the submitted nonce
  const header: BlockHeader = {
    ...tpl.header,
    powNonce,
  };

  // Verify PoW against header
  if (!verifyOrderingBlockPoW(header)) {
    return null;
  }

  // Sign the header hash
  const hh = blockHash(header);
  const sig = cryptoSign(null, Buffer.from(hh, 'hex'), validatorPrivKey);

  const block: OrderingBlock = {
    header,
    subBlockTree: tpl.subBlockTree,
    utxoTxTree: tpl.utxoTxTree,
    validatorSignature: new Uint8Array(sig),
  };

  // Finalize and broadcast
  finalizeBlock(block);

  return blockHash(block.header);
}
```

- [ ] **Step 2: Update `getCurrentTemplate`**

No structural changes needed — it still returns `OrderingBlock | null`. But verify the type annotation is correct:

```ts
export function getCurrentTemplate(): OrderingBlock | null {
  return currentTemplate;
}
```

(No code change needed if the type is already `OrderingBlock`.)

- [ ] **Step 3: Update `finalizeBlock` — references to block fields**

In `finalizeBlock()` (line 476), update all `block.X` references to use the nested structure:

- `block.coinbaseOutputs` → `block.utxoTxTree.coinbaseOutputs`
- `block.subBlockRefs` → `block.subBlockTree.subBlockRefs`
- `block.height` → `block.header.height`

Find and replace these three patterns throughout `finalizeBlock()`:

```ts
function finalizeBlock(block: OrderingBlock): void {
  // 1. Store block
  storeCreateOrderingBlock(block);

  // 2. Apply coinbase — mint credits for each output
  for (const out of block.utxoTxTree.coinbaseOutputs) {
    mintCredits(out.owner, out.value, block.header.height, out.lockedUntilBlock);
  }

  // 3. Broadcast
  const net = getNet();
  if (net) {
    net.broadcastOrderingBlock(block).catch((err: Error) => {
      console.warn(`Failed to broadcast ordering block: ${err.message}`);
    });
  }

  // 4. Confirm sub-blocks and their posts
  for (const sbId of block.subBlockTree.subBlockRefs) {
    confirmPost(sbId, block.header.height);
  }

  // 4b. Apply UTXO transactions locally ...
  // (the revalidateTxInContext block — replace block.height with block.header.height)
  // ...
  // Inside the loop near line 524:
  //   const revalResult = revalidateTxInContext(utxoDeps, tx, block.header.height);
  // ...
  //   applyTx(utxoDeps, tx, outputsWithIds, block.header.height);
```

Make the replacements:
- Line 483: `block.coinbaseOutputs` → `block.utxoTxTree.coinbaseOutputs`
- Line 483: `block.height` → `block.header.height`
- Line 494: `block.subBlockRefs` → `block.subBlockTree.subBlockRefs`
- Line 495: `block.height` → `block.header.height`
- Line 524: `block.height` → `block.header.height`
- Line 529: `block.height` → `block.header.height`

- [ ] **Step 4: Remove `encodeOrderingBlock` import if unused**

Check if `encodeOrderingBlock` is still imported in block-creator.ts. It was used in the old `createOrderingBlock` to compute `block.hash`. With the new code, `blockHash(header)` replaces that. If `encodeOrderingBlock` is no longer used, remove it from the imports.

- [ ] **Step 5: Remove `computeBlockBodyHash` import**

It's already renamed in Task 6's import update. Verify the import block no longer references `computeBlockBodyHash`.

- [ ] **Step 6: Commit**

```bash
git add packages/node/src/services/block-creator.ts
git commit -m "feat: update submitMinedBlock and finalizeBlock for headers

submitMinedBlock signs header hash. finalizeBlock accesses fields via
header/utxoTxTree/subBlockTree paths. blockHash() replaces inline
hash computation.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Node routes — blocks.ts + mining.ts

**Files:**
- Modify: `packages/node/src/routes/blocks.ts`
- Modify: `packages/node/src/routes/mining.ts`

**Interfaces:**
- Consumes: updated `OrderingBlock` type, `blockHash` from validation, `computePowHash` from validation
- Produces: updated JSON response shapes

- [ ] **Step 1: Update `packages/node/src/routes/blocks.ts` — blockToJson**

Replace `blockToJson()`:

```ts
import { blockHash } from '@dagsocial/validation';

function blockToJson(block: OrderingBlock): Record<string, unknown> {
  return {
    header: {
      protocolVersion: block.header.protocolVersion,
      height: block.header.height,
      prevBlockHash: block.header.prevBlockHash,
      subBlockRoot: block.header.subBlockRoot,
      utxoTxRoot: block.header.utxoTxRoot,
      stateRoot: block.header.stateRoot,
      validatorId: Buffer.from(block.header.validatorId).toString('hex'),
      powNonce: block.header.powNonce,
      powTargetBits: block.header.powTargetBits,
      createdAt: block.header.createdAt,
    },
    subBlockTree: {
      subBlockRefs: block.subBlockTree.subBlockRefs,
      stumpIds: block.subBlockTree.stumpIds,
    },
    utxoTxTree: {
      utxoTxIds: block.utxoTxTree.utxoTxIds,
      likeBoxIds: block.utxoTxTree.likeBoxIds,
      coinbaseOutputs: block.utxoTxTree.coinbaseOutputs.map((o) => ({
        owner: Buffer.from(o.owner).toString('hex'),
        value: o.value,
        lockedUntilBlock: o.lockedUntilBlock,
        isTreasury: o.isTreasury,
      })),
      ...(block.utxoTxTree.epochTallyResults
        ? { epochTallyResults: block.utxoTxTree.epochTallyResults }
        : {}),
    },
    validatorSignature: Buffer.from(block.validatorSignature).toString('hex'),
  };
}
```

Update the GET /blocks/current handler — replace `block.hash` with `blockHash(block.header)`:

```ts
router.get('/blocks/current', (_req, res) => {
  const height = deps.getCurrentHeight();
  if (height === 0) {
    res.json({ height: 0, hash: null });
    return;
  }

  const block = deps.getOrderingBlock(height);
  res.json({
    height,
    hash: block ? blockHash(block.header) : null,
  });
});
```

- [ ] **Step 2: Update `packages/node/src/routes/mining.ts` — template endpoint**

Replace the template endpoint to return the new structure:

```ts
import { blockHash, computePowHash } from '@dagsocial/validation';
import type { OrderingBlock } from '@dagsocial/types';

// ... MiningDeps interface unchanged ...

export function createRouter(deps: MiningDeps): Router {
  const router = Router();

  // GET /mining/template — return current block template
  router.get('/template', (_req, res) => {
    const tpl = deps.getCurrentTemplate();
    if (!tpl) {
      res.status(404).json({ error: 'No block template available' });
      return;
    }

    // Compute PoW preimage from the header
    const powPreimage = computePowHash(tpl.header);

    res.json({
      header: {
        protocolVersion: tpl.header.protocolVersion,
        height: tpl.header.height,
        prevBlockHash: tpl.header.prevBlockHash,
        subBlockRoot: tpl.header.subBlockRoot,
        utxoTxRoot: tpl.header.utxoTxRoot,
        stateRoot: tpl.header.stateRoot,
        validatorId: Buffer.from(tpl.header.validatorId).toString('hex'),
        powTargetBits: tpl.header.powTargetBits,
        createdAt: tpl.header.createdAt,
      },
      subBlockRefs: tpl.subBlockTree.subBlockRefs,
      likeBoxIds: tpl.utxoTxTree.likeBoxIds,
      utxoTxIds: tpl.utxoTxTree.utxoTxIds,
      stumpIds: tpl.subBlockTree.stumpIds,
      coinbaseOutputs: tpl.utxoTxTree.coinbaseOutputs.map((o) => ({
        owner: Buffer.from(o.owner).toString('hex'),
        value: o.value,
        lockedUntilBlock: o.lockedUntilBlock,
        isTreasury: o.isTreasury,
      })),
      bodyHash: powPreimage.toString('hex'),  // keep 'bodyHash' name for miner compat
    });
  });

  // POST /mining/submit — unchanged (still takes { powNonce, height })
  router.post('/submit', (_req, res) => {
    const { powNonce, height } = _req.body as { powNonce?: number; height?: number };

    if (typeof powNonce !== 'number' || powNonce < 0) {
      res.status(400).json({ error: 'powNonce required (non-negative integer)' });
      return;
    }

    if (typeof height !== 'number' || height < 1) {
      res.status(400).json({ error: 'height required (positive integer)' });
      return;
    }

    const result = deps.submitMinedBlock(powNonce, height);
    if (!result) {
      res.status(422).json({ error: 'PoW invalid or template stale' });
      return;
    }

    res.status(201).json({ blockHash: result, height });
  });

  return router;
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/node/src/routes/blocks.ts packages/node/src/routes/mining.ts
git commit -m "feat: update routes for nested block JSON shape

blockToJson returns header/subBlockTree/utxoTxTree sections.
Mining template endpoint returns header fields + bodyHash (PoW preimage).
blockHash() replaces block.hash in /blocks/current.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Node index.ts — applyOrderingBlock

**Files:**
- Modify: `packages/node/src/index.ts`

**Interfaces:**
- Consumes: updated `OrderingBlock` type, `verifyOrderingBlockPoW`, `blockHash` from validation
- Produces: updated `applyOrderingBlock()`

- [ ] **Step 1: Update `applyOrderingBlock` in `packages/node/src/index.ts`**

Replace the function body (lines 151-200 area). Key changes:
- `block.prevBlockHash` → `block.header.prevBlockHash`
- `block.height` → `block.header.height`
- `verifyOrderingBlockPoW(block)` → `verifyOrderingBlockPoW(block.header)`
- `block.hash` → `blockHash(block.header)`
- `block.validatorSignature` unchanged (still at top level)
- `block.coinbaseOutputs` → `block.utxoTxTree.coinbaseOutputs`
- `block.subBlockRefs` → `block.subBlockTree.subBlockRefs`

Find and update these field accesses throughout `applyOrderingBlock()`. The function logic is unchanged — only field paths change.

The chain-link comparison for `prevBlock.hash` becomes `blockHash(prevBlock.header)`.

- [ ] **Step 2: Commit**

```bash
git add packages/node/src/index.ts
git commit -m "feat: update applyOrderingBlock for nested block structure

Field paths updated: block.header.prevBlockHash, block.header.height,
block.utxoTxTree.coinbaseOutputs, block.subBlockTree.subBlockRefs.
PoW verification passes block.header. Chain-link check uses blockHash().

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Net package updates

**Files:**
- Modify: `packages/net/src/types.ts`
- Modify: `packages/net/src/gossip.ts`

**Interfaces:**
- Consumes: updated `verifyOrderingBlockStructure` signature from validation
- Produces: updated `NetValidators` interface, updated gossip encode/decode

- [ ] **Step 1: Update `packages/net/src/types.ts`**

The `NetValidators.verifyOrderingBlockStructure` signature needs no change — it already takes `(block: OrderingBlock) => ...`. The updated validation function takes the same parameter type (the outer `OrderingBlock` is still the parameter, just its internal shape changed). Verify the type checks pass after all other packages are updated.

No code change needed for `types.ts`.

- [ ] **Step 2: Update `packages/net/src/gossip.ts`**

The gossip topic `/dagsocial/ordering-block/1` carries `encodeOrderingBlock(block)` / `decodeOrderingBlock(raw)`. Since the serialization format is updated in Task 3 to the length-prefixed format, the gossip code itself doesn't change — it still calls `encodeOrderingBlock` and `decodeOrderingBlock`. Verify:

```ts
// In broadcastOrderingBlock (line 209):
const encoded = encodeOrderingBlock(block);  // unchanged call, new wire format

// In onOrderingBlock handler (line 138):
handlers.onOrderingBlock(decodeOrderingBlock(raw));  // unchanged call
```

No code change needed for `gossip.ts` — the encode/decode functions handle the new format.

- [ ] **Step 3: Commit**

```bash
git add packages/net/src/types.ts packages/net/src/gossip.ts
git commit -m "feat: net package — wire format change is transparent

encodeOrderingBlock/decodeOrderingBlock handle the new length-prefixed
format. Gossip topics and NetValidators interface unchanged.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: Update all tests

**Files:**
- Modify: `packages/validation/test/*.test.ts` (all test files)
- Modify: `packages/node/test/*.test.ts` (all test files that construct OrderingBlock)
- Modify: `packages/net/test/*.test.ts` (if any construct OrderingBlock)

**Interfaces:**
- Consumes: all updated types and functions from Tasks 1-10
- Produces: 353 passing tests

- [ ] **Step 1: Fix validation tests**

Run to see errors:
```bash
pnpm --filter @dagsocial/validation test 2>&1 | tail -30
```

Every test that constructs an `OrderingBlock` needs the new nested structure. The old flat form:
```ts
const block: OrderingBlock = {
  height: 1, hash: '...', prevBlockHash: '...', subBlockRefs: [], ...
};
```

Becomes:
```ts
const block: OrderingBlock = {
  header: {
    protocolVersion: 1, height: 1, prevBlockHash: '...',
    subBlockRoot: '...', utxoTxRoot: '...', stateRoot: EMPTY_STATE_ROOT,
    validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 12, createdAt: 0,
  },
  subBlockTree: { subBlockRefs: [], stumpIds: [] },
  utxoTxTree: { utxoTxIds: [], likeBoxIds: [], coinbaseOutputs: [] },
  validatorSignature: new Uint8Array(64),
};
```

Tests calling `verifyOrderingBlockPoW(block)` → `verifyOrderingBlockPoW(block.header)`.
Tests calling `computeBlockBodyHash(block)` → use `blockHash(block.header)` or `computePowHash(block.header)`.
Tests calling `verifyBlockChainLink(block, prev)` → signature unchanged but prev must have `header` too.

Go through each test file and apply these mechanical transformations. The test logic (what's being verified) does NOT change — only the object construction and function call signatures.

- [ ] **Step 2: Fix node tests**

```bash
pnpm --filter @dagsocial/node test 2>&1 | tail -30
```

Same mechanical transformations as Step 1. Additionally:
- Tests that read from `ordering_blocks` table directly need to use the new column names (`header_cbor`, etc.) — but most tests go through the store interface, which was already updated.
- Tests calling `createOrderingBlock(block)` need the block in nested format.

- [ ] **Step 3: Fix net tests**

```bash
pnpm --filter @dagsocial/net test 2>&1 | tail -30
```

Apply the same transformations.

- [ ] **Step 4: Run all tests**

```bash
pnpm test 2>&1
```

Expected: 353/353 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/validation/test/ packages/node/test/ packages/net/test/
git commit -m "test: update tests for header/body block structure

Mechanical transformation: flat OrderingBlock → nested header/body/trees.
Test logic unchanged. All 353 tests pass.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: Build, typecheck, and verify

**Files:**
- None (verification only)

- [ ] **Step 1: Full build**

```bash
pnpm build 2>&1
```

Expected: all 4 packages build without errors.

- [ ] **Step 2: Full typecheck**

```bash
pnpm typecheck 2>&1
```

Expected: clean, no errors.

- [ ] **Step 3: Full test run**

```bash
pnpm test 2>&1
```

Expected: 353/353 tests pass.

- [ ] **Step 4: E2E smoke test** (optional, requires fresh DB)

```bash
rm -f /home/mwaddip/projects/dagsocial/packages/node/dagsocial.db
node packages/node/dist/index.js &
sleep 3
curl -s http://localhost:3000/status | head -c 200
curl -s http://localhost:3000/blocks/current
kill %1 2>/dev/null
```

Expected: status returns `blockHeight: 0`, blocks/current returns `{ height: 0, hash: null }`.

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A
git diff --cached --stat
git commit -m "chore: final build/typecheck fixes for block headers"
```
