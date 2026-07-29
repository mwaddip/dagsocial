# DAGsocial Consensus

**Protocol version:** 1
**Last updated:** 2026-07-29

See `contracts/ARCHITECTURE.md` for the full system design and invariant catalog.

## 1. Two-Layer Architecture

DAGsocial splits state across two cryptographically independent layers:

| Layer | Purpose | Mutability |
|-------|---------|------------|
| **Content DAG** | Posts, threading, social graph | Author-sovereign (prunable) |
| **UTXO Ledger** | Karma, credits, invites, likes | Owner-controlled (spendable) |

A pure-additive DAG cannot model deletion or mutable balances. A pure UTXO
system cannot model threaded conversation. Ordering blocks bind both layers:
every block header commits to DAG topology (`subBlockRoot`), UTXO state
(`utxoTxRoot`), and the authenticated UTXO dictionary (`stateRoot`), anchoring
them to a single chain with cumulative PoW finality.

## 2. Ordering Blocks and PoW

### Block structure

An ordering block batches sub-blocks, UTXO transactions, and prune entries into
a single atomic unit. The header carries: `protocolVersion, height,
prevBlockHash, subBlockRoot, utxoTxRoot, stateRoot, validatorId, powNonce,
powTargetBits, createdAt`. The `subBlockTree` holds `subBlockEntries[{postId,
parentRefs}]` (post topology, no content) and `pruneEntries[{rootPostHash,
subtreePostIds[], subtreeMerkleRoot, authorId, authorSignature}]`. The
`utxoTxTree` holds UTXO transaction IDs and coinbase outputs. Block hash =
`blake2b-512/32` of CBOR-serialized header. The block is signed by the
validator (Ed25519 over the block hash).

### Merkle roots committed in the header

- **subBlockRoot** -- Merkle over leaf-hashed subBlockEntries and pruneEntries.
  Commits to post topology and authorized deletions without content.
- **utxoTxRoot** -- Merkle over UTXO tx IDs, like box IDs, and coinbase outputs.
- **stateRoot** -- 33-byte AVL+ digest (root hash || height) over the full UTXO
  set after block application (see Section 3).

All three are independently recomputed at block application. Mismatch on any
rejects the block.

### PoW and difficulty

PoW is standard hashcash: miner iterates `powNonce` until the first
`powTargetBits` of `blake2b-512(preimage ++ LE64(nonce)).subarray(0,32)` are
zero, where `preimage` is the header hash with `powNonce=0`. Difficulty adjusts
at credit epoch boundaries (every 129,600 blocks, ~90 days at 60s):
`newTarget = round(oldTarget * actualDuration / expectedDuration)`, clamped to
+/- 50% and floored at 4. Initial target: 12 bits.

## 3. State Root (AVL+)

The UTXO set is indexed by an AVL+ authenticated dictionary -- every tree node
carries a cryptographic hash of its subtree. The root digest commits to every
box in the UTXO set. Implementation uses `@ergots/avltree` with
`PersistentBatchAVLProver` over SQLite tables `avl_tree_versions` and
`avl_tree_nodes` keyed by `(version, label)`.

At block application, consumed boxes are removed from the prover by key and
created boxes are inserted. The resulting digest is compared against
`header.stateRoot` (gated by `VERIFY_STATE_ROOT`, default false during
development). After verification, `checkpointProver` writes a version and
prunes versions older than `MAX_PROOF_HISTORY` blocks (default 1440).

During fork resolution, the prover is rolled back to
`versionAtOrBeforeHeight(forkHeight)`, undoing every mutation from reverted
blocks, then re-applied with the new chain.

Light clients holding only block headers can verify box existence via
`GET /api/v1/proof/:boxId?atHeight=N`, which returns an inclusion or exclusion
proof verifiable against the stateRoot in the header at that height.

## 4. Post Lifecycle and SubBlockTree

**Creation:** Author requests challenge (random 32-byte nonce, expires in
`CHALLENGE_WINDOW_BLOCKS`), constructs post, iterates `powNonce` until PoW
meets `POST_POW_TARGET_BITS` over `content ++ author ++ parentRefs ++ challenge
++ protocolVersion ++ timestamp ++ powNonce`, signs with Ed25519, submits. Node
verifies (challenge, PoW, signature, parent refs, content, protocol, karma),
builds karma-lock UTXO tx, assembles sub-block, inserts both as a batch into
the mempool.

