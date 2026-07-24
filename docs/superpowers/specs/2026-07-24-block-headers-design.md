# Block Headers: Header/Body Split with Merkle Roots

**Date:** 2026-07-24
**Status:** design (not yet implemented)
**Protocol version:** 1 (wire format change, protocol version unchanged — CBOR codec handles structure)

## Motivation

The current `OrderingBlock` is 15 monolithic fields with no separation between
metadata and content. The PoW code has an informal "body" concept
(`computeBlockBodyHash` zeros out `powNonce`, `validatorSignature`, and `hash`
before hashing) — but this is a hack, not a type.

A formal header/body split with Merkle roots enables:

- **Fork resolution:** Compare competing chains by fetching ~200-byte headers
  instead of full blocks. Walk back to find the fork point cheaply.
- **Sync efficiency:** New nodes download headers first to find the canonical
  chain, then fetch body sections on demand.
- **Cleaner PoW model:** The header IS what you hash. No more "zero out three
  fields and rehash."
- **Future light clients:** Prove post inclusion or UTXO state against Merkle
  roots in the header.
- **Independently requestable sections:** A UTXO-only verifier downloads only
  the UTXO tree, not sub-blocks.

## Design

### Type split

Three new types replace the flat `OrderingBlock`:

```ts
interface BlockHeader {
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

interface SubBlockTree {
  subBlockRefs: PostId[];
  stumpIds: StumpId[];
}

interface UtxoTxTree {
  utxoTxIds: TxId[];
  likeBoxIds: BoxId[];
  coinbaseOutputs: CoinbaseOutput[];
  epochTallyResults?: EpochTally;
}

interface OrderingBlock {
  header: BlockHeader;
  subBlockTree: SubBlockTree;
  utxoTxTree: UtxoTxTree;
  validatorSignature: Uint8Array;  // Ed25519 over header hash
}
```

Changes from current flat `OrderingBlock`:
- `hash` field removed — block hash = hash of serialized header
- `validatorSignature` moved outside the header (signs header hash)
- `coinbaseOutputs` moved into the UTXO tree (Ergo-style: coinbase is a tx in
  the tree)
- `epochTallyResults` moved into the UTXO tree (derived from UTXO state)
- `stateRoot` is 33 bytes (32-byte digest + 1-byte tree height), zeroed for
  MVP. Reserved for future `@ergots/avltree` integration.
- `protocolVersion` kept in header (consistent with posts, sub-blocks, stumps)
- Two Merkle roots instead of none

### What goes in which tree

| Content | Tree | Rationale |
|---------|------|-----------|
| subBlockRefs | SubBlockTree | DAG content |
| stumpIds | SubBlockTree | DAG compaction events (what remains of pruned DAG content) |
| utxoTxIds | UtxoTxTree | UTXO state transitions |
| likeBoxIds | UtxoTxTree | UTXO boxes (standalone likes) |
| coinbaseOutputs | UtxoTxTree | Block reward (Ergo-style: coinbase is a transaction) |
| epochTallyResults | UtxoTxTree | Derived from UTXO like state |

### Hashing

```ts
// Block hash = hash of serialized header
function blockHash(header: BlockHeader): string {
  return blake2b512(encodeHeader(header)).subarray(0, 32).toString('hex');
}

// PoW: hash(header with powNonce=0 || nonce) meets targetBits
function computePowHash(header: BlockHeader): Buffer {
  const template = { ...header, powNonce: 0 };
  return blake2b512(encodeHeader(template)).subarray(0, 32);
}

function verifyBlockPoW(header: BlockHeader): boolean {
  const preimage = computePowHash(header);
  const nonceBuf = encodeU64LE(header.powNonce);
  const hash = blake2b512(preimage).update(nonceBuf).digest().subarray(0, 32);
  return leadingZeroBits(hash) >= header.powTargetBits;
}

// Validator signature
function signBlock(header: BlockHeader, key: KeyObject): Uint8Array {
  return crypto.sign(null, Buffer.from(blockHash(header), 'hex'), key);
}

function verifyBlockSig(header: BlockHeader, sig: Uint8Array, pubKey: KeyObject): boolean {
  return crypto.verify(null, Buffer.from(blockHash(header), 'hex'), pubKey, sig);
}
```

