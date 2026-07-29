# Verifiable Prune Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move prune authorization and settlement from DAG-side stumps into the ordering block, making settlement deterministically verifiable from the block chain + UTXO set without DAG content.

**Architecture:** New `PruneEntry` type in `SubBlockTree` carries the signed prune payload (postId list + Merkle root + Ed25519 signature). Settlement reads UTXO boxes by postId — no DAG walk. A `block_topology` table (populated from block entries) enables efficient subtree verification. The DAG-side `Stump` becomes a simplified historical artifact.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Ed25519 via `node:crypto`, CBOR via `cbor-x`, blake2b-512 via `node:crypto`

## Global Constraints

- Post content: 1–300 UTF-8 bytes
- Parent refs: 0–8 per post
- Signatures: raw Ed25519 (64 bytes), `crypto.verify(null, hash, keyObject, ...)` with JWK KeyObject
- Hashing: `blake2b512` with `.subarray(0, 32)` for all 32-byte outputs
- Wire format: CBOR (`cbor-x`). HTTP API: JSON.
- Secret keys never in API responses or DTOs
- Protocol version = 1 on all posts and blocks
- No WASM dependencies
- Contracts before code — types package changes first

---

## File Structure

```
packages/types/src/
├── block.ts              # MODIFY: SubBlockTree gains PruneEntry[], loses stumpIds
├── stump.ts              # MODIFY: add PruneEntry type, simplify Stump, remove computeStumpId
├── serialization.ts      # MODIFY: update SubBlockTree serialization
└── index.ts              # MODIFY: export new types

packages/node/src/
├── store/
│   ├── db.ts             # MODIFY: block_topology migration, mempool schema change
│   ├── mempool.ts        # MODIFY: stump → prune entry type
│   ├── stumps.ts         # MODIFY: simplified Stump insert/lookup
│   └── posts.ts          # MODIFY: simplify pruneSubtree
├── services/
│   ├── block-creator.ts  # MODIFY: drain prune entries, update computeSubBlockRoot
│   ├── block-apply.ts    # MODIFY: UTXO-driven settlement, populate block_topology
│   ├── stump-engine.ts   # MODIFY: build PruneEntry, verify client signature
│   └── verifier.ts       # MODIFY: remove verifyAuthorSignature
├── routes/
│   ├── delete.ts         # MODIFY: signed PruneEntry submission
│   └── pruning.ts        # MODIFY: signed PruneEntry submission (or merge into delete.ts)
└── index.ts              # MODIFY: wire updated deps

packages/net/src/
├── gossip.ts             # MODIFY: update stump gossip for simplified Stump
└── types.ts              # MODIFY: simplified Stump in protocol messages
```

---

### Task 1: Types package — PruneEntry, SubBlockTree, simplified Stump

**Files:**
- Modify: `packages/types/src/stump.ts`
- Modify: `packages/types/src/block.ts`
- Modify: `packages/types/src/index.ts`

**Interfaces:**
- Consumes: nothing (foundation)
- Produces:
  - `PruneEntry` type
  - `SubBlockTree.pruneEntries: PruneEntry[]` (replaces `stumpIds: StumpId[]`)
  - Simplified `Stump` type (no `karmaDeltas`, `pruneSignature`, `subtreeMerkleRoot`)
  - Updated `PruneIntent` (gains `subtreeMerkleRoot`, `subtreePostIds`; `signature` becomes real)
  - `computePruneEntryId(entry: PruneEntry): string` — replaces `computeStumpId`
  - `serializePruneEntry(entry: PruneEntry): Uint8Array` — deterministic CBOR for Merkle leaf

- [ ] **Step 1: Define PruneEntry and update types in stump.ts**

```typescript
// packages/types/src/stump.ts

import { createHash } from 'node:crypto';
import type { PostId, UserId } from './common.js';

export interface KarmaDelta {
  userId: UserId;
  delta: number;
}

export interface PruneIntent {
  rootPostHash: PostId;
  trigger: 'author' | 'storage_prune';
  authorId: UserId;
  subtreeMerkleRoot: Uint8Array;   // NEW: Merkle root over leafHash('stump', postId) for each pruned post
  subtreePostIds: PostId[];        // NEW: all post IDs in the reply subtree
  signature: Uint8Array;           // NOW REAL: 64-byte Ed25519 sig over (rootPostHash, subtreeMerkleRoot)
}

export interface PruneEntry {
  rootPostHash: PostId;
  subtreePostIds: PostId[];
  subtreeMerkleRoot: Uint8Array;
  authorId: UserId;
  authorSignature: Uint8Array;     // Ed25519 sig over blake2b512(rootPostHash ++ subtreeMerkleRoot)
  trigger: 'author' | 'storage_prune';
}

export interface Stump {
  rootPostHash: PostId;
  authorId: UserId;
  replyCount: number;
  upvoteCount: number;
  trigger: 'author' | 'storage_prune';
  protocolVersion: number;
  compactedAtBlockHeight: number;
}

export type StumpId = string;

export function computePruneEntryId(entry: PruneEntry): string {
  const h = createHash('blake2b512');
  h.update(entry.rootPostHash);
  h.update(entry.subtreeMerkleRoot);
  h.update(entry.authorId);
  return h.digest().subarray(0, 32).toString('hex');
}

import { toBuffer } from 'cbor-x';

export function serializePruneEntry(entry: PruneEntry): Uint8Array {
  return toBuffer({
    rootPostHash: entry.rootPostHash,
    subtreePostIds: entry.subtreePostIds,
    subtreeMerkleRoot: Buffer.from(entry.subtreeMerkleRoot).toString('hex'),
    authorId: Buffer.from(entry.authorId).toString('hex'),
    authorSignature: Buffer.from(entry.authorSignature).toString('hex'),
    trigger: entry.trigger,
  });
}
```

- [ ] **Step 2: Update SubBlockTree in block.ts**

```typescript
// packages/types/src/block.ts

export interface SubBlockTree {
  subBlockRefs: PostId[];
  subBlockEntries: SubBlockEntry[];
  pruneEntries: PruneEntry[];   // NEW: replaces stumpIds
}
```

Remove the `stumpIds: StumpId[]` field. Import `PruneEntry` from `./stump.js` at the top of the file.

- [ ] **Step 3: Update exports in index.ts**

Remove the old `StumpId` export if it was separate. Ensure `PruneEntry`, `PruneIntent`, `computePruneEntryId`, `serializePruneEntry` are all exported.

```typescript
export type { PruneIntent, KarmaDelta, Stump, StumpId, PruneEntry } from './stump.js';
export { computePruneEntryId, serializePruneEntry } from './stump.js';
```

Remove the old `computeStumpId` export if it exists.

- [ ] **Step 4: Build types package**

Run: `pnpm --filter @dagsocial/types build`
Expected: Clean build, no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/stump.ts packages/types/src/block.ts packages/types/src/index.ts
git commit -m "feat(types): add PruneEntry, update SubBlockTree, simplify Stump

