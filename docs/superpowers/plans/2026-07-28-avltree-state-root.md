# AVL+ State Root Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the zeroed `stateRoot` in block headers with a real AVL+ authenticated dictionary digest computed over the UTXO set via `@ergots/avltree`.

**Architecture:** New `packages/node/src/state/` module (3 files) implementing `VersionedAVLStorage` against SQLite, a `PersistentBatchAVLProver` singleton, and a `GET /api/v1/proof/:boxId` endpoint. Wired into `block-apply.ts` (mutation tracking + verification) and `block-creator.ts` (stateRoot computation).

**Tech Stack:** `@ergots/avltree@^0.3.1` (pure TS, `@noble/hashes`), `better-sqlite3`, `cbor-x` (deterministic encoding), TypeScript, Vitest.

## Global Constraints

- `@ergots/avltree@^0.3.1` — pure TS, no WASM
- `AVL_KEY_LENGTH = 32` (box ID = 32-byte blake2b hash, raw bytes not hex)
- `VERIFY_STATE_ROOT` defaults to `false` during development
- `MAX_PROOF_HISTORY` defaults to `1440` blocks
- Deterministic CBOR for box value serialization (`sortKeys: true`, `variable: false`)
- All new tests in `packages/node/test/state/`
- No changes to `packages/types` (BlockHeader.stateRoot already exists)
- Follow existing patterns: config via env vars, SQLite via `better-sqlite3`, Express routes

---

### Task 1: Add @ergots/avltree dependency, config flags, and schema migration

**Files:**
- Modify: `packages/node/package.json`
- Modify: `packages/node/src/config.ts`
- Modify: `packages/node/src/store/db.ts`

**Interfaces:**
- Produces: `Config.verifyStateRoot: boolean`, `Config.maxProofHistory: number`, `Config.avlKeyLength: number`
- Produces: `avl_tree_versions` and `avl_tree_nodes` SQLite tables

- [ ] **Step 1: Add @ergots/avltree dependency**

```bash
cd packages/node && pnpm add @ergots/avltree@^0.3.1
```

Expected: `@ergots/avltree` added to `dependencies` in `packages/node/package.json`.

- [ ] **Step 2: Add config flags to config.ts**

In `packages/node/src/config.ts`, add to the `Config` interface after the karma decay section:

```ts
// AVL state root
verifyStateRoot: boolean;
maxProofHistory: number;
avlKeyLength: number;
```

Add to `loadConfig()` return value, after the karma minimum line:

```ts
// AVL state root
verifyStateRoot: process.env['VERIFY_STATE_ROOT'] === 'true',
maxProofHistory: parseInt(
  process.env['MAX_PROOF_HISTORY'] ?? '1440',
  10,
),
avlKeyLength: parseInt(
  process.env['AVL_KEY_LENGTH'] ?? '32',
  10,
),
```

- [ ] **Step 3: Add schema migration to db.ts**

In `packages/node/src/store/db.ts`, add a new migration function after `migrateMempoolForStumps`:

```ts
function migrateAvlTree(database: Database.Database): void {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='avl_tree_versions'")
    .all() as Array<{ name: string }>;
  if (tables.length > 0) return;

  database.exec(`
    CREATE TABLE avl_tree_versions (
      version BLOB PRIMARY KEY,
      height INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE avl_tree_nodes (
      version BLOB NOT NULL REFERENCES avl_tree_versions(version),
      label BLOB NOT NULL,
      node_data BLOB NOT NULL,
      PRIMARY KEY (version, label)
    );
  `);
}
```

Call it after `migrateMempoolForStumps(db)` in `initDb`:

```ts
migrateAvlTree(db);
```

- [ ] **Step 4: Verify build**

```bash
pnpm typecheck && pnpm build
```

Expected: Clean typecheck, clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/node/package.json packages/node/pnpm-lock.yaml packages/node/src/config.ts packages/node/src/store/db.ts
git commit -m "feat(state): add @ergots/avltree dep, config flags, and AVL schema migration"
```

---

### Task 2: Box serialization — deterministic CBOR encode/decode

**Files:**
- Create: `packages/node/src/state/serialize-box.ts`
- Create: `packages/node/test/state/serialize-box.test.ts`

**Interfaces:**
- Produces: `serializeBox(box: AnyBox): Uint8Array`
- Produces: `deserializeBox(bytes: Uint8Array): AnyBox`
- Consumes: `AnyBox` types from `@dagsocial/types`

- [ ] **Step 1: Write failing tests**

Create `packages/node/test/state/serialize-box.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { serializeBox, deserializeBox } from '../../src/state/serialize-box.js';

describe('serializeBox', () => {
  it('roundtrips a KarmaBox', () => {
    const box = {
      id: 'ab'.repeat(32),
      boxType: 'karma' as const,
      value: 100,
      createdAtBlock: 5,
      owner: new Uint8Array(32).fill(0xaa),
      guard: 'owner_signature' as const,
      proofSource: 'mint-1',
      lastTouchBlock: 5,
    };
    const serialized = serializeBox(box);
    const deserialized = deserializeBox(serialized);
    expect(deserialized).toEqual(box);
  });

  it('roundtrips a CreditBox', () => {
    const box = {
      id: 'cd'.repeat(32),
      boxType: 'credit' as const,
      value: 50,
      createdAtBlock: 10,
      owner: new Uint8Array(32).fill(0xbb),
      guard: 'owner_signature' as const,
      proofSource: 10,
      lockedUntilBlock: 20,
    };
    expect(deserializeBox(serializeBox(box))).toEqual(box);
  });

  it('roundtrips a LikeBox', () => {
    const box = {
      id: 'ef'.repeat(32),
      boxType: 'like' as const,
      value: 2,
      createdAtBlock: 3,
      likerId: new Uint8Array(32).fill(0x11),
      targetPostId: 'post-1',
      guard: 'epoch_tally' as const,
    };
    expect(deserializeBox(serializeBox(box))).toEqual(box);
  });

  it('roundtrips an InviteBox', () => {
    const box = {
      id: 'gh'.repeat(32),
      boxType: 'invite' as const,
      value: 10,
      createdAtBlock: 7,
      secretHash: new Uint8Array(32).fill(0x22),
      inviterId: new Uint8Array(32).fill(0x33),
      guard: 'hash_preimage_with_bond' as const,
    };
    expect(deserializeBox(serializeBox(box))).toEqual(box);
  });

  it('roundtrips a BondBox', () => {
    const box = {
      id: 'ij'.repeat(32),
      boxType: 'bond' as const,
      value: 5,
      createdAtBlock: 7,
      inviterId: new Uint8Array(32).fill(0x33),
      inviteBoxId: 'gh'.repeat(32),
      inviteePublicKey: new Uint8Array(32),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual' as const,
    };
    expect(deserializeBox(serializeBox(box))).toEqual(box);
  });

  it('roundtrips a PostLockBox', () => {
    const box = {
      id: 'kl'.repeat(32),
      boxType: 'post_lock' as const,
      value: 5,
      originalValue: 5,
      createdAtBlock: 4,
      owner: new Uint8Array(32).fill(0x44),
      targetPostId: 'post-2',
      guard: 'epoch_tally' as const,
    };
    expect(deserializeBox(serializeBox(box))).toEqual(box);
  });

  it('is deterministic — same input produces identical bytes', () => {
    const box = {
      id: 'mn'.repeat(32),
      boxType: 'karma' as const,
      value: 42,
      createdAtBlock: 1,
      owner: new Uint8Array(32).fill(0x55),
      guard: 'owner_signature' as const,
      proofSource: 'mint-0',
      lastTouchBlock: 1,
    };
    const a = serializeBox(box);
    const b = serializeBox({ ...box });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('deserializeBox throws on truncated bytes', () => {
    const box = {
      id: 'op'.repeat(32),
      boxType: 'karma' as const,
      value: 1,
      createdAtBlock: 0,
      owner: new Uint8Array(32),
      guard: 'owner_signature' as const,
      proofSource: '',
      lastTouchBlock: 0,
    };
    const bytes = serializeBox(box);
    expect(() => deserializeBox(bytes.slice(0, 3))).toThrow();
  });

  it('deserializeBox throws on unknown box type byte', () => {
    expect(() => deserializeBox(new Uint8Array([0xff, ...new Array(100).fill(0)]))).toThrow();
  });
});
```

Run: `pnpm --filter @dagsocial/node test -- test/state/serialize-box.test.ts`
Expected: All 9 tests FAIL (module not found).

- [ ] **Step 2: Implement serializeBox**

Create `packages/node/src/state/serialize-box.ts`:

```ts
import { encode, decode } from 'cbor-x';
import type { AnyBox } from '@dagsocial/types';

// Box type discriminators (1 byte each)
const BOX_TYPE_TAG: Record<AnyBox['boxType'], number> = {
  karma: 0x01,
  credit: 0x02,
  like: 0x03,
  invite: 0x04,
  bond: 0x05,
  post_lock: 0x06,
};

const TAG_TO_BOX_TYPE: Record<number, AnyBox['boxType']> = {
  0x01: 'karma',
  0x02: 'credit',
  0x03: 'like',
  0x04: 'invite',
  0x05: 'bond',
  0x06: 'post_lock',
};

// Deterministic CBOR encoder: definite-length, sorted keys, no records (maps)
const cborEncode = (obj: unknown): Uint8Array =>
  encode(obj, { variable: false, sortKeys: true, useRecords: false });

/**
 * Serialize an AnyBox to a deterministic Uint8Array.
 * Format: boxTypeTag(1) || CBOR(boxFields)
 *
 * The box `id` is NOT included in the CBOR payload — it is the AVL key,
 * not part of the value. The `boxType` is encoded as a tag byte so
 * deserialization can reconstruct the discriminant.
 */
export function serializeBox(box: AnyBox): Uint8Array {
  const tag = BOX_TYPE_TAG[box.boxType];
  if (tag === undefined) throw new Error(`Unknown box type: ${box.boxType}`);

  // Omit `id` and `boxType` from CBOR — id is the AVL key, boxType is the tag byte
  const { id: _id, boxType: _bt, ...fields } = box;

  // Convert Uint8Array fields to Buffer for cbor-x (it handles both but Buffer is canonical)
  const payload = cborEncode(fields);

  const out = new Uint8Array(1 + payload.length);
  out[0] = tag;
  out.set(payload, 1);
  return out;
}

/**
 * Deserialize bytes produced by serializeBox back into an AnyBox.
 * The box `id` is NOT restored — callers must supply it separately
 * (it's the AVL key).
 */
export function deserializeBox(bytes: Uint8Array): Omit<AnyBox, 'id'> {
  if (bytes.length < 2) throw new Error('Truncated box data');

  const tag = bytes[0]!;
  const boxType = TAG_TO_BOX_TYPE[tag];
  if (!boxType) throw new Error(`Unknown box type tag: ${tag}`);

  const payload = bytes.slice(1);
  const fields = decode(payload) as Record<string, unknown>;

  // cbor-x decodes Uint8Arrays as Buffer; normalize for type compatibility
  return { boxType, ...fields } as Omit<AnyBox, 'id'>;
}

/**
 * Full roundtrip helper: serializes a box and returns deserializable bytes.
 * The box `id` is preserved in the returned object by the caller.
 */
export function serializeBoxWithId(box: AnyBox): Uint8Array {
  return serializeBox(box);
}

export function deserializeBoxWithId(id: string, bytes: Uint8Array): AnyBox {
  const fields = deserializeBox(bytes);
  return { id, ...fields } as AnyBox;
}
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @dagsocial/node test -- test/state/serialize-box.test.ts
```

Expected: All 9 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/state/serialize-box.ts packages/node/test/state/serialize-box.test.ts
git commit -m "feat(state): add deterministic CBOR box serialization"
```

---

### Task 3: SqliteAvlStorage — VersionedAVLStorage against SQLite

**Files:**
- Create: `packages/node/src/state/avl-storage.ts`
- Create: `packages/node/test/state/avl-storage.test.ts`

**Interfaces:**
- Produces: `class SqliteAvlStorage implements VersionedAVLStorage`
- Consumes: `VersionedAVLStorage` from `@ergots/avltree`
- Consumes: `serializeNode`, `deserializeNode`, `AvlNode`, `newLeaf`, `newInternal`, `newLabel`, `label` from `@ergots/avltree`
- Consumes: `BatchAVLProver` from `@ergots/avltree`
- Consumes: `getDb()` from `../store/db.js`

- [ ] **Step 1: Write failing tests**

Create `packages/node/test/state/avl-storage.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BatchAVLProver, PersistentBatchAVLProver } from '@ergots/avltree';
import { SqliteAvlStorage } from '../../src/state/avl-storage.js';
import { serializeNode, deserializeNode, type AvlNode } from '@ergots/avltree';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE avl_tree_versions (
      version BLOB PRIMARY KEY,
      height INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE avl_tree_nodes (
      version BLOB NOT NULL REFERENCES avl_tree_versions(version),
      label BLOB NOT NULL,
      node_data BLOB NOT NULL,
      PRIMARY KEY (version, label)
    );
  `);
  return db;
}

const HEIGHT_SENTINEL = new Uint8Array(32); // all zeros

describe('SqliteAvlStorage', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('version() returns null on empty storage', () => {
    const storage = new SqliteAvlStorage(db, 32, null);
    expect(storage.version()).toBeNull();
  });

  it('update() then version() returns the digest', () => {
    const storage = new SqliteAvlStorage(db, 32, null);
    const prover = new BatchAVLProver(32, null);

    // Insert a single key-value pair
    const key = new Uint8Array(32);
    key[0] = 0x01;
    const value = new Uint8Array([0xaa, 0xbb]);
    prover.performOneOperation({ tag: 'Insert', key, value });

    const digest = prover.digest()!;
    storage.update(prover, [[HEIGHT_SENTINEL, encodeHeight(1)]]);

    expect(storage.version()).toEqual(digest);
  });

  it('update() → rollback() roundtrip with single insert', () => {
    const storage = new SqliteAvlStorage(db, 32, null);
    const prover = new BatchAVLProver(32, null);

    const key = new Uint8Array(32);
    key[0] = 0x01;
    const value = new Uint8Array([0xaa, 0xbb]);
    prover.performOneOperation({ tag: 'Insert', key, value });

    const digestBefore = prover.digest()!;
    storage.update(prover, [[HEIGHT_SENTINEL, encodeHeight(1)]]);

    // Create fresh prover and rollback
    const prover2 = new BatchAVLProver(32, null);
    const persisted = new PersistentBatchAVLProver(prover2, storage, [[HEIGHT_SENTINEL, encodeHeight(1)]]);
    expect(persisted.digest()).toEqual(digestBefore);
    expect(persisted.unauthenticatedLookup(key)).toEqual(value);
  });

  it('update() → rollback() roundtrip with 100 inserts', () => {
    const storage = new SqliteAvlStorage(db, 32, null);
    const prover = new BatchAVLProver(32, null);

    const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
    for (let i = 0; i < 100; i++) {
      const key = new Uint8Array(32);
      key[0] = (i >> 8) & 0xff;
      key[1] = i & 0xff;
      const value = new Uint8Array([i & 0xff]);
      prover.performOneOperation({ tag: 'Insert', key, value });
      entries.push({ key, value });
    }

    const digestBefore = prover.digest()!;
    storage.update(prover, [[HEIGHT_SENTINEL, encodeHeight(1)]]);

    // Rollback fresh prover
    const prover2 = new BatchAVLProver(32, null);
    const persisted = new PersistentBatchAVLProver(prover2, storage, [[HEIGHT_SENTINEL, encodeHeight(1)]]);
    expect(persisted.digest()).toEqual(digestBefore);

    for (const { key, value } of entries) {
      expect(persisted.unauthenticatedLookup(key)).toEqual(value);
    }
  });

  it('rollbackVersions() returns all versions', () => {
    const storage = new SqliteAvlStorage(db, 32, null);

    // Insert at version 1
    const prover1 = new BatchAVLProver(32, null);
    const key1 = new Uint8Array(32);
    key1[0] = 0x01;
    prover1.performOneOperation({ tag: 'Insert', key1, value: new Uint8Array([1]) });
    storage.update(prover1, [[HEIGHT_SENTINEL, encodeHeight(1)]]);
    const v1 = storage.version()!;

    // Insert at version 2 (update storage with the SAME prover)
    prover1.performOneOperation({ tag: 'Insert', key: new Uint8Array(32).fill(0x01, 0, 1), value: new Uint8Array([2]) });
    storage.update(prover1, [[HEIGHT_SENTINEL, encodeHeight(2)]]);
    const v2 = storage.version()!;

    const versions = storage.rollbackVersions();
    expect(versions.length).toBe(2);
    expect(versions.map(v => Buffer.from(v).toString('hex')).sort()).toEqual(
      [v1, v2].map(v => Buffer.from(v).toString('hex')).sort()
    );
  });
});