`computeBlockBodyHash` is removed entirely.

### Merkle trees

Standard binary Merkle tree (same algorithm as the existing
`buildMerkleRoot` in `stump-engine.ts`), called twice with different leaf
sets. Domain-separated leaf hashes prevent cross-tree collision:

```ts
function leafHash(domain: string, data: Uint8Array | string): Uint8Array {
  return blake2b512(domain + '\0').update(data).digest().subarray(0, 32);
}

function subBlockRoot(tree: SubBlockTree): string {
  const leaves = [
    ...tree.subBlockRefs.map(id => leafHash('subblock', hexToBuf(id))),
    ...tree.stumpIds.map(id => leafHash('stump', hexToBuf(id))),
  ];
  return bufToHex(buildMerkleRoot(leaves));
}

function utxoTxRoot(tree: UtxoTxTree): string {
  const leaves = [
    ...tree.utxoTxIds.map(id => leafHash('utxotx', hexToBuf(id))),
    ...tree.likeBoxIds.map(id => leafHash('likebox', hexToBuf(id))),
    ...tree.coinbaseOutputs.map((o, i) =>
      leafHash('coinbase', encodeCoinbaseOutput(o))),
    ...(tree.epochTallyResults
      ? [leafHash('epoch', encodeEpochTally(tree.epochTallyResults))]
      : []),
  ];
  return bufToHex(buildMerkleRoot(leaves));
}
```

Domain tags: `subblock`, `stump`, `utxotx`, `likebox`, `coinbase`, `epoch`.

Empty trees produce 32 zero bytes (`buildMerkleRoot([])` returns
`new Uint8Array(32)`, consistent with existing stump engine behavior).

`buildMerkleRoot` is extracted from `stump-engine.ts` into `@dagsocial/types`
as a public export.

### Serialization

**CBOR** (on-disk, gossip):

Each section encodes independently. The full block on the wire is
length-prefixed:

```
[ u32BE headerLen | headerCbor | u32BE subTreeLen | subTreeCbor |
  u32BE utxoTxTreeLen | utxoTxTreeCbor | validatorSignature (64 bytes) ]
```

Length prefixes are 4-byte unsigned big-endian. This lets a syncing peer
request just the first `4 + headerLen` bytes to walk headers, or skip the
sub-block tree to fetch only UTXO data.

**HTTP API (JSON):**

`GET /blocks/:height` and `GET /mining/block-template` return nested JSON
matching the type structure:

```json
{
  "header": { "protocolVersion": 1, "height": 123, ... },
  "subBlockTree": { "subBlockRefs": [...], "stumpIds": [...] },
  "utxoTxTree": { "utxoTxIds": [...], "likeBoxIds": [...], "coinbaseOutputs": [...], ... },
  "validatorSignature": "hex(64)"
}
```

### DB schema

The `ordering_blocks` table switches from flat columns to blob storage:

```sql
CREATE TABLE ordering_blocks (
  height INTEGER PRIMARY KEY,
  header_cbor BLOB NOT NULL,
  subblock_tree_cbor BLOB NOT NULL,
  utxotx_tree_cbor BLOB NOT NULL,
  validator_signature BLOB NOT NULL,  -- 64 bytes
  created_at INTEGER NOT NULL
);
```

The old flat columns (`hash`, `prev_block_hash`, `sub_block_refs`, etc.) are
removed. Three CBOR blobs replace them. `height` and `created_at` are
duplicated as columns for indexed queries; all other fields live in the
blobs.

No backwards compatibility — fresh DB required.

### Network

Gossip topic `/dagsocial/ordering-block/1` carries the new length-prefixed
format. The topic version stays `/1` since CBOR handles structure changes
within the same protocol version.

`NetValidators.verifyOrderingBlockStructure` is updated to validate the
header structure (stateless Stage 1 check).

Future sync protocol (deferred): a node can request individual sections via
a libp2p custom protocol. The length-prefixed wire format makes this feasible
without re-encoding.

### Mining

**Template endpoint** (`GET /mining/template`):

