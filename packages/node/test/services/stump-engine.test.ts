import { uid } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  createHash,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  computePostId,
  computePruneEntryId,
  encodePost,
  leafHash,
  buildMerkleRoot,
  hexToBuf,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { Post, PruneIntent, PruneEntry } from '@dagsocial/types';

import {
  initDb,
  closeDb,
  getDb,
  insertPost,
  getPost as storeGetPost,
} from '../../src/store/index.js';
import { executePrune } from '../../src/services/stump-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract raw 32-byte Ed25519 public key from SPKI DER KeyObject. */
function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

/** Create a minimal Post object for testing. */
function makePost(
  content: string,
  author: Uint8Array,
  parentRefs: string[],
  overrides: Partial<Post> = {},
): Post {
  return {
    content,
    author,
    parentRefs,
    challenge: new Uint8Array(32).fill(0xaa),
    powNonce: 0,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: Date.now(),
    signature: new Uint8Array(64),
    ...overrides,
  };
}

/** Insert a post and return its computed ID. */
function insertTestPost(post: Post): string {
  const postId = computePostId(post);
  const rawCbor = encodePost(post);
  insertPost(post, rawCbor);
  return postId;
}

/**
 * Build a valid PruneIntent signed by the author.
 *
 * Reads the actual reply tree from the store to produce correct
 * subtreePostIds and subtreeMerkleRoot. Signs over
 * blake2b512(rootPostHash ++ subtreeMerkleRoot).subarray(0,32).
 */
