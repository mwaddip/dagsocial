import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { SubBlock, Post, LikeBox } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dynamic import helpers
// ---------------------------------------------------------------------------

async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database;
    closeDb: () => void;
  };
}

async function importSubblocksFresh() {
  const mod = await import('../../src/store/subblocks.js');
  return mod as {
    insertSubBlock: (sb: SubBlock) => void;
    getPendingSubBlocks: (limit: number) => SubBlock[];
    confirmSubBlock: (subBlockId: string, blockHeight: number) => void;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    content: 'hello world',
    author: 'user-abc',
    parentRefs: [],
    challenge: new Uint8Array(32),
    powNonce: 0,
    protocolVersion: 1,
    timestamp: Date.now(),
    signature: new Uint8Array(64),
    ...overrides,
  };
}

function makeLikeBox(overrides: Partial<LikeBox> = {}): LikeBox {
  return {
    id: 'like-box-1',
    boxType: 'like',
    value: 2,
    createdAtBlock: 5,
    likerId: 'liker-1',
    targetPostId: 'post-1',
    guard: 'epoch_tally',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subblocks store', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('insertSubBlock + getPendingSubBlocks round-trip', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertSubBlock, getPendingSubBlocks } =
      await importSubblocksFresh();

    initDb(':memory:');

    // Insert the like box first so getBox() can find it during reconstruction
    const likeBox = makeLikeBox({ id: 'like-box-aaa' });
    getDb().prepare(
      `INSERT INTO utxo_boxes (id, box_type, value, created_at_block, guard, extra_data)
       VALUES (?, 'like', ?, 5, 'epoch_tally', ?)`,
    ).run(
      likeBox.id,
      likeBox.value,
      JSON.stringify({ likerId: likeBox.likerId, targetPostId: likeBox.targetPostId }),
    );

    const post = makePost({ content: 'a sub-block post' });
    const sb: SubBlock = {
      subBlockId: 'sb-1',
      post,
      likeBoxes: [likeBox],
      producerId: 'user-abc',
      protocolVersion: 1,
    };

    insertSubBlock(sb);

    const pending = getPendingSubBlocks(10);
    expect(pending).toHaveLength(1);
    const result = pending[0];
    expect(result.subBlockId).toBe('sb-1');
    expect(result.post.content).toBe('a sub-block post');
    expect(result.post.author).toBe('user-abc');
    expect(result.likeBoxes).toHaveLength(1);
    expect(result.likeBoxes[0].id).toBe('like-box-aaa');
    expect(result.producerId).toBe('user-abc');
    expect(result.protocolVersion).toBe(1);
  });

  it('getPendingSubBlocks respects limit', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertSubBlock, getPendingSubBlocks } =
      await importSubblocksFresh();

    initDb(':memory:');

    for (let i = 0; i < 5; i++) {
      const sb: SubBlock = {
        subBlockId: `sb-${i}`,
        post: makePost({ content: `post ${i}` }),
        likeBoxes: [],
        producerId: 'user-abc',
        protocolVersion: 1,
      };
      insertSubBlock(sb);
    }

    const limited = getPendingSubBlocks(3);
    expect(limited).toHaveLength(3);
  });

  it('getPendingSubBlocks returns oldest first', async () => {
    const { initDb } = await importDbFresh();
    const { insertSubBlock, getPendingSubBlocks } =
      await importSubblocksFresh();

    initDb(':memory:');

    for (let i = 0; i < 3; i++) {
      const sb: SubBlock = {
        subBlockId: `sb-${i}`,
        post: makePost({ content: `post ${i}` }),
        likeBoxes: [],
        producerId: 'user-abc',
        protocolVersion: 1,
      };
      insertSubBlock(sb);
    }

    const pending = getPendingSubBlocks(10);
    expect(pending).toHaveLength(3);
    // Should be ordered by rowid ASC (insertion order)
    expect(pending[0].subBlockId).toBe('sb-0');
    expect(pending[1].subBlockId).toBe('sb-1');
    expect(pending[2].subBlockId).toBe('sb-2');
  });

  it('confirmSubBlock removes from pending', async () => {
    const { initDb } = await importDbFresh();
    const { insertSubBlock, getPendingSubBlocks, confirmSubBlock } =
      await importSubblocksFresh();

    initDb(':memory:');

    const sb1: SubBlock = {
      subBlockId: 'sb-1',
      post: makePost({ content: 'post 1' }),
      likeBoxes: [],
      producerId: 'user-abc',
      protocolVersion: 1,
    };
    const sb2: SubBlock = {
      subBlockId: 'sb-2',
      post: makePost({ content: 'post 2' }),
      likeBoxes: [],
      producerId: 'user-abc',
      protocolVersion: 1,
    };

    insertSubBlock(sb1);
    insertSubBlock(sb2);

    confirmSubBlock('sb-1', 42);

    const pending = getPendingSubBlocks(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].subBlockId).toBe('sb-2');
  });
});
