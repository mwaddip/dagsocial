import { randomUUID } from 'crypto';
import { getDb } from './db.js';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

interface LikeRow {
  id: string;
  target_post_id: string;
  liker_id: Buffer;          // 32-byte Ed25519 public key
  created_at: number;
  processed: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a free like row.
 * Returns the generated id (UUID v4).
 * Throws on UNIQUE violation (duplicate like).
 */
export function insertLike(targetPostId: string, likerId: Uint8Array): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO dag_likes (id, target_post_id, liker_id)
     VALUES (?, ?, ?)`,
  ).run(id, targetPostId, Buffer.from(likerId));
  return id;
}

/**
 * Check whether a user has already liked a post.
 * Checks both dag_likes (free) and utxo_boxes (locked like boxes).
 */
export function hasLiked(targetPostId: string, likerId: Uint8Array): boolean {
  const db = getDb();
  const likerBuf = Buffer.from(likerId);
  const row = db
    .prepare(
      `SELECT 1 FROM dag_likes WHERE target_post_id = ? AND liker_id = ?
       UNION
       SELECT 1 FROM utxo_boxes
       WHERE box_type = 'like'
         AND json_extract(extra_data, '$.targetPostId') = ?
         AND json_extract(extra_data, '$.likerId') = ?
         AND spent_at_block IS NULL`,
    )
    .get(targetPostId, likerBuf, targetPostId, Buffer.from(likerId).toString('hex')) as unknown;
  return row !== undefined;
}

/**
 * Find a free like row for a specific user and post.
 * Returns the like row (with id) or null if not found.
 */
export function getFreeLike(
  targetPostId: string,
  likerId: Uint8Array,
): { id: string } | null {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT id FROM dag_likes WHERE target_post_id = ? AND liker_id = ?',
    )
    .get(targetPostId, Buffer.from(likerId)) as { id: string } | undefined;
  return row ?? null;
}

/**
 * Delete a free like row.
 */
export function deleteFreeLike(targetPostId: string, likerId: Uint8Array): void {
  const db = getDb();
  db.prepare(
    'DELETE FROM dag_likes WHERE target_post_id = ? AND liker_id = ?',
  ).run(targetPostId, Buffer.from(likerId));
}

/**
 * Get like counts for a post, split by locked (utxo_boxes) and free (dag_likes).
 */
export function getLikeCount(postId: string): { locked: number; free: number } {
  const db = getDb();

  const lockedRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM utxo_boxes
       WHERE box_type = 'like'
         AND json_extract(extra_data, '$.targetPostId') = ?
         AND spent_at_block IS NULL`,
    )
    .get(postId) as { cnt: number };

  const freeRow = db
    .prepare(
      'SELECT COUNT(*) AS cnt FROM dag_likes WHERE target_post_id = ?',
    )
    .get(postId) as { cnt: number };

  return { locked: lockedRow.cnt, free: freeRow.cnt };
}

/**
 * Return all unprocessed free likes (processed = 0).
 */
export function getUnprocessedFreeLikes(): Array<{
  id: string;
  targetPostId: string;
  likerId: Uint8Array;
}> {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM dag_likes WHERE processed = 0')
    .all() as LikeRow[];
  return rows.map((r) => ({
    id: r.id,
    targetPostId: r.target_post_id,
    likerId: new Uint8Array(r.liker_id),
  }));
}

/**
 * Bulk-mark free likes as processed.
 */
export function markFreeLikesProcessed(likeIds: string[]): void {
  if (likeIds.length === 0) return;
  const db = getDb();
  const placeholders = likeIds.map(() => '?').join(', ');
  db.prepare(
    `UPDATE dag_likes SET processed = 1 WHERE id IN (${placeholders})`,
  ).run(...likeIds);
}
