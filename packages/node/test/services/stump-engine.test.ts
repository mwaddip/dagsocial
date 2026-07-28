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
  computeBoxId,
  encodePost,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { Post, PruneIntent, Stump } from '@dagsocial/types';
import Database from 'better-sqlite3';

import {
  initDb,
  closeDb,
  getDb,
  insertPost,
  getPost as storeGetPost,
  insertBox,
} from '../../src/store/index.js';
import { createPruneIntent, executePrune } from '../../src/services/stump-engine.js';

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
  author: string,
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

/** Create a karma box for a user (needed for karma tracking). */
function insertKarmaBox(owner: Uint8Array, value: number, createdAtBlock: number): string {
  const box = {
    boxType: 'karma' as const,
    value,
    createdAtBlock,
    owner,
    guard: 'owner_signature' as const,
    proofSource: 'test',
    lastTouchBlock: createdAtBlock,
  };
  const id = computeBoxId(box);
  insertBox({ ...box, id });
  return id;
}

/** Insert a like box for a target post. */
function insertLikeBox(likerId: Uint8Array, targetPostId: string, value: number, createdAtBlock: number): string {
  const box = {
    boxType: 'like' as const,
    value,
    createdAtBlock,
    likerId,
    targetPostId,
    guard: 'epoch_tally' as const,
  };
  const id = computeBoxId(box);
  insertBox({ ...box, id });
  return id;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('stump-engine', () => {
  let db: Database.Database;
  let authorPubKey: Uint8Array;
  let authorPrivKey: KeyObject;
  let authorId: Uint8Array;
  let otherPubKey: Uint8Array;
  let otherId: string;

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();

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
  // 1. createPruneIntent produces correct unsigned intent
  // -----------------------------------------------------------------------
  it('createPruneIntent produces correct unsigned intent', () => {
    const intent = createPruneIntent('deadbeef', authorId, 'author');

    expect(intent.rootPostHash).toBe('deadbeef');
    expect(intent.trigger).toBe('author');
    expect(intent.authorId).toEqual(authorId);
    expect(intent.signature).toEqual(new Uint8Array(64));
  });

  // -----------------------------------------------------------------------
  // 2. executePrune on root post with replies prunes all descendants
  // -----------------------------------------------------------------------
  it('executePrune on root post with replies prunes all descendants', () => {
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
    const reply3Id = insertTestPost(reply3);

    // Create PruneIntent
    const intent: PruneIntent = {
      rootPostHash: rootId,
      trigger: 'author',
      authorId,
      signature: new Uint8Array(64),
    };

    // Generate a signature (simulate author signing)
    const sigBuffer = cryptoSign(null, Buffer.from('prune'), authorPrivKey);
    const signature = new Uint8Array(sigBuffer);

    const stump = executePrune(intent, signature);

    // Root post should now be a Stump
    const retrieved = storeGetPost(rootId);
    expect(retrieved).not.toBeNull();
    expect('subtreeMerkleRoot' in retrieved!).toBe(true);

    // Replies should not be found (they were pruned, getPost returns null for pruned non-root)
    // Actually for descendant posts that are pruned but not root, getPost would look
    // for them in dag_posts (status='pruned') and try to find a stump row where root_post_hash = their id.
    // Since they aren't root posts, getPost will return null.
    expect(storeGetPost(reply1Id)).toBeNull();
    expect(storeGetPost(reply2Id)).toBeNull();
    expect(storeGetPost(reply3Id)).toBeNull();

    // Stump should have correct fields
    expect(stump.rootPostHash).toBe(rootId);
    expect(stump.authorId).toEqual(authorId);
    expect(stump.replyCount).toBe(3); // reply1, reply2, reply3
    expect(stump.trigger).toBe('author');
    expect(stump.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  // -----------------------------------------------------------------------
  // 3. executePrune on non-root post succeeds (guard removed)
  // -----------------------------------------------------------------------
  it('executePrune on non-root post succeeds', () => {
    // Create a root post
    const rootPost = makePost('Root', authorId, []);
    const rootId = insertTestPost(rootPost);

    // Create a reply (not a root)
    const replyPost = makePost('Reply', authorId, [rootId]);
    const replyId = insertTestPost(replyPost);

    const intent: PruneIntent = {
      rootPostHash: replyId, // pruning a reply is now allowed
      trigger: 'author',
      authorId,
      signature: new Uint8Array(64),
    };

    const sigBuffer = cryptoSign(null, Buffer.from('prune'), authorPrivKey);
    const signature = new Uint8Array(sigBuffer);

    // Should no longer throw — any post (root or reply) can be pruned
    const stump = executePrune(intent, signature);
    expect(stump.rootPostHash).toBe(replyId);
    expect(stump.replyCount).toBe(0); // reply has no children of its own
  });

  // -----------------------------------------------------------------------
  // 4. executePrune with wrong author throws
  // -----------------------------------------------------------------------
  it('executePrune with wrong author throws', () => {
    const rootPost = makePost('Root', authorId, []);
    const rootId = insertTestPost(rootPost);

    const intent: PruneIntent = {
      rootPostHash: rootId,
      trigger: 'author',
      authorId: otherId, // wrong author
      signature: new Uint8Array(64),
    };

    const sigBuffer = cryptoSign(null, Buffer.from('prune'), authorPrivKey);
    const signature = new Uint8Array(sigBuffer);

    expect(() => executePrune(intent, signature)).toThrow('Author mismatch');
  });

  // -----------------------------------------------------------------------
  // 5. Stump contains correct replyCount and upvoteCount
  // -----------------------------------------------------------------------
  it('Stump contains correct replyCount and upvoteCount', () => {
    const rootPost = makePost('Root', authorId, []);
    const rootId = insertTestPost(rootPost);

    const reply1 = makePost('Reply 1', authorId, [rootId]);
    const reply1Id = insertTestPost(reply1);

    const reply2 = makePost('Reply 2', otherId, [rootId]);
    const reply2Id = insertTestPost(reply2);

    // Add like boxes
    insertLikeBox(otherId, rootId, 2, 1);
    insertLikeBox(otherId, reply1Id, 2, 1);
    insertLikeBox(authorId, reply2Id, 2, 1);

    const intent: PruneIntent = {
      rootPostHash: rootId,
      trigger: 'author',
      authorId,
      signature: new Uint8Array(64),
    };

    const sigBuffer = cryptoSign(null, Buffer.from('prune'), authorPrivKey);
    const signature = new Uint8Array(sigBuffer);

    const stump = executePrune(intent, signature);

    expect(stump.replyCount).toBe(2); // reply1, reply2
    expect(stump.upvoteCount).toBe(3); // 3 like boxes total
  });

  // -----------------------------------------------------------------------
  // 6. Stump karmaDeltas reflect collected like boxes
  // -----------------------------------------------------------------------
  it('Stump karmaDeltas reflect collected like boxes', () => {
    const rootPost = makePost('Root', authorId, []);
    const rootId = insertTestPost(rootPost);

    const reply1 = makePost('Reply 1', authorId, [rootId]);
    const reply1Id = insertTestPost(reply1);

    // Add like boxes by different users
    insertLikeBox(otherId, rootId, 2, 1);
    insertLikeBox(otherId, reply1Id, 2, 1); // otherId liked twice = delta 4
    insertLikeBox(authorId, rootId, 2, 1); // authorId liked once = delta 2

    const intent: PruneIntent = {
      rootPostHash: rootId,
      trigger: 'author',
      authorId,
      signature: new Uint8Array(64),
    };

    const sigBuffer = cryptoSign(null, Buffer.from('prune'), authorPrivKey);
    const signature = new Uint8Array(sigBuffer);

    const stump = executePrune(intent, signature);

    expect(stump.karmaDeltas).toHaveLength(2);

    // Find each user's delta
    const otherDelta = stump.karmaDeltas.find((d) => Buffer.from(d.userId).equals(Buffer.from(otherId)));
    const authorDelta = stump.karmaDeltas.find((d) => Buffer.from(d.userId).equals(Buffer.from(authorId)));

    expect(otherDelta).toBeDefined();
    expect(otherDelta!.delta).toBe(4); // 2 + 2

    expect(authorDelta).toBeDefined();
    expect(authorDelta!.delta).toBe(2); // 2
  });

  // -----------------------------------------------------------------------
  // 7. After prune, getPost(rootId) returns Stump not Post
  // -----------------------------------------------------------------------
  it('After prune, getPost(rootId) returns Stump not Post', () => {
    const rootPost = makePost('Root', authorId, []);
    const rootId = insertTestPost(rootPost);

    const intent: PruneIntent = {
      rootPostHash: rootId,
      trigger: 'author',
      authorId,
      signature: new Uint8Array(64),
    };

    const sigBuffer = cryptoSign(null, Buffer.from('prune'), authorPrivKey);
    const signature = new Uint8Array(sigBuffer);

    executePrune(intent, signature);

    const retrieved = storeGetPost(rootId);
    expect(retrieved).not.toBeNull();
    expect('subtreeMerkleRoot' in retrieved!).toBe(true);

    const stump = retrieved as Stump;
    expect(stump.rootPostHash).toBe(rootId);
    expect(stump.authorId).toEqual(authorId);
  });

  // -----------------------------------------------------------------------
  // 8. Subtree with no likes produces empty karmaDeltas
  // -----------------------------------------------------------------------
  it('Subtree with no likes produces empty karmaDeltas', () => {
    const rootPost = makePost('Root', authorId, []);
    const rootId = insertTestPost(rootPost);

    const reply1 = makePost('Reply 1', authorId, [rootId]);
    insertTestPost(reply1);

    // No like boxes

    const intent: PruneIntent = {
      rootPostHash: rootId,
      trigger: 'author',
      authorId,
      signature: new Uint8Array(64),
    };

    const sigBuffer = cryptoSign(null, Buffer.from('prune'), authorPrivKey);
    const signature = new Uint8Array(sigBuffer);

    const stump = executePrune(intent, signature);

    expect(stump.karmaDeltas).toEqual([]);
    expect(stump.upvoteCount).toBe(0);
    expect(stump.replyCount).toBe(1);
  });
});
