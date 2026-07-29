import { createHash } from 'crypto';
import { encode } from 'cbor-x';
import type { UserId } from './identity.js';
import type { PostId } from './post.js';

// ---------------------------------------------------------------------------
// Karma delta (aggregated from pruned subtree)
// ---------------------------------------------------------------------------

export interface KarmaDelta {
  userId: UserId;
  delta: number;
}

// ---------------------------------------------------------------------------
// Prune intent (author signs this to authorize pruning)
// ---------------------------------------------------------------------------

export interface PruneIntent {
  rootPostHash: PostId;
  trigger: 'author' | 'storage_prune';
  authorId: UserId;
  subtreeMerkleRoot: Uint8Array;   // 32 bytes — Merkle root over leafHash('stump', postId) per pruned post
  subtreePostIds: PostId[];        // All post IDs in the reply subtree
  signature: Uint8Array;           // 64 bytes — Ed25519 sig over (rootPostHash, subtreeMerkleRoot)
}

// ---------------------------------------------------------------------------
// Prune entry (committed in SubBlockTree; one per pruned reply subtree)
// ---------------------------------------------------------------------------

export interface PruneEntry {
  rootPostHash: PostId;
  subtreePostIds: PostId[];
  subtreeMerkleRoot: Uint8Array;
  authorId: UserId;
  authorSignature: Uint8Array;     // 64 bytes — Ed25519 sig over blake2b512(rootPostHash ++ subtreeMerkleRoot)
  trigger: 'author' | 'storage_prune';
}

// ---------------------------------------------------------------------------
// Stump (compact proof replacing a pruned subtree — historical artifact)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBuffer(data: unknown): Uint8Array {
  return encode(data) as unknown as Uint8Array;
}

/**
 * Deterministic ID for a PruneEntry.
 */
export function computePruneEntryId(entry: PruneEntry): string {
  const h = createHash('blake2b512');
  h.update(entry.rootPostHash);
  h.update(entry.subtreeMerkleRoot);
  h.update(entry.authorId);
  return h.digest().subarray(0, 32).toString('hex');
}

/**
 * Deterministic CBOR encoding of a PruneEntry — used as the Merkle leaf
 * in the subtree proof.
 */
export function serializePruneEntry(entry: PruneEntry): Uint8Array {
  return toBuffer({
    rootPostHash: entry.rootPostHash,
    subtreePostIds: entry.subtreePostIds,
    subtreeMerkleRoot: entry.subtreeMerkleRoot,
    authorId: entry.authorId,
    authorSignature: entry.authorSignature,
    trigger: entry.trigger,
  });
}