function signPruneIntent(
  rootPostHash: string,
  authorId: Uint8Array,
  authorPrivKey: KeyObject,
): PruneIntent {
  // Collect all posts in the reply subtree from the store
  const db = getDb();
  const rows = db
    .prepare(
      `WITH RECURSIVE subtree AS (
         SELECT id FROM dag_posts WHERE id = ?
         UNION
         SELECT dp.id FROM dag_posts dp
         JOIN dag_parent_refs dpr ON dp.id = dpr.post_id
         JOIN subtree s ON dpr.parent_id = s.id
       )
       SELECT id FROM subtree`,
    )
    .all(rootPostHash) as Array<{ id: string }>;

  const subtreePostIds = rows.map(r => r.id).sort();

  // Compute Merkle root over leafHash('stump', postId) for each post
  const leaves = subtreePostIds
    .map(id => leafHash('stump', hexToBuf(id)));
  const merkleRoot = buildMerkleRoot(leaves);

  // Sign intent payload: blake2b512(rootPostHash ++ subtreeMerkleRoot).subarray(0,32)
  const payload = createHash('blake2b512')
    .update(rootPostHash)
    .update(merkleRoot)
    .digest()
    .subarray(0, 32);
  const sig = cryptoSign(null, payload, authorPrivKey);

  return {
    rootPostHash,
    trigger: 'author',
    authorId,
    subtreeMerkleRoot: merkleRoot,
    subtreePostIds,
    signature: new Uint8Array(sig),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('stump-engine', () => {
  let authorPubKey: Uint8Array;
  let authorPrivKey: KeyObject;
  let authorId: Uint8Array;
  let otherPubKey: Uint8Array;
  let otherId: Uint8Array;

  beforeEach(() => {
    initDb(':memory:');

    // Generate author keypair
    const authorKeys = generateKeyPairSync('ed25519');
    authorPubKey = rawPublicKey(authorKeys.publicKey);
    authorPrivKey = authorKeys.privateKey;
    authorId = authorPubKey;

    // Generate another keypair (for wrong-author tests)
    const otherKeys = generateKeyPairSync('ed25519');
    otherPubKey = rawPublicKey(otherKeys.publicKey);
    otherId = otherPubKey;
  });

  afterEach(() => {
    closeDb();
  });

  // -----------------------------------------------------------------------
  // 1. executePrune on root post with replies returns PruneEntry
  // -----------------------------------------------------------------------
  it('executePrune on root post with replies returns PruneEntry', () => {
    // Create root post
    const rootPost = makePost('Root post', authorId, []);
    const rootId = insertTestPost(rootPost);

    // Create reply posts (children of root)
    const reply1 = makePost('Reply 1', authorId, [rootId]);
    const reply1Id = insertTestPost(reply1);

    const reply2 = makePost('Reply 2', otherId, [rootId]);
    const reply2Id = insertTestPost(reply2);

    // Create nested reply (grandchild)
    const reply3 = makePost('Nested reply', otherId, [reply1Id]);
    insertTestPost(reply3);

    const intent = signPruneIntent(rootId, authorId, authorPrivKey);

    const entry = executePrune(intent);

    // Should return a PruneEntry
    expect(entry.rootPostHash).toBe(rootId);
    expect(entry.authorId).toEqual(authorId);
    expect(entry.trigger).toBe('author');
    expect(entry.subtreePostIds.length).toBeGreaterThanOrEqual(3); // root + replies
    expect(entry.authorSignature).toEqual(intent.signature);

    // computePruneEntryId should work
    const entryId = computePruneEntryId(entry);
    expect(typeof entryId).toBe('string');
    expect(entryId.length).toBe(64);

    // Posts are NOT pruned — pruning is deferred to block application
    const retrieved = storeGetPost(rootId);
    expect(retrieved).not.toBeNull();
    expect('content' in retrieved!).toBe(true);

    // Descendants are still present (not pruned)
    expect(storeGetPost(reply1Id)).not.toBeNull();
    expect(storeGetPost(reply2Id)).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // 2. executePrune on non-root post (reply) succeeds
  // -----------------------------------------------------------------------
  it('executePrune on non-root post succeeds', () => {
    // Create a root post
    const rootPost = makePost('Root', authorId, []);
    const rootId = insertTestPost(rootPost);

    // Create a reply (not a root)
    const replyPost = makePost('Reply', authorId, [rootId]);
    const replyId = insertTestPost(replyPost);

    const intent = signPruneIntent(replyId, authorId, authorPrivKey);

    // Should succeed — any post can be pruned
    const entry = executePrune(intent);
    expect(entry.rootPostHash).toBe(replyId);
    expect(entry.subtreePostIds).toContain(replyId);
  });

  // -----------------------------------------------------------------------
  // 3. executePrune with wrong author throws
  // -----------------------------------------------------------------------
  it('executePrune with wrong author throws', () => {
    const rootPost = makePost('Root', authorId, []);
    const rootId = insertTestPost(rootPost);

    // Create reply so subtree is not empty
    insertTestPost(makePost('Reply', authorId, [rootId]));

    const intent = signPruneIntent(rootId, authorId, authorPrivKey);
    // Tamper: replace authorId with otherId
    intent.authorId = otherId;

    expect(() => executePrune(intent)).toThrow('Author mismatch');
  });

  // -----------------------------------------------------------------------
  // 4. executePrune with invalid signature throws
  // -----------------------------------------------------------------------
  it('executePrune with invalid signature throws', () => {
    const rootPost = makePost('Root', authorId, []);
    const rootId = insertTestPost(rootPost);

    // Create reply so subtree is not empty
    insertTestPost(makePost('Reply', authorId, [rootId]));

    const intent = signPruneIntent(rootId, authorId, authorPrivKey);
    // Tamper: replace signature with all zeros
    intent.signature = new Uint8Array(64);

    expect(() => executePrune(intent)).toThrow('Invalid prune signature');
  });

  // -----------------------------------------------------------------------
  // 5. executePrune with mismatched subtreePostIds throws
  // -----------------------------------------------------------------------
  it('executePrune with mismatched subtreePostIds throws', () => {
    const rootPost = makePost('Root', authorId, []);
    const rootId = insertTestPost(rootPost);

    // Add a reply so the real subtree is non-empty
    insertTestPost(makePost('Reply', authorId, [rootId]));

    const intent = signPruneIntent(rootId, authorId, authorPrivKey);
    // Tamper: remove a post from the list
    intent.subtreePostIds = [rootId]; // missing the reply

    expect(() => executePrune(intent)).toThrow('subtreePostIds does not match');
  });

  // -----------------------------------------------------------------------
  // 6. executePrune with incorrect Merkle root throws
  // -----------------------------------------------------------------------
  it('executePrune with incorrect Merkle root throws', () => {
    const rootPost = makePost('Root', authorId, []);
    const rootId = insertTestPost(rootPost);

    // Add a reply so subtree is non-empty
    insertTestPost(makePost('Reply', authorId, [rootId]));

    const intent = signPruneIntent(rootId, authorId, authorPrivKey);
    // Tamper: replace merkle root with garbage AND re-sign
    const fakeRoot = new Uint8Array(32).fill(0xde);
    intent.subtreeMerkleRoot = fakeRoot;
    const payload = createHash('blake2b512')
      .update(intent.rootPostHash)
      .update(fakeRoot)
      .digest()
      .subarray(0, 32);
    intent.signature = new Uint8Array(cryptoSign(null, payload, authorPrivKey));

    expect(() => executePrune(intent)).toThrow('subtreeMerkleRoot does not match');
  });

  // -----------------------------------------------------------------------
  // 7. executePrune on non-existent post throws
  // -----------------------------------------------------------------------
  it('executePrune on non-existent post throws', () => {
    const fakeRootId = 'deadbeef'.repeat(8); // 64 hex chars

    // Build a valid PruneIntent with a signature using a fake merkle root
    const subtreePostIds = [fakeRootId];
    const leaves = subtreePostIds.map(id => leafHash('stump', hexToBuf(id)));
    const merkleRoot = buildMerkleRoot(leaves);

    const payload = createHash('blake2b512')
      .update(fakeRootId)
      .update(merkleRoot)
      .digest()
      .subarray(0, 32);
    const sig = cryptoSign(null, payload, authorPrivKey);

    const intent: PruneIntent = {
      rootPostHash: fakeRootId,
      trigger: 'author',
      authorId,
      subtreeMerkleRoot: merkleRoot,
      subtreePostIds,
      signature: new Uint8Array(sig),
    };

    expect(() => executePrune(intent)).toThrow('Post not found');
  });

  // -----------------------------------------------------------------------
  // 8. Subtree with no replies succeeds (leaf node prune)
  // -----------------------------------------------------------------------
  it('Subtree with no replies succeeds (leaf node prune)', () => {
    const rootPost = makePost('Root', authorId, []);
    const rootId = insertTestPost(rootPost);

    // No replies — subtree is just the root itself
    const intent = signPruneIntent(rootId, authorId, authorPrivKey);

    const entry = executePrune(intent);
    expect(entry.rootPostHash).toBe(rootId);
    expect(entry.subtreePostIds).toEqual([rootId]);
    expect(entry.authorId).toEqual(authorId);
  });
});
