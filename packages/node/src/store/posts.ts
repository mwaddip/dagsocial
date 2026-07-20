import { getDb } from './db.js';
import {
  computePostId,
  computeStumpId,
  encodeStump,
} from '@dagsocial/types';
import type { Post, Stump } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface PostRow {
  id: string;
  content: string;
  author: string;
  parent_refs: string;        // JSON array
  challenge: Buffer;
  pow_nonce: number;
  protocol_version: number;
  timestamp: number;
  signature: Buffer;
  raw_cbor: Buffer;
  status: string;
  block_height: number | null;
}

interface StumpRow {
  id: string;
  root_post_hash: string;
  subtree_merkle_root: Buffer;
  author_id: string;
  prune_signature: Buffer;
  karma_deltas: string;       // JSON array
  reply_count: number;
  upvote_count: number;
  trigger: string;
  protocol_version: number;
  compacted_at_block_height: number;
  raw_cbor: Buffer;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToPost(row: PostRow): Post {
  return {
    content: row.content,
    author: row.author,
    parentRefs: JSON.parse(row.parent_refs) as string[],
    challenge: new Uint8Array(row.challenge),
    powNonce: row.pow_nonce,
    protocolVersion: row.protocol_version,
    timestamp: row.timestamp,
    signature: new Uint8Array(row.signature),
  };
}

function rowToStump(row: StumpRow): Stump {
  return {
    rootPostHash: row.root_post_hash,
    subtreeMerkleRoot: new Uint8Array(row.subtree_merkle_root),
    authorId: row.author_id,
    pruneSignature: new Uint8Array(row.prune_signature),
    karmaDeltas: JSON.parse(row.karma_deltas),
    replyCount: row.reply_count,
    upvoteCount: row.upvote_count,
    trigger: row.trigger as Stump['trigger'],
    protocolVersion: row.protocol_version,
    compactedAtBlockHeight: row.compacted_at_block_height,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new post into dag_posts with status='pending', and insert a row
 * into dag_parent_refs for each parentId in post.parentRefs.
 */
export function insertPost(post: Post, rawCbor: Uint8Array): void {
  const db = getDb();
  const postId = computePostId(post);

  db.prepare(
    `INSERT INTO dag_posts
       (id, content, author, parent_refs, challenge, pow_nonce,
        protocol_version, timestamp, signature, raw_cbor, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(
    postId,
    post.content,
    post.author,
    JSON.stringify(post.parentRefs),
    Buffer.from(post.challenge),
    post.powNonce,
    post.protocolVersion,
    post.timestamp,
    Buffer.from(post.signature),
    Buffer.from(rawCbor),
  );

  const insertRef = db.prepare(
    'INSERT OR IGNORE INTO dag_parent_refs (post_id, parent_id) VALUES (?, ?)',
  );
  for (const parentId of post.parentRefs) {
    insertRef.run(postId, parentId);
  }
}

/**
 * Retrieve a post or stump by id.
 *
 * 1. Look in dag_posts first. If status != 'pruned', return the Post.
 * 2. If the post is pruned, look up the corresponding stump via root_post_hash.
 * 3. If not found in dag_posts at all, try dag_stumps by stump id directly.
 * 4. Return null if nothing matches.
 */
export function getPost(id: string): Post | Stump | null {
  const db = getDb();

  // 1. Try dag_posts first
  const postRow = db
    .prepare('SELECT * FROM dag_posts WHERE id = ?')
    .get(id) as PostRow | undefined;

  if (postRow) {
    if (postRow.status !== 'pruned') {
      return rowToPost(postRow);
    }
    // Post is pruned — look up the stump
    const stumpRow = db
      .prepare('SELECT * FROM dag_stumps WHERE root_post_hash = ?')
      .get(id) as StumpRow | undefined;
    return stumpRow ? rowToStump(stumpRow) : null;
  }

  // 2. Not in dag_posts — try dag_stumps by id (direct stump lookup)
  const stumpRow = db
    .prepare('SELECT * FROM dag_stumps WHERE id = ?')
    .get(id) as StumpRow | undefined;
  if (stumpRow) {
    return rowToStump(stumpRow);
  }

  return null;
}

/**
 * Query live posts (status != 'pruned'), newest first.
 *
 * @param opts.author  Optional author filter.
 * @param opts.limit   Max rows to return (default 50).
 * @param opts.offset  Pagination offset (default 0).
 */
export function queryPosts(opts: {
  author?: string;
  limit?: number;
  offset?: number;
}): Post[] {
  const db = getDb();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  let sql = "SELECT * FROM dag_posts WHERE status != 'pruned'";
  const params: unknown[] = [];

  if (opts.author) {
    sql += ' AND author = ?';
    params.push(opts.author);
  }

  sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as PostRow[];
  return rows.map(rowToPost);
}

/**
 * Get pending (unconfirmed) posts, oldest first.
 */
export function getPendingPosts(limit: number): Post[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM dag_posts WHERE status = 'pending' ORDER BY timestamp ASC LIMIT ?",
    )
    .all(limit) as PostRow[];
  return rows.map(rowToPost);
}

/**
 * Mark a post as confirmed at a given block height.
 */
export function confirmPost(postId: string, blockHeight: number): void {
  getDb()
    .prepare(
      "UPDATE dag_posts SET status = 'confirmed', block_height = ? WHERE id = ?",
    )
    .run(blockHeight, postId);
}

/**
 * Return the parent IDs for a given post, in insertion order.
 */
export function getParentRefs(postId: string): string[] {
  const rows = getDb()
    .prepare('SELECT parent_id FROM dag_parent_refs WHERE post_id = ?')
    .all(postId) as Array<{ parent_id: string }>;
  return rows.map((r) => r.parent_id);
}

/**
 * Return all descendant posts of the given root post, using a recursive CTE
 * over dag_parent_refs. The root post itself is NOT included in the result.
 */
export function getSubtree(postId: string): Post[] {
  const db = getDb();
  const rows = db
    .prepare(
      `WITH RECURSIVE subtree AS (
         SELECT dp.* FROM dag_posts dp
         JOIN dag_parent_refs dpr ON dp.id = dpr.post_id
         WHERE dpr.parent_id = ?

         UNION

         SELECT dp.* FROM dag_posts dp
         JOIN dag_parent_refs dpr ON dp.id = dpr.post_id
         JOIN subtree s ON dpr.parent_id = s.id
       )
       SELECT DISTINCT * FROM subtree`,
    )
    .all(postId) as PostRow[];
  return rows.map(rowToPost);
}

/**
 * Mark the entire reply subtree (including the root) as pruned, and insert
 * the stump into dag_stumps.
 */
export function pruneSubtree(rootPostId: string, stump: Stump): void {
  const db = getDb();

  // Collect all post IDs in the subtree (root + descendants)
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
    .all(rootPostId) as Array<{ id: string }>;

  // Mark all posts in the subtree as pruned
  const markPruned = db.prepare(
    "UPDATE dag_posts SET status = 'pruned' WHERE id = ?",
  );
  for (const { id } of rows) {
    markPruned.run(id);
  }

  // Insert the stump
  const stumpId = computeStumpId(stump);
  db.prepare(
    `INSERT INTO dag_stumps
       (id, root_post_hash, subtree_merkle_root, author_id, prune_signature,
        karma_deltas, reply_count, upvote_count, trigger, protocol_version,
        compacted_at_block_height, raw_cbor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    stumpId,
    stump.rootPostHash,
    Buffer.from(stump.subtreeMerkleRoot),
    stump.authorId,
    Buffer.from(stump.pruneSignature),
    JSON.stringify(stump.karmaDeltas),
    stump.replyCount,
    stump.upvoteCount,
    stump.trigger,
    stump.protocolVersion,
    stump.compactedAtBlockHeight,
    Buffer.from(encodeStump(stump)),
  );
}
