import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import { computePostId, encodePost, PROTOCOL_VERSION } from '@dagsocial/types';
import type { Post } from '@dagsocial/types';

import {
  initDb,
  closeDb,
  insertPost,
  getPost as storeGetPost,
  queryPosts,
  getLikeRecordCount,
  getLikersForPost,
  getAncestors,
  getSubtree,
  insertStump,
  pruneSubtree,
} from '../../src/store/index.js';
import { FeedService } from '../../src/services/feed-service.js';

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
  };
}

/** Insert a post and return its computed ID. */
function insertTestPost(post: Post): string {
  const postId = computePostId(post);
  insertPost(post, encodePost(post));
  return postId;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('feed-service', () => {
  let authorId: Uint8Array;
  let prunedRootId: string;
  let liveRootId: string;
  let liveReplyId: string;
  let feedService: FeedService;

  // The scalar fields of the stump the settled prune leaves behind.
  const stumpScalars = {
    replyCount: 1,
    upvoteCount: 0,
    trigger: 'author',
    protocolVersion: PROTOCOL_VERSION,
    compactedAtBlockHeight: 7,
  } as const;

  beforeEach(() => {
    initDb(':memory:');
    const keys = generateKeyPairSync('ed25519');
    authorId = rawPublicKey(keys.publicKey);

    // A live thread: root with one reply.
    liveRootId = insertTestPost(makePost('Live root', authorId, []));
    liveReplyId = insertTestPost(makePost('Live reply', authorId, [liveRootId]));

    // A pruned thread, settled exactly as block-apply settlement step 6
    // produces it: insertStump, then pruneSubtree.
    prunedRootId = insertTestPost(makePost('Doomed root', authorId, []));
    insertTestPost(makePost('Doomed reply', authorId, [prunedRootId]));
    insertStump({
      rootPostHash: prunedRootId,
      authorId,
      ...stumpScalars,
    });
    pruneSubtree(prunedRootId);

    feedService = new FeedService({
      getPost: storeGetPost,
      queryPosts,
      getLikeRecordCount,
      getLikersForPost,
      getAncestors,
      getSubtree,
    });
  });

  afterEach(() => {
    closeDb();
  });

  // -----------------------------------------------------------------------
  // getPost
  // -----------------------------------------------------------------------

  it('getPost returns a live post as serialized PostJson (control)', () => {
    const r = feedService.getPost(liveRootId) as Record<string, unknown>;
    expect(r).not.toBeNull();
    expect(r['id']).toBe(liveRootId);
    expect(r['content']).toBe('Live root');
    expect(r['author']).toBe(Buffer.from(authorId).toString('hex'));
    expect(r['likeCount']).toBe(0);
    expect(r['likers']).toEqual([]);
  });

  it('getPost on a pruned root returns the Stump as-is', () => {
    const r = feedService.getPost(prunedRootId) as Record<string, unknown>;
    expect(r).not.toBeNull();
    expect(r).toMatchObject({ rootPostHash: prunedRootId, ...stumpScalars });
    expect(new Uint8Array(r['authorId'] as Uint8Array)).toEqual(authorId);
    // A stump is not a post: no content, and no PostJson serialization.
    expect('content' in r).toBe(false);
    expect('likeCount' in r).toBe(false);
  });

  it('getPost returns null for an unknown id', () => {
    expect(feedService.getPost('ab'.repeat(32))).toBeNull();
  });

  // -----------------------------------------------------------------------
  // getThread
  // -----------------------------------------------------------------------

  it('getThread returns full thread context for a live post (control)', () => {
    const t = feedService.getThread(liveReplyId);
    expect(t).not.toBeNull();
    expect(t!.post).not.toBeNull();
    expect(t!.post!.id).toBe(liveReplyId);
    expect(t!.ancestors.map((p) => p.id)).toEqual([liveRootId]);
    expect(t!.descendants).toEqual([]);
  });

  it('getThread on a pruned root returns the stump shell', () => {
    const t = feedService.getThread(prunedRootId);
    expect(t).not.toBeNull();
    expect(t!.ancestors).toEqual([]);
    expect(t!.descendants).toEqual([]);
    expect(t!.post).toMatchObject({
      rootPostHash: prunedRootId,
      ...stumpScalars,
    });
  });

  it('getThread returns null for an unknown id', () => {
    expect(feedService.getThread('ab'.repeat(32))).toBeNull();
  });
});
