import { uid } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  createHash,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  computeBoxId,
  computePostId,
  encodePost,
  decodeTx,
  LIKE_COST,
  LIKE_THRESHOLD,
  LIKE_FREE_THRESHOLD,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { KarmaBox, LikeBox, Post } from '@dagsocial/types';
import Database from 'better-sqlite3';

import {
  initDb,
  closeDb,
  getDb,
  getBox,
  getKarmaBox,
  insertBox,
  insertPost,
  insertIdentity,
  getPost as storeGetPost,
  getPendingEntries,
} from '../../src/store/index.js';
import { castLike } from '../../src/services/likes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract raw 32-byte Ed25519 public key from SPKI DER KeyObject. */
function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

/** Create and insert a karma box. */
function createKarmaBox(
  owner: Uint8Array,
  value: number,
  createdAtBlock: number,
): KarmaBox {
  const box: Omit<KarmaBox, 'id'> & { id?: string } = {
    boxType: 'karma',
    value,
    createdAtBlock,
    owner,
    guard: 'owner_signature',
    proofSource: 'test',
    lastTouchBlock: createdAtBlock,
  };
  const id = computeBoxId(box);
  const full: KarmaBox = { ...box, id, boxType: 'karma', guard: 'owner_signature' };
  insertBox(full);
  return full;
}

/** Create and insert a minimal test post. Returns the post ID. */
function createTestPost(authorId: Uint8Array): string {
  const post: Post = {
    content: 'Test post',
    author: authorId,
    parentRefs: [],
    challenge: new Uint8Array(32).fill(0xcc),
    powNonce: 0,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: Date.now(),
    signature: new Uint8Array(64),
  };
  const postId = computePostId(post);
  insertPost(post, encodePost(post));
  return postId;
}

/** Insert a locked like box directly (for pre-populating likes to reach free threshold). */
function insertLockedLikeBox(
  likerId: Uint8Array,
  targetPostId: string,
  createdAtBlock: number,
): string {
  const box: Omit<LikeBox, 'id'> & { id?: string } = {
    boxType: 'like',
    value: LIKE_COST,
    createdAtBlock,
    likerId,
    targetPostId,
    guard: 'epoch_tally',
  };
  const id = computeBoxId(box);
  insertBox({ ...box, id, boxType: 'like', guard: 'epoch_tally' } as LikeBox);
  return id;
}

/** Generate a unique user ID for each fake liker (for free threshold population). */
function fakeUserId(index: number): Uint8Array {
  const { publicKey } = generateKeyPairSync('ed25519');
  return rawPublicKey(publicKey);
}