**Block inclusion:** The ordering block includes a `SubBlockEntry{postId,
parentRefs}` -- topology only. Content lives DAG-side.

**block_topology table:** Populated from every `SubBlockEntry` at block
application. A recursive CTE on `parent_refs` reconstructs the full reply tree
for any root post independently of the Content DAG. This is what enables
UTXO-first sync nodes to verify prune settlements without post content -- they
have the topology from the block chain and the UTXO state from the ledger.

## 5. Prune Consensus

Pruning is authorized solely by the root author's Ed25519 signature over
`blake2b-512(rootPostHash ++ subtreeMerkleRoot).subarray(0,32)`. The signature
travels in a `PruneEntry` committed in the ordering block. Every node verifies
independently -- no validator attestation is required.

**Verification at block application (four steps):**

1. **Ed25519 signature** -- recover author public key, verify `authorSignature`
2. **Topology** -- walk `block_topology` via recursive CTE from `rootPostHash`;
   resulting set must match `subtreePostIds` exactly
3. **Merkle root** -- sort `subtreePostIds`, compute `leafHash('stump', postId)`,
   build Merkle root, verify against `subtreeMerkleRoot`
4. **UTXO settlement** -- deterministically consume PostLockBoxes and unspent
   LikeBoxes in the subtree, mint refund karma to authors and likers

Any step failing rejects the block. Settlement is deterministic from UTXO state
and block_topology -- every node produces identical box consumption/creation.

**What the miner cannot do:** Forge the author signature, alter
`subtreePostIds` (breaks Merkle/topology), or alter settlement (breaks
conservation/guards). Miner discretion is limited to inclusion ordering --
excluded prunes stay in the mempool.

## 6. Fork Resolution

**Fork choice:** Cumulative PoW (heaviest chain wins). Total work =
`sum(2^powTargetBits)`. Strictly greater wins; equal work produces no reorg.
Max reorg depth: 20 blocks.

**Reorg process** (single SQLite transaction):

1. **Revert** from tip to fork point, reversing each block's journal:
   UTXO txs, decay burns, tallied like boxes, coinbase, post confirmations,
   block_topology entries. Collect reverted prunes.
2. **AVL prover rollback** to `versionAtOrBeforeHeight(forkHeight)`.
3. **Re-mempool** reverted txs, sub-blocks, and prunes (FIFO).
4. **Apply** new chain from fork point forward via `applyOrderingBlock`.
   Every block re-verified (PoW, Merkle roots, state root, prunes).

## 7. Trust Model

**Single trust assumption:** PoW majority hash rate. An attacker with > 50%
hash rate can reorg the chain (standard Nakamoto consensus).

**Everything else is locally verified by every full node:** Ed25519 signatures
(posts, likes, invites, prunes, block headers), PoW solutions (post and block),
Merkle roots (subBlockRoot, utxoTxRoot), UTXO transitions (conservation,
guards, legal transitions), prune settlements (signature, topology, Merkle,
UTXO settlement), state root (when `VERIFY_STATE_ROOT` is enabled), and
coinbase rewards (emission schedule).

**Miner constraints:**

| Miner CAN | Miner CANNOT |
|-----------|-------------|
| Include/exclude transactions | Forge Ed25519 signatures |
| Order txs within a block | Alter prune settlements (deterministic) |
| Produce empty blocks | Forge state root (commits to UTXO set) |
| Censor posts/sub-blocks | Skip epoch tally processing |
|                    | Mint extra karma/credits (emission schedule) |
|                    | Produce subBlockRoot not matching entries |

Post content integrity is not miner-gated -- posts are verified independently
of block inclusion.

## 8. Config Flags

| Flag | Default | Effect |
|------|---------|--------|
| `VERIFY_STATE_ROOT` | `false` | Gate stateRoot verification; mismatch rejects block when true. Computed regardless. |
| `MAX_PROOF_HISTORY` | `1440` | AVL+ versions retained; older versions pruned. |
| `AVL_KEY_LENGTH` | `32` | Box ID byte length in AVL tree (matches blake2b-512/32). |