Replace stumpIds with structured pruneEntries in SubBlockTree.
Stump becomes a historical artifact without karmaDeltas or pruneSignature.
Add computePruneEntryId and serializePruneEntry.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Types package — update serialization

**Files:**
- Modify: `packages/types/src/serialization.ts`

**Interfaces:**
- Consumes: `SubBlockTree` with `pruneEntries`, `PruneEntry`, `Stump` (simplified)
- Produces: updated `encodeSubBlockTree`, `decodeSubBlockTree`, `encodeStump`, `decodeStump`

- [ ] **Step 1: Update Stump serialization**

The simplified Stump no longer has `karmaDeltas`, `pruneSignature`, or `subtreeMerkleRoot`. CBOR serialization via `toBuffer`/`fromBuffer` handles this automatically since those fields are removed from the type. No code change needed in serialization.ts for Stump itself — the generic `toBuffer(stump)` will serialize whatever fields exist.

Verify: the `encodeStump`/`decodeStump` functions still work since they use the generic `toBuffer`/`fromBuffer`.

- [ ] **Step 2: Update SubBlockTree serialization**

`encodeSubBlockTree` and `decodeSubBlockTree` currently use `toBuffer`/`fromBuffer` which handle the type change automatically — `pruneEntries` replaces `stumpIds` in the object shape. No code change needed.

- [ ] **Step 3: Verify no stale references**

Search for `stumpIds` in the serialization file:
```bash
rtk proxy grep -n "stumpIds\|stump_ids" packages/types/src/serialization.ts
```
Expected: No matches (field name handled by CBOR key from object shape).

- [ ] **Step 4: Build types package**

