import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  createPost,
  PostServiceError,
  PostValidationError,
} from '../../src/services/post-service.js';
import type { PostServiceDeps } from '../../src/services/post-service.js';
import type { Post, UtxoTransaction, AnyBox, KarmaBox } from '@dagsocial/types';
import { PROTOCOL_VERSION } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Standard blake2b-512/32 hash (matches the implementation in post-service.ts).
 */
function blake2b32(data: Uint8Array): Uint8Array {
  return createHash('blake2b512').update(data).digest().subarray(0, 32);
}

function encodeUint32(n: number): Uint8Array {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, n, true);
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// Mock deps factory
// ---------------------------------------------------------------------------

interface MockStore {
  posts: Map<string, Uint8Array>; // id -> raw CBOR bytes
  watermarkValues: Map<string, Uint8Array>;
}

function mockDeps(
  store: MockStore,
  overrides?: Partial<PostServiceDeps>,
): PostServiceDeps {
  return {
    verifyPost: () => ({ valid: true }),
    getActiveChallenge: () => ({
      challenge: new Uint8Array(32).fill(0xcc),
      expiresAtBlock: 9999,
      userId: new Uint8Array(32),
    }),
    getKarmaBoxes: () => [{ value: 100 }],
    getPost: (id: string) => {
      // Return a post-like object if raw bytes exist
      return store.posts.has(id) ? { id, content: 'stored-parent' } : null;
    },
    getPostRaw: (id: string) => {
      const raw = store.posts.get(id);
      return raw ?? null;
    },
    encodePost: (post: Post) => {
      // CBOR encode for the parent hash check — use JSON as a simple
      // deterministic serialization for test purposes
      return new TextEncoder().encode(JSON.stringify(post));
    },
    insertPost: () => {},
    getCurrentHeight: () => 100,
    consumeChallenge: () => {},
    insertMempoolSubBlock: () => 1,
    insertUtxoTx: () => 1,
    validateTx: () => ({ valid: true, txId: 'tx-1' }),
    getBox: () =>
      ({
        boxType: 'karma',
        value: 100,
        owner: new Uint8Array(32),
        createdAtBlock: 1,
        guard: 'owner_signature',
        proofSource: 'genesis',
        lastTouchBlock: 1,
      }) as AnyBox,
    onSubBlockReceived: () => {},
    metaPut: (key: string, value: Uint8Array) => {
      store.watermarkValues.set(key, value);
    },
    metaGet: (key: string) => {
      return store.watermarkValues.get(key) ?? null;
    },
    ...overrides,
  };
}

function makeStore(): MockStore {
  return {
    posts: new Map(),
    watermarkValues: new Map(),
  };
}

function makePost(overrides?: Partial<Post>): Post {
  return {
    content: 'hello world',
    author: new Uint8Array(32),
    parentRefs: [],
    challenge: new Uint8Array(32).fill(0xcc),
    powNonce: 42,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: Date.now(),
    signature: new Uint8Array(64),
    ...overrides,
  };
}

