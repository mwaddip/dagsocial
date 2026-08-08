import type { UserId } from '@dagsocial/types';
import { getDb } from './db.js';
import {
  isBlockJournalOpen,
  recordLikeRecordInsertion,
  recordLikeRecordDeletions,
} from './journal.js';

// ---------------------------------------------------------------------------
// Like-records (P2-D — NODE_INTERFACE "Like-records")
//
// `(liker, targetPostId)` pairs written ONLY at block application, never by
// an HTTP route. Content-layer consensus state, the `block_topology` tier:
// deterministic by replay, journalled with exact inverses, not in the
// `stateRoot`. Records die with the post on prune and survive withdraw.
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