Run: `pnpm --filter @dagsocial/types build`
Expected: Clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/serialization.ts
git commit -m "chore(types): verify serialization handles updated Stump and SubBlockTree"
```

---

### Task 3: Database — block_topology migration, mempool schema

**Files:**
- Modify: `packages/node/src/store/db.ts`

**Interfaces:**
- Consumes: nothing new (migration system exists)
- Produces: `block_topology` table, updated mempool schema

- [ ] **Step 1: Add block_topology table migration**

Find the latest migration in `db.ts` (look for the migration function pattern). Add a new migration:

```typescript
function migrateBlockTopology(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS block_topology (
      post_id TEXT PRIMARY KEY,
      parent_refs TEXT NOT NULL,
      block_height INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_block_topology_height
      ON block_topology(block_height);
  `);
}
```

Wire it into the migration chain by incrementing the schema version and calling it from the main migration function.

- [ ] **Step 2: Update mempool schema to store PruneEntry**

The mempool currently stores `stump_id TEXT` for stump entries. Replace with a `prune_entry_cbor BLOB` column to store the serialized `PruneEntry`.

Add a migration that alters the mempool table:
```sql
ALTER TABLE mempool ADD COLUMN prune_entry_cbor BLOB;
```

Keep the old `stump_id` column for now (existing rows will be wiped on resync anyway per spec). Or, since protocol version isn't locked and no production deployment exists, drop and recreate:
```sql
DROP TABLE IF EXISTS mempool;
CREATE TABLE mempool (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_type TEXT NOT NULL CHECK(entry_type IN ('subblock', 'utxo_tx', 'prune')),
  subblock_id TEXT,
  utxo_tx_cbor BLOB,
  prune_entry_cbor BLOB,
  batch_id TEXT,
  expires_at_height INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 3: Update dag_stumps table**

Remove `prune_signature`, `karma_deltas`, `subtree_merkle_root` columns from `dag_stumps`. The simplified Stump only needs: `id`, `root_post_hash`, `author_id`, `reply_count`, `upvote_count`, `trigger`, `protocol_version`, `compacted_at_block_height`, `raw_cbor`.

Add migration: drop and recreate `dag_stumps` with the simplified schema.

- [ ] **Step 4: Build and verify**

Run: `pnpm --filter @dagsocial/node build`
Expected: Build succeeds (type errors from other files referencing old types are expected — those are fixed in later tasks).

- [ ] **Step 5: Commit**

```bash
git add packages/node/src/store/db.ts
git commit -m "feat(db): add block_topology table, update mempool and dag_stumps schemas"
```

---

### Task 4: Store layer — mempool, stumps, posts

**Files:**
- Modify: `packages/node/src/store/mempool.ts`
- Modify: `packages/node/src/store/stumps.ts`
- Modify: `packages/node/src/store/posts.ts`

**Interfaces:**
- Consumes: `PruneEntry`, simplified `Stump`
- Produces: `insertMempoolPrune`, `drainMempoolPrunes`, `removeMempoolPrunes`, `insertStump` (simplified), `getStump` (simplified), `pruneSubtree` (simplified)

- [ ] **Step 1: Update mempool.ts — replace stump functions with prune functions**

Replace `insertMempoolStump`, `drainMempoolStumps`, `removeMempoolStumps` with:

```typescript
import { type PruneEntry, serializePruneEntry } from '@dagsocial/types';

export function insertMempoolPrune(
  entry: PruneEntry,
  expiresAtHeight: number,
): number {
  const db = getDb();
  const cbor = Buffer.from(serializePruneEntry(entry));
  const result = db.prepare(
    `INSERT INTO mempool (entry_type, prune_entry_cbor, expires_at_height)
     VALUES ('prune', ?, ?)`,
  ).run(cbor, expiresAtHeight);
  return Number(result.lastInsertRowid);
}
```

```typescript
export function drainMempoolPrunes(limit: number): PruneEntry[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT rowid, prune_entry_cbor FROM mempool
     WHERE entry_type = 'prune'
     ORDER BY rowid ASC LIMIT ?`,
  ).all(limit) as Array<{ rowid: number; prune_entry_cbor: Buffer }>;

  if (rows.length === 0) return [];

  const ids = rows.map(r => r.rowid);
  db.prepare(
    `DELETE FROM mempool WHERE rowid IN (${ids.map(() => '?').join(',')})`,
  ).run(...ids);

  const { fromBuffer } = require('cbor-x');
  return rows.map(r => fromBuffer(r.prune_entry_cbor) as PruneEntry);
}
```

```typescript
export function removeMempoolPrunes(entryIds: string[]): void {
  // entryIds are computePruneEntryId results — find by recomputing or store id column
  // Simpler: drain already handles removal. This function may not be needed.
}
```

Remove `insertMempoolStump`, `drainMempoolStumps`, `removeMempoolStumps`.

- [ ] **Step 2: Update store/stumps.ts — simplified Stump**

Update `insertStump` to handle the simplified Stump type (no `karmaDeltas`, `pruneSignature`, `subtreeMerkleRoot` columns):

```typescript
export function insertStump(stump: Stump): void {
  const db = getDb();
  const stumpId = computePruneEntryId({
    rootPostHash: stump.rootPostHash,
    subtreePostIds: [],  // not needed for ID computation
    subtreeMerkleRoot: new Uint8Array(32), // not in Stump anymore
    authorId: stump.authorId,
    authorSignature: new Uint8Array(64),
    trigger: stump.trigger,
  });
  // Actually, the Stump ID should match the PruneEntry ID from the block.
  // Store with the ID from the block, not recomputed.
  // For now, use rootPostHash as the lookup key.
  
  db.prepare(
    `INSERT OR REPLACE INTO dag_stumps
       (id, root_post_hash, author_id, reply_count, upvote_count,
        trigger, protocol_version, compacted_at_block_height, raw_cbor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    stumpId,
    stump.rootPostHash,
    Buffer.from(stump.authorId),
    stump.replyCount,
    stump.upvoteCount,
    stump.trigger,
    stump.protocolVersion,
    stump.compactedAtBlockHeight,
    Buffer.from(encodeStump(stump)),
  );
}
```

Update `getStump` to deserialize the simplified columns:

```typescript
export function getStump(stumpId: string): Stump | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM dag_stumps WHERE id = ?`,
  ).get(stumpId) as StumpRow | undefined;
  if (!row) return null;
  return rowToStump(row);
}
```

Update the row mapper (`rowToStump`) to match simplified columns.

- [ ] **Step 3: Simplify pruneSubtree in store/posts.ts**

Remove the Stump insertion from `pruneSubtree` — it now only marks posts as pruned. The Stump is inserted separately during block application (when DAG content is present).

```typescript
export function pruneSubtree(rootPostId: string): void {
  const db = getDb();
  const rows = db.prepare(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM dag_posts WHERE id = ?
       UNION
       SELECT dp.id FROM dag_posts dp
       JOIN dag_parent_refs dpr ON dp.id = dpr.post_id
       JOIN subtree s ON dpr.parent_id = s.id
     )
     SELECT DISTINCT id FROM subtree`,
  ).all(rootPostId) as Array<{ id: string }>;

  const postIds = rows.map(r => r.id);
  if (postIds.length === 0) return;

  const stmt = db.prepare(`UPDATE dag_posts SET status = 'pruned' WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const id of postIds) {
      stmt.run(id);
    }
  });
  tx();
}
```

Remove the old signature that took `stump: Stump` as second parameter.

- [ ] **Step 4: Build and fix type errors**

Run: `pnpm --filter @dagsocial/node build`
Expected: Type errors from services/routes that reference old signatures. These are expected — note them and move to next tasks.

- [ ] **Step 5: Commit**

```bash
git add packages/node/src/store/mempool.ts packages/node/src/store/stumps.ts packages/node/src/store/posts.ts
git commit -m "feat(store): prune-aware mempool, simplified Stump storage, simplified pruneSubtree"
```

---

### Task 5: Core services — stump-engine.ts refactor

**Files:**
- Modify: `packages/node/src/services/stump-engine.ts`

**Interfaces:**
- Consumes: `PruneEntry`, `PruneIntent` (updated), `computePruneEntryId`, `serializePruneEntry`
- Produces: `executePrune(intent: PruneIntent): PruneEntry` (returns PruneEntry, not Stump)

- [ ] **Step 1: Rewrite executePrune to build PruneEntry**

```typescript
import {
  computePostId,
  computePruneEntryId,
  serializePruneEntry,
  PROTOCOL_VERSION,
  leafHash,
  buildMerkleRoot,
  hexToBuf,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type { PruneEntry, PruneIntent, Post, LikeBox } from '@dagsocial/types';
import {
  getPost,
  getSubtree,
  getLockedLikeBoxes,
  getCurrentHeight,
  insertMempoolPrune,
} from '../store/index.js';
import { getNet } from './net-instance.js';

export function executePrune(intent: PruneIntent): PruneEntry {
  // 1. Verify post exists
  const post = getPost(intent.rootPostHash) as Post | null;
  if (!post) {
    throw Object.assign(new Error('Post not found'), { statusCode: 404 });
  }

  // 2. Check not already pruned
  if ('subtreeMerkleRoot' in post) {
    throw Object.assign(new Error('Post already pruned'), { statusCode: 400 });
  }

  // 3. Verify author matches
  if (!Buffer.from(post.author).equals(Buffer.from(intent.authorId))) {
    throw Object.assign(new Error('Author mismatch'), { statusCode: 403 });
  }

  // 4. Verify client signature over (rootPostHash, subtreeMerkleRoot)
  // node:crypto imported at top of file
  const payload = createHash('blake2b512')
    .update(intent.rootPostHash)
    .update(intent.subtreeMerkleRoot)
    .digest()
    .subarray(0, 32);
  
  const keyObject = createPublicKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(intent.authorId).toString('base64url'),
    },
    format: 'jwk',
  });
  
  const valid = verify(null, payload, keyObject, intent.signature);
  if (!valid) {
    throw Object.assign(new Error('Invalid prune signature'), { statusCode: 403 });
  }

  // 5. Verify subtreePostIds match the actual reply tree
  const descendants = getSubtree(intent.rootPostHash);
  const expectedIds = new Set([
    intent.rootPostHash,
    ...descendants.map(p => computePostId(p)),
  ]);
  const actualIds = new Set(intent.subtreePostIds);
  if (expectedIds.size !== actualIds.size ||
      ![...expectedIds].every(id => actualIds.has(id))) {
    throw Object.assign(
      new Error('subtreePostIds does not match actual reply subtree'),
      { statusCode: 400 },
    );
  }

  // 6. Verify Merkle root
  const leaves = intent.subtreePostIds
    .sort()
    .map(id => leafHash('stump', hexToBuf(id)));
  const computedRoot = buildMerkleRoot(leaves);
  if (Buffer.from(computedRoot).toString('hex') !==
      Buffer.from(intent.subtreeMerkleRoot).toString('hex')) {
    throw Object.assign(
      new Error('subtreeMerkleRoot does not match postId list'),
      { statusCode: 400 },
    );
  }

  // 7. Build PruneEntry
  const entry: PruneEntry = {
    rootPostHash: intent.rootPostHash,
    subtreePostIds: intent.subtreePostIds,
    subtreeMerkleRoot: intent.subtreeMerkleRoot,
    authorId: intent.authorId,
    authorSignature: intent.signature,
    trigger: intent.trigger,
  };

  // 8. Broadcast and enqueue
  const net = getNet();
  if (net) {
    net.broadcastStump({
      rootPostHash: entry.rootPostHash,
      authorId: entry.authorId,
      replyCount: descendants.length,
      upvoteCount: 0, // computed from like boxes, optional for historical record
      trigger: entry.trigger,
      protocolVersion: PROTOCOL_VERSION,
      compactedAtBlockHeight: getCurrentHeight(),
    });
  }

  const currentHeight = getCurrentHeight();
  insertMempoolPrune(entry, currentHeight + MEMPOOL_EXPIRY_BLOCKS);

  return entry;
}
```

- [ ] **Step 2: Remove createPruneIntent (no longer needed)**

The PruneIntent is now client-built with a real signature. Remove the old `createPruneIntent` function.

- [ ] **Step 3: Update store index exports**

Ensure `packages/node/src/store/index.ts` exports the new mempool functions. Remove old `insertMempoolStump`, `drainMempoolStumps` from exports.

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/services/stump-engine.ts packages/node/src/store/index.ts
git commit -m "feat(stump-engine): refactor executePrune to build and verify PruneEntry

Verify client Ed25519 signature over (rootPostHash, subtreeMerkleRoot).
Verify subtreePostIds match actual reply tree.
Verify Merkle root over postId list.
Broadcast simplified Stump, enqueue PruneEntry in mempool.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Core services — UTXO-driven settlement in block-apply.ts

**Files:**
- Modify: `packages/node/src/services/block-apply.ts`

**Interfaces:**
- Consumes: `PruneEntry[]` from `block.subBlockTree.pruneEntries`, block_topology table, UTXO store functions
- Produces: deterministic settlement logic, block_topology population

- [ ] **Step 1: Rewrite the stump settlement section (lines 240-304)**

Replace the entire `for (const stumpId of block.subBlockTree.stumpIds)` block with:

```typescript
// Process prune entries from this block
for (const entry of block.subBlockTree.pruneEntries) {
  // 1. Verify authorization
  // node:crypto imported at top of file
  const payload = createHash('blake2b512')
    .update(entry.rootPostHash)
    .update(entry.subtreeMerkleRoot)
    .digest()
    .subarray(0, 32);

  const keyObject = createPublicKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(entry.authorId).toString('base64url'),
    },
    format: 'jwk',
  });

  if (!verify(null, payload, keyObject, entry.authorSignature)) {
    console.error(`Block ${block.header.height}: invalid prune signature for ${entry.rootPostHash}`);
    return false; // reject block
  }

  // 2. Verify postId set against block_topology
  const topologyIds = getSubtreeTopology(entry.rootPostHash);
  const entryIds = new Set(entry.subtreePostIds);
  if (topologyIds.size !== entryIds.size ||
      ![...topologyIds].every(id => entryIds.has(id))) {
    console.error(`Block ${block.header.height}: prune postId set mismatch for ${entry.rootPostHash}`);
    return false;
  }

  // 3. Verify Merkle root
  const leaves = [...entry.subtreePostIds]
    .sort()
    .map(id => leafHash('stump', hexToBuf(id)));
  const computedRoot = Buffer.from(buildMerkleRoot(leaves)).toString('hex');
  const entryRoot = Buffer.from(entry.subtreeMerkleRoot).toString('hex');
  if (computedRoot !== entryRoot) {
    console.error(`Block ${block.header.height}: prune Merkle root mismatch for ${entry.rootPostHash}`);
    return false;
  }

  // 4. Settle UTXO — deterministic from post IDs
  try {
    settlePruneUtxo(entry.subtreePostIds, block.header.height, currentJournal);
  } catch (err) {
    console.error(`Block ${block.header.height}: prune settlement failed for ${entry.rootPostHash}: ${String(err)}`);
    return false;
  }

  // 5. Prune DAG content (when present)
  try {
    pruneSubtree(entry.rootPostHash);
    // Insert simplified Stump for historical record
    insertStump({
      rootPostHash: entry.rootPostHash,
      authorId: entry.authorId,
      replyCount: entry.subtreePostIds.length - 1, // exclude root
      upvoteCount: 0, // can be derived from like boxes if needed
      trigger: entry.trigger,
      protocolVersion: PROTOCOL_VERSION,
      compactedAtBlockHeight: block.header.height,
    });
  } catch (err) {
    console.warn(`Failed to prune DAG subtree for ${entry.rootPostHash}: ${String(err)}`);
    // Non-fatal — DAG content may not be present
  }
}
```

- [ ] **Step 2: Add settlePruneUtxo closure inside applyOrderingBlock**

`getSubtreeTopology` is imported from `../store/topology.js`. `settlePruneUtxo` is a closure inside `applyOrderingBlock` capturing the store functions (`getPostLockBox`, `getUnspentLikeBoxes`, `getKarmaBoxes`, `consumeBox`, `mintKarma`) from the outer scope:

```typescript
function settlePruneUtxo(postIds: string[], blockHeight: number, journal: BlockJournal): void {
  const authorRefunds = new Map<string, number>();
  const likerRefunds = new Map<string, number>();

  for (const postId of postIds) {
    // Consume PostLockBox (author's locked karma)
    const lockBox = getPostLockBox(postId);
    if (lockBox && lockBox.value > 0) {
      const key = Buffer.from(lockBox.owner).toString('hex');
      authorRefunds.set(key, (authorRefunds.get(key) ?? 0) + lockBox.value);
      consumeBox(lockBox.id!, blockHeight);
      journal.consumedBoxIds.push(lockBox.id!);
    }

    // Consume unspent LikeBoxes (likers' locked karma)
    const likeBoxes = getUnspentLikeBoxes(postId);
    for (const likeBox of likeBoxes) {
      if (likeBox.value > 0) {
        const key = Buffer.from(likeBox.likerId).toString('hex');
        likerRefunds.set(key, (likerRefunds.get(key) ?? 0) + likeBox.value);
        consumeBox(likeBox.id!, blockHeight);
        journal.consumedBoxIds.push(likeBox.id!);
      }
    }
  }

  // Mint refund karma for authors
  for (const [hexUserId, amount] of authorRefunds) {
    const userId = new Uint8Array(Buffer.from(hexUserId, 'hex'));
    const existingKarma = getKarmaBoxes(userId);
    for (const kb of existingKarma) {
      if (kb.id) journal.consumedBoxIds.push(kb.id);
    }
    const newBoxId = mintKarma(userId, amount, blockHeight);
    if (newBoxId) journal.createdBoxIds.push(newBoxId);
  }

  // Mint refund karma for likers
  for (const [hexUserId, amount] of likerRefunds) {
    const userId = new Uint8Array(Buffer.from(hexUserId, 'hex'));
    const existingKarma = getKarmaBoxes(userId);
    for (const kb of existingKarma) {
      if (kb.id) journal.consumedBoxIds.push(kb.id);
    }
    const newBoxId = mintKarma(userId, amount, blockHeight);
    if (newBoxId) journal.createdBoxIds.push(newBoxId);
  }
}
```

- [ ] **Step 3: Add getUnspentLikeBoxes to store/utxo.ts if not present**

Check if `getUnspentLikeBoxes` exists. If not, add:

```typescript
export function getUnspentLikeBoxes(targetPostId: string): LikeBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'like'
         AND json_extract(extra_data, '$.targetPostId') = ?
         AND spent_at_block IS NULL`,
    )
    .all(targetPostId) as UtxoRow[];
  return rows.map(rowToBox) as LikeBox[];
}
```

- [ ] **Step 4: Populate block_topology during block application**

In `applyOrderingBlock`, after the subBlockEntries are processed (where posts are confirmed), add:

```typescript
// Populate block_topology from this block's entries
for (const entry of block.subBlockTree.subBlockEntries) {
  insertBlockTopology(entry.postId, entry.parentRefs, block.header.height);
}
```

Add `insertBlockTopology` to store/topology.ts (new file):

```typescript
// packages/node/src/store/topology.ts
import { getDb } from './db.js';

