import { describe, it, expect } from 'vitest';
import {
  verifyContentLimits,
  verifyParentRefsCount,
} from '@dagsocial/validation';
import type { NetValidators } from '../src/types.js';

// Unit tests for Stage 1 validation logic (extracted for testability)

function runStage1SubBlock(
  sb: any,
  v: NetValidators,
): { valid: boolean; error?: string } {
  const struct = v.verifySubBlockStructure(sb);
  if (!struct.valid) return struct;
  const post = sb.post;
  const content = verifyContentLimits(post.content);
  if (!content.valid) return content;
  const refs = verifyParentRefsCount(post.parentRefs || []);
  if (!refs.valid) return refs;
  if (!v.verifyProtocolVersion(post.protocolVersion ?? 1)) {
    return { valid: false, error: 'Unsupported protocol version' };
  }
  return { valid: true };
}

function makeMockValidators(): NetValidators {
  return {
    verifyPoW: () => true,
    verifyPostSignature: () => true,
    verifyProtocolVersion: (v: number) => v === 1,
    verifyContentLimits,
    verifyParentRefsCount,
    verifySubBlockStructure: (sb: any) => {
      if (!sb.post) return { valid: false, error: 'Sub-block missing post' };
      if (!sb.subBlockId) return { valid: false, error: 'Sub-block missing subBlockId' };
      if (!Array.isArray(sb.likeBoxes)) return { valid: false, error: 'Sub-block likeBoxes must be an array' };
      if (typeof sb.protocolVersion !== 'number') return { valid: false, error: 'Sub-block missing protocolVersion' };
      if (!sb.producerId) return { valid: false, error: 'Sub-block missing producerId' };
      return { valid: true };
    },
    verifyTxStructure: () => ({ valid: true } as const),
    verifyOrderingBlockStructure: () => ({ valid: true } as const),
  };
}

describe('Stage 1 sub-block validation', () => {
  const validators = makeMockValidators();

  it('accepts a valid sub-block', () => {
    const sb = {
      post: { content: 'hello', author: 'user1', parentRefs: [], challenge: new Uint8Array(32), powNonce: 0, protocolVersion: 1, timestamp: Date.now(), signature: new Uint8Array(64) },
      subBlockId: 'abc123',
      likeBoxes: [],
      producerId: 'user1',
      protocolVersion: 1,
    };
    expect(runStage1SubBlock(sb, validators)).toEqual({ valid: true });
  });

  it('rejects empty content', () => {
    const sb = {
      post: { content: '', author: 'user1', parentRefs: [], protocolVersion: 1 },
      subBlockId: 'abc',
      likeBoxes: [],
      producerId: 'user1',
      protocolVersion: 1,
    };
    const result = runStage1SubBlock(sb, validators);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Content is empty');
  });

  it('rejects content exceeding 300 bytes', () => {
    const sb = {
      post: { content: 'x'.repeat(301), author: 'user1', parentRefs: [], protocolVersion: 1 },
      subBlockId: 'abc',
      likeBoxes: [],
      producerId: 'user1',
      protocolVersion: 1,
    };
    expect(runStage1SubBlock(sb, validators).valid).toBe(false);
  });

  it('rejects too many parent refs', () => {
    const sb = {
      post: { content: 'hello', author: 'user1', parentRefs: Array.from({ length: 9 }, (_, i) => `ref${i}`), protocolVersion: 1 },
      subBlockId: 'abc',
      likeBoxes: [],
      producerId: 'user1',
      protocolVersion: 1,
    };
    expect(runStage1SubBlock(sb, validators).valid).toBe(false);
  });

  it('rejects unsupported protocol version', () => {
    const sb = {
      post: { content: 'hello', author: 'user1', parentRefs: [], protocolVersion: 999 },
      subBlockId: 'abc',
      likeBoxes: [],
      producerId: 'user1',
      protocolVersion: 1,
    };
    expect(runStage1SubBlock(sb, validators).valid).toBe(false);
  });

  it('rejects sub-block with missing post', () => {
    const sb = {
      subBlockId: 'abc',
      likeBoxes: [],
      producerId: 'user1',
      protocolVersion: 1,
    };
    expect(runStage1SubBlock(sb, validators).valid).toBe(false);
  });

  it('rejects sub-block with non-array likeBoxes', () => {
    const sb = {
      post: { content: 'hello', author: 'user1', parentRefs: [], protocolVersion: 1 },
      subBlockId: 'abc',
      likeBoxes: 'not-array',
      producerId: 'user1',
      protocolVersion: 1,
    };
    expect(runStage1SubBlock(sb, validators).valid).toBe(false);
  });
});
