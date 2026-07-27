import type { PostStore } from '../store/post-store.js';
import { getDb } from '../store/db.js';
import { getParentRefs } from '../store/posts.js';
import { getReorgFloor } from '../store/meta.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DagReorgPlan {
  /** Common ancestor of old and new tips. null = no common ancestor found. */
  forkPoint: string | null;
  /** Post IDs to remove from canonical branch (in descending depth order). */
  toUnconfirm: string[];
  /** Post IDs to add to canonical branch (forkPoint+1 .. newTip). */
  toConfirm: string[];
}

export interface CanonicalTip {
  postId: string;
  score: number;
  depth: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum DAG walk steps to prevent runaway traversal. */
const MAX_ANCESTOR_WALK = 1000;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DagService {
  constructor(private store: PostStore) {}

  // -----------------------------------------------------------------------
  // Scoring
  // -----------------------------------------------------------------------

  /**
   * Compute the cumulative score for a new post.
   * score = parent_cumulative_score + own_work
   */
  computeScore(_postId: string, parentScore: number, ownWork: number): number {
    return parentScore + ownWork;
  }

  /**
   * Store a cumulative score for a post. Idempotent (overwrites on conflict).
   */
  saveScore(postId: string, score: number): void {
    const db = getDb();
    db.prepare(
      'INSERT OR REPLACE INTO post_scores (post_id, cumulative_score) VALUES (?, ?)',
    ).run(postId, score);
  }

  /**
   * Retrieve the cached cumulative score for a post.
   * Returns null if not yet scored.
   */
  getScore(postId: string): number | null {
    const db = getDb();
    const row = db
      .prepare('SELECT cumulative_score FROM post_scores WHERE post_id = ?')
      .get(postId) as { cumulative_score: number } | undefined;
    return row ? row.cumulative_score : null;
  }

  // -----------------------------------------------------------------------
  // Canonical branch queries
  // -----------------------------------------------------------------------

  /**
   * Return the current canonical tip (highest depth entry).
   */
  getCurrentTip(): CanonicalTip | null {
    const db = getDb();
    const branchRow = db
      .prepare(
        'SELECT depth, post_id FROM canonical_branch ORDER BY depth DESC LIMIT 1',
      )
      .get() as { depth: number; post_id: string } | undefined;
    if (!branchRow) return null;

    const score = this.getScore(branchRow.post_id);
    return {
      postId: branchRow.post_id,
      score: score ?? 0,
      depth: branchRow.depth,
    };
  }

  /**
   * Get the canonical depth of a post, or null if not on the canonical branch.
   */
  getCanonicalDepth(postId: string): number | null {
    const db = getDb();
    const row = db
      .prepare('SELECT depth FROM canonical_branch WHERE post_id = ?')
      .get(postId) as { depth: number } | undefined;
    return row ? row.depth : null;
  }

  /**
   * Get all canonical branch entries above a given depth (exclusive),
   * in descending depth order.
   */
  private getBranchAbove(depth: number): string[] {
    const db = getDb();
    const rows = db
      .prepare(
        'SELECT post_id FROM canonical_branch WHERE depth > ? ORDER BY depth DESC',
      )
      .all(depth) as Array<{ post_id: string }>;
    return rows.map((r) => r.post_id);
  }

  // -----------------------------------------------------------------------
  // DAG traversal
  // -----------------------------------------------------------------------

  /**
   * Collect all ancestors of a post by walking parent references.
   * Returns a Set of post IDs.
   */
  private collectAncestors(startId: string, maxSteps: number = MAX_ANCESTOR_WALK): Set<string> {
    const ancestors = new Set<string>();
    const queue: string[] = [startId];
    let steps = 0;

    while (queue.length > 0 && steps < maxSteps) {
      const current = queue.shift()!;
      if (ancestors.has(current)) continue;
      ancestors.add(current);
      steps++;

      const parents = getParentRefs(current);
      for (const parentId of parents) {
        if (!ancestors.has(parentId)) {
          queue.push(parentId);
        }
      }
    }

    return ancestors;
  }

  /**
   * Find the common ancestor of two DAG tips by walking parent references
   * backward from both tips.
   *
   * Returns the fork point (common ancestor closest to newTip), or null
   * if no common ancestor is found (disconnected DAGs) or the walk limit
   * is exceeded.
   */
  findForkPoint(oldTip: string, newTip: string): string | null {
    // Collect all ancestors of oldTip
    const oldAncestors = this.collectAncestors(oldTip);

    // Walk from newTip backward, find first ancestor in the oldTip set.
    // BFS ensures we find the common ancestor closest to newTip.
    const visited = new Set<string>();
    const queue: string[] = [newTip];
    let steps = 0;

    while (queue.length > 0 && steps < MAX_ANCESTOR_WALK) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      steps++;

      if (oldAncestors.has(current)) {
        return current; // first match = closest to newTip
      }

      const parents = getParentRefs(current);
      for (const parentId of parents) {
        if (!visited.has(parentId)) {
          queue.push(parentId);
        }
      }
    }

    return null; // no common ancestor within walk limit
  }

