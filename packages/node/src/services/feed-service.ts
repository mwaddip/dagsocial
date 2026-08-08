import { computePostId } from '@dagsocial/types';
import type { Post, Stump } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface FeedServiceDeps {
  /**
   * The store's real signature (`store/posts.ts` → `getPost`), not `unknown`.
   *
   * It was typed `unknown | null` — which collapses to `unknown`, so the
   * stump arm below was invisible to the compiler and the raw `Stump` went out
   * of `res.json` with its `authorId` serialized index-keyed
   * (`{"0":…,"1":…}`). Naming the union makes the compiler the mutation
   * detector for this file: re-widening this type must not typecheck the
   * stump arm away, and a future variant added to the store's return breaks
   * here rather than in a response body.
   */
  getPost: (id: string) => Post | Stump | null;
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

/**
 * A pruned root's JSON form (NODE_INTERFACE → Posts, "Stump JSON shape").
 *
 * A stump is renderable tombstone data, not an absence, so `GET /posts/:id`
 * stays a 200 on one. It is a DISTINCT type discriminated by an explicit
 * `kind`, never by which of `PostJson`'s keys happen to be missing — clients
 * test for the field's presence, and `PostJson` carries none.
 *
 * `author` is hex, matching `PostJson.author`'s convention. That is the whole
 * defect this type closes: the raw `Stump` used to be returned as-is, and
 * `res.json` serialized its `authorId` — a `Uint8Array` — index-keyed.
 */
export interface StumpJson {
  kind: 'stump';
  id: string;
  author: string;
  replyCount: number;
  upvoteCount: number;
  trigger: 'author' | 'storage_prune';
  protocolVersion: number;
  compactedAtBlockHeight: number;
}

export interface ThreadJson {
  post: PostJson | StumpJson | null;
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

/**
 * Convert a Stump to its JSON form. The twin of `postToJson`, and the only
 * place a `Stump` may cross into a response body.
 *
 * `id` is the `rootPostHash` — the id a client asked for when it got here,
 * since a pruned root resolves to its stump by that hash.
 */
export function stumpToJson(stump: Stump): StumpJson {
  return {
    kind: 'stump',
    id: stump.rootPostHash,
    author: Buffer.from(stump.authorId).toString('hex'),
    replyCount: stump.replyCount,
    upvoteCount: stump.upvoteCount,
    trigger: stump.trigger,
    protocolVersion: stump.protocolVersion,
    compactedAtBlockHeight: stump.compactedAtBlockHeight,
  };
}

/**
 * Narrow the store's `Post | Stump` union.
 *
 * A stump has no `content`; a live Post always does. (Do not test
 * `'subtreeMerkleRoot' in` — that field lives on PruneIntent/PruneEntry,
 * never on Stump, so the check can never fire.)
 */
function isStump(result: Post | Stump): result is Stump {
  return !('content' in result);
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
   * A pruned root comes back as `StumpJson`, a 200 either way.
   */
  getPost(id: string): PostJson | StumpJson | null {
    const result = this.deps.getPost(id);
    if (!result) return null;
    if (isStump(result)) return stumpToJson(result);

    const likeCount = this.deps.getLikeRecordCount(id);
    const likers = this.deps.getLikersForPost(id);
    return postToJson(result, likeCount, likers);
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

    // Stumps carry no thread context — the subtree is what pruning removed.
    if (isStump(result)) {
      return { post: stumpToJson(result), ancestors: [], descendants: [] };
    }

    const post = result;
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