export function insertBlockTopology(
  postId: string,
  parentRefs: string[],
  blockHeight: number,
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO block_topology (post_id, parent_refs, block_height)
     VALUES (?, ?, ?)`,
  ).run(postId, JSON.stringify(parentRefs), blockHeight);
}

export function getSubtreeTopology(rootPostId: string): Set<string> {
  const db = getDb();
  const rows = db.prepare(
    `WITH RECURSIVE subtree AS (
       SELECT post_id FROM block_topology WHERE post_id = ?
       UNION
       SELECT bt.post_id FROM block_topology bt
       JOIN subtree s ON (
         bt.parent_refs LIKE '%' || s.post_id || '%'
       )
     )
     SELECT DISTINCT post_id FROM subtree`,
  ).all(rootPostId) as Array<{ post_id: string }>;
  return new Set(rows.map(r => r.post_id));
}
```

- [ ] **Step 5: Handle fork resolution rollback**

During fork resolution (block-apply.ts `rollbackBlock` or equivalent), entries from reverted blocks must be removed from `block_topology`. Add:

```typescript
function rollbackBlockTopology(blockHeight: number): void {
  const db = getDb();
  db.prepare(
    `DELETE FROM block_topology WHERE block_height = ?`,
  ).run(blockHeight);
}
```

Call this in the rollback path (where UTXO boxes are being rolled back).

- [ ] **Step 6: Commit**

```bash
git add packages/node/src/services/block-apply.ts packages/node/src/store/topology.ts packages/node/src/store/utxo.ts
git commit -m "feat(block-apply): UTXO-driven prune settlement, block_topology population

Replace DAG-walk settlement with deterministic UTXO queries keyed by postId list.
Add block_topology table population from subBlockEntries.
Add getUnspentLikeBoxes store function.
Handle block_topology rollback during fork resolution.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Core services — block-creator.ts update

**Files:**
- Modify: `packages/node/src/services/block-creator.ts`

**Interfaces:**
- Consumes: `PruneEntry[]`, `drainMempoolPrunes`, `computePruneEntryId`
- Produces: updated `computeSubBlockRoot`, updated `createOrderingBlock`

- [ ] **Step 1: Update computeSubBlockRoot**

```typescript
import { serializePruneEntry } from '@dagsocial/types';
import type { PruneEntry } from '@dagsocial/types';

export function computeSubBlockRoot(tree: SubBlockTree): string {
  const leaves = [
    ...tree.subBlockEntries.map((entry) =>
      leafHash('subblock', Buffer.from(JSON.stringify({
        postId: entry.postId,
        parentRefs: entry.parentRefs,
      })))),
    ...tree.pruneEntries.map((entry) =>
      leafHash('prune', Buffer.from(serializePruneEntry(entry)))),
  ];
  return Buffer.from(buildMerkleRoot(leaves)).toString('hex');
}
```

- [ ] **Step 2: Update createOrderingBlock to drain prune entries**

Replace the old stump draining code (around line 521):

```typescript
// Drain queued prune entries for block inclusion
const MAX_PRUNES_PER_BLOCK = 32;
const pruneEntries = drainMempoolPrunes(MAX_PRUNES_PER_BLOCK);

// Build SubBlockTree
const subBlockTree: SubBlockTree = {
  subBlockRefs,
  subBlockEntries: subBlockEntriesForBlock,
  pruneEntries,
};
```

- [ ] **Step 3: Update imports**

Replace `drainMempoolStumps` with `drainMempoolPrunes`. Remove `stumpIds` variable.

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/services/block-creator.ts
git commit -m "feat(block-creator): drain prune entries from mempool, update Merkle root"
```

---

### Task 8: HTTP routes — signed PruneEntry submission

**Files:**
- Modify: `packages/node/src/routes/delete.ts`
- Modify: `packages/node/src/routes/pruning.ts` (or delete, merging into delete.ts)

**Interfaces:**
- Consumes: `PruneIntent`, `PruneEntry`, `executePrune` (updated)
- Produces: new `POST /prune` endpoint, updated `DELETE /posts/:id`

- [ ] **Step 1: Rewrite delete.ts route**

Replace the challenge-response flow. The client now sends a fully-formed `PruneIntent` with a real signature:

```typescript
import { Router } from 'express';
import type { PruneIntent, PruneEntry } from '@dagsocial/types';

export interface DeleteDeps {
  executePrune: (intent: PruneIntent) => PruneEntry;
}

export function deleteRoutes(deps: DeleteDeps): Router {
  const router = Router();

  router.post('/posts/:id/prune', (req, res) => {
    try {
      const { rootPostHash, authorId, subtreeMerkleRoot, subtreePostIds,
              signature, trigger } = req.body;

      // Validate required fields
      if (!rootPostHash || !authorId || !subtreeMerkleRoot ||
          !subtreePostIds || !signature) {
        return res.status(400).json({
          error: 'Missing required fields: rootPostHash, authorId, subtreeMerkleRoot, subtreePostIds, signature',
        });
      }

      // Validate types
      if (!Array.isArray(subtreePostIds) || subtreePostIds.length === 0) {
        return res.status(400).json({ error: 'subtreePostIds must be a non-empty array' });
      }

      if (!/^[0-9a-f]{64}$/.test(rootPostHash)) {
        return res.status(400).json({ error: 'Invalid rootPostHash format' });
      }

      const intent: PruneIntent = {
        rootPostHash,
        trigger: trigger === 'storage_prune' ? 'storage_prune' : 'author',
        authorId: Buffer.from(authorId, 'hex'),
        subtreeMerkleRoot: Buffer.from(subtreeMerkleRoot, 'hex'),
        subtreePostIds,
        signature: Buffer.from(signature, 'hex'),
      };

      const entry = deps.executePrune(intent);
      const { computePruneEntryId } = await import('@dagsocial/types');
      const entryId = computePruneEntryId(entry);

      return res.status(201).json({
        status: 'deleted',
        entryId,
        postId: rootPostHash,
        replyCount: subtreePostIds.length - 1,
      });
    } catch (err: any) {
      if (err.statusCode === 404) {
        return res.status(404).json({ error: 'Post not found' });
      }
      if (err.statusCode === 403) {
        return res.status(403).json({ error: err.message });
      }
      if (err.statusCode === 400) {
        return res.status(400).json({ error: err.message });
      }
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
```

- [ ] **Step 2: Remove pruning.ts (merge into delete.ts)**

The old `POST /posts/:id/prune` route in `pruning.ts` is superseded by the new `POST /posts/:id/prune` in `delete.ts`. Delete `packages/node/src/routes/pruning.ts`.

- [ ] **Step 3: Update server.ts wiring**

In `packages/node/src/server.ts`, remove the `pruningRoutes` import and wiring. The `deleteRoutes` now handles both. Update the deps object to no longer include challenge-related functions:

```typescript
// Old (remove):
import { pruningRoutes } from './routes/pruning.js';
// ...
app.use(pruningRoutes({
  executePrune, computeStumpId,
  getActiveChallenge, consumeChallenge, getCurrentHeight,
}));

// New:
app.use(deleteRoutes({
  executePrune,
}));
```

Also remove the `verifyAuthorSignature` import from server.ts if present.

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/routes/delete.ts packages/node/src/routes/pruning.ts packages/node/src/server.ts
git commit -m "feat(routes): signed PruneIntent submission, remove challenge-response

Replace DELETE /posts/:id with POST /posts/:id/prune accepting a
client-signed PruneIntent. Remove pruning.ts (merged into delete.ts).
Remove challenge-response deps from server wiring.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Verifier cleanup

**Files:**
- Modify: `packages/node/src/services/verifier.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: removal of `verifyAuthorSignature`

- [ ] **Step 1: Remove verifyAuthorSignature and AuthorVerifierDeps**

Remove `verifyAuthorSignature` function (lines 280-329) and the `AuthorVerifierDeps` interface (lines 265-269).

- [ ] **Step 2: Check for remaining references**

Search for `verifyAuthorSignature` and `AuthorVerifierDeps` across the codebase:
```bash
rtk proxy grep -rn "verifyAuthorSignature\|AuthorVerifierDeps" packages/
```
Expected: No results outside dist/.

- [ ] **Step 3: Commit**

```bash
git add packages/node/src/services/verifier.ts
git commit -m "chore(verifier): remove verifyAuthorSignature (replaced by signed PruneIntent)"
```

---

### Task 10: Net package — simplified Stump gossip

**Files:**
- Modify: `packages/net/src/gossip.ts`
- Modify: `packages/net/src/types.ts`

**Interfaces:**
- Consumes: simplified `Stump` type
- Produces: updated gossip topic validator, updated protocol message types

- [ ] **Step 1: Update gossip topic validator**

The current validator calls `computeStumpId(stump)`. Replace with `computePruneEntryId` or a simpler check — the simplified Stump doesn't carry enough fields for the old ID computation. Use `rootPostHash` as the identifier:

```typescript
gs.topicValidators.set(TOPICS.stump, (_peer, msg) => {
  try {
    const raw = new Uint8Array(msg.data);
    const stump = decodeStump(raw);
    // Structural check: rootPostHash must be valid hex
    if (!/^[0-9a-f]{64}$/.test(stump.rootPostHash)) {
      peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, 'invalid stump');
      return TopicValidatorResult.Reject;
    }
    return TopicValidatorResult.Accept;
  } catch (err) {
    peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, _peer.toString(), ...);
    return TopicValidatorResult.Reject;
  }
});
```

- [ ] **Step 2: Update protocol message types**

In `packages/net/src/types.ts`, the `StumpsEntry` type may reference old Stump fields. Update to match simplified Stump.

- [ ] **Step 3: Update content-sweep.ts**

In `packages/node/src/services/content-sweep.ts`, replace the old `sweepStumps` (which scanned `ordering_blocks` for `stumpIds` not in `dag_stumps`) with `sweepPruneEntries` that scans for `pruneEntries`:

The sweep function deserializes the `subblock_tree_cbor` from recent `ordering_blocks`, extracts `pruneEntries`, and for each checks if the corresponding `dag_stumps` row exists (by `rootPostHash`). Missing entries trigger a backfill request to peers. Since settlement is driven by the block (not DAG), the sweep only backfills the historical Stump record — settlement was already applied during block sync. The core change is replacing `stumpIds` array iteration with `pruneEntries` array iteration.

- [ ] **Step 4: Commit**

```bash
git add packages/net/src/gossip.ts packages/net/src/types.ts packages/node/src/services/content-sweep.ts
git commit -m "chore(net): update gossip for simplified Stump, update content sweep for PruneEntry"
```

---

### Task 11: Index wiring and build verification

**Files:**
- Modify: `packages/node/src/index.ts`
- Modify: `packages/node/src/store/index.ts`

**Interfaces:**
- Consumes: all updated modules
- Produces: working node startup

- [ ] **Step 1: Update store/index.ts exports**

Ensure all new store functions are exported:
```typescript
export { insertMempoolPrune, drainMempoolPrunes, removeMempoolPrunes } from './mempool.js';
export { insertBlockTopology, getSubtreeTopology, rollbackBlockTopology } from './topology.js';
export { getUnspentLikeBoxes } from './utxo.js';
```

Remove old exports: `insertMempoolStump`, `drainMempoolStumps`, `removeMempoolStumps`.

- [ ] **Step 2: Update index.ts wiring**

Update all imports in `packages/node/src/index.ts` that reference old function names. Key points:
- Any call to `insertMempoolStump` → removed (now handled by `executePrune`)
- Net `onStump` handler — still works with simplified Stump type
- Content sweep integration — update function names

- [ ] **Step 3: Full build**

```bash
pnpm build
```
Fix all type errors. Iterate until clean.

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```
Expected: Clean (after fixing all type errors from build step).