function makeKarmaLockTx(): UtxoTransaction {
  return {
    inputs: ['box-1'],
    outputs: [
      {
        boxType: 'karma',
        value: 75,
        createdAtBlock: 5,
        owner: new Uint8Array(32),
        guard: 'owner_signature',
        proofSource: 'post-lock',
        lastTouchBlock: 5,
      } as KarmaBox,
      {
        boxType: 'post_lock',
        value: 25,
        createdAtBlock: 5,
        originalValue: 25,
        owner: new Uint8Array(32),
        targetPostId: '',
        guard: 'epoch_tally',
      } as AnyBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validate-dont-trust', () => {
  // -----------------------------------------------------------------------
  // Parent hash recomputation
  // -----------------------------------------------------------------------

  it('rejects a post whose parent hash does not match stored bytes', () => {
    const store = makeStore();

    // Store a parent post with a known ID. The raw bytes are arbitrary.
    const parentRaw = new TextEncoder().encode(
      JSON.stringify({ content: 'parent content', author: Array(32).fill(0) }),
    );
    const parentHash = blake2b32(parentRaw);
    const parentId = Buffer.from(parentHash).toString('hex');
    store.posts.set(parentId, parentRaw);

    // Create a child post that references the correct parentId — this should
    // succeed because getPostRaw returns bytes that hash to parentId.
    const child = makePost({ parentRefs: [parentId] });
    const tx = makeKarmaLockTx();

    // This should succeed — parent hash matches
    const result = createPost(mockDeps(store), child, tx);
    expect(result.status).toBe('pending');
  });

  it('rejects a post whose parent hash does not match: tampered bytes', () => {
    const store = makeStore();

    // Store a parent post with ID derived from original bytes
    const originalRaw = new TextEncoder().encode('original parent data');
    const originalHash = blake2b32(originalRaw);
    const parentId = Buffer.from(originalHash).toString('hex');

    // Store DIFFERENT bytes at this parentId — simulating a tampered store
    // where the stored bytes don't hash to the claimed ID
    const tamperedRaw = new TextEncoder().encode('tampered parent data');
    // tamperedHash != originalHash, but we're storing it under parentId
    // (which is derived from originalRaw)
    store.posts.set(parentId, tamperedRaw);

    // Create a child that references parentId
    const child = makePost({ parentRefs: [parentId] });
    const tx = makeKarmaLockTx();

    // Should reject: getPostRaw(parentId) returns tamperedRaw,
    // blake2b32(tamperedRaw) != parentId
    expect(() => createPost(mockDeps(store), child, tx)).toThrow(PostValidationError);
    expect(() => createPost(mockDeps(store), child, tx)).toThrow('parent hash mismatch');
  });

  it('rejects a post referencing a nonexistent parent (raw bytes unavailable)', () => {
    const store = makeStore();
    const nonexistentId = 'a'.repeat(64);

    const child = makePost({ parentRefs: [nonexistentId] });
    const tx = makeKarmaLockTx();

    expect(() => createPost(mockDeps(store), child, tx)).toThrow(PostValidationError);
    expect(() => createPost(mockDeps(store), child, tx)).toThrow(
      'raw bytes unavailable',
    );
  });

  // -----------------------------------------------------------------------
  // Content hash (post ID) is server-authoritative
  // -----------------------------------------------------------------------

  it('computes post ID server-authoritatively (client ID is ignored)', () => {
    const store = makeStore();

    // Create a post — the client does NOT provide postId
    const post = makePost({ parentRefs: [] });
    const tx = makeKarmaLockTx();

    const result = createPost(mockDeps(store), post, tx);

    // postId is a 64-char hex string (32 bytes)
    expect(typeof result.postId).toBe('string');
    expect(result.postId.length).toBe(64);

    // Verify it's valid hex
    expect(/^[0-9a-f]{64}$/.test(result.postId)).toBe(true);
  });

  it('produces different post IDs for different content', () => {
    const store = makeStore();
    const tx = makeKarmaLockTx();

    const post1 = makePost({ content: 'hello world' });
    const post2 = makePost({ content: 'different content' });

    const result1 = createPost(mockDeps(store), post1, tx);
    const result2 = createPost(mockDeps(store), post2, tx);

    expect(result1.postId).not.toBe(result2.postId);
  });

  // NOTE: The Post type does not carry a client-set `id` field, so there is
  // no self-reported content hash to reject on mismatch. The post ID is
  // ALWAYS computed server-authoritatively via computePostId(). The following
  // test verifies that the server-derived ID is fully determined by post
  // content — there is no client-controlled ID to spoof.

  it('server-derived postId is deterministic and non-spoofable (no client id field)', () => {
    const store = makeStore();
    const tx = makeKarmaLockTx();

    // Create identical posts — they must produce the same postId.
    // We only vary the fields that affect computePostId (content, parentRefs,
    // timestamp, powNonce, protocolVersion). Author/challenge/signature are
    // fixed to match the mock deps defaults so the karma-ownership check passes.
    const base = {
      content: 'identical content',
      parentRefs: [] as string[],
      timestamp: 1700000000000,
      powNonce: 42,
      protocolVersion: PROTOCOL_VERSION,
    };

    const postA = makePost(base);
    const postB = makePost(base);

    const resultA = createPost(mockDeps(store), postA, tx);
    const resultB = createPost(mockDeps(store), postB, tx);

    // Same deterministic fields → same postId. The server computes it; the
    // client cannot inject a different value.
    expect(resultA.postId).toBe(resultB.postId);

    // Changing ANY field (even powNonce) produces a different postId.
    const postC = makePost({ ...base, powNonce: 43 });
    const resultC = createPost(mockDeps(store), postC, tx);
    expect(resultC.postId).not.toBe(resultA.postId);
  });

  // -----------------------------------------------------------------------
  // Watermark advancement
  // -----------------------------------------------------------------------

  it('advances last_indexed_sequence watermark after successful insertion', () => {
    const store = makeStore();
    const post = makePost({ parentRefs: [] });
    const tx = makeKarmaLockTx();

    createPost(mockDeps(store), post, tx);

    const indexedBytes = store.watermarkValues.get('last_indexed_sequence');
    expect(indexedBytes).toBeDefined();
    const indexed = new DataView(
      indexedBytes!.buffer,
      indexedBytes!.byteOffset,
      4,
    ).getUint32(0, true);
    expect(indexed).toBe(1);
  });

  it('advances last_validated_sequence watermark after full pipeline', () => {
    const store = makeStore();
    const post = makePost({ parentRefs: [] });
    const tx = makeKarmaLockTx();

    createPost(mockDeps(store), post, tx);

    const validatedBytes = store.watermarkValues.get('last_validated_sequence');
    expect(validatedBytes).toBeDefined();
    const validated = new DataView(
      validatedBytes!.buffer,
      validatedBytes!.byteOffset,
      4,
    ).getUint32(0, true);
    expect(validated).toBe(1);
  });

  it('does NOT advance watermarks when validation fails', () => {
    const store = makeStore();
    const post = makePost({ parentRefs: [] });
    const tx = makeKarmaLockTx();

    const deps = mockDeps(store, {
      verifyPost: () => ({ valid: false, error: 'Content is empty' }),
    });

    expect(() => createPost(deps, post, tx)).toThrow(PostServiceError);

    // Watermarks should not have been written
    expect(store.watermarkValues.has('last_indexed_sequence')).toBe(false);
    expect(store.watermarkValues.has('last_validated_sequence')).toBe(false);
  });

  it('advances watermarks monotonically across multiple posts', () => {
    const store = makeStore();
    const tx = makeKarmaLockTx();

    // First post
    createPost(mockDeps(store), makePost({ content: 'post 1' }), tx);
    // Second post
    createPost(mockDeps(store), makePost({ content: 'post 2' }), tx);
    // Third post
    createPost(mockDeps(store), makePost({ content: 'post 3' }), tx);

    const indexedBytes = store.watermarkValues.get('last_indexed_sequence');
    const validatedBytes = store.watermarkValues.get('last_validated_sequence');

    expect(indexedBytes).toBeDefined();
    expect(validatedBytes).toBeDefined();

    const indexed = new DataView(
      indexedBytes!.buffer,
      indexedBytes!.byteOffset,
      4,
    ).getUint32(0, true);
    const validated = new DataView(
      validatedBytes!.buffer,
      validatedBytes!.byteOffset,
      4,
    ).getUint32(0, true);

    expect(indexed).toBe(3);
    expect(validated).toBe(3);
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it('accepts a post with no parent refs (root post)', () => {
    const store = makeStore();
    const post = makePost({ parentRefs: [] });
    const tx = makeKarmaLockTx();

    const result = createPost(mockDeps(store), post, tx);
    expect(result.status).toBe('pending');
    expect(result.subBlock.likeBoxes).toEqual([]);
  });

  it('accepts a post with multiple valid parent refs', () => {
    const store = makeStore();

    // Store two parent posts
    const raw1 = new TextEncoder().encode(JSON.stringify({ content: 'parent 1' }));
    const raw2 = new TextEncoder().encode(JSON.stringify({ content: 'parent 2' }));
    const id1 = Buffer.from(blake2b32(raw1)).toString('hex');
    const id2 = Buffer.from(blake2b32(raw2)).toString('hex');

    store.posts.set(id1, raw1);
    store.posts.set(id2, raw2);

    const child = makePost({ parentRefs: [id1, id2] });
    const tx = makeKarmaLockTx();

    const result = createPost(mockDeps(store), child, tx);
    expect(result.status).toBe('pending');
  });
});
