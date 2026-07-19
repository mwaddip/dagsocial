import { getDb } from './db.js';
import type { KeyPair } from '@dagsocial/types';

export function insertIdentity(userId: string, keyPair: KeyPair): void {
  getDb().prepare(
    `INSERT INTO identities (user_id, public_key, secret_key, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(userId, Buffer.from(keyPair.publicKey), Buffer.from(keyPair.secretKey), Date.now());
}

export function getIdentity(userId: string): { userId: string; publicKey: string; createdAt: number } | null {
  const row = getDb().prepare(
    'SELECT user_id, public_key, created_at FROM identities WHERE user_id = ?'
  ).get(userId) as { user_id: string; public_key: Buffer; created_at: number } | undefined;
  if (!row) return null;
  return {
    userId: row.user_id,
    publicKey: Buffer.from(row.public_key).toString('hex'),
    createdAt: row.created_at,
  };
}