function encodeHeight(h: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, h, false); // BE
  return buf;
}
```

Run: `pnpm --filter @dagsocial/node test -- test/state/avl-storage.test.ts`
Expected: All 5 tests FAIL (module not found).

- [ ] **Step 2: Implement SqliteAvlStorage**

Create `packages/node/src/state/avl-storage.ts`:

```ts
import type { VersionedAVLStorage, BatchAVLProver } from '@ergots/avltree';
import { serializeNode, deserializeNode, label } from '@ergots/avltree';
import type { AvlNode, InternalNode } from '@ergots/avltree';
import { getDb } from '../store/db.js';
import type Database from 'better-sqlite3';

/**
 * SQLite-backed VersionedAVLStorage.
 *
 * Stores each version's tree as individual serialized nodes keyed by
 * (version, node_label). Unchanged subtrees between versions share
 * the same serialized nodes — we skip re-inserting nodes whose
 * (label, node_data) is identical to the previous version.
 */
export class SqliteAvlStorage implements VersionedAVLStorage {
  private db: Database.Database;
  private keyLength: number;
  private valueLengthOpt: number | null;

  constructor(db: Database.Database, keyLength: number, valueLengthOpt: number | null) {
    this.db = db;
    this.keyLength = keyLength;
    this.valueLengthOpt = valueLengthOpt;
  }

  update(prover: BatchAVLProver, additionalData: [Uint8Array, Uint8Array][]): void {
    const newVersion = prover.digest();
    if (!newVersion) throw new Error('Prover digest is null');

    const prevVersion = this.version();

    const insertVersion = this.db.prepare(
      'INSERT INTO avl_tree_versions (version, height) VALUES (?, ?)',
    );

    // Extract block height from additionalData (HEIGHT_SENTINEL → height)
    let height = 0;
    for (const [k, v] of additionalData) {
      if (k.length === 32 && k.every(b => b === 0)) {
        height = new DataView(v.buffer, v.byteOffset, 4).getUint32(0, false);
        break;
      }
    }

    const insertNode = this.db.prepare(
      'INSERT OR REPLACE INTO avl_tree_nodes (version, label, node_data) VALUES (?, ?, ?)',
    );

    // Collect node labels from the previous version for dedup
    const prevLabels = prevVersion
      ? new Set(
          (this.db
            .prepare('SELECT label FROM avl_tree_nodes WHERE version = ?')
            .all(prevVersion) as Array<{ label: Buffer }>)
            .map(r => Buffer.from(r.label).toString('hex')),
        )
      : new Set<string>();

    const transaction = this.db.transaction(() => {
      insertVersion.run(newVersion, height);

      // Walk tree post-order, serialize each node, skip unchanged
      if (prover.root) {
        this.walkAndStore(prover.root, insertNode, newVersion, prevLabels);
      }
    });

    transaction();
  }

