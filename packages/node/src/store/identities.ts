import { getDb } from './db.js';

/**
 * Insert a new identity row.
 * userId IS the 32-byte Ed25519 public key.
 * Throws on duplicate (SQLite PRIMARY KEY violation).
 */
export function insertIdentity(userId: Uint8Array, publicKey: Uint8Array): void {
  getDb()
    .prepare('INSERT INTO identities (user_id, public_key) VALUES (?, ?)')
    .run(Buffer.from(userId), Buffer.from(publicKey));
}

/**
 * Retrieve an identity by userId (the public key itself).
 * Returns null if not found.
 */
export function getIdentity(
  userId: Uint8Array,
): { userId: Uint8Array; publicKey: Uint8Array; createdAt: number } | null {
  const row = getDb()
    .prepare('SELECT user_id, public_key, created_at FROM identities WHERE user_id = ?')
    .get(Buffer.from(userId)) as { user_id: Buffer; public_key: Buffer; created_at: number } | undefined;

  if (!row) return null;

  return {
    userId: new Uint8Array(row.user_id),
    publicKey: new Uint8Array(row.public_key),
    createdAt: row.created_at,
  };
}
