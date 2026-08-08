import { computePostId } from '@dagsocial/types';
import type { Post } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface FeedServiceDeps {
  getPost: (id: string) => unknown | null;
  queryPosts: (opts: {
    author?: Uint8Array;
    limit?: number;
    offset?: number;
  }) => Post[];
  getLikeRecordCount: (postId: string) => number;
  getLikersForPost: (postId: string) => string[];
  getAncestors: (postId: string) => Post[];
  getSubtree: (postId: string) => Post[];
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface PostJson {
  id: string;
  content: string;
  author: string;
  parentRefs: string[];
  challenge: string;
  powNonce: number;
  protocolVersion: number;
  timestamp: number;
  signature: string;
  status: string;
  likeCount: number;
  likers: string[];
}

export interface ThreadJson {
  post: PostJson | null;
  ancestors: PostJson[];
  descendants: PostJson[];
}

// ---------------------------------------------------------------------------
// Service helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Post's Uint8Array fields to hex for JSON responses.
 */
export function postToJson(
  post: Post & { status?: string },
  likeCount: number,
  likers: string[],
): PostJson {
  const postId = computePostId(post);
  return {
    id: postId,
    content: post.content,
    author: Buffer.from(post.author).toString('hex'),
    parentRefs: post.parentRefs,
    challenge: Buffer.from(post.challenge).toString('hex'),
    powNonce: post.powNonce,
    protocolVersion: post.protocolVersion,
    timestamp: post.timestamp,
    signature: Buffer.from(post.signature).toString('hex'),
    status: post.status ?? 'unknown',
    likeCount,
    likers,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Feed query service. Thin facade over the post store for read operations.
 * Handles serialization of binary fields to hex for JSON responses.
 */
export class FeedService {
  constructor(private deps: FeedServiceDeps) {}

  /**
   * Retrieve a single post by ID. Returns null if not found.
   * Stumps are returned as-is.
   */
  getPost(id: string): unknown | null {
    const result = this.deps.getPost(id);
    if (!result) return null;

    // A stump has no `content`; a live Post always does. (Do not test
    // `'subtreeMerkleRoot' in` — that field lives on PruneIntent/PruneEntry,
    // never on Stump, so the check can never fire.)
    if (
      typeof result === 'object' &&
      result !== null &&
      !('content' in result)
    ) {
      return result;
    }

    const post = result as Post;
    const likeCount = this.deps.getLikeRecordCount(id);
    const likers = this.deps.getLikersForPost(id);
    return postToJson(post, likeCount, likers);
  }

  /**
   * Query posts with pagination. Returns serialized JSON-ready posts.
   */
  queryPosts(opts: {
    author?: Uint8Array;
    limit?: number;
    offset?: number;
  }): PostJson[] {
    const limit = Math.min(opts.limit ?? 50, 100);
    const offset = opts.offset ?? 0;
    const posts = this.deps.queryPosts({ author: opts.author, limit, offset });
    return posts.map((post) => {
      const postId = computePostId(post);
      const likeCount = this.deps.getLikeRecordCount(postId);
      const likers = this.deps.getLikersForPost(postId);
      return postToJson(post, likeCount, likers);
    });
  }

  /**
   * Fetch a post with its full thread context: ancestor chain (genesis →
   * immediate parent, straight line) and descendant subtree (all replies).
   * Returns null if the post is not found.
   */
  getThread(id: string): ThreadJson | null {
    const result = this.deps.getPost(id);
    if (!result) return null;

    // Handle Stumps — no thread context available. A stump has no `content`;
    // a live Post always does. (Do not test `'subtreeMerkleRoot' in` — that
    // field lives on PruneIntent/PruneEntry, never on Stump, so the check
    // can never fire.)
    if (
      typeof result === 'object' &&
      result !== null &&
      !('content' in result)
    ) {
      return { post: result as unknown as PostJson, ancestors: [], descendants: [] };
    }

    const post = result as Post;
    const likeCount = this.deps.getLikeRecordCount(id);
    const likers = this.deps.getLikersForPost(id);
    const postJson = postToJson(post, likeCount, likers);

    // Ancestors: walk up the parent chain (genesis → immediate parent)
    const ancestorPosts = this.deps.getAncestors(id);
    const ancestors = ancestorPosts.map((p) => {
      const pid = computePostId(p);
      const c = this.deps.getLikeRecordCount(pid);
      const l = this.deps.getLikersForPost(pid);
      return postToJson(p, c, l);
    });

    // Descendants: full reply subtree below the target
    const descendantPosts = this.deps.getSubtree(id);
    const descendants = descendantPosts.map((p) => {
      const pid = computePostId(p);
      const c = this.deps.getLikeRecordCount(pid);
      const l = this.deps.getLikersForPost(pid);
      return postToJson(p, c, l);
    });

    return { post: postJson, ancestors, descendants };
  }
}