  private walkAndStore(
    node: AvlNode,
    insertStmt: Database.Statement,
    version: Uint8Array,
    prevLabels: Set<string>,
  ): void {
    if (node.kind === 'internal') {
      this.walkAndStore(node.left, insertStmt, version, prevLabels);
      this.walkAndStore(node.right, insertStmt, version, prevLabels);
    }

    const nodeLabel = label(node);
    const labelHex = Buffer.from(nodeLabel).toString('hex');

    // Skip if unchanged from previous version (dedup)
    if (prevLabels.has(labelHex)) return;

    const nodeData = serializeNode(node);
    insertStmt.run(version, nodeLabel, nodeData);
  }

  rollback(version: Uint8Array): [AvlNode, number] {
    const rows = this.db
      .prepare('SELECT label, node_data FROM avl_tree_nodes WHERE version = ?')
      .all(version) as Array<{ label: Buffer; node_data: Buffer }>;

    if (rows.length === 0) {
      throw new Error(`Version not found: ${Buffer.from(version).toString('hex')}`);
    }

    // Deserialize all nodes, index by label hex
    const nodeMap = new Map<string, AvlNode>();
    for (const row of rows) {
      const node = deserializeNode(new Uint8Array(row.node_data));
      const lbl = Buffer.from(row.label).toString('hex');
      nodeMap.set(lbl, node);
    }

    // Re-link InternalNode children via leftLabel/rightLabel
    for (const node of nodeMap.values()) {
      if (node.kind === 'internal') {
        const internal = node as InternalNode;
        // Left child is referenced by label
        const leftLabel = label(internal.left as AvlNode);
        const leftKey = Buffer.from(leftLabel).toString('hex');
        const leftNode = nodeMap.get(leftKey);
        if (leftNode) internal.left = leftNode;

        const rightLabel = label(internal.right as AvlNode);
        const rightKey = Buffer.from(rightLabel).toString('hex');
        const rightNode = nodeMap.get(rightKey);
        if (rightNode) internal.right = rightNode;
      }
    }

    // Find root: the node with no parent. In a stored tree, the root
    // is the node whose label is the version's first 32 bytes.
    const rootLabel = version.slice(0, 32);
    const rootKey = Buffer.from(rootLabel).toString('hex');
    const root = nodeMap.get(rootKey);
    if (!root) throw new Error('Root node not found in stored version');

    const height = version[32]!;
    return [root, height];
  }

  version(): Uint8Array | null {
    const row = this.db
      .prepare('SELECT version FROM avl_tree_versions ORDER BY height DESC LIMIT 1')
      .get() as { version: Buffer } | undefined;
    return row ? new Uint8Array(row.version) : null;
  }

  rollbackVersions(): Uint8Array[] {
    const rows = this.db
      .prepare('SELECT version FROM avl_tree_versions ORDER BY height ASC')
      .all() as Array<{ version: Buffer }>;
    return rows.map(r => new Uint8Array(r.version));
  }

  flush(): void {
    // SQLite WAL is auto-flushed; explicit checkpoint for durability
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }
}
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @dagsocial/node test -- test/state/avl-storage.test.ts
```

Expected: All 5 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/state/avl-storage.ts packages/node/test/state/avl-storage.test.ts
git commit -m "feat(state): implement SQLite-backed VersionedAVLStorage"
```

---

### Task 4: AVL prover lifecycle — factory, bootstrap, and block hooks

**Files:**
- Create: `packages/node/src/state/avl-prover.ts`
- Create: `packages/node/test/state/avl-prover.test.ts`

**Interfaces:**
- Produces: `createAvlProver(db): PersistentBatchAVLProver`
- Produces: `bootstrapAvlProver(prover, storage): void`
- Produces: `applyBlockMutations(prover, consumed: string[], created: AnyBox[]): Uint8Array`
- Produces: `HEIGHT_SENTINEL: Uint8Array`
- Produces: `encodeHeight(h: number): Uint8Array`
- Consumes: `BatchAVLProver`, `PersistentBatchAVLProver` from `@ergots/avltree`
- Consumes: `SqliteAvlStorage` from `./avl-storage.js`
- Consumes: `serializeBox` from `./serialize-box.js`
- Consumes: store functions from `../store/index.js`

- [ ] **Step 1: Write failing tests**

Create `packages/node/test/state/avl-prover.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BatchAVLProver } from '@ergots/avltree';
import { SqliteAvlStorage } from '../../src/state/avl-storage.js';
import {
  createAvlProver,
  applyBlockMutations,
  HEIGHT_SENTINEL,
  encodeHeight,
} from '../../src/state/avl-prover.js';
import { serializeBox } from '../../src/state/serialize-box.js';

describe('avl-prover', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE avl_tree_versions (
        version BLOB PRIMARY KEY,
        height INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE avl_tree_nodes (
        version BLOB NOT NULL REFERENCES avl_tree_versions(version),
        label BLOB NOT NULL,
        node_data BLOB NOT NULL,
        PRIMARY KEY (version, label)
      );
    `);
  });

  afterEach(() => { db.close(); });

  it('createAvlProver() returns a PersistentBatchAVLProver with null digest on empty DB', () => {
    const { prover } = createAvlProver(db);
    expect(prover.digest()).not.toBeNull();
    // Empty tree still has a digest (the sentinel neg-inf leaf)
  });

  it('applyBlockMutations() updates the prover and returns new digest', () => {
    const { prover } = createAvlProver(db);
    const initialDigest = prover.digest()!;

    // Create a box
    const box = makeKarmaBox('aa'.repeat(32), 100, 1);
    const consumed: string[] = [];
    const created = [box];

    const newDigest = applyBlockMutations(prover, consumed, created);
    expect(newDigest).not.toEqual(initialDigest);
    expect(newDigest.length).toBe(33);
  });

  it('consume + create produces different digest than create alone', () => {
    const { prover } = createAvlProver(db);

    const box1 = makeKarmaBox('aa'.repeat(32), 100, 1);
    const box2 = makeKarmaBox('bb'.repeat(32), 50, 2);

    // Create box1
    const d1 = applyBlockMutations(prover, [], [box1]);

    // Create box2, consume box1
    const d2 = applyBlockMutations(prover, ['aa'.repeat(32)], [box2]);

    expect(Buffer.from(d1).equals(Buffer.from(d2))).toBe(false);
  });

  it('deterministic: same operations produce same digest', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db);

    const box = makeKarmaBox('cc'.repeat(32), 42, 1);
    const d1 = applyBlockMutations(p1, [], [box]);
    const d2 = applyBlockMutations(p2, [], [box]);

    expect(Buffer.from(d1).equals(Buffer.from(d2))).toBe(true);
  });
});