  /**
   * Walk from startId back to ancestorId using BFS over ALL parent references.
   * Returns post IDs from ancestor (exclusive) to startId (inclusive),
   * in ascending order (ancestor's child first).
   *
   * Uses BFS (shortest path) for consistency with findForkPoint, which also
   * explores all parent edges. Following only parents[0] would miss the fork
   * point for multi-parent posts.
   */
  private walkToAncestor(startId: string, ancestorId: string): string[] {
    if (startId === ancestorId) return [];

    const visited = new Set<string>();
    // parentId -> childId: reverse edge so we can reconstruct the path
    // from ancestorId forward (through children) to startId.
    const childMap = new Map<string, string>();
    const queue: string[] = [startId];
    visited.add(startId);
    let steps = 0;

    while (queue.length > 0 && steps < MAX_ANCESTOR_WALK) {
      const current = queue.shift()!;
      steps++;

      if (current === ancestorId) {
        // Reconstruct path from ancestorId to startId (forward in DAG)
        const path: string[] = [];
        let node = ancestorId;
        while (node !== startId) {
          const child = childMap.get(node)!;
          path.push(child);
          node = child;
        }
        // path is already [ancestor's child, ..., startId] — ascending order
        return path;
      }

      const parents = getParentRefs(current);
      for (const parentId of parents) {
        if (!visited.has(parentId)) {
          visited.add(parentId);
          childMap.set(parentId, current); // record parent->child edge
          queue.push(parentId);
        }
      }
    }

    return []; // walk failed
  }

  // -----------------------------------------------------------------------
  // Reorg planning
  // -----------------------------------------------------------------------

  /**
   * Build a reorg plan: which posts to remove from the canonical branch
   * and which posts to add, given a new branch with a potentially higher
   * cumulative score.
   *
   * Strictly greater score wins. Equal score = no reorg (first-seen wins).
   *
   * Returns null if no reorg is needed (new score not higher, no fork
   * point found, or branch walk fails).
   */
  buildReorgPlan(newTipId: string, newTipScore: number): DagReorgPlan | null {
    const currentTip = this.getCurrentTip();
    if (!currentTip) {
      // No canonical branch yet — this is the first tip.
      // Build a plan that inserts the full path from genesis to newTip.
      return this.buildInitialPlan(newTipId);
    }

    // Strictly greater score required
    if (newTipScore <= currentTip.score) {
      return null;
    }

    // Find common ancestor
    const forkPoint = this.findForkPoint(currentTip.postId, newTipId);
    if (!forkPoint) {
      return null;
    }

    const forkDepth = this.getCanonicalDepth(forkPoint);
    if (forkDepth === null) {
      // Fork point exists in the DAG but isn't on our canonical branch.
      // This shouldn't happen normally — the current canonical tip is
      // always an ancestor of itself.  If it does, treat as no-reorg.
      return null;
    }

    // Reorg floor: reject reorgs below the floor depth
    const floor = getReorgFloor();
    if (forkDepth < floor) {
      return null;
    }

    // Posts to remove: current canonical branch above fork point
    const toUnconfirm = this.getBranchAbove(forkDepth);

    // Posts to add: walk from newTip back to fork point
    const toConfirm = this.walkToAncestor(newTipId, forkPoint);
    if (toConfirm.length === 0 && newTipId !== forkPoint) {
      return null; // walk failed
    }

    return { forkPoint, toUnconfirm, toConfirm };
  }

