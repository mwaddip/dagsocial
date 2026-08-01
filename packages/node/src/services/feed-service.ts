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
  getLikeCount: (postId: string) => { locked: number; free: number };
  getLikersForPost: (postId: string) => string[];
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
   * Stumps (posts with subtreeMerkleRoot) are returned as-is.
   */
  getPost(id: string): unknown | null {
    const result = this.deps.getPost(id);
    if (!result) return null;

    // Check if it's a Stump (has subtreeMerkleRoot)
    if (
      typeof result === 'object' &&
      result !== null &&
      'subtreeMerkleRoot' in result
    ) {
      return result;
    }

    const post = result as Post;
    const counts = this.deps.getLikeCount(id);
    const likers = this.deps.getLikersForPost(id);
    return postToJson(post, counts.locked + counts.free, likers);
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
      const counts = this.deps.getLikeCount(postId);
      const likers = this.deps.getLikersForPost(postId);
      return postToJson(post, counts.locked + counts.free, likers);
    });
  }
}
