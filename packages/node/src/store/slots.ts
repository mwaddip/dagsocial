import { getDb } from './db.js';
import type { SlotToken } from '@dagsocial/types';

export function insertSlot(token: SlotToken, challenge: string): void {
  const db = getDb();
  db.prepare('UPDATE slots SET consumed = 1 WHERE user_id = ? AND consumed = 0')
    .run(token.userId);
  db.prepare(
    `INSERT OR REPLACE INTO slots (user_id, challenge, nonce, token_hash, issued_at, expires_at, consumed)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).run(token.userId, challenge, token.nonce, token.hash, token.issuedAtBlock, token.expiresAtBlock);
}

export function getValidSlot(userId: string, tokenHash: string): SlotToken | null {
  const row = getDb().prepare(
    'SELECT user_id, issued_at, expires_at, nonce, token_hash FROM slots WHERE user_id = ? AND token_hash = ? AND consumed = 0'
  ).get(userId, tokenHash) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    userId: row['user_id'] as string,
    issuedAtBlock: row['issued_at'] as number,
    expiresAtBlock: row['expires_at'] as number,
    nonce: row['nonce'] as number,
    hash: row['token_hash'] as string,
  };
}

export function consumeSlot(userId: string, tokenHash: string): void {
  getDb().prepare('UPDATE slots SET consumed = 1 WHERE user_id = ? AND token_hash = ?')
    .run(userId, tokenHash);
}
