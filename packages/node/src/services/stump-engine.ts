import {
  computePostId,
  leafHash,
  buildMerkleRoot,
  hexToBuf,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type { PruneEntry, PruneIntent, Post } from '@dagsocial/types';
import {
  getPost,
  getSubtree,
  getCurrentHeight,
  insertMempoolPrune,
} from '../store/index.js';
import { createHash, createPublicKey, verify } from 'crypto';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a prune operation: verify a client-signed PruneIntent and build a
 * PruneEntry to be included in a SubBlock.
 *
 * Verification steps:
 *  1. Post exists
 *  2. Not already pruned
 *  3. Author matches intent.authorId
 *  4. Client Ed25519 signature over (rootPostHash, subtreeMerkleRoot)
 *  5. subtreePostIds match the actual reply tree
 *  6. Merkle root over postId list is correct
 *
 * @param intent  The client-signed prune intent
 * @returns The constructed PruneEntry
 */
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

  // 8. Enqueue in mempool. Nothing is broadcast at prune initiation: the prune
  // propagates inside the ordering block that carries the PruneEntry, and every
  // node derives its own stump at settlement (NODE_INTERFACE "Stumps are
  // derived state"). A gossiped stump is unverifiable by construction and the
  // table it would write is trusted by the read API and relay verifier, so no
  // stump crosses the network in either direction.
  const currentHeight = getCurrentHeight();
  insertMempoolPrune(entry, currentHeight + MEMPOOL_EXPIRY_BLOCKS);

  return entry;
}
