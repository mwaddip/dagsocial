import {
  describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
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
  MEMPOOL_EXPIRY_BLOCKS,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { KarmaBox, LikeBox, Post, UtxoTransaction, AnyBox } from '@dagsocial/types';
import Database from 'better-sqlite3';

import {
  initDb,
  closeDb,
  getDb,
  getKarmaBox,
  insertBox,
  insertPost,
  getBox as storeGetBox,
  getBoxByProvenance as storeGetBoxByProvenance,
  getPendingEntries,
  insertMempoolSubBlock,
} from '../../src/store/index.js';
import { castLike } from '../../src/services/likes.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';
import {
  fixtureProvenance, rawPublicKey, signTransaction } from '../helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create and insert a karma box. */
function createKarmaBox(
  owner: Uint8Array,
  value: bigint,
  seed: number,
): KarmaBox {
  const box: Omit<KarmaBox, 'id'> & { id?: string } = {
    boxType: 'karma',
    value,
    owner,
    guard: 'owner_signature',
    proofSource: 'test',
  };
  Object.assign(box, fixtureProvenance(box, seed));
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
  seed: number,
): string {
  const box: Omit<LikeBox, 'id'> & { id?: string } = {
    boxType: 'like',
    value: LIKE_COST,
    likerId,
    targetPostId,
    guard: 'epoch_tally',
  };
  Object.assign(box, fixtureProvenance(box, seed));
  const id = computeBoxId(box);
  insertBox({ ...box, id, boxType: 'like', guard: 'epoch_tally' } as LikeBox);
  return id;
}

/** Generate a unique user ID for each fake liker (for free threshold population). */
function fakeUserId(index: number): Uint8Array {
  const { publicKey } = generateKeyPairSync('ed25519');
  return rawPublicKey(publicKey);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('likes service', () => {
  let db: Database.Database;
  let likerPubKey: Uint8Array;
  let likerPrivKey: KeyObject;
  let likerPubKeyHex: string;
  let likerId: Uint8Array;

  function makeDeps(): UtxoEngineDeps {
    return {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db
          .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
          .get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
      getBoxByProvenance: storeGetBoxByProvenance,
      insertBox: (box: AnyBox) => {
        insertBox(box);
      },
      consumeBox: (id: string, atBlock: number) => {
        db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(atBlock, id);
      },
      getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
    };
  }

  let deps: UtxoEngineDeps;

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();

    const likerKeys = generateKeyPairSync('ed25519');
    likerPubKey = rawPublicKey(likerKeys.publicKey);
    likerPrivKey = likerKeys.privateKey;
    likerPubKeyHex = Buffer.from(likerPubKey).toString('hex');
    likerId = likerPubKey;
    deps = makeDeps();
  });

  afterEach(() => {
    closeDb();
  });

  // -----------------------------------------------------------------------
  // 1. castLike locked case returns pending
  // -----------------------------------------------------------------------
  it('castLike locked case returns pending', () => {
    const karma = createKarmaBox(likerPubKey, 100, 1);
    const postId = createTestPost(likerId);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 98n,
      owner: likerPubKey,
      guard: 'owner_signature',
      proofSource: `like:${postId}`,
    };
    Object.assign(newKarma, fixtureProvenance(newKarma, 1));
    const newKarmaId = computeBoxId(newKarma);
    const likeBox: LikeBox = {
      boxType: 'like',
      value: LIKE_COST,
      likerId,
      targetPostId: postId,
      guard: 'epoch_tally',
    };
    Object.assign(likeBox, fixtureProvenance(likeBox, 1));
    const likeBoxId = computeBoxId(likeBox);

    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { ...newKarma, id: newKarmaId },
        { ...likeBox, id: likeBoxId },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    signTransaction(tx, likerPrivKey, likerPubKeyHex);

    const result = castLike(deps, tx, 5);

    expect(result.castLikeResult).toBe('pending');
    expect(result.txId).toBeDefined();
    expect(typeof result.txId).toBe('string');
    expect(result.expiresAtHeight).toBe(5 + MEMPOOL_EXPIRY_BLOCKS);
  });

  // -----------------------------------------------------------------------
  // 2. castLike locked case inserts transaction into mempool
  // -----------------------------------------------------------------------
  it('castLike locked case inserts transaction into mempool', () => {
    const karma = createKarmaBox(likerPubKey, 100, 1);
    const postId = createTestPost(likerId);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 98n,
      owner: likerPubKey,
      guard: 'owner_signature',
      proofSource: `like:${postId}`,
    };
    Object.assign(newKarma, fixtureProvenance(newKarma, 1));
    const newKarmaId = computeBoxId(newKarma);
    const likeBox: LikeBox = {
      boxType: 'like',
      value: LIKE_COST,
      likerId,
      targetPostId: postId,
      guard: 'epoch_tally',
    };
    Object.assign(likeBox, fixtureProvenance(likeBox, 1));
    const likeBoxId = computeBoxId(likeBox);

    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { ...newKarma, id: newKarmaId },
        { ...likeBox, id: likeBoxId },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    signTransaction(tx, likerPrivKey, likerPubKeyHex);

    castLike(deps, tx, 5);

    // Verify mempool has the entry
    const entries = getPendingEntries(100);
    const matching = entries.filter((e) => {
      if (e.entryType !== 'utxo_tx' || !e.utxoTxCbor) return false;
      const storedTx = decodeTx(e.utxoTxCbor);
      return storedTx.outputs.some(
        (o) => o.boxType === 'like' && (o as LikeBox).targetPostId === postId,
      );
    });
    expect(matching.length).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 3. castLike rejects locked tx on post at free threshold
  // -----------------------------------------------------------------------
  it('castLike rejects locked tx on post at free threshold', () => {
    const karma = createKarmaBox(likerPubKey, 100, 1);
    const postId = createTestPost(likerId);

    // Pre-populate to reach free threshold
    const freeThreshold = LIKE_FREE_THRESHOLD * LIKE_THRESHOLD; // 50
    for (let i = 0; i < freeThreshold; i++) {
      const fakeId = fakeUserId(i);
      insertLockedLikeBox(fakeId, postId, 1);
    }

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 98n,
      owner: likerPubKey,
      guard: 'owner_signature',
      proofSource: `like:${postId}`,
    };
    Object.assign(newKarma, fixtureProvenance(newKarma, 1));
    const newKarmaId = computeBoxId(newKarma);
    const likeBox: LikeBox = {
      boxType: 'like',
      value: LIKE_COST,
      likerId,
      targetPostId: postId,
      guard: 'epoch_tally',
    };
    Object.assign(likeBox, fixtureProvenance(likeBox, 1));
    const likeBoxId = computeBoxId(likeBox);

    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { ...newKarma, id: newKarmaId },
        { ...likeBox, id: likeBoxId },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    signTransaction(tx, likerPrivKey, likerPubKeyHex);

    expect(() => castLike(deps, tx, 5)).toThrow(
      'sufficient likes for free liking',
    );
  });

  // -----------------------------------------------------------------------
  // 4. castLike fails if post unknown
  // -----------------------------------------------------------------------
  it('castLike fails if post unknown', () => {
    const karma = createKarmaBox(likerPubKey, 100, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 98n,
      owner: likerPubKey,
      guard: 'owner_signature',
      proofSource: 'like:nonexistent',
    };
    Object.assign(newKarma, fixtureProvenance(newKarma, 1));
    const newKarmaId = computeBoxId(newKarma);
    const likeBox: LikeBox = {
      boxType: 'like',
      value: LIKE_COST,
      likerId,
      targetPostId: 'nonexistent',
      guard: 'epoch_tally',
    };
    Object.assign(likeBox, fixtureProvenance(likeBox, 1));
    const likeBoxId = computeBoxId(likeBox);

    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { ...newKarma, id: newKarmaId },
        { ...likeBox, id: likeBoxId },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    signTransaction(tx, likerPrivKey, likerPubKeyHex);

    expect(() => castLike(deps, tx, 5)).toThrow('Post not found');
  });

  // -----------------------------------------------------------------------
  // 5. castLike fails if already liked (via DB)
  // -----------------------------------------------------------------------
  it('castLike fails if already liked (via DB)', () => {
    const karma = createKarmaBox(likerPubKey, 100, 1);
    const postId = createTestPost(likerId);

    // Insert a like box directly (simulates confirmed like)
    insertLockedLikeBox(likerId, postId, 1);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 98n,
      owner: likerPubKey,
      guard: 'owner_signature',
      proofSource: `like:${postId}`,
    };
    Object.assign(newKarma, fixtureProvenance(newKarma, 1));
    const newKarmaId = computeBoxId(newKarma);
    const likeBox: LikeBox = {
      boxType: 'like',
      value: LIKE_COST,
      likerId,
      targetPostId: postId,
      guard: 'epoch_tally',
    };
    Object.assign(likeBox, fixtureProvenance(likeBox, 1));
    const likeBoxId = computeBoxId(likeBox);

    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { ...newKarma, id: newKarmaId },
        { ...likeBox, id: likeBoxId },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    signTransaction(tx, likerPrivKey, likerPubKeyHex);

    expect(() => castLike(deps, tx, 5)).toThrow('Already liked');
  });

  // -----------------------------------------------------------------------
  // 6. castLike fails if already liked (via mempool — duplicate pending)
  // -----------------------------------------------------------------------
  it('castLike fails if already liked (via mempool)', () => {
    const karma = createKarmaBox(likerPubKey, 100, 1);
    const postId = createTestPost(likerId);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 98n,
      owner: likerPubKey,
      guard: 'owner_signature',
      proofSource: `like:${postId}`,
    };
    Object.assign(newKarma, fixtureProvenance(newKarma, 1));
    const newKarmaId = computeBoxId(newKarma);
    const likeBox: LikeBox = {
      boxType: 'like',
      value: LIKE_COST,
      likerId,
      targetPostId: postId,
      guard: 'epoch_tally',
    };
    Object.assign(likeBox, fixtureProvenance(likeBox, 1));
    const likeBoxId = computeBoxId(likeBox);

    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { ...newKarma, id: newKarmaId },
        { ...likeBox, id: likeBoxId },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    signTransaction(tx, likerPrivKey, likerPubKeyHex);

    // First like -> pending
    castLike(deps, tx, 5);

    // Second like with same params -> should detect pending and throw
    // Build a fresh tx (different txId but same target/liker)
    const tx2: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { ...newKarma, id: newKarmaId },
        { ...likeBox, id: likeBoxId },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx2, likerPrivKey, likerPubKeyHex);

    expect(() => castLike(deps, tx2, 5)).toThrow('Already liked');
  });

  // -----------------------------------------------------------------------
  // 6b. The mempool gate sees a pending like past the old 1000-row scan
  //     bound (audit M-8). Beyond that bound the duplicate check used to go
  //     blind, so the same identity could double-like the same post.
  // -----------------------------------------------------------------------
  it('castLike rejects a duplicate whose pending like sits past row 1000', () => {
    const karma = createKarmaBox(likerPubKey, 100, 1);
    const postId = createTestPost(likerId);

    function buildLikeTx(): UtxoTransaction {
      const newKarma: KarmaBox = {
        boxType: 'karma',
        value: 98n,
        owner: likerPubKey,
        guard: 'owner_signature',
        proofSource: `like:${postId}`,
      };
      const likeBox: LikeBox = {
        boxType: 'like',
        value: LIKE_COST,
        likerId,
        targetPostId: postId,
        guard: 'epoch_tally',
      };
      const tx: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [
          { ...newKarma, id: computeBoxId(newKarma) },
          { ...likeBox, id: computeBoxId(likeBox) },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      signTransaction(tx, likerPrivKey, likerPubKeyHex);
      return tx;
    }

    // Bury the pending like behind 1000 unrelated entries.
    for (let i = 0; i < 1000; i++) insertMempoolSubBlock(`filler_${i}`, 900);
    castLike(deps, buildLikeTx(), 5);

    // Vacuity: the pending like is genuinely out of the old scan's reach.
    const scanned = getPendingEntries(1000);
    expect(scanned.some((e) => e.entryType === 'utxo_tx')).toBe(false);

    expect(() => castLike(deps, buildLikeTx(), 5)).toThrow('Already liked');

    // Control — same post, different liker: single-field delta, still accepted.
    const otherKeys = generateKeyPairSync('ed25519');
    const otherPub = rawPublicKey(otherKeys.publicKey);
    const otherKarma = createKarmaBox(otherPub, 100, 1);
    const otherNewKarma: KarmaBox = {
      boxType: 'karma',
      value: 98n,
      owner: otherPub,
      guard: 'owner_signature',
      proofSource: `like:${postId}`,
    };
    const otherLike: LikeBox = {
      boxType: 'like',
      value: LIKE_COST,
      likerId: otherPub,
      targetPostId: postId,
      guard: 'epoch_tally',
    };
    const otherTx: UtxoTransaction = {
      inputs: [otherKarma.id!],
      outputs: [
        { ...otherNewKarma, id: computeBoxId(otherNewKarma) },
        { ...otherLike, id: computeBoxId(otherLike) },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(otherTx, otherKeys.privateKey, Buffer.from(otherPub).toString('hex'));

    expect(castLike(deps, otherTx, 5).castLikeResult).toBe('pending');
  });

  // -----------------------------------------------------------------------
  // 7. castLike accepts karma below like cost (decay is periodic)
  // -----------------------------------------------------------------------
  it('castLike rejects karma below like cost (audit C-1)', () => {
    const karma = createKarmaBox(likerPubKey, 1, 1); // Only 1 karma, need 2+ for like cost
    const postId = createTestPost(likerId);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 0n,
      owner: likerPubKey,
      guard: 'owner_signature',
      proofSource: `like:${postId}`,
    };
    Object.assign(newKarma, fixtureProvenance(newKarma, 1));
    const newKarmaId = computeBoxId(newKarma);
    const likeBox: LikeBox = {
      boxType: 'like',
      value: LIKE_COST,
      likerId,
      targetPostId: postId,
      guard: 'epoch_tally',
    };
    Object.assign(likeBox, fixtureProvenance(likeBox, 1));
    const likeBoxId = computeBoxId(likeBox);

    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { ...newKarma, id: newKarmaId },
        { ...likeBox, id: likeBoxId },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    signTransaction(tx, likerPrivKey, likerPubKeyHex);

    // K(1) -> K(0) + Like(2) would mint 1 karma from nothing.
    expect(() => castLike(deps, tx, 5)).toThrow('Value non-conservation');
  });

  // -----------------------------------------------------------------------
  // 8. castLike pending does not change karma immediately
  // -----------------------------------------------------------------------
  it('castLike pending does not change karma immediately', () => {
    const karma = createKarmaBox(likerPubKey, 100, 1);
    const postId = createTestPost(likerId);

    const newKarma: KarmaBox = {
      boxType: 'karma',
      value: 98n,
      owner: likerPubKey,
      guard: 'owner_signature',
      proofSource: `like:${postId}`,
    };
    Object.assign(newKarma, fixtureProvenance(newKarma, 1));
    const newKarmaId = computeBoxId(newKarma);
    const likeBox: LikeBox = {
      boxType: 'like',
      value: LIKE_COST,
      likerId,
      targetPostId: postId,
      guard: 'epoch_tally',
    };
    Object.assign(likeBox, fixtureProvenance(likeBox, 1));
    const likeBoxId = computeBoxId(likeBox);

    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { ...newKarma, id: newKarmaId },
        { ...likeBox, id: likeBoxId },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    signTransaction(tx, likerPrivKey, likerPubKeyHex);
    castLike(deps, tx, 5);

    // Karma should be unchanged (pending in mempool, not applied)
    const karmaBox = getKarmaBox(likerPubKey);
    expect(karmaBox).not.toBeNull();
    expect(karmaBox!.value).toBe(100n); // unchanged — pending
  });
});
