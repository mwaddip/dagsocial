import { getDb } from './db.js';

/**
 * Record a post's parent references at the block height where it was confirmed.
 * Idempotent — duplicate calls for the same postId are ignored.
 */
export function insertBlockTopology(
  postId: string,
  parentRefs: string[],
  blockHeight: number,
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO block_topology (post_id, parent_refs, block_height)
     VALUES (?, ?, ?)`,
  ).run(postId, JSON.stringify(parentRefs), blockHeight);
}

/**
 * Walk the DAG downward from rootPostId using the block_topology table.
 * Returns the set of all post IDs in the subtree rooted at rootPostId
 * (including rootPostId itself).
 */
export function getSubtreeTopology(rootPostId: string): Set<string> {
  const db = getDb();
  const rows = db.prepare(
    `WITH RECURSIVE subtree AS (
       SELECT post_id FROM block_topology WHERE post_id = ?
       UNION
       SELECT bt.post_id FROM block_topology bt
       JOIN subtree s ON EXISTS (
         SELECT 1 FROM json_each(bt.parent_refs) WHERE value = s.post_id
       )
     )
     SELECT DISTINCT post_id FROM subtree`,
  ).all(rootPostId) as Array<{ post_id: string }>;
  return new Set(rows.map(r => r.post_id));
}

/**
 * Delete all block_topology entries recorded at the given block height.
 * Called during fork resolution to roll back topology from reverted blocks.
 */
export function rollbackBlockTopology(blockHeight: number): void {
  const db = getDb();
  db.prepare(
    `DELETE FROM block_topology WHERE block_height = ?`,
  ).run(blockHeight);
}
