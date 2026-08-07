import { randomUUID } from 'crypto';
import type { UserId } from '@dagsocial/types';
import { getDb } from './db.js';
import {
  isBlockJournalOpen,
  recordFreeLikesProcessed,
  recordLikeRecordInsertion,
  recordLikeRecordDeletions,
} from './journal.js';

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
 *
 * Ordered by like id so the epoch tally walks them identically on every node
 * whatever order they arrived in.  Defence in depth: the consensus-relevant
 * serialization is canonicalized (`epoch-canonical.ts`), never left to rely on
 * rowid order.
 */
export function getUnprocessedFreeLikes(): Array<{
  id: string;
  targetPostId: string;
  likerId: Uint8Array;
}> {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM dag_likes WHERE processed = 0 ORDER BY id')
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
  recordFreeLikesProcessed(likeIds);
}

/**
 * Bulk-mark free likes as unprocessed — exact inverse of
 * markFreeLikesProcessed. Fork-rollback inverse — never records to the
 * block journal.
 */
export function markFreeLikesUnprocessed(likeIds: string[]): void {
  if (likeIds.length === 0) return;
  const db = getDb();
  const placeholders = likeIds.map(() => '?').join(', ');
  db.prepare(
    `UPDATE dag_likes SET processed = 0 WHERE id IN (${placeholders})`,
  ).run(...likeIds);
}

// ---------------------------------------------------------------------------
// Like-records (P2-D — NODE_INTERFACE "Like-records")
//
// `(liker, targetPostId)` pairs written ONLY at block application, never by
// an HTTP route — the retired free-like tier's `dag_likes` rows above were
// route-written, which is what made the old epoch mint a DAG-index read
// inside consensus. Content-layer consensus state, the `block_topology` tier:
// deterministic by replay, journalled with exact inverses, not in the
// `stateRoot`. Records die with the post on prune and survive withdraw.
//
// The free-like functions above run the retired system until P2-D N4 deletes
// them together with `dag_likes`.
// ---------------------------------------------------------------------------

/**
 * Write the like-record for an applied like transaction.
 *
 * **Block application only** — by convention, not enforcement: N2b's
 * embedded-tx application is the intended sole caller. Throws on the primary
 * key: `(target, liker)` already present IS the structural
 * one-like-per-account dedup, and at apply time the engine treats the
 * collision as an invalid transaction.
 *
 * While a block journal is open, records a `likeRecordInsertions`
 * side-record (inverse: `deleteLikeRecord`). Recording happens after the
 * INSERT so a duplicate throws before anything reaches the journal.
 */
export function insertLikeRecord(
  targetPostId: string,
  likerId: UserId,
  blockHeight: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO like_records (target_post_id, liker_id, applied_at_block)
       VALUES (?, ?, ?)`,
    )
    .run(targetPostId, Buffer.from(likerId), blockHeight);
  recordLikeRecordInsertion(targetPostId, likerId);
}

/** Has this liker already liked this post? The apply-time dedup read. */
export function hasLikeRecord(targetPostId: string, likerId: UserId): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM like_records WHERE target_post_id = ? AND liker_id = ?')
    .get(targetPostId, Buffer.from(likerId));
  return row !== undefined;
}

/**
 * Lifetime like count for a live post — feeds post-lock vesting and the API
 * `likeCount`. Records die with the post on prune, so a pruned post counts
 * zero by construction.
 */
export function getLikeRecordCount(postId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS cnt FROM like_records WHERE target_post_id = ?')
    .get(postId) as { cnt: number };
  return row.cnt;
}

/**
 * Delete every like-record for the given posts — prune settlement only.
 *
 * While a block journal is open, captures every deleted row (all three
 * columns) as a `likeRecordDeletions` side-record BEFORE deleting, so a
 * reverted prune restores the subtree's records exactly (inverse:
 * `restoreLikeRecord`). Capture order is pinned by the primary key so the
 * journal bytes are a function of state, not of SQLite's row order.
 */
export function deleteLikeRecordsForPosts(postIds: string[]): void {
  if (postIds.length === 0) return;
  const db = getDb();
  const placeholders = postIds.map(() => '?').join(', ');
  if (isBlockJournalOpen()) {
    const rows = db
      .prepare(
        `SELECT target_post_id, liker_id, applied_at_block FROM like_records
         WHERE target_post_id IN (${placeholders})
         ORDER BY target_post_id, liker_id`,
      )
      .all(...postIds) as Array<{
        target_post_id: string;
        liker_id: Buffer;
        applied_at_block: number;
      }>;
    recordLikeRecordDeletions(
      rows.map((r) => ({
        targetPostId: r.target_post_id,
        likerId: new Uint8Array(r.liker_id),
        appliedAtBlock: r.applied_at_block,
      })),
    );
  }
  db.prepare(
    `DELETE FROM like_records WHERE target_post_id IN (${placeholders})`,
  ).run(...postIds);
}

/**
 * Remove one like-record — fork-rollback inverse of `insertLikeRecord`.
 * Never records to the block journal.
 */
export function deleteLikeRecord(targetPostId: string, likerId: UserId): void {
  getDb()
    .prepare('DELETE FROM like_records WHERE target_post_id = ? AND liker_id = ?')
    .run(targetPostId, Buffer.from(likerId));
}

/**
 * Re-insert a deleted like-record with its original applied height —
 * fork-rollback inverse of one `likeRecordDeletions` entry. Never records to
 * the block journal.
 *
 * Plain INSERT, deliberately: when a revert replays, the row must be absent,
 * so a primary-key collision here is a rollback-ordering bug and should
 * throw rather than be papered over by OR REPLACE.
 */
export function restoreLikeRecord(
  targetPostId: string,
  likerId: UserId,
  appliedAtBlock: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO like_records (target_post_id, liker_id, applied_at_block)
       VALUES (?, ?, ?)`,
    )
    .run(targetPostId, Buffer.from(likerId), appliedAtBlock);
}
