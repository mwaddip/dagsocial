import { createHash, randomBytes } from 'crypto';
import { verifyPoW } from './pow.js';
import { insertSlot } from '../store/slots.js';
import { getDb } from '../store/db.js';
import { config } from '../config.js';
import type { SlotToken } from '@dagsocial/types';

export function createSlotChallenge(userId: string): string {
  const salt = randomBytes(16).toString('hex');
  return createHash('blake2b512')
    .update(userId)
    .update(String(Date.now()))
    .update(salt)
    .digest('hex');
}

export function claimSlot(userId: string, challenge: string, nonce: number): SlotToken | null {
  if (!verifyPoW(challenge, nonce, config.pow.slotTargetBits)) {
    return null;
  }

  const db = getDb();
  const existing = db.prepare(
    'SELECT token_hash FROM slots WHERE user_id = ? AND challenge = ?'
  ).get(userId, challenge);
  if (existing) return null;

  const currentHeight = (db.prepare(
    'SELECT COALESCE(MAX(height), 0) as h FROM blocks'
  ).get() as { h: number }).h;

  const hash = createHash('blake2b512')
    .update(userId)
    .update(challenge)
    .update(String(nonce))
    .digest('hex');

  const token: SlotToken = {
    userId,
    issuedAtBlock: currentHeight,
    expiresAtBlock: currentHeight + config.pow.slotWindowBlocks,
    nonce,
    hash,
  };

  insertSlot(token, challenge);
  return token;
}
