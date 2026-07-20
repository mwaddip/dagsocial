import { createHash } from 'crypto';
import type { UserId } from './identity.js';
import type { PostId } from './post.js';

// ---------------------------------------------------------------------------
// Prune intent (author signs this to authorize pruning)
// ---------------------------------------------------------------------------

export interface PruneIntent {
  rootPostHash: PostId;
  trigger: 'author' | 'drep' | 'storage_prune';
  authorId: UserId;
  signature: Uint8Array;  // 64 bytes — Ed25519 from root author's key
}

// ---------------------------------------------------------------------------
// Karma delta (aggregated from pruned subtree)
// ---------------------------------------------------------------------------

export interface KarmaDelta {
  userId: UserId;
  delta: number;
}

// ---------------------------------------------------------------------------
// Stump (compact proof replacing a pruned subtree)
// ---------------------------------------------------------------------------

export interface Stump {
  rootPostHash: PostId;
  subtreeMerkleRoot: Uint8Array;    // 32 bytes — Merkle root over all pruned posts
  authorId: UserId;
  pruneSignature: Uint8Array;       // 64 bytes — from PruneIntent

  karmaDeltas: KarmaDelta[];
  replyCount: number;
  upvoteCount: number;

  trigger: 'author' | 'drep' | 'storage_prune';
  protocolVersion: number;
  compactedAtBlockHeight: number;
}

export type StumpId = string;

/**
 * Deterministic stump ID.
 */
export function computeStumpId(stump: Stump): StumpId {
  const h = createHash('blake2b512');
  h.update(stump.rootPostHash);
  h.update(String(stump.compactedAtBlockHeight));
  h.update(stump.authorId);
  return h.digest().subarray(0, 32).toString('hex');
}
