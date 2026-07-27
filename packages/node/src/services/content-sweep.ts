import { verifyPostId } from '@dagsocial/types';
import { encodePost } from '@dagsocial/types';
import type { Post } from '@dagsocial/types';
import type { NetNode } from '@dagsocial/net';
import { verifyPostForRelay, type VerifierDeps } from './verifier.js';
import { insertPost } from '../store/posts.js';
import { getDb } from '../store/db.js';

export interface SweepResult {
  success: boolean;
  remaining: number;
}

const BATCH_SIZE = 50;
const MAX_PEERS_PER_BATCH = 3;
const DEFAULT_MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;

/** Check if any placeholder posts exist (content is empty, status is pending). */
export function hasPlaceholders(): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as count FROM dag_posts WHERE status = 'pending' AND content = ''")
    .get() as { count: number } | undefined;
  return (row?.count ?? 0) > 0;
}

function getPlaceholderIds(): string[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT id FROM dag_posts WHERE status = 'pending' AND content = ''")
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch missing post content from peers after block sync.
 *
 * Scans dag_posts for placeholders (content='', status='pending') and
 * requests the actual content from connected peers. Retries with
 * exponential backoff until all placeholders are resolved or maxRetries
 * is exhausted.
 */
export async function sweepPlaceholders(
  net: NetNode,
  deps: VerifierDeps,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): Promise<SweepResult> {
  let retries = 0;

  while (retries < maxRetries) {
    const placeholderIds = getPlaceholderIds();
    if (placeholderIds.length === 0) {
      return { success: true, remaining: 0 };
    }

    const peerIds = net.getConnectedPeers();
    if (peerIds.length === 0) {
      // No peers to request from — return early, will retry on next
      // peer connection trigger.
      return { success: false, remaining: placeholderIds.length };
    }

    const batches = chunk(placeholderIds, BATCH_SIZE);
    for (const batch of batches) {
      // Pick up to MAX_PEERS_PER_BATCH random peers
      const selected = peerIds.slice(0, MAX_PEERS_PER_BATCH);
      const results = await Promise.all(
        selected.map((peerId) =>
          net.requestPosts(peerId, batch).catch(() => ({ entries: [] })),
        ),
      );

      const seen = new Set<string>();
      for (const response of results) {
        for (const entry of response.entries) {
          // Avoid processing the same post twice from different peers
          if (seen.has(entry.postId)) continue;
          seen.add(entry.postId);

          // Verify post ID matches claimed ID
          if (!verifyPostId(entry.post, entry.postId)) {
            console.warn(
              `[content-sweep] post ID mismatch for claimed ${entry.postId}, dropping`,
            );
            continue;
          }

          // Verify post structure, PoW, signature
          const result = verifyPostForRelay(deps, entry.post, 0);
          if (!result.valid) {
            console.warn(
              `[content-sweep] post validation failed for ${entry.postId}: ${result.error}`,
            );
            continue;
          }

          // Insert — upgrades placeholder to real content
          insertPost(entry.post, encodePost(entry.post));
        }
      }
    }

    const remaining = getPlaceholderIds().length;
    if (remaining === 0) {
      return { success: true, remaining: 0 };
    }

    retries++;
    if (retries < maxRetries) {
      await sleep(BASE_DELAY_MS * retries); // 2s, 4s, 8s, ...
    }
  }

  const remaining = getPlaceholderIds().length;
  return { success: false, remaining };
}
