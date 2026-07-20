import { describe, it, expect } from 'vitest';
import {
  generateKeyPairSync,
  createHash,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  signingHash,
  getUserId,
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  KARMA_POSTING_MINIMUM,
} from '@dagsocial/types';
import type { Post } from '@dagsocial/types';
import { verifyPoW } from '../../src/services/pow.js';
import { verifyPost } from '../../src/services/verifier.js';
import type { VerifierDeps } from '../../src/services/verifier.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Brute-force a valid PoW nonce for the given input and target bits.
 * Returns the first nonce >= startNonce that satisfies the target.
 */
function solvePoW(input: Uint8Array, targetBits: number, startNonce = 0): number {
  for (let nonce = startNonce; nonce < 100_000_000; nonce++) {
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce));
    const hash = createHash('blake2b512')
      .update(Buffer.concat([Buffer.from(input), nonceBuf]))
      .digest()
      .subarray(0, 32);

    let valid = true;
    for (let i = 0; i < targetBits; i++) {
      const byteIdx = Math.floor(i / 8);
      const bitIdx = 7 - (i % 8);
      if ((hash[byteIdx]! & (1 << bitIdx)) !== 0) {
        valid = false;
        break;
      }
    }
    if (valid) return nonce;
  }
  throw new Error('Failed to solve PoW within iteration limit');
}

/**
 * Build the powInput buffer exactly as the verifier does.
 */
function buildPowInput(post: Post): Buffer {
  return Buffer.concat([
    Buffer.from(post.content),
    Buffer.from(post.author),
    ...post.parentRefs.map((r) => Buffer.from(r)),
    Buffer.from(post.challenge),
    Buffer.from(String(post.protocolVersion)),
    Buffer.from(String(post.timestamp)),
  ]);
}

// ---------------------------------------------------------------------------
// Mock store helpers
// ---------------------------------------------------------------------------

interface MockStore {
  identities: Map<string, { userId: string; publicKey: Uint8Array; createdAt: number }>;
  challenges: Map<string, { challenge: Uint8Array; expiresAtBlock: number; userId: string }>;
  karmaBoxes: Map<string, { value: number }>; // keyed by hex(owner publicKey)
  posts: Map<string, unknown>;
}

