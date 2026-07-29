Read ~/projects/OVERRIDES.md.
Read ~/.claude/RTK.md.
Read CLAUDE.md.
Read contracts/ARCHITECTURE.md.

## ergots/avltree: Export node types and add serialization helpers

DAGsocial needs `VersionedAVLStorage` backends to persist and restore AVL+ trees
without depending on `@ergots/avltree` internal structure. The storage walks the
tree itself (consumer-owned traversal) but calls library functions for per-node
serialization.

### Changes to `packages/avltree/src/index.ts`

Export from `./node.js`:
- `AvlNode`, `LeafNode`, `InternalNode`, `LabelNode` (types)
- `Balance` (type, already exported? verify)
- `newLeaf`, `newInternal`, `newLabel` (constructors)
- `label` (already exported? verify — may be internal, but storage needs it)

### New file: `packages/avltree/src/serialize.ts`

Two functions, both consensus-agnostic (these are storage-format only, proofs
are verifier-side):

```ts
function serializeNode(node: AvlNode): Uint8Array
```

Binary format:
- Leaf:     `0x01` || keyLen(2 bytes BE) || key || valueLen(4 bytes BE) || value || nextLeafKeyLen(2 bytes BE) || nextLeafKey
- Internal: `0x02` || keyLen(2 bytes BE) || key || balance(1 byte, i8→u8 via `& 0xff`) || leftLabel(32 bytes) || rightLabel(32 bytes)
- Label:    `0x03` || label(32 bytes)

For Leaf, keyLen=0 means key omitted (chain-optimized — caller fills from
previous leaf's nextLeafKey, same as the proof format). valueLen uses 4 bytes
BE whether fixed or variable length.

For Internal, keyLen=0 means key is absent (verifier-only reconstructed nodes).

Balance byte: `node.balance & 0xff` (-1→0xff, 0→0x00, 1→0x01).

```ts
function deserializeNode(bytes: Uint8Array): AvlNode
```

Reverse of above. Returns the appropriate node variant via `newLeaf`/`newInternal`/`newLabel`.

LabelNode's label is the data; no separate cache needed.

### Constraints

- Pure functions, no I/O, no `node:*` imports, no `Buffer`
- `@noble/hashes` is already a dependency (blake2b), no new deps
- Must work in browsers (evergreen) and Node ≥20
- `serializeNode` does NOT compute labels — just binary-encodes the node fields
- `deserializeNode` reconstructs with `labelCache: null` (caller re-labels after tree assembly)

### Tests

- Roundtrip: `deserializeNode(serializeNode(node))` produces structurally identical node for all three kinds
- Leaf with/without key omission
- Internal with/without key
- Balance byte roundtrip for all three values (-1, 0, 1)
- Malformed input: `deserializeNode` throws on truncated data, unknown kind byte
- Test both fixed-length and variable-length values

### No protocol changes

These are storage-format helpers, not consensus-critical. The proof format and
label computation are unchanged.

## Coordination
When done, send a brief completion summary back to the main session window:
    kitty @ send-text --match=id:<MAIN_WINDOW_ID> 'ergots/avltree: node types exported, serialize/deserialize helpers done'
    kitty @ send-text --match=id:<MAIN_WINDOW_ID> $'\r'
