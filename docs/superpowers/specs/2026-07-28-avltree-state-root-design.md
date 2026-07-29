# AVL+ State Root Integration

**Date:** 2026-07-28
**Status:** design
**Package:** `@dagsocial/node`

## Summary

Replace the zeroed `stateRoot` in block headers with a real AVL+ authenticated
dictionary digest computed over the UTXO set. Use `@ergots/avltree` for both
the prover (tree builder, runs in every node) and verifier (proof checking, for
light clients). Add a proof endpoint so light clients can verify box
inclusion/exclusion without downloading the full UTXO set.

## Motivation

`BlockHeader.stateRoot` is reserved as `hex(33)` — a 32-byte blake2b-256 root
label plus 1-byte tree height — matching Ergo's AVL+ digest format. It's
currently `'00'.repeat(33)`. Filling it enables:

- **Intra-node verification:** every node recomputes the state root after
  applying a block and checks it matches the header.
- **Light-client proofs:** a `GET /proof` endpoint returns AVL+ inclusion or
  exclusion proofs verifiable with `@ergots/avltree`'s `verifyAvlLookup`.
- **UTXO set integrity:** the ordering chain commits to the full UTXO set, not
  just the transactions in each block.

## Architecture

New module `packages/node/src/state/` with three files:

```
packages/node/src/state/
├── avl-storage.ts    # VersionedAVLStorage against SQLite
├── avl-prover.ts      # Singleton PersistentBatchAVLProver + lifecycle
└── avl-endpoint.ts    # GET /api/v1/proof/:boxId
```

### Dependencies

```
@ergots/avltree@^0.3.1  →  packages/node  →  SQLite (utxo_boxes + avl_tree_*)
```

`@ergots/avltree` (pure TS, single dep `@noble/hashes`) provides the prover
(`PersistentBatchAVLProver`), verifier functions, node types, and
serialization helpers (`serializeNode`/`deserializeNode`).

### Hash note

`@ergots/avltree` uses `@noble/hashes` blake2b-256 for AVL tree labels.
DAGsocial currently uses `node:crypto` blake2b-512 truncated for post IDs,
block hashes, and signatures. These produce different outputs for the same
input (different BLAKE2 parameter blocks) but serve different domains. The
AVL tree's internal hashing is self-contained; it does not need to interoperate
with DAGsocial's other hash outputs.

A future protocol version may migrate all hashing to `@noble/hashes` for
consistency and browser compatibility. That migration is out of scope here.

## VersionedAVLStorage (avl-storage.ts)

Implements `VersionedAVLStorage` from `@ergots/avltree` against the existing
SQLite connection.

### Schema

```sql
CREATE TABLE IF NOT EXISTS avl_tree_versions (
    version BLOB PRIMARY KEY,   -- 33 bytes: root_label(32) || height(1)
    height INTEGER NOT NULL,    -- block height for admin queries
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS avl_tree_nodes (
    version BLOB NOT NULL REFERENCES avl_tree_versions(version),
    label BLOB NOT NULL,        -- 32-byte node label
    node_data BLOB NOT NULL,    -- serialized node (see below)
    PRIMARY KEY (version, label)
);
```

### Node serialization

Per-node binary format (provided by `serializeNode`/`deserializeNode` from
`@ergots/avltree`):

- **Leaf:** `0x01` || keyLen(u16 BE) || key || valueLen(u32 BE) || value || nextLeafKeyLen(u16 BE) || nextLeafKey
- **Internal:** `0x02` || keyLen(u16 BE) || key || balance(i8→u8) || leftLabel(32) || rightLabel(32)
- **Label:** `0x03` || label(32)

Fixed-length values skip the valueLen prefix (determined by `valueLengthOpt`).

### update() algorithm

1. Compute `newVersion = prover.digest()` (33 bytes)
2. Start SQLite transaction
3. Insert into `avl_tree_versions`
4. Walk the prover's tree (post-order). For each node:
   - Call `serializeNode(node)` → bytes
   - If the node's label already exists in the parent version's nodes with
     identical `node_data`, skip (unchanged subtree)
   - Otherwise, INSERT OR REPLACE into `avl_tree_nodes`
5. COMMIT

### rollback() algorithm

1. SELECT all `(label, node_data)` rows for the requested version
2. Call `deserializeNode(node_data)` for each row
3. Reconstruct the tree by re-linking parent→child references via labels
   (Internal nodes store leftLabel/rightLabel; match against loaded nodes)
4. Return `[rootNode, height]`

### Garbage collection

Versions older than `currentHeight - MAX_PROOF_HISTORY` (default 1440 blocks,
~1 day at 60s block interval) are pruned. Nodes referenced only by pruned
versions are dropped.

## Prover Lifecycle (avl-prover.ts)

### Startup

```ts
function createAvlProver(db, keyLength, valueLengthOpt): PersistentBatchAVLProver {
  const storage = new SqliteAvlStorage(db, keyLength, valueLengthOpt)
  const prover = new BatchAVLProver(keyLength, valueLengthOpt)
  return new PersistentBatchAVLProver(prover, storage, additionalData)
}
```

- `keyLength = 32` (box ID = 32-byte blake2b hash)
- `valueLengthOpt = null` (variable-length — boxes differ in size)
- `additionalData` maps per-version metadata into the AVL tree alongside UTXO boxes.
  One sentinel key is defined:
  - `HEIGHT_SENTINEL = new Uint8Array(32)` (all zeroes) → block height as 4-byte BE uint32.
  This ensures every version's digest commits to the block height, preventing
  cross-height proof replay.

