import { getDb } from './db.js';
import type { Post } from '@dagsocial/types';

export function insertPendingPost(post: Post, rawCbor: Buffer): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO posts (id, content, author, slot_hash, pow_nonce, signature, status, created_at, raw_cbor)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(post.id, post.content, post.author, post.slotHash, post.powNonce, post.signature, post.timestamp, rawCbor);

  for (const parentId of post.parentRefs) {
    db.prepare('INSERT OR IGNORE INTO post_parents (post_id, parent_id) VALUES (?, ?)')
      .run(post.id, parentId);
  }
}

export function getPost(id: string): Post | null {
  const row = getDb().prepare(
    'SELECT id, content, author, slot_hash, pow_nonce, signature, status, block_height, created_at FROM posts WHERE id = ?'
  ).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToPost(row);
}

export function queryPosts(opts: { author?: string; limit: number; offset: number }): Post[] {
  let sql = "SELECT id, content, author, slot_hash, pow_nonce, signature, status, block_height, created_at FROM posts WHERE status = 'confirmed'";
  const params: unknown[] = [];
  if (opts.author) {
    sql += ' AND author = ?';
    params.push(opts.author);
  }
  sql += ' ORDER BY block_height DESC, created_at DESC LIMIT ? OFFSET ?';
  params.push(opts.limit, opts.offset);
  const rows = getDb().prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToPost);
}

function getParentRefs(postId: string): string[] {
  const rows = getDb().prepare(
    'SELECT parent_id FROM post_parents WHERE post_id = ? ORDER BY rowid'
  ).all(postId) as { parent_id: string }[];
  return rows.map(r => r.parent_id);
}

function rowToPost(row: Record<string, unknown>): Post {
  return {
    id: row['id'] as string,
    content: row['content'] as string,
    author: row['author'] as string,
    parentRefs: getParentRefs(row['id'] as string),
    slotHash: row['slot_hash'] as string,
    powNonce: row['pow_nonce'] as number,
    signature: row['signature'] as string,
    timestamp: row['created_at'] as number,
    status: row['status'] as 'pending' | 'confirmed',
    blockHeight: row['block_height'] as number | undefined,
  };
}

export function getPendingPosts(limit: number): Post[] {
  const rows = getDb().prepare(
    "SELECT id, content, author, slot_hash, pow_nonce, signature, status, block_height, created_at FROM posts WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?"
  ).all(limit) as Record<string, unknown>[];
  return rows.map(rowToPost);
}

export function confirmPost(postId: string, blockHeight: number): void {
  getDb().prepare(
    "UPDATE posts SET status = 'confirmed', block_height = ? WHERE id = ?"
  ).run(blockHeight, postId);
}
