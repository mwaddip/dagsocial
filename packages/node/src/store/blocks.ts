import { createHash } from 'crypto';
import { getDb } from './db.js';
import { getPendingPosts, confirmPost } from './posts.js';
import { config } from '../config.js';
import type { Block } from '@dagsocial/types';

export function createBlock(): Block | null {
  const db = getDb();
  const posts = getPendingPosts(config.block.maxPostsPerBlock);
  if (posts.length === 0) return null;

  const postIds = posts.map(p => p.id);
  // Node.js v22 lacks blake2b256; use blake2b512 truncated to 32 bytes
  const hash = createHash('blake2b512')
    .update(postIds.join(''))
    .update(String(Date.now()))
    .digest()
    .subarray(0, 32)
    .toString('hex');

  const now = Date.now();
  const result = db.prepare(
    'INSERT INTO blocks (hash, post_count, created_at) VALUES (?, ?, ?)'
  ).run(hash, posts.length, now);

  const height = Number(result.lastInsertRowid);

  for (let i = 0; i < posts.length; i++) {
    const postId = postIds[i]!;
    db.prepare(
      'INSERT INTO block_posts (block_height, post_id, position) VALUES (?, ?, ?)'
    ).run(height, postId, i);
    confirmPost(postId, height);
  }

  return { height, hash, postIds, postCount: posts.length, createdAt: now };
}

export function getBlock(height: number): Block | null {
  const db = getDb();
  const blockRow = db.prepare(
    'SELECT height, hash, post_count, created_at FROM blocks WHERE height = ?'
  ).get(height) as Record<string, unknown> | undefined;
  if (!blockRow) return null;

  const postRows = db.prepare(
    'SELECT post_id FROM block_posts WHERE block_height = ? ORDER BY position'
  ).all(height) as { post_id: string }[];

  return {
    height: blockRow['height'] as number,
    hash: blockRow['hash'] as string,
    postCount: blockRow['post_count'] as number,
    postIds: postRows.map(r => r.post_id),
    createdAt: blockRow['created_at'] as number,
  };
}

export function getCurrentHeight(): number {
  const row = getDb().prepare('SELECT COALESCE(MAX(height), 0) as h FROM blocks').get() as { h: number };
  return row.h;
}