function createMockDeps(store: MockStore): VerifierDeps {
  return {
    getActiveChallenge: (userId: string) => store.challenges.get(userId) ?? null,
    getIdentity: (userId: string) => store.identities.get(userId) ?? null,
    getKarmaBox: (owner: Uint8Array) => {
      const hex = Buffer.from(owner).toString('hex');
      return store.karmaBoxes.get(hex) ?? null;
    },
    getPost: (id: string) => store.posts.get(id) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifyPost', () => {
  // Shared test fixtures
  let pubKeyRaw: Uint8Array;
  let privKey: KeyObject;
  let userId: string;
  let challengeBytes: Uint8Array;

  // Build a fresh mock store for each test
  function makeStore(): MockStore {
    return {
      identities: new Map(),
      challenges: new Map(),
      karmaBoxes: new Map(),
      posts: new Map(),
    };
  }

  /**
   * Create a fully valid Post object (unsigned) with the given overrides.
   * The caller is responsible for signing and setting powNonce.
   */
  function makePost(overrides: Partial<Post> = {}): Post {
    return {
      content: 'hello world',
      author: userId,
      parentRefs: [],
      challenge: challengeBytes,
      powNonce: 0,
      protocolVersion: PROTOCOL_VERSION,
      timestamp: 1700000000000,
      signature: new Uint8Array(64),
      ...overrides,
    };
  }

  /**
   * Sign a post with the test private key and set its signature.
   */
  function signPost(post: Post): Post {
    const sig = cryptoSign(null, signingHash(post), privKey);
    return { ...post, signature: new Uint8Array(sig) };
  }

  // Generate a real Ed25519 keypair once for all tests
  {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    pubKeyRaw = new Uint8Array(pubDer.slice(pubDer.length - 32));
    // Keep KeyObject — crypto.sign needs it for Ed25519
    privKey = privateKey;
    userId = getUserId(pubKeyRaw);
    challengeBytes = new Uint8Array(
      createHash('blake2b512').update('test-challenge').digest().subarray(0, 32),
    );
  }

  // -----------------------------------------------------------------------
  // 1. Valid post passes all checks
  // -----------------------------------------------------------------------
  it(
    'valid post passes all checks',
    { timeout: 60_000 },
    () => {
      const store = makeStore();

      // Populate store
      store.identities.set(userId, {
        userId,
        publicKey: pubKeyRaw,
        createdAt: Date.now(),
      });
      store.challenges.set(userId, {
        userId,
        challenge: challengeBytes,
        expiresAtBlock: 100,
      });
      store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), {
        value: KARMA_POSTING_MINIMUM,
      });

      // Build post and solve PoW
      let post = makePost();
      const powInput = buildPowInput(post);
      const nonce = solvePoW(powInput, 20);
      post = { ...post, powNonce: nonce };

      // Sign
      post = signPost(post);

      const deps = createMockDeps(store);
      const result = verifyPost(deps, post, 50);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    },
  );

  // -----------------------------------------------------------------------
  // 2. Empty content
  // -----------------------------------------------------------------------
  it('rejects empty content', () => {
    const store = makeStore();
    const post = makePost({ content: '' });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Content is empty');
  });

  // -----------------------------------------------------------------------
  // 3. Content > 300 bytes
  // -----------------------------------------------------------------------
  it('rejects content exceeding max length', () => {
    const store = makeStore();
    const post = makePost({ content: 'x'.repeat(MAX_CONTENT_BYTES + 1) });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Content exceeds max length');
  });

  // -----------------------------------------------------------------------
  // 4. > 8 parent refs
  // -----------------------------------------------------------------------
  it('rejects too many parent refs', () => {
    const store = makeStore();
    const post = makePost({
      parentRefs: Array.from({ length: 9 }, (_, i) => `post${i}`),
    });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Too many parent refs');
  });

  // -----------------------------------------------------------------------
  // 5. Wrong protocol version
  // -----------------------------------------------------------------------
  it('rejects unsupported protocol version', () => {
    const store = makeStore();
    const post = makePost({ protocolVersion: 99 });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Unsupported protocol version');
  });

  // -----------------------------------------------------------------------
  // 6. No active challenge
  // -----------------------------------------------------------------------
  it('rejects missing challenge', () => {
    const store = makeStore();
    // No challenge inserted
    const post = makePost({ content: 'test' }); // 4 bytes, passes content check
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('No active challenge');
  });

  // -----------------------------------------------------------------------
  // 7. Challenge mismatch
  // -----------------------------------------------------------------------
  it('rejects challenge mismatch', () => {
    const store = makeStore();
    store.challenges.set(userId, {
      userId,
      challenge: new Uint8Array(32), // all zeros — not what the post carries
      expiresAtBlock: 100,
    });
    const post = makePost({ content: 'test' });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Challenge mismatch');
  });

  // -----------------------------------------------------------------------
  // 8. Expired challenge
  // -----------------------------------------------------------------------
  it('rejects expired challenge', () => {
    const store = makeStore();
    store.challenges.set(userId, {
      userId,
      challenge: challengeBytes,
      expiresAtBlock: 10,
    });
    const post = makePost({ content: 'test' });
    const deps = createMockDeps(store);
    // currentBlockHeight (20) > expiresAtBlock (10)
    const result = verifyPost(deps, post, 20);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Challenge expired');
  });

  // -----------------------------------------------------------------------
  // 9. Invalid PoW
  // -----------------------------------------------------------------------
  it('rejects invalid PoW', () => {
    const store = makeStore();
    store.challenges.set(userId, {
      userId,
      challenge: challengeBytes,
      expiresAtBlock: 100,
    });
    // powNonce=0 with targetBits=20 is almost certainly invalid
    const post = makePost({ content: 'test', powNonce: 0 });
    const deps = createMockDeps(store);

    // Verify that powNonce=0 is actually invalid for this input
    const powInput = buildPowInput(post);
    const isValid = verifyPoW(powInput, 0, 20);
    if (isValid) {
      // Extremely unlikely — skip the test if 0 happens to be valid
      return;
    }

    const result = verifyPost(deps, post, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Proof of Work invalid');
  });

  // -----------------------------------------------------------------------
  // 10. Invalid signature (tampered content)
  // -----------------------------------------------------------------------
  it(
    'rejects invalid signature',
    { timeout: 60_000 },
    () => {
      const store = makeStore();

      store.identities.set(userId, {
        userId,
        publicKey: pubKeyRaw,
        createdAt: Date.now(),
      });
      store.challenges.set(userId, {
        userId,
        challenge: challengeBytes,
        expiresAtBlock: 100,
      });
      store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), {
        value: KARMA_POSTING_MINIMUM,
      });

      // Build a valid post, solve PoW, and sign the original content
      let post = makePost({ content: 'original content' });
      let powInput = buildPowInput(post);
      const goodNonce = solvePoW(powInput, 20);
      post = { ...post, powNonce: goodNonce };
      post = signPost(post);

      // Tamper with content after signing — signature no longer matches.
      // Re-solve PoW for the tampered content so PoW check passes and we reach
      // the signature verification step.
      const tamperedPost = { ...post, content: 'tampered content' };
      powInput = buildPowInput(tamperedPost);
      const tamperedNonce = solvePoW(powInput, 20);
      const finalTampered = { ...tamperedPost, powNonce: tamperedNonce };

      const deps = createMockDeps(store);
      const result = verifyPost(deps, finalTampered, 50);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Signature invalid');
    },
  );

  // -----------------------------------------------------------------------
  // 11. Missing parent ref
  // -----------------------------------------------------------------------
  it(
    'rejects missing parent ref',
    { timeout: 60_000 },
    () => {
      const store = makeStore();

      store.identities.set(userId, {
        userId,
        publicKey: pubKeyRaw,
        createdAt: Date.now(),
      });
      store.challenges.set(userId, {
        userId,
        challenge: challengeBytes,
        expiresAtBlock: 100,
      });
      store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), {
        value: KARMA_POSTING_MINIMUM,
      });

      // Reference a post that does not exist
      let post = makePost({ parentRefs: ['nonexistent-parent-id'] });
      const powInput = buildPowInput(post);
      const nonce = solvePoW(powInput, 20);
      post = { ...post, powNonce: nonce };
      post = signPost(post);

      const deps = createMockDeps(store);
      const result = verifyPost(deps, post, 50);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Parent post not found: nonexistent-parent-id');
    },
  );

  // -----------------------------------------------------------------------
  // 12. Insufficient karma
  // -----------------------------------------------------------------------
  it(
    'rejects insufficient karma',
    { timeout: 60_000 },
    () => {
      const store = makeStore();

      store.identities.set(userId, {
        userId,
        publicKey: pubKeyRaw,
        createdAt: Date.now(),
      });
      store.challenges.set(userId, {
        userId,
        challenge: challengeBytes,
        expiresAtBlock: 100,
      });
      // Karma box value = 0, below KARMA_POSTING_MINIMUM (1)
      store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), { value: 0 });

      let post = makePost();
      const powInput = buildPowInput(post);
      const nonce = solvePoW(powInput, 20);
      post = { ...post, powNonce: nonce };
      post = signPost(post);

      const deps = createMockDeps(store);
      const result = verifyPost(deps, post, 50);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Insufficient karma');
    },
  );

  // -----------------------------------------------------------------------
  // 13. Valid post with 0 parent refs passes
  // -----------------------------------------------------------------------
  it(
    'valid post with 0 parent refs passes',
    { timeout: 60_000 },
    () => {
      const store = makeStore();

      store.identities.set(userId, {
        userId,
        publicKey: pubKeyRaw,
        createdAt: Date.now(),
      });
      store.challenges.set(userId, {
        userId,
        challenge: challengeBytes,
        expiresAtBlock: 100,
      });
      store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), {
        value: KARMA_POSTING_MINIMUM,
      });

      // Explicitly empty parentRefs
      let post = makePost({ parentRefs: [] });
      const powInput = buildPowInput(post);
      const nonce = solvePoW(powInput, 20);
      post = { ...post, powNonce: nonce };
      post = signPost(post);

      const deps = createMockDeps(store);
      const result = verifyPost(deps, post, 50);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    },
  );
});