  /**
   * Build a reorg plan for the initial tip (no canonical branch exists yet).
   */
  private buildInitialPlan(newTipId: string): DagReorgPlan | null {
    // Walk from newTip back to genesis (post with no parents).
    // Collect all posts along the first-parent path.
    const toConfirm = this.walkToGenesis(newTipId);
    if (toConfirm.length === 0) return null;

    // Also save scores for all confirmed posts (they're all new)
    return { forkPoint: null, toUnconfirm: [], toConfirm };
  }

  /**
   * Walk from startId back to a genesis post (one with empty parentRefs),
   * using BFS over ALL parent references. Returns posts in ascending
   * order (genesis child first, startId last).
   */
  private walkToGenesis(startId: string): string[] {
    const visited = new Set<string>();
    // parentId -> childId: reverse edge for path reconstruction
    const childMap = new Map<string, string>();
    const queue: string[] = [startId];
    visited.add(startId);
    let steps = 0;

    while (queue.length > 0 && steps < MAX_ANCESTOR_WALK) {
      const current = queue.shift()!;
      steps++;

      const parents = getParentRefs(current);
      if (parents.length === 0) {
        // Found genesis — reconstruct path from genesis to startId
        // Include genesis itself (unlike walkToAncestor which excludes the endpoint)
        const path: string[] = [current]; // genesis
        let node = current;
        while (node !== startId) {
          const child = childMap.get(node)!;
          path.push(child);
          node = child;
        }
        // path is [genesis, genesisChild, ..., startId] — ascending order
        return path;
      }

      for (const parentId of parents) {
        if (!visited.has(parentId)) {
          visited.add(parentId);
          childMap.set(parentId, current); // record parent->child edge
          queue.push(parentId);
        }
      }
    }

    return [];
  }

  // -----------------------------------------------------------------------
  // Branch switching
  // -----------------------------------------------------------------------

  /**
   * Switch the canonical branch atomically.
   *
   * Either the in-memory view AND the store both switch, or neither does.
   * The canonical_branch table is updated inside a single transaction:
   *   1. Remove old branch entries above the fork point
   *   2. Insert new branch entries starting at forkDepth + 1
   *   3. Update dag_tip_hash in dag_meta
   *
   * If forkPoint is null (initial plan), the entire branch is inserted from
   * depth 0.
   */
  switchToBranch(plan: DagReorgPlan): void {
    const db = getDb();

    db.transaction(() => {
      if (plan.forkPoint !== null) {
        // Reorg: unwind above fork point, then insert new branch
        const forkDepth = this.getCanonicalDepth(plan.forkPoint);
        if (forkDepth === null) {
          throw new Error(
            `Fork point ${plan.forkPoint} not found in canonical_branch`,
          );
        }

        // 1. Remove old branch entries above fork point
        db.prepare('DELETE FROM canonical_branch WHERE depth > ?').run(forkDepth);

        // 2. Insert new branch entries
        const insertStmt = db.prepare(
          'INSERT OR REPLACE INTO canonical_branch (depth, post_id) VALUES (?, ?)',
        );
        for (let i = 0; i < plan.toConfirm.length; i++) {
          insertStmt.run(forkDepth + 1 + i, plan.toConfirm[i]!);
        }

        // 3. Update dag_tip_hash
        // When toConfirm is empty (newTipId === forkPoint), the fork point
        // becomes the new tip — we're truncating the branch.
        const newTip =
          plan.toConfirm.length > 0
            ? plan.toConfirm[plan.toConfirm.length - 1]!
            : plan.forkPoint!;
        db.prepare(
          'INSERT OR REPLACE INTO dag_meta (key, value) VALUES (?, ?)',
        ).run('dag_tip_hash', Buffer.from(newTip, 'hex'));
      } else {
        // Initial plan: insert from depth 0
        // First, clear any existing entries (shouldn't be any, but be safe)
        db.prepare('DELETE FROM canonical_branch').run();

        const insertStmt = db.prepare(
          'INSERT OR REPLACE INTO canonical_branch (depth, post_id) VALUES (?, ?)',
        );
        for (let i = 0; i < plan.toConfirm.length; i++) {
          insertStmt.run(i, plan.toConfirm[i]!);
        }

        // Update dag_tip_hash
        const newTip = plan.toConfirm[plan.toConfirm.length - 1]!;
        db.prepare(
          'INSERT OR REPLACE INTO dag_meta (key, value) VALUES (?, ?)',
        ).run('dag_tip_hash', Buffer.from(newTip, 'hex'));
      }
    })();
  }
}
