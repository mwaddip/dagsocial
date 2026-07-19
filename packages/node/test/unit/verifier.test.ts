import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSign, createHash, generateKeyPairSync } from 'crypto';
import { initDb, getDb, closeDb } from '../../src/store/db.js';
import { insertSlot } from '../../src/store/slots.js';
import { verifyPost } from '../../src/services/verifier.js';
import { solvePoW } from '../../src/services/pow.js';
import { computePostId, signingHash } from '@dagsocial/types';
import type { Post, SlotToken } from '@dagsocial/types';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-verify.sqlite';

function signPost(post: Post, privateKey: Buffer): string {
  const hash = signingHash(post);
  const sign = createSign('SHA-256');
  sign.update(hash);
  sign.end();
  return sign.sign(privateKey).toString('base64');
}

function makeSlot(userId: string): SlotToken {
  const hash = createHash('blake2b512')
    .update(userId)
    .update('ch')
    .update('42')
    .digest()
    .subarray(0, 32)
    .toString('hex');
  return { userId, issuedAtBlock: 0, expiresAtBlock: 1000, nonce: 42, hash };
}

describe('verifier', () => {
  let userId: string;
  let privKeyDer: Buffer;

  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch {}
    initDb(TEST_DB);

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubDer = publicKey.export({ type: 'spki', format: 'der' });
    privKeyDer = privateKey.export({ type: 'pkcs8', format: 'der' });
    const pubKeyRaw = Buffer.from(pubDer.slice(pubDer.length - 32));
    userId = createHash('blake2b512')
      .update(pubKeyRaw)
      .digest()
      .subarray(0, 32)
      .toString('hex');

    // Insert identity so verifier can find public key
    getDb().prepare(
      'INSERT INTO identities (user_id, public_key, secret_key, created_at) VALUES (?, ?, ?, ?)'
    ).run(userId, pubKeyRaw, Buffer.from(privKeyDer), Date.now());
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('returns error for missing slot token', () => {
    const slot = makeSlot(userId);
    const post: Post = {
      id: computePostId({ content: 'x', author: userId, parentRefs: [], slotHash: slot.hash, powNonce: 0, timestamp: Date.now() }),
      content: 'x', author: userId, parentRefs: [], slotHash: slot.hash,
      powNonce: 0, timestamp: Date.now(), signature: '', status: 'pending',
    };
    const result = verifyPost(post, 0);
    expect(result.valid).toBe(false);
  });

  it('returns error for invalid signature', () => {
    const slot = makeSlot(userId);
    insertSlot(slot, 'challenge');

    const post: Post = {
      id: computePostId({ content: 'hello', author: userId, parentRefs: [], slotHash: slot.hash, powNonce: 0, timestamp: Date.now() }),
      content: 'hello', author: userId, parentRefs: [], slotHash: slot.hash,
      powNonce: 0, timestamp: Date.now(), signature: 'bad-signature', status: 'pending',
    };
    const result = verifyPost(post, 0);
    expect(result.valid).toBe(false);
  });
});
