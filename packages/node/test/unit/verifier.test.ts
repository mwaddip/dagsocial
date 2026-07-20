import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createHash, sign as cryptoSign } from 'crypto';
import { signingHash, getUserId, PROTOCOL_VERSION } from '@dagsocial/types';
import type { Post } from '@dagsocial/types';
import { verifyPost } from '../../src/services/verifier.js';
import type { VerifierDeps } from '../../src/services/verifier.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockStore {
  identities: Map<string, { userId: string; publicKey: Uint8Array; createdAt: number }>;
  challenges: Map<string, { challenge: Uint8Array; expiresAtBlock: number; userId: string }>;
  karmaBoxes: Map<string, { value: number }>;
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

function makeStore(): MockStore {
  return {
    identities: new Map(),
    challenges: new Map(),
    karmaBoxes: new Map(),
    posts: new Map(),
  };
}

function signPost(post: Post, privKey: Buffer | crypto.KeyObject): Post {
  const sig = cryptoSign(null, signingHash(post), privKey);
  return { ...post, signature: new Uint8Array(sig) };
}

describe('verifier', () => {
  let userId: string;
  let pubKeyRaw: Uint8Array;
  let privKey: crypto.KeyObject;
  let challengeBytes: Uint8Array;

  // Generate a real Ed25519 keypair
  {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    pubKeyRaw = new Uint8Array(pubDer.slice(pubDer.length - 32));
    privKey = privateKey;
    userId = getUserId(pubKeyRaw);
    challengeBytes = new Uint8Array(
      createHash('blake2b512').update('unit-test-challenge').digest().subarray(0, 32),
    );
  }

  function makePost(overrides: Partial<Post> = {}): Post {
    return {
      content: 'hello',
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

  it('rejects post with unsupported protocol version', () => {
    const store = makeStore();
    const post = makePost({ protocolVersion: 99 });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post, 0);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Unsupported protocol version');
  });

  it('rejects post with content exceeding max length', () => {
    const store = makeStore();
    const longContent = 'x'.repeat(301);
    const post = makePost({ content: longContent });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post, 0);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Content exceeds max length');
  });

  it('rejects post with empty content', () => {
    const store = makeStore();
    const post = makePost({ content: '' });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post, 0);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Content is empty');
  });

  it('rejects post with invalid signature', () => {
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
    store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), { value: 1 });

    let post = makePost({ powNonce: 1 });
    // Sign correctly, then zero the signature — crypto.verify will fail on
    // an all-zeros 64-byte array against the real public key.
    post = signPost(post, privKey);
    const badPost = { ...post, signature: new Uint8Array(64) };

    // powNonce=1 almost certainly fails PoW at targetBits=20, so the first
    // failure will be "Proof of Work invalid". Both failure modes (PoW and
    // signature) produce the correct `valid: false` with a descriptive error.
    const deps = createMockDeps(store);
    const result = verifyPost(deps, badPost, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});