- [ ] **Step 5: Commit**

```bash
git add packages/node/src/index.ts packages/node/src/store/index.ts
git commit -m "chore(node): wire updated store and service functions in index.ts"
```

---

### Task 12: Tests — types, serialization, and unit tests

**Files:**
- Create: `packages/types/test/prune-entry.test.ts`
- Modify: existing type tests if needed

**Interfaces:**
- Consumes: `PruneEntry`, `computePruneEntryId`, `serializePruneEntry`, `Stump`
- Produces: passing unit tests

- [ ] **Step 1: Write PruneEntry serialization round-trip test**

```typescript
// packages/types/test/prune-entry.test.ts
import { describe, it, expect } from 'vitest';
import { computePruneEntryId, serializePruneEntry } from '../src/stump.js';
import type { PruneEntry } from '../src/stump.js';
import { fromBuffer, toBuffer } from 'cbor-x';

function makeEntry(overrides?: Partial<PruneEntry>): PruneEntry {
  return {
    rootPostHash: 'a'.repeat(64),
    subtreePostIds: ['b'.repeat(64), 'c'.repeat(64)],
    subtreeMerkleRoot: new Uint8Array(32).fill(0xdd),
    authorId: new Uint8Array(32).fill(0xaa),
    authorSignature: new Uint8Array(64).fill(0xbb),
    trigger: 'author',
    ...overrides,
  };
}

describe('PruneEntry', () => {
  it('computePruneEntryId produces 64-char hex', () => {
    const entry = makeEntry();
    const id = computePruneEntryId(entry);
    expect(id).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(id)).toBe(true);
  });

  it('computePruneEntryId is deterministic', () => {
    const a = makeEntry();
    const b = makeEntry();
    expect(computePruneEntryId(a)).toBe(computePruneEntryId(b));
  });

  it('computePruneEntryId changes with different rootPostHash', () => {
    const a = makeEntry();
    const b = makeEntry({ rootPostHash: 'd'.repeat(64) });
    expect(computePruneEntryId(a)).not.toBe(computePruneEntryId(b));
  });

  it('serializePruneEntry round-trips via CBOR', () => {
    const entry = makeEntry();
    const bytes = serializePruneEntry(entry);
    const decoded = fromBuffer(bytes);
    expect(decoded.rootPostHash).toBe(entry.rootPostHash);
    expect(decoded.subtreePostIds).toEqual(entry.subtreePostIds);
    expect(decoded.trigger).toBe('author');
  });

  it('serializePruneEntry is deterministic', () => {
    const a = makeEntry();
    const b = makeEntry();
    expect(Buffer.from(serializePruneEntry(a)).equals(
      Buffer.from(serializePruneEntry(b)))).toBe(true);
  });

  it('serializePruneEntry changes with different subtreePostIds', () => {
    const a = makeEntry();
    const b = makeEntry({ subtreePostIds: ['e'.repeat(64)] });
    expect(Buffer.from(serializePruneEntry(a)).equals(
      Buffer.from(serializePruneEntry(b)))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @dagsocial/types test
```
Expected: All tests pass including new ones.

