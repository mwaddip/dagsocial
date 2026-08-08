import { describe, it, expect } from 'vitest';
import { createPost, PostServiceError } from '../../src/services/post-service.js';
import type { PostServiceDeps } from '../../src/services/post-service.js';
import type { Post, UtxoTransaction, AnyBox, KarmaBox } from '@dagsocial/types';
import { PROTOCOL_VERSION } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Minimal mock deps factory
// ---------------------------------------------------------------------------

function mockDeps(overrides?: Partial<PostServiceDeps>): PostServiceDeps {
  return {
    verifyPost: () => ({ valid: true }),
    getActiveChallenge: () => ({
      challenge: new Uint8Array(32).fill(0xcc),
      expiresAtBlock: 9999,
      userId: new Uint8Array(32),
    }),
    getKarmaBoxes: () => [{ value: 100 }],
    getPost: () => ({ id: 'post-1', content: 'hello' }),
    getPostRaw: () => new Uint8Array(32).fill(0xaa),
    encodePost: () => new Uint8Array(10),
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
        guard: 'owner_signature',
        proofSource: 'genesis',
      }) as AnyBox,
    onSubBlockReceived: () => {},
    metaPut: () => {},
    metaGet: () => null,
    ...overrides,
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
        owner: new Uint8Array(32),
        guard: 'owner_signature',
        proofSource: 'post-lock',
      } as KarmaBox,
      {
        boxType: 'post_lock',
        value: 25,
        originalValue: 25,
        owner: new Uint8Array(32),
        targetPostId: '',
        guard: 'block_apply',
      } as AnyBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostService', () => {
  it('returns pending result on successful post creation', () => {
    const deps = mockDeps();
    const post = makePost();
    const tx = makeKarmaLockTx();

    const result = createPost(deps, post, tx);

    expect(result.status).toBe('pending');
    expect(typeof result.postId).toBe('string');
    expect(result.expiresAtHeight).toBeGreaterThan(0);
    expect(result.subBlock).toBeDefined();
    // T2b shape pin at the producer: a sub-block carries exactly the post —
    // no likeBoxes sidecar key (deleted; sub-block CBOR is consensus bytes).
    expect(Object.keys(result.subBlock).sort()).toEqual(
      ['post', 'producerId', 'protocolVersion', 'subBlockId'],
    );
  });

  it('throws PostServiceError when verifyPost fails', () => {
    const deps = mockDeps({
      verifyPost: () => ({ valid: false, error: 'Content is empty' }),
    });
    const post = makePost();
    const tx = makeKarmaLockTx();

    expect(() => createPost(deps, post, tx)).toThrow(PostServiceError);
    expect(() => createPost(deps, post, tx)).toThrow('Content is empty');
  });

  it('throws PostServiceError when karma-lock tx validation fails', () => {
    const deps = mockDeps({
      validateTx: () => ({ valid: false, error: 'Invalid signature' }),
    });
    const post = makePost();
    const tx = makeKarmaLockTx();

    expect(() => createPost(deps, post, tx)).toThrow(PostServiceError);
    expect(() => createPost(deps, post, tx)).toThrow('Invalid signature');
  });

  it('throws PostServiceError when karma-lock tx has no inputs', () => {
    const deps = mockDeps();
    const post = makePost();
    const tx = makeKarmaLockTx();
    tx.inputs = [];

    expect(() => createPost(deps, post, tx)).toThrow(PostServiceError);
    expect(() => createPost(deps, post, tx)).toThrow('no inputs');
  });

  it('throws PostServiceError when first input is not a karma box', () => {
    const deps = mockDeps({
      getBox: () => ({ boxType: 'credit', value: 100 }) as AnyBox,
    });
    const post = makePost();
    const tx = makeKarmaLockTx();

    expect(() => createPost(deps, post, tx)).toThrow(PostServiceError);
    expect(() => createPost(deps, post, tx)).toThrow('karma box');
  });

  it('throws PostServiceError when karma owner does not match post author', () => {
    const otherKey = new Uint8Array(32).fill(0xaa);
    const deps = mockDeps({
      getBox: () =>
        ({
          boxType: 'karma',
          value: 100,
          owner: otherKey,
        }) as AnyBox,
    });
    const post = makePost();
    const tx = makeKarmaLockTx();

    expect(() => createPost(deps, post, tx)).toThrow(PostServiceError);
    expect(() => createPost(deps, post, tx)).toThrow('does not belong to post author');
  });

  it('consumeChallenge is called on successful post creation', () => {
    let consumed = false;
    const deps = mockDeps({
      consumeChallenge: () => {
        consumed = true;
      },
    });
    const post = makePost();
    const tx = makeKarmaLockTx();

    createPost(deps, post, tx);
    expect(consumed).toBe(true);
  });

  it('consumeChallenge is called on verifyPost failure', () => {
    let consumed = false;
    const deps = mockDeps({
      verifyPost: () => ({ valid: false, error: 'fail' }),
      consumeChallenge: () => {
        consumed = true;
      },
    });
    const post = makePost();
    const tx = makeKarmaLockTx();

    expect(() => createPost(deps, post, tx)).toThrow(PostServiceError);
    expect(consumed).toBe(true);
  });

  it('onSubBlockReceived is called on success', () => {
    let signaled = false;
    const deps = mockDeps({
      onSubBlockReceived: () => {
        signaled = true;
      },
    });
    const post = makePost();
    const tx = makeKarmaLockTx();

    createPost(deps, post, tx);
    expect(signaled).toBe(true);
  });

  it('insertMempoolSubBlock and insertUtxoTx receive matching batchId', () => {
    let subBlockBatchId: string | null | undefined = undefined;
    let utxoBatchId: string | null = undefined;

    const deps = mockDeps({
      insertMempoolSubBlock: (_sb, _exp, batchId) => {
        subBlockBatchId = batchId;
        return 1;
      },
      insertUtxoTx: (_tx, batchId, _exp) => {
        utxoBatchId = batchId;
        return 1;
      },
    });

    const post = makePost();
    const tx = makeKarmaLockTx();

    const result = createPost(deps, post, tx);
    expect(subBlockBatchId).toBe(result.postId);
    expect(utxoBatchId).toBe(result.postId);
    expect(subBlockBatchId).toBe(utxoBatchId);
  });
});