function makeKarmaBox(id: string, value: number, height: number) {
  return {
    id,
    boxType: 'karma' as const,
    value,
    createdAtBlock: height,
    owner: new Uint8Array(32).fill(0x77),
    guard: 'owner_signature' as const,
    proofSource: 'mint-1',
    lastTouchBlock: height,
  };
}
```

Run: `pnpm --filter @dagsocial/node test -- test/state/avl-prover.test.ts`
Expected: All 4 tests FAIL.

- [ ] **Step 2: Implement avl-prover.ts**

Create `packages/node/src/state/avl-prover.ts`:

```ts
import { BatchAVLProver, PersistentBatchAVLProver } from '@ergots/avltree';
import { SqliteAvlStorage } from './avl-storage.js';
import { serializeBox } from './serialize-box.js';
import { getDb } from '../store/db.js';
import { config } from '../config.js';
import type { AnyBox } from '@dagsocial/types';

/** Sentinel key for block height metadata in additionalData. */
export const HEIGHT_SENTINEL = new Uint8Array(32); // all zeros

/** Encode a block height as 4-byte big-endian uint32. */
export function encodeHeight(h: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, h, false);
  return buf;
}

let persistentProver: PersistentBatchAVLProver | null = null;
let storage: SqliteAvlStorage | null = null;

export interface AvlProverHandle {
  prover: PersistentBatchAVLProver;
  storage: SqliteAvlStorage;
}

/**
 * Create or return the singleton AVL prover.
 * Must be called after initDb().
 */
export function createAvlProver(db?: import('better-sqlite3').Database): AvlProverHandle {
  if (persistentProver && storage) return { prover: persistentProver, storage };

  const database = db ?? getDb();
  const keyLength = config.avlKeyLength;
  const valueLengthOpt = null; // variable-length box values

  storage = new SqliteAvlStorage(database, keyLength, valueLengthOpt);
  const innerProver = new BatchAVLProver(keyLength, valueLengthOpt);

  persistentProver = new PersistentBatchAVLProver(innerProver, storage, [
    [HEIGHT_SENTINEL, encodeHeight(0)], // initial height, updated on first block
  ]);

  return { prover: persistentProver, storage };
}

/**
 * Bootstrap the prover from the current UTXO set.
 * Called once on first AVL-aware startup if storage is empty but UTXO set exists.
 */
export function bootstrapAvlProver(
  handle: AvlProverHandle,
  unspentBoxes: AnyBox[],
  currentHeight: number,
): void {
  for (const box of unspentBoxes) {
    const key = hexToBytes(box.id!);
    const value = serializeBox(box);
    handle.prover.performOneOperation({ tag: 'Insert', key, value });
  }
  // Checkpoint at current tip
  handle.prover.generateProofAndUpdateStorage([
    [HEIGHT_SENTINEL, encodeHeight(currentHeight)],
  ]);
}

/**
 * Apply a block's UTXO mutations to the prover and return the new 33-byte digest.
 *
 * @param consumed - hex-encoded box IDs consumed in this block
 * @param created - full box objects created in this block
 * @returns 33-byte digest (root label || height)
 */
export function applyBlockMutations(
  prover: PersistentBatchAVLProver,
  consumed: string[],
  created: AnyBox[],
): Uint8Array {
  // Remove consumed boxes
  for (const boxId of consumed) {
    const key = hexToBytes(boxId);
    prover.performOneOperation({ tag: 'Remove', key });
  }

  // Insert created boxes
  for (const box of created) {
    const key = hexToBytes(box.id!);
    const value = serializeBox(box);
    prover.performOneOperation({ tag: 'Insert', key, value });
  }

  const digest = prover.digest();
  if (!digest) throw new Error('Prover digest is null after block mutations');
  return digest;
}

/**
 * Checkpoint the prover state at a block height.
 * Called after all mutations for a block are applied.
 */
export function checkpointProver(
  handle: AvlProverHandle,
  height: number,
): void {
  handle.prover.generateProofAndUpdateStorage([
    [HEIGHT_SENTINEL, encodeHeight(height)],
  ]);
}

/** Decode hex string to bytes. */
function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/** Get the singleton prover handle (throws if not initialized). */
export function getAvlProver(): AvlProverHandle {
  if (!persistentProver || !storage) {
    throw new Error('AVL prover not initialized. Call createAvlProver() first.');
  }
  return { prover: persistentProver, storage };
}
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @dagsocial/node test -- test/state/avl-prover.test.ts
```

Expected: All 4 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/state/avl-prover.ts packages/node/test/state/avl-prover.test.ts
git commit -m "feat(state): add AVL prover lifecycle with bootstrap and block hooks"
```

---

### Task 5: Wire AVL prover into block-apply.ts

**Files:**
- Modify: `packages/node/src/services/block-apply.ts`
- Modify: `packages/node/test/state/avl-prover.test.ts` — add integration test

**Interfaces:**
- Consumes: `getAvlProver`, `applyBlockMutations`, `checkpointProver` from `../state/avl-prover.js`
- Modifies: `BlockJournal` — new `consumedBoxIds: string[]` and `createdBoxIds: string[]` fields

- [ ] **Step 1: Extend BlockJournal type**

In `packages/types/src/journal.ts`, add two fields to `BlockJournal`:

```ts
export interface BlockJournal {
  blockHeight: number;
  creditBoxIds: string[];
  confirmedSubBlockIds: string[];
  talliedLikeBoxIds: string[];
  karmaMints: KarmaMint[];
  appliedUtxoTxs: AppliedUtxoTx[];
  decayBurns: DecayJournalEntry[];
  // AVL state root tracking — all box IDs consumed and created during block apply
  consumedBoxIds: string[];
  createdBoxIds: string[];
}
```

- [ ] **Step 2: Initialize the mutation arrays in block-apply.ts**

In `packages/node/src/services/block-apply.ts`, in the journal initialization block (~line 52), add:

```ts
currentJournal = {
  blockHeight: block.header.height,
  creditBoxIds: [],
  confirmedSubBlockIds: [...block.subBlockTree.subBlockRefs],
  talliedLikeBoxIds: [...block.utxoTxTree.likeBoxIds],
  karmaMints: [],
  appliedUtxoTxs: [],
  decayBurns: [],
  consumedBoxIds: [],   // NEW
  createdBoxIds: [],    // NEW
};
```

- [ ] **Step 3: Track mutations throughout block-apply**

At every `consumeBox(boxId, ...)` call site, add:
```ts
currentJournal.consumedBoxIds.push(boxId);
```

At every `insertBox(box)` call site (where a new box is created), add:
```ts
currentJournal.createdBoxIds.push(box.id!);
```

The key mutation sites (search for `consumeBox(` and `insertBox(` in block-apply.ts):

- **Coinbase** (`mintCredits`): internally calls `insertBox` for credit outputs. After `mintCredits` returns, push the credit box IDs (already in `currentJournal.creditBoxIds`).

- **Stump settlement** (~line 263): `consumeBox(lockBox.id!, ...)` → push to `consumedBoxIds`. `mintKarma(...)` → internally calls `insertBox`; push the resulting box ID.

- **Epoch tally** (~line 344): `consumeBox(boxId, ...)` for PostLockBoxes → push. `consumeBox(boxId, ...)` for LikeBoxes → push. `mintKarma(...)` for rewards → push output box IDs.

- **UTXO transactions** (~line 406): `applyTx(...)` internally calls `consumeBox` for inputs and `insertBox` for outputs. After each `applyTx` call, collect from the `AppliedUtxoTx` entry that's pushed right after:
  ```ts
  currentJournal.consumedBoxIds.push(...appliedTx.inputBoxIds);
  currentJournal.createdBoxIds.push(...appliedTx.outputBoxIds);
  ```

- **Karma decay** (~line 448): `applyKarmaDecay(...)` internally calls `consumeBox` and `mintKarma`. After it completes, collect from `currentJournal.decayBurns`:
  ```ts
  for (const burn of currentJournal.decayBurns) {
    currentJournal.consumedBoxIds.push(...burn.consumedBoxIds);
    currentJournal.createdBoxIds.push(burn.newBoxId);
  }
  ```

- [ ] **Step 4: Apply mutations to AVL prover and verify stateRoot**

After all mutations are applied but before journal persistence, add at the end of `applyOrderingBlock` (~before `insertBlockJournal`):

```ts
// AVL state root update
const handle = getAvlProver();

// Collect all consumed box IDs
const allConsumed = new Set(currentJournal.consumedBoxIds);

// Collect all created boxes (by box ID, fetch from store)
const allCreated: AnyBox[] = [];
for (const boxId of currentJournal.createdBoxIds) {
  const box = getBox(boxId);
  if (box) allCreated.push(box);
}

// Apply to prover
const computedDigest = applyBlockMutations(
  handle.prover,
  [...allConsumed],
  allCreated,
);

// Verify against block header (gated)
if (config.verifyStateRoot) {
  const expectedHex = Buffer.from(computedDigest).toString('hex');
  if (block.header.stateRoot !== expectedHex) {
    console.warn(
      `stateRoot mismatch at height ${block.header.height}: ` +
      `computed=${expectedHex.slice(0, 16)}... ` +
      `header=${block.header.stateRoot.slice(0, 16)}...`,
    );
    currentJournal = null;
    return false;
  }
}

// Checkpoint
checkpointProver(handle, block.header.height);
```

- [ ] **Step 5: Initialize prover in index.ts startup**

In `packages/node/src/index.ts`, after `initDb(config.dbPath)` and before the server starts, add:

```ts
import { createAvlProver, bootstrapAvlProver } from './state/avl-prover.js';
import { getUnspentBoxes } from './store/index.js'; // new store helper — see below
```

Add a store helper `getUnspentBoxes` in `packages/node/src/store/utxo.ts`:

```ts
export function getUnspentBoxes(): AnyBox[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, box_type, value, created_at_block, spent_at_block, owner, guard, proof_source, extra_data, last_touch_block FROM utxo_boxes WHERE spent_at_block IS NULL ORDER BY created_at_block ASC'
  ).all();
  return rows.map(rowToAnyBox);
}
```

Then in index.ts, after `initDb`:

```ts
// Initialize AVL prover
const avlHandle = createAvlProver();
const currentHeight = getCurrentHeight();
if (currentHeight > 0) {
  const unspent = getUnspentBoxes();
  if (unspent.length > 0) {
    bootstrapAvlProver(avlHandle, unspent, currentHeight);
    console.log(`AVL prover bootstrapped from ${unspent.length} unspent boxes at height ${currentHeight}`);
  }
}
```

- [ ] **Step 6: Build and run existing tests to check for regressions**

```bash
pnpm build && pnpm test
```

Expected: All existing tests still pass (413/415, 2 E2E flakes not related to AVL).

- [ ] **Step 7: Add integration test for block-apply AVL hook**

Add to `packages/node/test/state/avl-prover.test.ts`:

```ts
import { initDb } from '../../src/store/db.js';
import { insertBox, consumeBox } from '../../src/store/index.js';

describe('block-apply integration', () => {
  it('prover tracks insertBox and consumeBox correctly', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    initTestSchema(db);

    const handle = createAvlProver(db);

    // Simulate block application: create two boxes, consume one
    const box1 = makeKarmaBox('11'.repeat(32), 100, 1);
    const box2 = makeKarmaBox('22'.repeat(32), 50, 1);

    applyBlockMutations(handle.prover, [], [box1, box2]);
    checkpointProver(handle, 1);
    const digestAfterCreate = handle.prover.digest()!;

    // Consume box1, create box3
    const box3 = makeKarmaBox('33'.repeat(32), 25, 2);
    applyBlockMutations(handle.prover, ['11'.repeat(32)], [box3]);
    checkpointProver(handle, 2);
    const digestAfterConsume = handle.prover.digest()!;

    expect(Buffer.from(digestAfterCreate).equals(Buffer.from(digestAfterConsume))).toBe(false);

    // Rollback to height 1 and verify box1 still exists
    const version1 = new Uint8Array(digestAfterCreate);
    handle.prover.rollback(version1);
    const key1 = hexToBytes32('11'.repeat(32));
    expect(handle.prover.unauthenticatedLookup(key1)).not.toBeNull();
  });
});
```

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/journal.ts packages/node/src/services/block-apply.ts packages/node/src/index.ts packages/node/src/store/utxo.ts packages/node/test/state/avl-prover.test.ts
git commit -m "feat(state): wire AVL prover into block-apply with mutation tracking"
```

---

### Task 6: Wire AVL prover into block-creator.ts

**Files:**
- Modify: `packages/node/src/services/block-creator.ts`

**Interfaces:**
- Consumes: `getAvlProver` from `../state/avl-prover.js`
- Modifies: `createOrderingBlock()` — replaces `stateRoot: EMPTY_STATE_ROOT` with computed digest

- [ ] **Step 1: Compute stateRoot during block creation**

In `packages/node/src/services/block-creator.ts`, import:

```ts
import { getAvlProver } from '../state/avl-prover.js';
```

In `createOrderingBlock()`, before building the header template (~line 544), add:

```ts
// Compute AVL state root from the current UTXO set
let stateRoot = EMPTY_STATE_ROOT; // fallback if prover not initialized
try {
  const handle = getAvlProver();
  const digest = handle.prover.digest();
  if (digest) {
    stateRoot = Buffer.from(digest).toString('hex');
  }
} catch {
  // Prover not yet initialized (shouldn't happen after startup, but safe fallback)
}
```

Replace line 551 (`stateRoot: EMPTY_STATE_ROOT`) with:

```ts
stateRoot: stateRoot,
```

- [ ] **Step 2: Handle genesis block**

Genesis block (height 1) has no prior UTXO set. The prover's empty-tree digest is the correct stateRoot for the empty pre-genesis state. The prover starts with an empty tree (single neg-inf sentinel leaf), so its digest IS the genesis pre-state root.

After genesis is applied (via `finalizeBlock` → `applyOrderingBlock`), any genesis-created boxes (system karma, faucet credits) are inserted into the prover, producing a new stateRoot for block 1. Block 2's header will carry that digest.

- [ ] **Step 3: Build and run tests**

```bash
pnpm build && pnpm test
```

Expected: All existing tests pass. E2E harness should show non-zero stateRoot in block headers.

- [ ] **Step 4: Commit**

```bash
git add packages/node/src/services/block-creator.ts
git commit -m "feat(state): compute real stateRoot during block creation"
```

---

### Task 7: Proof endpoint

**Files:**
- Create: `packages/node/src/state/avl-endpoint.ts`
- Modify: `packages/node/src/server.ts` — register the route
- Create: `packages/node/test/state/avl-endpoint.test.ts`

**Interfaces:**
- Produces: `GET /api/v1/proof/:boxId?atHeight=<n>` Express route
- Consumes: `getAvlProver` from `./avl-prover.js`

- [ ] **Step 1: Write failing test**

Create `packages/node/test/state/avl-endpoint.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { createAvlProver, applyBlockMutations, checkpointProver } from '../../src/state/avl-prover.js';
import { registerProofEndpoint } from '../../src/state/avl-endpoint.js';

