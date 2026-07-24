import { getDb } from './db.js';

/**
 * Insert or replace a challenge for a user.
 * Upsert: deletes any existing challenge for the userId, then inserts.
 */
export function createChallenge(
  userId: Uint8Array,
  challenge: Uint8Array,
  expiresAtBlock: number,
): void {
  const db = getDb();
  const userIdBuf = Buffer.from(userId);
  // Upsert: delete existing then insert
  db.prepare('DELETE FROM challenges WHERE user_id = ?').run(userIdBuf);
  db.prepare(
    'INSERT INTO challenges (user_id, challenge, expires_at_block) VALUES (?, ?, ?)',
  ).run(userIdBuf, Buffer.from(challenge), expiresAtBlock);
}

/**
 * Retrieve the active challenge for a userId.
 * Returns null if no challenge exists.
 */
export function getActiveChallenge(
  userId: Uint8Array,
): { challenge: Uint8Array; expiresAtBlock: number; userId: Uint8Array } | null {
  const row = getDb()
    .prepare(
      'SELECT user_id, challenge, expires_at_block FROM challenges WHERE user_id = ?',
    )
    .get(Buffer.from(userId)) as
    | { user_id: Buffer; challenge: Buffer; expires_at_block: number }
    | undefined;

  if (!row) return null;

  return {
    userId: new Uint8Array(row.user_id),
    challenge: new Uint8Array(row.challenge),
    expiresAtBlock: row.expires_at_block,
  };
}

/**
 * Delete a challenge, verifying the challenge bytes match what is stored.
 * Throws if no challenge exists for userId or if the bytes don't match.
 */
export function consumeChallenge(
  userId: Uint8Array,
  challenge: Uint8Array,
): void {
  const db = getDb();
  const userIdBuf = Buffer.from(userId);
  const row = db
    .prepare(
      'SELECT challenge FROM challenges WHERE user_id = ?',
    )
    .get(userIdBuf) as { challenge: Buffer } | undefined;

  if (!row) {
    throw new Error(
      `consumeChallenge: no challenge found for userId ${Buffer.from(userId).toString('hex')}`,
    );
  }

  const stored = new Uint8Array(row.challenge);
  if (stored.length !== challenge.length) {
    throw new Error(
      `consumeChallenge: challenge bytes mismatch for userId ${Buffer.from(userId).toString('hex')}`,
    );
  }
  for (let i = 0; i < stored.length; i++) {
    if (stored[i] !== challenge[i]) {
      throw new Error(
        `consumeChallenge: challenge bytes mismatch for userId ${Buffer.from(userId).toString('hex')}`,
      );
    }
  }

  db.prepare('DELETE FROM challenges WHERE user_id = ?').run(userIdBuf);
}