- [ ] **Step 3: Commit**

```bash
git add packages/types/test/prune-entry.test.ts
git commit -m "test(types): add PruneEntry serialization and ID computation tests"
```

---

### Task 13: Tests — Ed25519 signature round-trip

**Files:**
- Create: `packages/node/test/services/prune-signature.test.ts`

- [ ] **Step 1: Write signature verification test**

```typescript
// packages/node/test/services/prune-signature.test.ts
import { describe, it, expect } from 'vitest';
import { createHash, generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto';

describe('PruneEntry Ed25519 signature', () => {
  it('signs (rootPostHash, subtreeMerkleRoot) and verifies', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');

    const rootPostHash = 'a'.repeat(64);
    const subtreeMerkleRoot = Buffer.alloc(32, 0xdd);

    const payload = createHash('blake2b512')
      .update(rootPostHash)
      .update(subtreeMerkleRoot)
      .digest()
      .subarray(0, 32);

    const signature = sign(null, payload, privateKey);

    // Verify
    const authorId = publicKey.export({ format: 'jwk' }).x
      ? Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')
      : publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

    // Actually, get raw 32-byte public key:
    const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

    const keyObject = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: rawPub.toString('base64url'),
      },
      format: 'jwk',
    });

    const valid = verify(null, payload, keyObject, signature);
    expect(valid).toBe(true);
  });

  it('rejects tampered rootPostHash', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

    const rootPostHash = 'a'.repeat(64);
    const subtreeMerkleRoot = Buffer.alloc(32, 0xdd);

    const payload = createHash('blake2b512')
      .update(rootPostHash)
      .update(subtreeMerkleRoot)
      .digest()
      .subarray(0, 32);

    const signature = sign(null, payload, privateKey);

    // Tamper
    const tamperedPayload = createHash('blake2b512')
      .update('b'.repeat(64))
      .update(subtreeMerkleRoot)
      .digest()
      .subarray(0, 32);

    const keyObject = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: rawPub.toString('base64url') },
      format: 'jwk',
    });

    const valid = verify(null, tamperedPayload, keyObject, signature);
    expect(valid).toBe(false);
  });

  it('rejects wrong key', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const { publicKey: otherPub } = generateKeyPairSync('ed25519');
    const rawOther = otherPub.export({ type: 'spki', format: 'der' }).subarray(-32);

    const rootPostHash = 'a'.repeat(64);
    const subtreeMerkleRoot = Buffer.alloc(32, 0xdd);
    const payload = createHash('blake2b512')
      .update(rootPostHash)
      .update(subtreeMerkleRoot)
      .digest()
      .subarray(0, 32);

    const signature = sign(null, payload, privateKey);

    const keyObject = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: rawOther.toString('base64url') },
      format: 'jwk',
    });

    const valid = verify(null, payload, keyObject, signature);
    expect(valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @dagsocial/node test -- --testPathPattern="prune-signature"
```
Expected: All 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/node/test/services/prune-signature.test.ts
git commit -m "test(node): Ed25519 signature round-trip for PruneEntry authorization"
```

---

### Task 14: Tests — block_topology and deterministic settlement

**Files:**
- Create: `packages/node/test/services/prune-settlement.test.ts`

- [ ] **Step 1: Write settlement unit tests**

```typescript
// packages/node/test/services/prune-settlement.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initTestDb } from '../harness/test-db.js'; // or inline setup