describe('GET /api/v1/proof/:boxId', () => {
  let app: express.Express;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE avl_tree_versions (version BLOB PRIMARY KEY, height INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE avl_tree_nodes (version BLOB NOT NULL REFERENCES avl_tree_versions(version), label BLOB NOT NULL, node_data BLOB NOT NULL, PRIMARY KEY (version, label));
    `);

    const handle = createAvlProver(db);

    // Create a box at height 1
    const box = {
      id: 'aa'.repeat(32),
      boxType: 'karma' as const,
      value: 100,
      createdAtBlock: 1,
      owner: new Uint8Array(32).fill(0xaa),
      guard: 'owner_signature' as const,
      proofSource: 'mint-1',
      lastTouchBlock: 1,
    };
    applyBlockMutations(handle.prover, [], [box]);
    checkpointProver(handle, 1);

    app = express();
    app.use(express.json());
    registerProofEndpoint(app, handle);
  });

  afterEach(() => { db.close(); });

  it('returns box data for an existing box at current tip', async () => {
    const res = await request(app)
      .get('/api/v1/proof/' + 'aa'.repeat(32))
      .expect(200);

    expect(res.body.boxId).toBe('aa'.repeat(32));
    expect(res.body.atHeight).toBe(1);
    expect(res.body.value).not.toBeNull();
    expect(res.body.value.boxType).toBe('karma');
    expect(res.body.proof).toBeTruthy(); // base64 proof
    expect(res.body.stateRoot).toBeTruthy(); // hex state root
  });

  it('returns value=null for a non-existent box', async () => {
    const res = await request(app)
      .get('/api/v1/proof/' + 'ff'.repeat(32))
      .expect(200);

    expect(res.body.value).toBeNull();
    expect(res.body.proof).toBeTruthy(); // exclusion proof still returned
  });

  it('returns 400 for invalid boxId length', async () => {
    await request(app)
      .get('/api/v1/proof/abc')
      .expect(400);
  });

  it('returns 404 for unavailable height', async () => {
    await request(app)
      .get('/api/v1/proof/' + 'aa'.repeat(32) + '?atHeight=999')
      .expect(404);
  });
});
```

Run: `pnpm --filter @dagsocial/node test -- test/state/avl-endpoint.test.ts`
Expected: All 4 tests FAIL.

- [ ] **Step 2: Implement the endpoint**

Create `packages/node/src/state/avl-endpoint.ts`:

```ts
import type { Express, Request, Response } from 'express';
import type { AvlProverHandle } from './avl-prover.js';

export function registerProofEndpoint(app: Express, handle: AvlProverHandle): void {
  app.get('/api/v1/proof/:boxId', (req: Request, res: Response) => {
    const { boxId } = req.params;
    const atHeight = req.query['atHeight']
      ? parseInt(req.query['atHeight'] as string, 10)
      : null;

    // Validate boxId: must be 64 hex chars (32 bytes)
    if (!boxId || boxId.length !== 64 || !/^[0-9a-fA-F]+$/.test(boxId)) {
      res.status(400).json({ error: 'boxId must be 64 hex characters' });
      return;
    }

    const boxKey = Buffer.from(boxId, 'hex');

    try {
      // Determine which version to query
      let version: Uint8Array;
      if (atHeight !== null) {
        const versions = handle.storage.rollbackVersions();
        // Find version at or before the requested height
        // (versions are sorted by height asc)
        const match = versions.find(v => v[32]! <= atHeight);
        if (!match) {
          res.status(404).json({ error: 'height not available' });
          return;
        }
        version = match;
      } else {
        const v = handle.storage.version();
        if (!v) {
          res.status(404).json({ error: 'no state available' });
          return;
        }
        version = v;
      }

      // Rollback to historical version
      const currentVersion = handle.prover.digest()!;
      handle.prover.rollback(version);

      // Perform lookup
      const value = handle.prover.unauthenticatedLookup(boxKey);
      const proof = handle.prover.generateProof();

      // Restore current version
      handle.prover.rollback(currentVersion);

      // Deserialize box value if found
      let boxData = null;
      if (value) {
        const { deserializeBoxWithId } = require('./serialize-box.js');
        boxData = deserializeBoxWithId(boxId, value);
      }

      res.json({
        boxId,
        atHeight: version[32],
        stateRoot: Buffer.from(version).toString('hex'),
        proof: Buffer.from(proof).toString('base64'),
        value: boxData,
      });
    } catch (err) {
      console.error('Proof endpoint error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });
}
```

- [ ] **Step 3: Register the route in server.ts**

In `packages/node/src/server.ts`, add after the other route registrations:

```ts
import { registerProofEndpoint } from './state/avl-endpoint.js';

// Inside createApp(), after other routes:
registerProofEndpoint(app, getAvlProver());
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @dagsocial/node test -- test/state/avl-endpoint.test.ts
```

Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/node/src/state/avl-endpoint.ts packages/node/src/server.ts packages/node/test/state/avl-endpoint.test.ts
git commit -m "feat(state): add GET /api/v1/proof/:boxId endpoint"
```

---

### Task 8: Integration — full pipeline smoke test and cleanup

**Files:**
- Create: `packages/node/test/state/avl-integration.test.ts`

**Interfaces:**
- Consumes: all previous state/ modules
- Consumes: store functions from `../store/index.js`

- [ ] **Step 1: Write integration test**

Create `packages/node/test/state/avl-integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createAvlProver, applyBlockMutations, checkpointProver } from '../../src/state/avl-prover.js';
import { serializeBox, deserializeBoxWithId } from '../../src/state/serialize-box.js';

describe('AVL integration — full pipeline', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE avl_tree_versions (version BLOB PRIMARY KEY, height INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE avl_tree_nodes (version BLOB NOT NULL REFERENCES avl_tree_versions(version), label BLOB NOT NULL, node_data BLOB NOT NULL, PRIMARY KEY (version, label));
    `);
  });

  afterEach(() => { db.close(); });

  it('simulates 10 blocks of UTXO mutations and verifies historical proofs', () => {
    const handle = createAvlProver(db);
    const allBoxes: Map<string, any> = new Map();

    // Block 1: create 5 boxes
    const created1 = Array.from({ length: 5 }, (_, i) => ({
      id: `${i.toString(16).padStart(64, '0')}`,
      boxType: 'karma' as const,
      value: 100 + i,
      createdAtBlock: 1,
      owner: new Uint8Array(32).fill(i),
      guard: 'owner_signature' as const,
      proofSource: `mint-${i}`,
      lastTouchBlock: 1,
    }));
    for (const b of created1) { allBoxes.set(b.id, b); }
    const d1 = applyBlockMutations(handle.prover, [], created1);
    checkpointProver(handle, 1);

    // Block 2: create 3 more, consume 1
    const created2 = Array.from({ length: 3 }, (_, i) => ({
      id: `${(i + 5).toString(16).padStart(64, '0')}`,
      boxType: 'credit' as const,
      value: 50 + i,
      createdAtBlock: 2,
      owner: new Uint8Array(32).fill(i + 5),
      guard: 'owner_signature' as const,
      proofSource: 2,
    }));
    for (const b of created2) { allBoxes.set(b.id, b); }
    const consumed2 = [created1[0]!.id];
    allBoxes.delete(created1[0]!.id);
    const d2 = applyBlockMutations(handle.prover, consumed2, created2);
    checkpointProver(handle, 2);
    expect(Buffer.from(d2).equals(Buffer.from(d1))).toBe(false);

    // ... simulate blocks 3-10 similarly, then verify proofs at each height
    for (let block = 3; block <= 10; block++) {
      const created = Array.from({ length: 2 }, (_, i) => ({
        id: `${(block * 10 + i).toString(16).padStart(64, '0')}`,
        boxType: 'karma' as const,
        value: 10 + i,
        createdAtBlock: block,
        owner: new Uint8Array(32).fill(block),
        guard: 'owner_signature' as const,
        proofSource: `mint-${block}-${i}`,
        lastTouchBlock: block,
      }));
      const consumed: string[] = [];
      // Consume the oldest box every other block
      if (block % 2 === 0 && allBoxes.size > 0) {
        const oldest = allBoxes.keys().next().value;
        if (oldest) {
          consumed.push(oldest);
          allBoxes.delete(oldest);
        }
      }
      for (const b of created) { allBoxes.set(b.id, b); }
      applyBlockMutations(handle.prover, consumed, created);
      checkpointProver(handle, block);
    }

    // Verify: current tip has correct count of boxes
    const finalCount = allBoxes.size;
    // We can verify by looking up each expected box
    let found = 0;
    for (const [boxId, _] of allBoxes) {
      const key = Buffer.from(boxId, 'hex');
      const value = handle.prover.unauthenticatedLookup(key);
      if (value) {
        found++;
        // Verify deserialization works
        const box = deserializeBoxWithId(boxId, value);
        expect(box.id).toBe(boxId);
      }
    }
    expect(found).toBe(finalCount);

    // Verify: consumed box is NOT found
    const consumedKey = Buffer.from(created1[0]!.id, 'hex');
    expect(handle.prover.unauthenticatedLookup(consumedKey)).toBeNull();

    // Verify: rollback to height 1 and check box count
    const version1 = new Uint8Array(d1);
    handle.prover.rollback(version1);
    let foundAtHeight1 = 0;
    for (let i = 0; i < 5; i++) {
      const key = Buffer.from(`${i.toString(16).padStart(64, '0')}`, 'hex');
      if (handle.prover.unauthenticatedLookup(key)) foundAtHeight1++;
    }
    expect(foundAtHeight1).toBe(5); // all 5 original boxes exist at height 1
  });
});
```

- [ ] **Step 2: Run integration test**

```bash
pnpm --filter @dagsocial/node test -- test/state/avl-integration.test.ts
```

Expected: All tests PASS.

- [ ] **Step 3: Run full test suite**

```bash
pnpm build && pnpm test
```

Expected: 413/415 existing + ~20 new AVL tests. All pass except 2 known E2E flakes.

- [ ] **Step 4: Commit**

```bash
git add packages/node/test/state/avl-integration.test.ts
git commit -m "test(state): add full-pipeline AVL integration test"
```
