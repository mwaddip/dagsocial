import { getDb } from './db.js';

/**
 * Insert a new identity row.
 * Throws on duplicate userId (SQLite PRIMARY KEY violation).
 */
export function insertIdentity(userId: string, publicKey: Uint8Array): void {
  getDb()
    .prepare('INSERT INTO identities (user_id, public_key) VALUES (?, ?)')
    .run(userId, Buffer.from(publicKey));
}

/**
 * Retrieve an identity by userId.
 * Returns null if not found.
 * publicKey is 32 raw bytes (Uint8Array).
 */
export function getIdentity(
  userId: string,
): { userId: string; publicKey: Uint8Array; createdAt: number } | null {
  const row = getDb()
    .prepare('SELECT user_id, public_key, created_at FROM identities WHERE user_id = ?')
    .get(userId) as { user_id: string; public_key: Buffer; created_at: number } | undefined;

  if (!row) return null;

  return {
    userId: row.user_id,
    publicKey: new Uint8Array(row.public_key),
    createdAt: row.created_at,
  };
}