describe('Prune settlement', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initTestDb(); // creates in-memory DB with schema
  });

  afterEach(() => {
    db.close();
  });

  it('getSubtreeTopology computes transitive closure', () => {
    // Insert a chain: root -> reply1 -> reply2
    insertBlockTopology('root1', [], 1);
    insertBlockTopology('reply1', ['root1'], 2);
    insertBlockTopology('reply2', ['reply1'], 2);

    const subtree = getSubtreeTopology('root1');
    expect(subtree).toEqual(new Set(['root1', 'reply1', 'reply2']));
  });

  it('getSubtreeTopology returns only root when no replies', () => {
    insertBlockTopology('root1', [], 1);
    const subtree = getSubtreeTopology('root1');
    expect(subtree).toEqual(new Set(['root1']));
  });

  it('settlePruneUtxo consumes PostLockBoxes and mints refund karma', () => {
    // Arrange: insert a post_lock box and a like box for post 'root1'
    const rootPostId = 'a'.repeat(64);
    const authorId = new Uint8Array(32).fill(0x01);
    const likerId = new Uint8Array(32).fill(0x02);

    db.prepare(`INSERT INTO utxo_boxes (id, box_type, value, owner, guard, extra_data, created_at_block, spent_at_block)
      VALUES ('box1', 'post_lock', 100, ?, 'epoch_tally', ?, 1, NULL)`).run(
      Buffer.from(authorId),
      JSON.stringify({ targetPostId: rootPostId }),
    );
    db.prepare(`INSERT INTO utxo_boxes (id, box_type, value, owner, guard, extra_data, created_at_block, spent_at_block)
      VALUES ('box2', 'like', 2, ?, 'epoch_tally', ?, 1, NULL)`).run(
      Buffer.from(likerId),
      JSON.stringify({ targetPostId: rootPostId, likerId: Buffer.from(likerId).toString('hex') }),
    );

    // Act: settle (using a mock journal)
    const journal = { consumedBoxIds: [] as string[], createdBoxIds: [] as string[] };
    settlePruneUtxo([rootPostId], 10, journal);

    // Assert: boxes consumed
    expect(journal.consumedBoxIds).toContain('box1');
    expect(journal.consumedBoxIds).toContain('box2');

    // Assert: karma refunded (author gets 100, liker gets 2)
    expect(journal.createdBoxIds.length).toBe(2);

    // Assert: boxes marked spent in DB
    const box1 = db.prepare(`SELECT spent_at_block FROM utxo_boxes WHERE id = 'box1'`).get() as any;
    expect(box1.spent_at_block).toBe(10);
  });

  it('settlePruneUtxo handles empty postId list', () => {
    const journal = { consumedBoxIds: [] as string[], createdBoxIds: [] as string[] };
    expect(() => settlePruneUtxo([], 5, journal)).not.toThrow();
    expect(journal.consumedBoxIds.length).toBe(0);
    expect(journal.createdBoxIds.length).toBe(0);
  });

  it('settlePruneUtxo skips already-spent boxes', () => {
    const rootPostId = 'b'.repeat(64);
    // Insert an already-spent box
    db.prepare(`INSERT INTO utxo_boxes (id, box_type, value, owner, guard, extra_data, created_at_block, spent_at_block)
      VALUES ('box3', 'post_lock', 50, ?, 'epoch_tally', ?, 1, 5)`).run(
      Buffer.from(new Uint8Array(32).fill(0x03)),
      JSON.stringify({ targetPostId: rootPostId }),
    );

    const journal = { consumedBoxIds: [] as string[], createdBoxIds: [] as string[] };
    settlePruneUtxo([rootPostId], 10, journal);

    // Already-spent box should not be re-consumed
    expect(journal.consumedBoxIds).not.toContain('box3');
    expect(journal.createdBoxIds.length).toBe(0);
  });
});
```

- [ ] **Step 2: Write full integration test**

```typescript
it('full prune lifecycle: create → reply → like → prune → verify refunds', () => {
  // 1. Create root post with PostLockBox (karma locked)
  const rootId = 'a'.repeat(64);
  const replyId = 'b'.repeat(64);
  const authorId = new Uint8Array(32).fill(0xaa);
  const likerId = new Uint8Array(32).fill(0xbb);

  // Seed block_topology: root has no parents, reply has root as parent
  insertBlockTopology(rootId, [], 1);
  insertBlockTopology(replyId, [rootId], 2);

  // Seed UTXO: PostLockBox for each post + LikeBox on root
  insertTestBox('bl1', 'post_lock', 50, authorId, rootId, null);
  insertTestBox('bl2', 'post_lock', 50, authorId, replyId, null);
  insertTestBox('lk1', 'like', 2, likerId, rootId, null);

  // 2. Compute Merkle root over {rootId, replyId}
  const leaves = [rootId, replyId]
    .sort()
    .map(id => leafHash('stump', hexToBuf(id)));
  const merkleRoot = buildMerkleRoot(leaves);

  // 3. Sign PruneIntent
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  // (in real test, authorId = raw pubkey from the keypair)
  const payload = createHash('blake2b512')
    .update(rootId)
    .update(merkleRoot)
    .digest()
    .subarray(0, 32);
  const signature = sign(null, payload, privateKey);

  // 4. Build PruneEntry and apply settlement
  const entry: PruneEntry = {
    rootPostHash: rootId,
    subtreePostIds: [rootId, replyId],
    subtreeMerkleRoot: merkleRoot,
    authorId,
    authorSignature: signature,
    trigger: 'author',
  };

  const journal = applyPruneEntry(entry, 10);

  // 5. Verify PostLockBoxes consumed
  expect(journal.consumedBoxIds).toContain('bl1');
  expect(journal.consumedBoxIds).toContain('bl2');
  // LikeBox consumed
  expect(journal.consumedBoxIds).toContain('lk1');

  // 6. Verify karma refunded: author gets 50+50=100, liker gets 2
  const createdBoxes = journal.createdBoxIds.map(id => getBoxById(id));
  const authorBox = createdBoxes.find(b => Buffer.from(b.owner).equals(authorId));
  const likerBox = createdBoxes.find(b => Buffer.from(b.owner).equals(likerId));
  expect(authorBox!.value).toBe(100);
  expect(likerBox!.value).toBe(2);

  // 7. Verify posts marked pruned in dag_posts
  const rootPost = getPost(rootId);
  expect(rootPost).toBeNull(); // pruned posts hidden
  const stumpRecord = getStump(computePruneEntryId(entry));
  expect(stumpRecord).not.toBeNull();
  expect(stumpRecord!.replyCount).toBe(1); // root + 1 reply
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @dagsocial/node test -- --testPathPattern="prune-settlement"
```

- [ ] **Step 4: Commit**

```bash
git add packages/node/test/services/prune-settlement.test.ts
git commit -m "test(node): block_topology and deterministic settlement tests"
```

---

### Task 15: Tests — update and remove existing tests

**Files:**
- Modify: `packages/node/test/routes/pruning.test.ts`
- Modify: `packages/node/test/routes/delete.test.ts`
- Modify: any other tests referencing old types

- [ ] **Step 1: Find broken tests**

```bash
pnpm test 2>&1 | grep -E "FAIL|Error|failed"
```

- [ ] **Step 2: Update pruning.test.ts**

Remove tests that reference `verifyAuthorSignature`, challenge-response flow, or the old `executePrune(intent, signature)` signature. Replace with tests for the new `POST /posts/:id/prune` endpoint accepting a signed `PruneIntent`.

- [ ] **Step 3: Update delete.test.ts**

Same — remove challenge-response tests, add PruneIntent submission tests.

- [ ] **Step 4: Update any other broken tests**

Search for references to removed functions:
```bash
rtk proxy grep -rn "verifyAuthorSignature\|insertMempoolStump\|drainMempoolStumps\|computeStumpId" packages/node/test/
```
Update each to use new function names.

- [ ] **Step 5: Run full test suite**

```bash
pnpm test
```
Fix failures until all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/node/test/
git commit -m "test(node): update tests for verifiable prune, remove challenge-response tests"
```

---

### Task 16: Final integration test and verification

- [ ] **Step 1: Full build**

```bash
pnpm build
```
Expected: Clean.

- [ ] **Step 2: Full typecheck**

```bash
pnpm typecheck
```
Expected: Clean.

- [ ] **Step 3: Full test suite**

```bash
pnpm test
```
Expected: All tests pass (existing E2E flake excepted).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: final wiring and verification for verifiable prune

All types updated, services refactored, tests passing.
Prune authorization now travels in the block as a signed PruneEntry.
Settlement is deterministic from UTXO state — no DAG content required.

Co-Authored-By: Claude <noreply@anthropic.com>"
```