/** Sign a castLike message for locked likes. */
function signCastLike(
  targetPostId: string,
  likerId: Uint8Array,
  privKey: KeyObject,
): Uint8Array {
  const likerIdHex = Buffer.from(likerId).toString('hex');
  const signData = JSON.stringify({ targetPostId, likerId: likerIdHex });
  const hash = createHash('blake2b512').update(signData).digest().subarray(0, 32);
  return new Uint8Array(cryptoSign(null, hash, privKey));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('likes service', () => {
  let db: Database.Database;
  let likerPubKey: Uint8Array;
  let likerPrivKey: KeyObject;
  let likerId: Uint8Array;

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();

    const likerKeys = generateKeyPairSync('ed25519');
    likerPubKey = rawPublicKey(likerKeys.publicKey);
    likerPrivKey = likerKeys.privateKey;
    likerId = likerPubKey;
    insertIdentity(likerId, likerPubKey);
  });

  afterEach(() => {
    closeDb();
  });

  // -----------------------------------------------------------------------
  // 1. castLike locked case returns pending
  // -----------------------------------------------------------------------
  it('castLike locked case returns pending', () => {
    createKarmaBox(likerPubKey, 100, 1);
    const postId = createTestPost(likerId);

    const signature = signCastLike(postId, likerId, likerPrivKey);
    const result = castLike(postId, likerId, signature, 5);

    expect(result.castLikeResult).toBe('pending');
    expect(result.txId).toBeDefined();
    expect(typeof result.txId).toBe('string');
    expect(result.expiresAtHeight).toBe(5 + 720);
  });

  // -----------------------------------------------------------------------
  // 2. castLike locked case inserts transaction into mempool
  // -----------------------------------------------------------------------
  it('castLike locked case inserts transaction into mempool', () => {
    createKarmaBox(likerPubKey, 100, 1);
    const postId = createTestPost(likerId);

    const signature = signCastLike(postId, likerId, likerPrivKey);
    const result = castLike(postId, likerId, signature, 5);

    // Verify mempool has the entry
    const entries = getPendingEntries(100);
    const matching = entries.filter((e) => {
      if (e.entryType !== 'utxo_tx' || !e.utxoTxCbor) return false;
      const tx = decodeTx(e.utxoTxCbor);
      // Check the tx contains a like box output for our target post
      return tx.outputs.some(
        (o) => o.boxType === 'like' && (o as LikeBox).targetPostId === postId,
      );
    });
    expect(matching.length).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 3. castLike free case still works (no UTXO, direct dag_likes insert)
  // -----------------------------------------------------------------------
  it('castLike free case when at/above free threshold', () => {
    createKarmaBox(likerPubKey, 100, 1);
    const postId = createTestPost(likerId);

    // Pre-populate 50 locked likes (free threshold)
    const freeThreshold = LIKE_FREE_THRESHOLD * LIKE_THRESHOLD; // 50
    for (let i = 0; i < freeThreshold; i++) {
      const fakeId = fakeUserId(i);
      insertLockedLikeBox(fakeId, postId, 1);
    }

    const signature = signCastLike(postId, likerId, likerPrivKey);
    const result = castLike(postId, likerId, signature, 5);

    expect(result.castLikeResult).toBe('free');
    expect(result.likeId).toBeDefined();
    expect(typeof result.likeId).toBe('string');
  });

  // -----------------------------------------------------------------------
  // 4. castLike free like does not lock karma
  // -----------------------------------------------------------------------
  it('castLike free like does not lock karma', () => {
    createKarmaBox(likerPubKey, 100, 1);
    const postId = createTestPost(likerId);

    // Pre-populate to reach free threshold
    const freeThreshold = LIKE_FREE_THRESHOLD * LIKE_THRESHOLD;
    for (let i = 0; i < freeThreshold; i++) {
      insertLockedLikeBox(fakeUserId(i), postId, 1);
    }

    const signature = signCastLike(postId, likerId, likerPrivKey);
    castLike(postId, likerId, signature, 5);

    // Karma should be unchanged (free like)
    const karmaBox = getKarmaBox(likerPubKey);
    expect(karmaBox).not.toBeNull();
    expect(karmaBox!.value).toBe(100); // unchanged
  });

  // -----------------------------------------------------------------------
  // 5. castLike fails if post unknown
  // -----------------------------------------------------------------------
  it('castLike fails if post unknown', () => {
    createKarmaBox(likerPubKey, 100, 1);

    const signature = signCastLike('nonexistent', likerId, likerPrivKey);
    expect(() =>
      castLike('nonexistent', likerId, signature, 5),
    ).toThrow('Post not found');
  });

  // -----------------------------------------------------------------------
  // 6. castLike fails if already liked (via DB)
  // -----------------------------------------------------------------------
  it('castLike fails if already liked (via DB)', () => {
    createKarmaBox(likerPubKey, 100, 1);
    const postId = createTestPost(likerId);

    // Insert a like box directly (simulates confirmed like)
    insertLockedLikeBox(likerId, postId, 1);

    const signature = signCastLike(postId, likerId, likerPrivKey);
    expect(() =>
      castLike(postId, likerId, signature, 5),
    ).toThrow('Already liked');
  });

  // -----------------------------------------------------------------------
  // 7. castLike fails if already liked (via mempool — duplicate pending)
  // -----------------------------------------------------------------------
  it('castLike fails if already liked (via mempool)', () => {
    createKarmaBox(likerPubKey, 100, 1);
    const postId = createTestPost(likerId);

    const signature = signCastLike(postId, likerId, likerPrivKey);
    // First like → pending
    castLike(postId, likerId, signature, 5);

    // Second like with same params → should detect pending and throw
    expect(() =>
      castLike(postId, likerId, signature, 5),
    ).toThrow('Already liked');
  });

  // -----------------------------------------------------------------------
  // 8. castLike fails if insufficient karma (locked)
  // -----------------------------------------------------------------------
  it('castLike fails if insufficient karma (locked)', () => {
    createKarmaBox(likerPubKey, 1, 1); // Only 1 karma, need 2
    const postId = createTestPost(likerId);

    const signature = signCastLike(postId, likerId, likerPrivKey);
    expect(() =>
      castLike(postId, likerId, signature, 5),
    ).toThrow('Insufficient karma');
  });

  // -----------------------------------------------------------------------
  // 9. castLike fails if zero karma (free case)
  // -----------------------------------------------------------------------
  it('castLike fails if zero karma (free case)', () => {
    createKarmaBox(likerPubKey, 0, 1); // Zero karma
    const postId = createTestPost(likerId);

    // Pre-populate to reach free threshold
    const freeThreshold = LIKE_FREE_THRESHOLD * LIKE_THRESHOLD;
    for (let i = 0; i < freeThreshold; i++) {
      insertLockedLikeBox(fakeUserId(i), postId, 1);
    }

    const signature = signCastLike(postId, likerId, likerPrivKey);
    expect(() =>
      castLike(postId, likerId, signature, 5),
    ).toThrow('Insufficient karma (need > 0 for free like)');
  });

  // -----------------------------------------------------------------------
  // 10. castLike pending does not change karma immediately
  // -----------------------------------------------------------------------
  it('castLike pending does not change karma immediately', () => {
    createKarmaBox(likerPubKey, 100, 1);
    const postId = createTestPost(likerId);

    const signature = signCastLike(postId, likerId, likerPrivKey);
    castLike(postId, likerId, signature, 5);

    // Karma should be unchanged (pending in mempool)
    const karmaBox = getKarmaBox(likerPubKey);
    expect(karmaBox).not.toBeNull();
    expect(karmaBox!.value).toBe(100); // unchanged — pending
  });
});
