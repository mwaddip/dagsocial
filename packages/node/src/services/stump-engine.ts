import { createHash } from 'crypto';
import {
  computePostId,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { Stump, PruneIntent, KarmaDelta, Post, LikeBox } from '@dagsocial/types';
import {
  getPost,
  getSubtree,
  getLockedLikeBoxes,
  pruneSubtree,
  getCurrentHeight,
} from '../store/index.js';

// ---------------------------------------------------------------------------
// Merkle tree helpers
// ---------------------------------------------------------------------------

/**
 * Compute the hash of a single leaf (post ID).
 * leafHash = blake2b512(postId).subarray(0, 32)
 */
function leafHash(postId: string): Uint8Array {
  return createHash('blake2b512')
    .update(postId)
    .digest()
    .subarray(0, 32);
}

/**
 * Compute the hash of two child nodes.
 * nodeHash = blake2b512(left || right).subarray(0, 32)
 */
function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return createHash('blake2b512')
    .update(Buffer.from(left))
    .update(Buffer.from(right))
    .digest()
    .subarray(0, 32);
}

/**
 * Build a Merkle tree over an ordered list of leaf hashes.
 * Returns the Merkle root (32 bytes). A single leaf is its own root.
 */
function buildMerkleRoot(leafHashes: Uint8Array[]): Uint8Array {
  if (leafHashes.length === 0) {
    return new Uint8Array(32); // zero-filled for empty tree
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
        // Odd number of nodes: promote the last one
        nextLevel.push(level[i]!);
      }
    }
    level = nextLevel;
  }

  return level[0]!;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an unsigned prune intent.
 * The caller (author) signs this intent to authorize pruning of their root post.
 */
export function createPruneIntent(
  rootPostId: string,
  authorId: string,
  trigger: 'author' | 'drep' | 'storage_prune',
): PruneIntent {
  return {
    rootPostHash: rootPostId,
    trigger,
    authorId,
    signature: new Uint8Array(64),
  };
}

/**
 * Execute a prune operation on a root post's reply subtree.
 *
 * 1. Verify the post exists and is a root (parentRefs empty)
 * 2. Verify the author matches
 * 3. Walk the reply subtree
 * 4. Collect like boxes for all posts in the subtree
 * 5. Compute karma deltas (per-user sum of like box values)
 * 6. Compute subtree Merkle root
 * 7. Build and store the Stump
 * 8. Prune the subtree via store
 *
 * @param intent  The prune intent (unsigned, with author info)
 * @param signature  Ed25519 signature from the root post author (64 bytes)
 * @returns The constructed Stump
 */
export function executePrune(
  intent: PruneIntent,
  signature: Uint8Array,
): Stump {
  // ---- 1. Verify post exists and is a root ----
  const rootPost = getPost(intent.rootPostHash);
  if (!rootPost) {
    throw new Error(`Post not found: ${intent.rootPostHash}`);
  }

  // Check it's not a Stump (already pruned)
  if ('subtreeMerkleRoot' in rootPost) {
    throw new Error('Post is already pruned');
  }

  const post = rootPost as Post;
  if (post.parentRefs.length > 0) {
    throw new Error('Only root posts (empty parentRefs) can be pruned');
  }

  // ---- 2. Verify author matches ----
  if (!Buffer.from(post.author).equals(Buffer.from(intent.authorId))) {
    throw new Error('Author mismatch: post author does not match intent authorId');
  }

  // ---- 3. Walk the reply subtree ----
  const descendants = getSubtree(intent.rootPostHash);
  const subtreePosts = [post, ...descendants];
  const replyCount = descendants.length;

  // ---- 4. Collect like boxes for all posts in the subtree ----
  const allLikeBoxes: LikeBox[] = [];
  for (const subtreePost of subtreePosts) {
    const postId = computePostId(subtreePost);
    const likeBoxes = getLockedLikeBoxes(postId);
    allLikeBoxes.push(...likeBoxes);
  }

  // ---- 5. Compute karma deltas (per-user sum of like box values) ----
  const karmaMap = new Map<string, number>();
  let upvoteCount = 0;
  for (const likeBox of allLikeBoxes) {
    upvoteCount += 1;
    const key = Buffer.from(likeBox.likerId).toString('hex');
    const current = karmaMap.get(key) ?? 0;
    karmaMap.set(key, current + likeBox.value);
  }

  const karmaDeltas: KarmaDelta[] = [];
  for (const [hexUserId, delta] of karmaMap) {
    karmaDeltas.push({ userId: new Uint8Array(Buffer.from(hexUserId, 'hex')), delta });
  }

  // ---- 6. Compute subtree Merkle root ----
  // Leaf for each post in the pruned set (root + descendants)
  const leafHashes: Uint8Array[] = [];
  for (const subtreePost of subtreePosts) {
    const postId = computePostId(subtreePost);
    leafHashes.push(leafHash(postId));
  }

  const merkleRoot = buildMerkleRoot(leafHashes);
  const currentHeight = getCurrentHeight();

  // ---- 7. Build the Stump ----
  const stump: Stump = {
    rootPostHash: intent.rootPostHash,
    subtreeMerkleRoot: merkleRoot,
    authorId: intent.authorId,
    pruneSignature: signature,
    karmaDeltas,
    replyCount,
    upvoteCount,
    trigger: intent.trigger,
    protocolVersion: PROTOCOL_VERSION,
    compactedAtBlockHeight: currentHeight,
  };

  // ---- 8. Prune the subtree ----
  pruneSubtree(intent.rootPostHash, stump);

  return stump;
}