If `storage.version() === null` and `utxo_boxes` has unspent rows, run
bootstrap (see below).

### Bootstrap (existing chain, first AVL-aware start)

On first AVL-aware startup (`storage.version() === null` but UTXO set is
non-empty), rebuild the tree from the current UTXO set and checkpoint
only at the current tip:

```
FOR each unspent box in utxo_boxes ORDER BY created_at_block ASC:
  prover.performOneOperation(Insert, boxId, serializeBox(box))
storage.update(prover, [[HEIGHT_SENTINEL, encodeHeight(currentHeight)]])
```

Historical versions (between genesis and tip) are NOT backfilled — the node
only has the final UTXO set, not the per-block mutation log. Historical
proof queries for heights before the first AVL-aware checkpoint will return
404 until the node has been AVL-aware for `MAX_PROOF_HISTORY` blocks.

`serializeBox` encodes the box into a deterministic byte string (see
"UTXO value encoding" below).

### Block apply hook

After all UTXO mutations for a block are applied (journal populated):

```
FOR each box consumed (journal.inputs):
  prover.performOneOperation(Remove, boxId)
FOR each box created (journal.outputs):
  prover.performOneOperation(Insert, boxId, serializeBox(box))
digest = prover.digest()
verify digest === block.header.stateRoot   // if VERIFY_STATE_ROOT enabled
prover.generateProofAndUpdateStorage([[HEIGHT_SENTINEL, encodeHeight(block.height)]])
```

### Block creation hook

The miner clones the prover state, applies the same operations, and sets
`stateRoot` on the new header. Uses `prover.generateProofForOperations(ops)`
which clones internally and returns `{proof, digest}` without mutating the
live prover.

## UTXO Value Encoding

Boxes are serialized to `Uint8Array` for storage as AVL values. Format must
be deterministic (byte-identical across all nodes).

### Format

```
boxType(1) || CBOR(boxFields)
```

Where `boxFields` is a canonical CBOR map with keys sorted lexicographically
and definite-length encodings. The `cbor-x` encoder is configured with:

```ts
const encodeOptions = {
  variable: false,      // use definite-length encoding
  sortKeys: true,       // canonical key ordering
  useRecords: false,    // map form
}
```

A regression test freezes the CBOR output for each box type. If `cbor-x` ever
changes its encoding, the test catches the drift before it causes a fork.

### Box types and their serialized fields

All box types include: `id`, `boxType`, `value`, `createdAtBlock`, `guard`,
`owner` (if applicable), plus type-specific fields. The full mapping mirrors
the `AnyBox` union type from `@dagsocial/types`.

## Proof Endpoint (avl-endpoint.ts)

```
GET /api/v1/proof/:boxId?atHeight=<n>
```

### Parameters

- `boxId` — 64 hex characters (32 bytes)
- `atHeight` — optional block height. Defaults to current tip.

### Response (200)

```json
{
  "boxId": "hex",
  "atHeight": 123,
  "stateRoot": "hex(66 chars = 33 bytes)",
  "proof": "base64(serialized AVL proof)",
  "value": { ... box fields ... } | null
}
```

`value` is the full box object if the box exists at that height, `null` if
the proof proves exclusion.

### Response (404)

```json
{ "error": "height not available" }
```

The requested height is beyond the current chain tip or older than the pruned
proof history window.

### Implementation

```ts
const version = getVersionForHeight(atHeight)       // lookup avl_tree_versions
prover.rollback(version)
const value = prover.unauthenticatedLookup(boxIdBytes)
const proof = prover.generateProof()
// Restore prover to current tip
const latestVersion = getVersionForHeight(currentHeight)
prover.rollback(latestVersion)
return { boxId, atHeight, stateRoot: hex(version), proof: base64(proof), value }
```

## Config

| Flag | Default | Description |
|---|---|---|
| `VERIFY_STATE_ROOT` | `false` | Reject blocks whose stateRoot doesn't match local computation |
| `MAX_PROOF_HISTORY` | `1440` | Block heights of AVL version history to retain |
| `AVL_KEY_LENGTH` | `32` | Box ID length in bytes |

`VERIFY_STATE_ROOT` defaults to `false` during development to avoid forking
the test chain while serialization determinism is validated. Flip to `true`
once state roots are stable across all nodes.

## Testing

### Unit tests (avl-storage.test.ts)

- `update` → `rollback` roundtrip (empty tree, single leaf, 100 inserts)
- Node dedup across versions (unchanged subtrees not re-serialized)
- Garbage collection (old versions pruned, orphaned nodes dropped)
- Malformed node_data → `deserializeNode` throws, storage rejects

### Integration tests (avl-prover.test.ts)

- Bootstrap from SQLite `utxo_boxes` — reconstitute tree, verify digest
- Block-apply hook: insert + remove → digest changes predictably
- Determinism: two nodes starting from same UTXO set produce same digest
- CBOR determinism: freeze regression test for each box type

### E2E tests

- Extend E2E harness with stateRoot checks (when `VERIFY_STATE_ROOT` enabled)
- Multi-node: stateRoot matches across miner and sync-only servers

## Out of Scope

- Light-client sync protocol (Ergo's state proofs, NiPoPoWs)
- Exclusion proofs via `verifyAvlLookup` (endpoint returns raw proof;
  client-side verification is a separate concern)
- AVL-backed Merkle proofs for cross-chain bridges
- Migrating DAGsocial's other hashing to `@noble/hashes`
- Pruning spent boxes from the AVL tree older than some horizon
  (the tree always tracks the current UTXO set; spent boxes are removed)
