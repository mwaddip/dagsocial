import { describe, it, expect } from 'vitest';
import { encodePost, decodePost, encodeSlotToken, decodeSlotToken } from '../src/serialization.js';
import type { Post, SlotToken } from '../src/post.js';

const makePost = (): Post => ({
  id: 'some-id',
  content: 'Hello, DAGsocial!',
  author: 'user123',
  parentRefs: ['ref1', 'ref2'],
  slotHash: 'abc123',
  powNonce: 12345,
  timestamp: 1700000000000,
  signature: 'sig-data',
  status: 'pending',
});

const makeSlotToken = (): SlotToken => ({
  userId: 'user123',
  issuedAtBlock: 100,
  expiresAtBlock: 200,
  nonce: 42,
  hash: 'abc123hash',
});

describe('CBOR serialization', () => {
  it('round-trips a pending post', () => {
    const post = makePost();
    const decoded = decodePost(encodePost(post));
    expect(decoded).toEqual(post);
  });

  it('round-trips a confirmed post with blockHeight', () => {
    const post: Post = { ...makePost(), status: 'confirmed', blockHeight: 42 };
    const decoded = decodePost(encodePost(post));
    expect(decoded).toEqual(post);
  });

  it('encoding is deterministic', () => {
    const post = makePost();
    const a = encodePost(post);
    const b = encodePost(post);
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('round-trips a SlotToken', () => {
    const token = makeSlotToken();
    const decoded = decodeSlotToken(encodeSlotToken(token));
    expect(decoded).toEqual(token);
  });

  it('SlotToken encoding is deterministic', () => {
    const token = makeSlotToken();
    const a = encodeSlotToken(token);
    const b = encodeSlotToken(token);
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('decodePost throws on garbage bytes', () => {
    expect(() => decodePost(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow();
  });

  it('decodeSlotToken throws on garbage bytes', () => {
    expect(() => decodeSlotToken(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow();
  });
});