Returns the header template (with `powNonce=0`, Merkle roots pre-computed)
plus the body leaf lists. The miner hashes the header. The Merkle roots are
included so the miner can verify the template's integrity, but the miner
doesn't rebuild them.

**Submit endpoint** (`POST /mining/submit`):

Same as today: `{ height, powNonce }`. The node verifies PoW against the
stored template header, signs, finalizes.

## What breaks and how

| Layer | Breakage | Fix |
|-------|----------|-----|
| `@dagsocial/types` | Flat `OrderingBlock` → nested struct with header/body types | New types + encode/decode/serialize in `block.ts` and `serialization.ts` |
| `@dagsocial/types` | `buildMerkleRoot` is private in node package | Extract to `types` as public export |
| `@dagsocial/validation` | `computeBlockBodyHash` removed | Replace with `blockHash(header)` + `computePowHash(header)` |
| `@dagsocial/validation` | `verifyOrderingBlockPoW` takes full block | Takes `BlockHeader` |
| `@dagsocial/validation` | `verifyOrderingBlockStructure` checks 15 flat fields | Checks nested structure |
| `@dagsocial/validation` | `verifyBlockChainLink` accesses `block.hash` | Accesses `blockHash(block.header)` |
| `@dagsocial/node` | `block-creator.ts` builds flat object | Builds header + trees, computes Merkle roots, signs header |
| `@dagsocial/node` | `store/ordering.ts` — flat column access | CBOR blob read/write |
| `@dagsocial/node` | `store/db.ts` — `ordering_blocks` table schema | Three blob columns + sig |
| `@dagsocial/node` | `routes/blocks.ts`, `routes/mining.ts` | Updated JSON shapes |
| `@dagsocial/node` | `index.ts` — `applyOrderingBlock` | Header verification first, then body application |
| `@dagsocial/net` | `NetValidators.verifyOrderingBlockStructure` | Updated to validate header structure |

## What doesn't break

- Post types, identity, UTXO box types, stumps — unchanged
- Sub-block structure — unchanged
- Mempool — unchanged (holds sub-blocks and UTXO txs, not blocks)
- Like system, invite system, epoch tally logic — unchanged
- Mining API semantics — template/submit flow is the same
- Identity, challenge, post, likes, invite, pruning, UTXO query endpoints — unchanged

## Extraction: `buildMerkleRoot` to types

The private `buildMerkleRoot` function in
`packages/node/src/services/stump-engine.ts` is extracted to
`@dagsocial/types` as a public export. The stump engine imports it from
types. This keeps Merkle tree construction in one place and makes it
available for block header Merkle root computation in both `types` and
`validation`.

Functions:
```ts
export function buildMerkleRoot(leafHashes: Uint8Array[]): Uint8Array;
export function leafHash(domain: string, data: Uint8Array): Uint8Array;
```

## stateRoot: deferred AVL+ integration

The `stateRoot` field in the header is 33 zero bytes for MVP. The slot is
reserved for `@ergots/avltree` integration, which provides a batch AVL+
authenticated dictionary compatible with Ergo's tree format.

`@ergots/avltree` is a standalone npm package (sole dep: `@noble/hashes`)
that verifies AVL+ proofs. It is **verifier-only** — the prover
(`BatchAVLProver`) has not been ported from Rust yet. The prover must be
built before `stateRoot` can carry a real digest. This is deferred to
pre-public-release but does not require a wire-format break — the 33-byte
slot is already there.

When implemented, `stateRoot` will hold the AVL+ digest of the UTXO set
after the block is applied, enabling light clients to verify account
balances without downloading the full UTXO set.

## Migration

Fresh database required. No backwards compatibility path. This is the right
time for a breaking DB change — the project is pre-MVP, the Phase 2 schema
is clean, and the fork resolution work that depends on this design is the
last remaining protocol gap.

## Test impact

Tests that construct `OrderingBlock` objects need mechanical updates for the
new nested structure. Test logic (verification checks, store operations,
route assertions) remains semantically identical. Expected test count change:
~15-20 tests updated, no new test scenarios required (the Merkle root
computation is covered by existing stump engine tests once `buildMerkleRoot`
is extracted to types).
