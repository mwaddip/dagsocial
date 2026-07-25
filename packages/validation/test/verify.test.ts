import { describe, it, expect } from 'vitest';
import { createHash, sign, createPrivateKey } from 'crypto';
import {
  verifyPoW,
  verifyPostSignature,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifySubBlockStructure,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyBlockChainLink,
  blockHash,
} from '../src/verify.js';
import { generateKeyPair, computePostId, signingHash, EMPTY_STATE_ROOT } from '@dagsocial/types';
import type { Post, SubBlock, OrderingBlock, UtxoTransaction } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// verifyPoW
// ---------------------------------------------------------------------------

describe('verifyPoW', () => {
  it('accepts a valid PoW solution', () => {
    const input = Buffer.from('test input');
    let nonce = 0;
    const targetBits = 4;
    // Find a valid nonce
    while (nonce < 100000) {
      if (verifyPoW(input, nonce, targetBits)) break;
      nonce++;
    }
    expect(verifyPoW(input, nonce, targetBits)).toBe(true);
  });

  it('rejects an invalid PoW solution', () => {
    const input = Buffer.from('test input');
    expect(verifyPoW(input, 0, 20)).toBe(false);
  });

  it('verifies the same solution consistently', () => {
    const input = Buffer.from('hello world');
    let nonce = 0;
    while (nonce < 100000 && !verifyPoW(input, nonce, 4)) nonce++;
    for (let i = 0; i < 5; i++) {
      expect(verifyPoW(input, nonce, 4)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// verifyPostSignature
// ---------------------------------------------------------------------------

describe('verifyPostSignature', () => {
  it('accepts a valid Ed25519 signature', () => {
    const kp = generateKeyPair();
    const post: Post = {
      content: 'hello',
      author: kp.publicKey,
      parentRefs: [],
      challenge: new Uint8Array(32),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: Date.now(),
      signature: new Uint8Array(64), // placeholder
    };
    // Sign the post
    const sig = sign(null, signingHash(post), createPrivateKey({ key: Buffer.from(kp.secretKey), format: 'der', type: 'pkcs8' }));
    post.signature = new Uint8Array(sig);
    expect(verifyPostSignature(post, kp.publicKey)).toBe(true);
  });

  it('rejects a signature with wrong public key', () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    const post: Post = {
      content: 'hello',
      author: kp1.publicKey,
      parentRefs: [],
      challenge: new Uint8Array(32),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: Date.now(),
      signature: new Uint8Array(64),
    };
    const sig = sign(null, signingHash(post), createPrivateKey({ key: Buffer.from(kp1.secretKey), format: 'der', type: 'pkcs8' }));
    post.signature = new Uint8Array(sig);
    expect(verifyPostSignature(post, kp2.publicKey)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const kp = generateKeyPair();
    const post: Post = {
      content: 'hello',
      author: kp.publicKey,
      parentRefs: [],
      challenge: new Uint8Array(32),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: Date.now(),
      signature: new Uint8Array(64),
    };
    const sig = sign(null, signingHash(post), createPrivateKey({ key: Buffer.from(kp.secretKey), format: 'der', type: 'pkcs8' }));
    // Tamper with one byte
    const tampered = new Uint8Array(sig);
    tampered[0] = (tampered[0]! + 1) % 256;
    post.signature = tampered;
    expect(verifyPostSignature(post, kp.publicKey)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyProtocolVersion
// ---------------------------------------------------------------------------

describe('verifyProtocolVersion', () => {
  it('accepts version 1', () => {
    expect(verifyProtocolVersion(1)).toBe(true);
  });

  it('rejects version 0', () => {
    expect(verifyProtocolVersion(0)).toBe(false);
  });

  it('rejects version 2', () => {
    expect(verifyProtocolVersion(2)).toBe(false);
  });

  it('rejects version 999', () => {
    expect(verifyProtocolVersion(999)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyContentLimits
// ---------------------------------------------------------------------------

describe('verifyContentLimits', () => {
  it('accepts content within limits', () => {
    expect(verifyContentLimits('hello')).toEqual({ valid: true });
  });

  it('rejects empty content', () => {
    expect(verifyContentLimits('')).toEqual({ valid: false, error: 'Content is empty' });
  });

  it('rejects content exceeding 300 bytes', () => {
    const long = 'x'.repeat(301);
    expect(verifyContentLimits(long)).toEqual({ valid: false, error: 'Content exceeds max length' });
  });

  it('accepts exactly 300 bytes', () => {
    const exact = 'x'.repeat(300);
    expect(verifyContentLimits(exact)).toEqual({ valid: true });
  });

  it('accepts 1-byte content', () => {
    expect(verifyContentLimits('x')).toEqual({ valid: true });
  });

  it('counts UTF-8 bytes not characters', () => {
    // '€' is 3 bytes in UTF-8
    const euros = '€'.repeat(100); // 300 bytes
    expect(verifyContentLimits(euros)).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// verifyParentRefsCount
// ---------------------------------------------------------------------------

describe('verifyParentRefsCount', () => {
  it('accepts 0 parent refs', () => {
    expect(verifyParentRefsCount([])).toEqual({ valid: true });
  });

  it('accepts up to 8 parent refs', () => {
    const refs = Array.from({ length: 8 }, (_, i) => `ref${i}`);
    expect(verifyParentRefsCount(refs)).toEqual({ valid: true });
  });

  it('rejects 9 parent refs', () => {
    const refs = Array.from({ length: 9 }, (_, i) => `ref${i}`);
    expect(verifyParentRefsCount(refs).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifySubBlockStructure
// ---------------------------------------------------------------------------

describe('verifySubBlockStructure', () => {
  const makeBasePost = (): Post => ({
    content: 'test',
    author: 'user1',
    parentRefs: [],
    challenge: new Uint8Array(32),
    powNonce: 0,
    protocolVersion: 1,
    timestamp: Date.now(),
    signature: new Uint8Array(64),
  });

  it('accepts a valid sub-block', () => {
    const sb: SubBlock = {
      subBlockId: computePostId(makeBasePost()),
      post: makeBasePost(),
      likeBoxes: [],
      producerId: 'user1',
      protocolVersion: 1,
    };
    expect(verifySubBlockStructure(sb)).toEqual({ valid: true });
  });

  it('rejects sub-block missing post', () => {
    const sb = {
      subBlockId: 'abc',
      likeBoxes: [],
      producerId: 'user1',
      protocolVersion: 1,
    } as unknown as SubBlock;
    expect(verifySubBlockStructure(sb).valid).toBe(false);
  });

  it('rejects sub-block with non-array likeBoxes', () => {
    const sb = {
      subBlockId: 'abc',
      post: makeBasePost(),
      likeBoxes: 'not-an-array',
      producerId: 'user1',
      protocolVersion: 1,
    } as unknown as SubBlock;
    expect(verifySubBlockStructure(sb).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyTxStructure
// ---------------------------------------------------------------------------

describe('verifyTxStructure', () => {
  it('accepts a valid transaction', () => {
    const tx: UtxoTransaction = {
      inputs: ['input1'],
      outputs: [{ boxType: 'karma', value: 5, createdAtBlock: 1, owner: new Uint8Array(32), guard: 'owner_signature', proofSource: 'abc', lastTouchBlock: 1 }],
      signatures: {},
      protocolVersion: 1,
    };
    expect(verifyTxStructure(tx)).toEqual({ valid: true });
  });

  it('rejects transaction with no inputs', () => {
    const tx: UtxoTransaction = {
      inputs: [],
      outputs: [{ boxType: 'karma', value: 5, createdAtBlock: 1, owner: new Uint8Array(32), guard: 'owner_signature', proofSource: 'abc', lastTouchBlock: 1 }],
      signatures: {},
      protocolVersion: 1,
    };
    expect(verifyTxStructure(tx).valid).toBe(false);
  });

  it('rejects transaction with no outputs', () => {
    const tx: UtxoTransaction = {
      inputs: ['input1'],
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    };
    expect(verifyTxStructure(tx).valid).toBe(false);
  });

  it('rejects transaction with duplicate inputs', () => {
    const tx: UtxoTransaction = {
      inputs: ['input1', 'input1'],
      outputs: [{ boxType: 'karma', value: 5, createdAtBlock: 1, owner: new Uint8Array(32), guard: 'owner_signature', proofSource: 'abc', lastTouchBlock: 1 }],
      signatures: {},
      protocolVersion: 1,
    };
    expect(verifyTxStructure(tx).valid).toBe(false);
  });

  it('rejects transaction missing protocolVersion', () => {
    const tx = {
      inputs: ['input1'],
      outputs: [{ boxType: 'karma', value: 5 }],
      signatures: {},
    } as unknown as UtxoTransaction;
    expect(verifyTxStructure(tx).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyOrderingBlockStructure
// ---------------------------------------------------------------------------

describe('verifyOrderingBlockStructure', () => {
  const makeValidBlock = (): OrderingBlock => ({
    header: {
      protocolVersion: 1,
      height: 1,
      prevBlockHash: '0'.repeat(64),
      subBlockRoot: '00'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: new Uint8Array(32).fill(1),
      powNonce: 0,
      powTargetBits: 12,
      createdAt: Date.now(),
    },
    subBlockTree: {
      subBlockRefs: [],
      stumpIds: [],
    },
    utxoTxTree: {
      utxoTxIds: [],
      likeBoxIds: [],
      coinbaseOutputs: [],
    },
    validatorSignature: new Uint8Array(64),
  });

  it('accepts a valid ordering block', () => {
    expect(verifyOrderingBlockStructure(makeValidBlock())).toEqual({ valid: true });
  });

  it('rejects block missing prevBlockHash', () => {
    const block = {
      ...makeValidBlock(),
      header: { ...makeValidBlock().header, prevBlockHash: '' },
    };
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects block with invalid validatorSignature length', () => {
    const block = { ...makeValidBlock(), validatorSignature: new Uint8Array(32) };
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects block with height 0', () => {
    const block = {
      ...makeValidBlock(),
      header: { ...makeValidBlock().header, height: 0 },
    };
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects block missing protocolVersion', () => {
    const block = {
      ...makeValidBlock(),
      header: { ...makeValidBlock().header, protocolVersion: undefined },
    } as unknown as OrderingBlock;
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects block with empty hash', () => {
    // Block hash is computed from header, not stored. The structure validator
    // checks for missing header — an empty prevBlockHash triggers that path.
    const block = {
      ...makeValidBlock(),
      header: { ...makeValidBlock().header, prevBlockHash: '', height: 0 },
    };
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyBlockChainLink
// ---------------------------------------------------------------------------

describe('verifyBlockChainLink', () => {
  const makeBlock = (height: number, prevHash: string): OrderingBlock => ({
    header: {
      protocolVersion: 1,
      height,
      prevBlockHash: prevHash,
      subBlockRoot: '00'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: new Uint8Array(32).fill(1),
      powNonce: 0,
      powTargetBits: 12,
      createdAt: Date.now(),
    },
    subBlockTree: {
      subBlockRefs: [],
      stumpIds: [],
    },
    utxoTxTree: {
      utxoTxIds: [],
      likeBoxIds: [],
      coinbaseOutputs: [],
    },
    validatorSignature: new Uint8Array(64),
  });

  it('accepts a valid chain link', () => {
    const prev = makeBlock(1, '0000');
    const prevHash = blockHash(prev.header);
    const next = makeBlock(2, prevHash);
    expect(verifyBlockChainLink(next, prev)).toBe(true);
  });

  it('rejects mismatched prevBlockHash', () => {
    const prev = makeBlock(1, '0000');
    const next = makeBlock(2, 'wronghash');
    expect(verifyBlockChainLink(next, prev)).toBe(false);
  });

  it('rejects non-sequential height', () => {
    const prev = makeBlock(1, '0000');
    const prevHash = blockHash(prev.header);
    const next = makeBlock(3, prevHash);
    expect(verifyBlockChainLink(next, prev)).toBe(false);
  });
});
