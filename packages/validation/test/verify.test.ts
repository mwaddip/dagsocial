import { describe, it, expect } from 'vitest';
import { createHash, sign, createPrivateKey } from 'crypto';
import { readFileSync } from 'fs';
import {
  verifyPoW,
  verifyPostSignature,
  verifyValidatorSignature,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyContentCharacters,
  verifyParentRefsCount,
  verifySubBlockStructure,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyBlockChainLink,
  verifyOrderingBlockPoW,
  blockHash,
  isValidVouchTarget,
} from '../src/verify.js';
import { isDisallowedContentCodepoint, PINNED_UNICODE_VERSION } from '../src/content-charset.js';
import { generateKeyPair, computePostId, signingHash, EMPTY_STATE_ROOT } from '@dagsocial/types';
import type { Post, SubBlock, SubBlockEntry, PruneEntry, BlockHeader, OrderingBlock, UtxoTransaction } from '@dagsocial/types';

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
// verifyValidatorSignature
// ---------------------------------------------------------------------------

describe('verifyValidatorSignature', () => {
  type KeyPair = ReturnType<typeof generateKeyPair>;

  const privKeyOf = (kp: KeyPair) =>
    createPrivateKey({ key: Buffer.from(kp.secretKey), format: 'der', type: 'pkcs8' });

  const makeHeader = (over: Partial<BlockHeader> = {}): BlockHeader => ({
    protocolVersion: 1,
    height: 7,
    prevBlockHash: 'ab'.repeat(32),
    subBlockRoot: '11'.repeat(32),
    utxoTxRoot: '22'.repeat(32),
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: new Uint8Array(32),
    powNonce: 12345,
    powTargetBits: 4,
    createdAt: 1_700_000_000_000,
    ...over,
  });

  /** Sign exactly what the block creator signs: the 32 raw bytes of blockHash(header). */
  const signHeader = (header: BlockHeader, kp: KeyPair): Uint8Array =>
    new Uint8Array(sign(null, Buffer.from(blockHash(header), 'hex'), privKeyOf(kp)));

  it('accepts a correctly signed header', () => {
    const kp = generateKeyPair();
    const header = makeHeader({ validatorId: kp.publicKey });
    expect(verifyValidatorSignature(header, signHeader(header, kp))).toBe(true);
  });

  it('rejects a signature made by a key other than validatorId (forged authorship)', () => {
    const kpA = generateKeyPair();
    const kpB = generateKeyPair();
    // The header claims B produced the block; A actually signed it.
    const header = makeHeader({ validatorId: kpB.publicKey });
    expect(verifyValidatorSignature(header, signHeader(header, kpA))).toBe(false);
  });

  it('rejects a tampered header — the recomputed blockHash no longer matches', () => {
    const kp = generateKeyPair();
    const header = makeHeader({ validatorId: kp.publicKey });
    const sig = signHeader(header, kp);
    expect(verifyValidatorSignature({ ...header, height: 8 }, sig)).toBe(false);
    expect(verifyValidatorSignature({ ...header, utxoTxRoot: '33'.repeat(32) }, sig)).toBe(false);
    expect(verifyValidatorSignature({ ...header, powNonce: 12346 }, sig)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const kp = generateKeyPair();
    const header = makeHeader({ validatorId: kp.publicKey });
    const sig = signHeader(header, kp);
    sig[0] = (sig[0]! + 1) % 256;
    expect(verifyValidatorSignature(header, sig)).toBe(false);
  });

  it('rejects an all-zero placeholder signature', () => {
    const kp = generateKeyPair();
    const header = makeHeader({ validatorId: kp.publicKey });
    expect(verifyValidatorSignature(header, new Uint8Array(64))).toBe(false);
  });

  // --- no-panic (M-5): every malformed shape returns false, never throws ---

  it('returns false without throwing on a missing or mis-typed signature', () => {
    const kp = generateKeyPair();
    const header = makeHeader({ validatorId: kp.publicKey });
    for (const bad of [undefined, null, 'abc', 42, {}, [], new Uint32Array(16)]) {
      expect(() => verifyValidatorSignature(header, bad as any)).not.toThrow();
      expect(verifyValidatorSignature(header, bad as any)).toBe(false);
    }
  });

  it('returns false without throwing on a wrong-length signature', () => {
    const kp = generateKeyPair();
    const header = makeHeader({ validatorId: kp.publicKey });
    for (const len of [0, 32, 63, 65, 128]) {
      expect(() => verifyValidatorSignature(header, new Uint8Array(len))).not.toThrow();
      expect(verifyValidatorSignature(header, new Uint8Array(len))).toBe(false);
    }
  });

  it('returns false without throwing when validatorId is not 32 bytes (createPublicKey)', () => {
    const kp = generateKeyPair();
    const sig = signHeader(makeHeader({ validatorId: kp.publicKey }), kp);
    for (const len of [0, 31, 33, 64]) {
      const header = makeHeader({ validatorId: new Uint8Array(len) });
      expect(() => verifyValidatorSignature(header, sig)).not.toThrow();
      expect(verifyValidatorSignature(header, sig)).toBe(false);
    }
    // 32 bytes that are not a valid curve point must still reject cleanly.
    const offCurve = makeHeader({ validatorId: new Uint8Array(32).fill(0xff) });
    expect(() => verifyValidatorSignature(offCurve, sig)).not.toThrow();
    expect(verifyValidatorSignature(offCurve, sig)).toBe(false);
  });

  it('returns false without throwing on a header that encodeHeader would reject', () => {
    const kp = generateKeyPair();
    const sig = signHeader(makeHeader({ validatorId: kp.publicKey }), kp);
    const bad: unknown[] = [
      null,
      undefined,
      'not-a-header',
      42,
      makeHeader({ prevBlockHash: Symbol('s') as any }),
      makeHeader({ validatorId: undefined as any }),
      makeHeader({ validatorId: 'hex-string' as any }),
      makeHeader({ height: undefined as any }),
      makeHeader({ stateRoot: Symbol('r') as any }),
      makeHeader({ createdAt: (() => 1) as any }),
    ];
    for (const h of bad) {
      expect(() => verifyValidatorSignature(h as any, sig)).not.toThrow();
      expect(verifyValidatorSignature(h as any, sig)).toBe(false);
    }
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
// verifyContentCharacters
// ---------------------------------------------------------------------------

describe('verifyContentCharacters', () => {
  it('accepts plain ASCII text', () => {
    expect(verifyContentCharacters('hello world')).toEqual({ valid: true });
  });

  it('accepts text with newlines', () => {
    expect(verifyContentCharacters('line1\nline2\nline3')).toEqual({ valid: true });
  });

  it('accepts Unicode letters and marks', () => {
    expect(verifyContentCharacters('Café résumé naïve')).toEqual({ valid: true });
  });

  it('accepts CJK characters', () => {
    expect(verifyContentCharacters('你好世界')).toEqual({ valid: true });
  });

  it('accepts emoji', () => {
    expect(verifyContentCharacters('hello 👋 world 🌍')).toEqual({ valid: true });
  });

  it('accepts punctuation and symbols', () => {
    expect(verifyContentCharacters('Hello! How are you? #excited')).toEqual({ valid: true });
  });

  it('accepts numbers', () => {
    expect(verifyContentCharacters('12345')).toEqual({ valid: true });
  });

  it('accepts empty string', () => {
    // Character check passes; content length is enforced separately by verifyContentLimits
    expect(verifyContentCharacters('')).toEqual({ valid: true });
  });

  it('rejects null byte', () => {
    expect(verifyContentCharacters('hello world').valid).toBe(false);
  });

  it('rejects backspace', () => {
    expect(verifyContentCharacters('hello\bworld').valid).toBe(false);
  });

  it('rejects tab', () => {
    expect(verifyContentCharacters('hello\tworld').valid).toBe(false);
  });

  it('rejects carriage return', () => {
    expect(verifyContentCharacters('hello\rworld').valid).toBe(false);
  });

  it('rejects escape sequence', () => {
    expect(verifyContentCharacters('helloworld').valid).toBe(false);
  });

  it('rejects zero-width space (U+200B)', () => {
    expect(verifyContentCharacters('hello​world').valid).toBe(false);
  });

  it('rejects zero-width non-joiner (U+200C)', () => {
    expect(verifyContentCharacters('hello‌world').valid).toBe(false);
  });

  it('rejects zero-width joiner (U+200D)', () => {
    expect(verifyContentCharacters('hello‍world').valid).toBe(false);
  });

  it('rejects BOM (U+FEFF)', () => {
    expect(verifyContentCharacters('﻿hello').valid).toBe(false);
  });

  it('rejects bidi override LTR (U+202D)', () => {
    expect(verifyContentCharacters('hello‭world').valid).toBe(false);
  });

  it('rejects bidi override RTL (U+202E)', () => {
    expect(verifyContentCharacters('hello‮world').valid).toBe(false);
  });

  it('rejects bidi isolate chars (U+2066-U+2069)', () => {
    expect(verifyContentCharacters('hello⁦world').valid).toBe(false);
    expect(verifyContentCharacters('hello⁧world').valid).toBe(false);
    expect(verifyContentCharacters('hello⁨world').valid).toBe(false);
    expect(verifyContentCharacters('hello⁩world').valid).toBe(false);
  });

  it('rejects soft hyphen (U+00AD)', () => {
    // U+00AD is Cf (format), not Pd (punctuation dash)
    expect(verifyContentCharacters('hello­world').valid).toBe(false);
  });

  it('rejects private use area (U+E000)', () => {
    expect(verifyContentCharacters('helloworld').valid).toBe(false);
  });

  it('rejects string that is entirely disallowed chars', () => {
    expect(verifyContentCharacters('​‌‍').valid).toBe(false);
  });

  it('provides a useful error message', () => {
    const result = verifyContentCharacters('bad​char');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('disallowed characters');
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
      subBlockEntries: [],
      pruneEntries: [],
    },
    utxoTxTree: {
      utxoTxIds: [],
      utxoTxs: [],
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

  it('rejects block with subBlockEntries misaligned with subBlockRefs', () => {
    const block = makeValidBlock();
    block.subBlockTree.subBlockRefs = ['aa'.repeat(32)];
    block.subBlockTree.subBlockEntries = []; // misaligned — 1 ref, 0 entries
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects subBlockEntries with invalid postId', () => {
    const block = makeValidBlock();
    block.subBlockTree.subBlockRefs = ['aa'.repeat(32)];
    block.subBlockTree.subBlockEntries = [
      { postId: 'too-short', parentRefs: [], author: 'cc'.repeat(32) },
    ];
    const result = verifyOrderingBlockStructure(block);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invalid postId');
  });

  it('accepts a subBlockEntry with a 64-char author (control for the author check)', () => {
    const block = makeValidBlock();
    block.subBlockTree.subBlockRefs = ['aa'.repeat(32)];
    block.subBlockTree.subBlockEntries = [
      { postId: 'aa'.repeat(32), parentRefs: [], author: 'cc'.repeat(32) },
    ];
    expect(verifyOrderingBlockStructure(block)).toEqual({ valid: true });
  });

  it('rejects subBlockEntries with a missing author', () => {
    const block = makeValidBlock();
    block.subBlockTree.subBlockRefs = ['aa'.repeat(32)];
    block.subBlockTree.subBlockEntries = [
      { postId: 'aa'.repeat(32), parentRefs: [] } as unknown as SubBlockEntry,
    ];
    const result = verifyOrderingBlockStructure(block);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invalid author');
  });

  it('rejects subBlockEntries with a wrong-length author', () => {
    const block = makeValidBlock();
    block.subBlockTree.subBlockRefs = ['aa'.repeat(32)];
    block.subBlockTree.subBlockEntries = [
      { postId: 'aa'.repeat(32), parentRefs: [], author: 'too-short' },
    ];
    const result = verifyOrderingBlockStructure(block);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invalid author');
  });

  it('rejects block with utxoTxs misaligned with utxoTxIds', () => {
    const block = makeValidBlock();
    block.utxoTxTree.utxoTxIds = ['bb'.repeat(32)];
    block.utxoTxTree.utxoTxs = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]; // 1 id, 2 txs
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects block missing utxoTxTree.utxoTxIds', () => {
    const block = {
      ...makeValidBlock(),
      utxoTxTree: {
        utxoTxs: [],
        likeBoxIds: [],
        coinbaseOutputs: [],
      },
    } as unknown as OrderingBlock;
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  // -------------------------------------------------------------------------
  // pruneEntries
  //
  // These fields are the ones block application feeds to `Buffer.from(...)`
  // and `createHash().update(...)`, so a wrong *type* here is not a cosmetic
  // defect: it throws inside the apply funnel. Nothing else validates them.
  // -------------------------------------------------------------------------

  /** A prune entry that is well-formed in every field the structure check reads. */
  const makeValidPruneEntry = (): PruneEntry => ({
    rootPostHash: 'aa'.repeat(32),
    subtreePostIds: ['aa'.repeat(32), 'bb'.repeat(32)],
    subtreeMerkleRoot: new Uint8Array(32).fill(7),
    authorId: new Uint8Array(32).fill(3),
    authorSignature: new Uint8Array(64).fill(9),
    trigger: 'author',
  });

  /** The valid block, carrying one prune entry with `over` applied to it. */
  const blockWithPrune = (over: Record<string, unknown> = {}): OrderingBlock => {
    const block = makeValidBlock();
    block.subBlockTree.pruneEntries = [
      { ...makeValidPruneEntry(), ...over } as unknown as PruneEntry,
    ];
    return block;
  };

  it('accepts a well-formed prune entry (control for every rejection below)', () => {
    expect(verifyOrderingBlockStructure(blockWithPrune())).toEqual({ valid: true });
  });

  it('accepts the "storage_prune" trigger', () => {
    expect(verifyOrderingBlockStructure(blockWithPrune({ trigger: 'storage_prune' })))
      .toEqual({ valid: true });
  });

  it('rejects a block with no pruneEntries field at all', () => {
    const block = makeValidBlock();
    delete (block.subBlockTree as unknown as Record<string, unknown>).pruneEntries;
    const result = verifyOrderingBlockStructure(block);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('pruneEntries');
  });

  it('rejects a non-array pruneEntries', () => {
    const block = makeValidBlock();
    (block.subBlockTree as unknown as Record<string, unknown>).pruneEntries = 'nope';
    expect(verifyOrderingBlockStructure(block).valid).toBe(false);
  });

  it('rejects a prune entry that is not an object', () => {
    const block = makeValidBlock();
    (block.subBlockTree as unknown as Record<string, unknown>).pruneEntries = [42];
    const result = verifyOrderingBlockStructure(block);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('pruneEntry is not an object');
  });

  // Each case below deviates from `makeValidPruneEntry()` in exactly one field,
  // and the control above proves the rest of the entry passes — so what each
  // one measures is that field and nothing else. The distinct-error assertion
  // at the end proves no two of them are being rejected for the same reason.
  const REJECTED_SHAPES: Array<{ name: string; over: Record<string, unknown>; error: string }> = [
    { name: 'rootPostHash too short', over: { rootPostHash: 'aa' }, error: 'invalid rootPostHash' },
    { name: 'rootPostHash not a string', over: { rootPostHash: 42 }, error: 'invalid rootPostHash' },
    { name: 'rootPostHash bytes, not hex', over: { rootPostHash: new Uint8Array(32) }, error: 'invalid rootPostHash' },
    { name: 'subtreePostIds not an array', over: { subtreePostIds: 'aa'.repeat(32) }, error: 'invalid subtreePostIds' },
    { name: 'subtreePostIds holds a non-string', over: { subtreePostIds: [42] }, error: 'subtreePostId must be 64-char hex' },
    { name: 'subtreePostIds holds a short string', over: { subtreePostIds: ['aa'] }, error: 'subtreePostId must be 64-char hex' },
    // The kill shot: a CBOR integer where 32 bytes belong. `Buffer.from(42)`
    // throws, and block apply reaches it with nothing in between.
    { name: 'subtreeMerkleRoot is a number', over: { subtreeMerkleRoot: 42 }, error: 'invalid subtreeMerkleRoot' },
    // Length-bearing impostors — what a `.length`-only check would wave through.
    { name: 'subtreeMerkleRoot is a 32-char string', over: { subtreeMerkleRoot: 'a'.repeat(32) }, error: 'invalid subtreeMerkleRoot' },
    { name: 'subtreeMerkleRoot is {length: 32}', over: { subtreeMerkleRoot: { length: 32 } }, error: 'invalid subtreeMerkleRoot' },
    { name: 'subtreeMerkleRoot is a 32-element array', over: { subtreeMerkleRoot: new Array(32).fill(0) }, error: 'invalid subtreeMerkleRoot' },
    // Right type, wrong width — an 8-byte key or root is not a key or root.
    { name: 'subtreeMerkleRoot is 31 bytes', over: { subtreeMerkleRoot: new Uint8Array(31) }, error: 'invalid subtreeMerkleRoot' },
    { name: 'subtreeMerkleRoot is a Uint32Array', over: { subtreeMerkleRoot: new Uint32Array(8) }, error: 'invalid subtreeMerkleRoot' },
    { name: 'subtreeMerkleRoot missing', over: { subtreeMerkleRoot: undefined }, error: 'invalid subtreeMerkleRoot' },
    { name: 'authorId is a 32-char string', over: { authorId: 'a'.repeat(32) }, error: 'invalid authorId' },
    { name: 'authorId is {length: 32}', over: { authorId: { length: 32 } }, error: 'invalid authorId' },
    { name: 'authorId is 33 bytes', over: { authorId: new Uint8Array(33) }, error: 'invalid authorId' },
    { name: 'authorId missing', over: { authorId: undefined }, error: 'invalid authorId' },
    { name: 'authorSignature is a 64-char string', over: { authorSignature: 'a'.repeat(64) }, error: 'invalid authorSignature' },
    { name: 'authorSignature is {length: 64}', over: { authorSignature: { length: 64 } }, error: 'invalid authorSignature' },
    { name: 'authorSignature is 32 bytes', over: { authorSignature: new Uint8Array(32) }, error: 'invalid authorSignature' },
    { name: 'authorSignature missing', over: { authorSignature: undefined }, error: 'invalid authorSignature' },
    { name: 'trigger is an unknown string', over: { trigger: 'whatever' }, error: 'invalid trigger' },
    { name: 'trigger is missing', over: { trigger: undefined }, error: 'invalid trigger' },
    { name: 'trigger is a number', over: { trigger: 1 }, error: 'invalid trigger' },
  ];

  for (const shape of REJECTED_SHAPES) {
    it(`rejects a prune entry whose ${shape.name}`, () => {
      const result = verifyOrderingBlockStructure(blockWithPrune(shape.over));
      expect(result.valid).toBe(false);
      expect(result.error).toContain(shape.error);
    });
  }

  it('names the offending field distinctly for each prune-entry rejection', () => {
    // One error string per field, so an operator reading a rejection log can
    // tell which field the producer got wrong.
    const errors = new Set(REJECTED_SHAPES.map((s) => s.error));
    expect(errors.size).toBe(7);
    for (const shape of REJECTED_SHAPES) {
      expect(verifyOrderingBlockStructure(blockWithPrune(shape.over)).error).toContain(shape.error);
    }
  });

  it('never throws on a hostile prune entry', () => {
    for (const shape of REJECTED_SHAPES) {
      expect(() => verifyOrderingBlockStructure(blockWithPrune(shape.over))).not.toThrow();
    }
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
      subBlockEntries: [],
      pruneEntries: [],
    },
    utxoTxTree: {
      utxoTxIds: [],
      utxoTxs: [],
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

// ---------------------------------------------------------------------------
// isValidVouchTarget
// ---------------------------------------------------------------------------

describe('isValidVouchTarget', () => {
  it('accepts 32-byte Uint8Array', () => {
    expect(isValidVouchTarget(new Uint8Array(32).fill(0x42))).toBe(true);
  });

  it('rejects non-Uint8Array', () => {
    expect(isValidVouchTarget(Buffer.alloc(32) as any)).toBe(false);
  });

  it('rejects wrong length', () => {
    expect(isValidVouchTarget(new Uint8Array(31))).toBe(false);
    expect(isValidVouchTarget(new Uint8Array(33))).toBe(false);
  });

  it('rejects all zeros', () => {
    expect(isValidVouchTarget(new Uint8Array(32))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M-4 — version-independent content character check
// ---------------------------------------------------------------------------

describe('verifyContentCharacters — version-independent table (M-4)', () => {
  /** Wrap a bare codepoint in ASCII so a failure is about that codepoint only. */
  const cp = (n: number) => `ok${String.fromCodePoint(n)}ok`;

  it('pins a documented Unicode version', () => {
    expect(PINNED_UNICODE_VERSION).toBe('16.0');
  });

  it('never consults runtime Unicode category data', () => {
    // This is the whole of M-4: a `\p{...}` escape anywhere on the path would
    // reintroduce the Node/V8-version dependence the table exists to remove.
    // Scanned at source level, not via `Function.prototype.toString`, so a
    // property escape hidden in a module-level regex const is caught too.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const propertyEscape = /\\[pP]\{/;

    for (const file of ['../src/verify.ts', '../src/content-charset.ts']) {
      const code = stripComments(readFileSync(new URL(file, import.meta.url), 'utf8'));
      expect(propertyEscape.test(code), `${file} uses a Unicode property escape`).toBe(false);
    }
  });

  describe('known-dangerous codepoints stay rejected', () => {
    const dangerous: [string, number][] = [
      ['NUL U+0000', 0x0000],
      ['TAB U+0009', 0x0009],
      ['CR U+000D', 0x000d],
      ['DEL U+007F', 0x007f],
      ['SOFT HYPHEN U+00AD', 0x00ad],
      ['ZWSP U+200B', 0x200b],
      ['ZWJ U+200D', 0x200d],
      ['RLO U+202E', 0x202e],
      ['LRI U+2066', 0x2066],
      ['BOM U+FEFF', 0xfeff],
      ['lone surrogate U+D800', 0xd800],
      ['private use U+E000', 0xe000],
      ['LANGUAGE TAG U+E0001', 0xe0001],
      ['tag char U+E0041', 0xe0041],
      ['plane-15 private use U+F0000', 0xf0000],
      ['plane-16 private use U+100000', 0x100000],
    ];
    for (const [name, code] of dangerous) {
      it(`rejects ${name}`, () => {
        expect(verifyContentCharacters(cp(code)).valid).toBe(false);
      });
    }
  });

  describe('known-safe content stays allowed', () => {
    it('accepts ASCII letters', () => {
      expect(verifyContentCharacters('hello world').valid).toBe(true);
    });

    it('accepts a line feed', () => {
      expect(verifyContentCharacters('line1\u{000A}line2').valid).toBe(true);
    });

    it('accepts multi-byte letters', () => {
      expect(verifyContentCharacters('café 你好 Ωμέγα').valid).toBe(true);
    });

    it('accepts a plain emoji', () => {
      expect(verifyContentCharacters('wave \u{1F44B}').valid).toBe(true);
    });

    it('rejects a ZWJ emoji sequence — U+200D is a format char, as before', () => {
      expect(verifyContentCharacters('\u{1F468}\u{200D}\u{1F469}').valid).toBe(false);
    });
  });

  describe('frontier codepoints — the version-independence property', () => {
    // These are the codepoints whose category differs between Unicode data
    // versions. Under the old `\P{C}` check each flipped verdict as the
    // runtime's Unicode version moved, because `\P{C}` rejects `Cn`
    // (unassigned). The table allows `Cn`, so the verdict is now the same on
    // every build. Asserting the table against runtime `\p{}` instead would be
    // exactly the version-fragile test this replaces.

    it('allows U+11BC0 — assigned in Unicode 16.0, unassigned before it', () => {
      expect(verifyContentCharacters(cp(0x11bc0)).valid).toBe(true);
    });

    it('allows U+10940 — still unassigned at the pinned Unicode 16.0', () => {
      expect(verifyContentCharacters(cp(0x10940)).valid).toBe(true);
    });

    it('allows U+2065 — unassigned, inside the Cf run U+2060–U+206F', () => {
      expect(verifyContentCharacters(cp(0x2065)).valid).toBe(true);
    });

    it('allows the U+FFFE noncharacter — Cn, not Cc/Cf/Cs/Co', () => {
      expect(verifyContentCharacters(cp(0xfffe)).valid).toBe(true);
    });
  });

  describe('table boundaries', () => {
    it('allows U+000A but rejects both its neighbours', () => {
      expect(verifyContentCharacters('a\u{000A}b').valid).toBe(true);
      expect(verifyContentCharacters('a\u{0009}b').valid).toBe(false);
      expect(verifyContentCharacters('a\u{000B}b').valid).toBe(false);
    });

    it('allows the codepoint immediately outside each rejected run', () => {
      expect(verifyContentCharacters(cp(0x00a0)).valid).toBe(true); // past U+007F–U+009F
      expect(verifyContentCharacters(cp(0x00ae)).valid).toBe(true); // past U+00AD
      expect(verifyContentCharacters(cp(0x200a)).valid).toBe(true); // before U+200B
      expect(verifyContentCharacters(cp(0x2010)).valid).toBe(true); // past U+200F
      expect(verifyContentCharacters(cp(0xf900)).valid).toBe(true); // past U+D800–U+F8FF
    });

    it('classifies range edges exactly', () => {
      expect(isDisallowedContentCodepoint(0x0009)).toBe(true);
      expect(isDisallowedContentCodepoint(0x000a)).toBe(false);
      expect(isDisallowedContentCodepoint(0x000b)).toBe(true);
      expect(isDisallowedContentCodepoint(0xd7ff)).toBe(false);
      expect(isDisallowedContentCodepoint(0xd800)).toBe(true);
      expect(isDisallowedContentCodepoint(0xf8ff)).toBe(true);
      expect(isDisallowedContentCodepoint(0xf900)).toBe(false);
      expect(isDisallowedContentCodepoint(0x10fffd)).toBe(true);
      expect(isDisallowedContentCodepoint(0x10fffe)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// M-6 — integer guards on nonces and targetBits
// ---------------------------------------------------------------------------

describe('integer guards on nonce and targetBits (M-6)', () => {
  const input = Buffer.from('m-6 fixture');
  let goodNonce = 0;
  while (goodNonce < 100000 && !verifyPoW(input, goodNonce, 4)) goodNonce++;

  it('has a valid baseline solution to degrade from', () => {
    expect(verifyPoW(input, goodNonce, 4)).toBe(true);
  });

  const badNumbers: [string, number][] = [
    ['NaN', NaN],
    ['negative', -1],
    ['float', 1.5],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['past MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1],
    ['past u64', 2 ** 64],
  ];

  for (const [name, bad] of badNumbers) {
    it(`rejects a ${name} nonce`, () => {
      expect(verifyPoW(input, bad, 4)).toBe(false);
    });

    it(`rejects a ${name} targetBits`, () => {
      expect(verifyPoW(input, goodNonce, bad)).toBe(false);
    });
  }

  it('rejects a targetBits wider than the 256-bit digest', () => {
    // The old loop indexed past the end of the digest, where `undefined & mask`
    // coerces to 0. That only mis-accepted an all-zero digest (unreachable in
    // practice), unlike the NaN/Infinity cases above which accepted any hash.
    expect(verifyPoW(input, goodNonce, 257)).toBe(false);
    expect(verifyPoW(input, goodNonce, 1_000_000)).toBe(false);
  });

  it('still evaluates a satisfiable target at full digest width', () => {
    expect(verifyPoW(input, goodNonce, 256)).toBe(false);
    expect(verifyPoW(input, goodNonce, 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M-5 — no exported verify function throws on malformed input
// ---------------------------------------------------------------------------

/** Values that arrive off the wire wrongly typed, out of range, or hostile. */
const circular: Record<string, unknown> = { name: 'circular' };
circular.self = circular;

const MALFORMED: unknown[] = [
  undefined,
  null,
  true,
  false,
  0,
  -1,
  1.5,
  NaN,
  Infinity,
  -Infinity,
  Number.MAX_SAFE_INTEGER + 1,
  2 ** 64,
  -(2 ** 64),
  '',
  'x',
  'not-an-array',
  '0'.repeat(100),
  {},
  [],
  [null],
  [undefined],
  [Symbol('ref')],
  [123],
  Symbol('sym'),
  123n,
  new Uint8Array(0),
  new Uint8Array(31),
  new Uint8Array(33),
  new Uint32Array(8),
  Buffer.alloc(0),
  Buffer.alloc(64),
  () => 1,
  new Map(),
  new Set(),
  circular,
];

describe('no-panic on malformed input (M-5)', () => {
  const kp = generateKeyPair();

  const makeGoodPost = (): Post => {
    const post: Post = {
      content: 'hello',
      author: kp.publicKey,
      parentRefs: [],
      challenge: new Uint8Array(32),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: 1_700_000_000_000,
      signature: new Uint8Array(64),
    };
    const sig = sign(
      null,
      signingHash(post),
      createPrivateKey({ key: Buffer.from(kp.secretKey), format: 'der', type: 'pkcs8' }),
    );
    post.signature = new Uint8Array(sig);
    return post;
  };

  const makeHeader = (over: Partial<BlockHeader> = {}): BlockHeader => ({
    protocolVersion: 1,
    height: 1,
    prevBlockHash: '0'.repeat(64),
    subBlockRoot: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: new Uint8Array(32).fill(1),
    powNonce: 0,
    powTargetBits: 4,
    createdAt: 1_700_000_000_000,
    ...over,
  });

  const goodPost = makeGoodPost();
  const goodInput = Buffer.from('pow input');
  const goodBlock: OrderingBlock = {
    header: makeHeader(),
    subBlockTree: { subBlockRefs: [], subBlockEntries: [], pruneEntries: [] },
    utxoTxTree: { utxoTxIds: [], utxoTxs: [], likeBoxIds: [], coinbaseOutputs: [] },
    validatorSignature: new Uint8Array(64),
  };

  // --- the fuzz sweep: every argument position of every exported verify fn ---

  it('verifyPoW survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyPoW(bad as any, 0, 4)).not.toThrow();
      expect(() => verifyPoW(goodInput, bad as any, 4)).not.toThrow();
      expect(() => verifyPoW(goodInput, 0, bad as any)).not.toThrow();
      expect(() => verifyPoW(bad as any, bad as any, bad as any)).not.toThrow();
    }
  });

  it('verifyPostSignature survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyPostSignature(bad as any, kp.publicKey)).not.toThrow();
      expect(() => verifyPostSignature(goodPost, bad as any)).not.toThrow();
      expect(() => verifyPostSignature({ ...goodPost, content: bad } as any, kp.publicKey)).not.toThrow();
      expect(() => verifyPostSignature({ ...goodPost, author: bad } as any, kp.publicKey)).not.toThrow();
      expect(() => verifyPostSignature({ ...goodPost, parentRefs: bad } as any, kp.publicKey)).not.toThrow();
      expect(() => verifyPostSignature({ ...goodPost, challenge: bad } as any, kp.publicKey)).not.toThrow();
      expect(() => verifyPostSignature({ ...goodPost, signature: bad } as any, kp.publicKey)).not.toThrow();
      expect(() => verifyPostSignature({ ...goodPost, protocolVersion: bad } as any, kp.publicKey)).not.toThrow();
      expect(() => verifyPostSignature({ ...goodPost, timestamp: bad } as any, kp.publicKey)).not.toThrow();
    }
  });

  it('verifyValidatorSignature survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyValidatorSignature(bad as any, new Uint8Array(64))).not.toThrow();
      expect(() => verifyValidatorSignature(makeHeader(), bad as any)).not.toThrow();
      expect(() => verifyValidatorSignature(makeHeader({ validatorId: bad as any }), bad as any)).not.toThrow();
      expect(() => verifyValidatorSignature(makeHeader({ prevBlockHash: bad as any }), bad as any)).not.toThrow();
      expect(() => verifyValidatorSignature(makeHeader({ createdAt: bad as any }), bad as any)).not.toThrow();
    }
  });

  it('verifyContentLimits survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyContentLimits(bad as any)).not.toThrow();
    }
  });

  it('verifyContentCharacters survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyContentCharacters(bad as any)).not.toThrow();
    }
  });

  it('verifyParentRefsCount survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyParentRefsCount(bad as any)).not.toThrow();
    }
  });

  it('verifyProtocolVersion survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyProtocolVersion(bad as any)).not.toThrow();
    }
  });

  it('verifySubBlockStructure survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifySubBlockStructure(bad as any)).not.toThrow();
    }
  });

  it('verifyTxStructure survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyTxStructure(bad as any)).not.toThrow();
      expect(() => verifyTxStructure({ inputs: bad, outputs: bad, protocolVersion: 1 } as any)).not.toThrow();
    }
  });

  it('verifyOrderingBlockStructure survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyOrderingBlockStructure(bad as any)).not.toThrow();
      expect(() => verifyOrderingBlockStructure({ ...goodBlock, header: bad } as any)).not.toThrow();
      expect(() =>
        verifyOrderingBlockStructure({
          ...goodBlock,
          subBlockTree: { subBlockRefs: [bad], subBlockEntries: [bad], pruneEntries: [bad] },
        } as any),
      ).not.toThrow();
      expect(() =>
        verifyOrderingBlockStructure({
          ...goodBlock,
          subBlockTree: { subBlockRefs: [], subBlockEntries: [], pruneEntries: bad },
        } as any),
      ).not.toThrow();
      expect(() =>
        verifyOrderingBlockStructure({
          ...goodBlock,
          subBlockTree: {
            subBlockRefs: [],
            subBlockEntries: [],
            pruneEntries: [
              {
                rootPostHash: bad,
                subtreePostIds: bad,
                subtreeMerkleRoot: bad,
                authorId: bad,
                authorSignature: bad,
                trigger: bad,
              },
            ],
          },
        } as any),
      ).not.toThrow();
      expect(() =>
        verifyOrderingBlockStructure({
          ...goodBlock,
          utxoTxTree: { utxoTxIds: [], utxoTxs: [], likeBoxIds: [], coinbaseOutputs: [bad] },
        } as any),
      ).not.toThrow();
    }
  });

  it('verifyOrderingBlockPoW survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyOrderingBlockPoW(bad as any)).not.toThrow();
      expect(() => verifyOrderingBlockPoW(makeHeader({ powNonce: bad as any }))).not.toThrow();
      expect(() => verifyOrderingBlockPoW(makeHeader({ powTargetBits: bad as any }))).not.toThrow();
      expect(() => verifyOrderingBlockPoW(makeHeader({ validatorId: bad as any }))).not.toThrow();
      expect(() => verifyOrderingBlockPoW(makeHeader({ prevBlockHash: bad as any }))).not.toThrow();
    }
  });

  it('verifyBlockChainLink survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => verifyBlockChainLink(bad as any, goodBlock)).not.toThrow();
      expect(() => verifyBlockChainLink(goodBlock, bad as any)).not.toThrow();
      expect(() =>
        verifyBlockChainLink(goodBlock, { ...goodBlock, header: makeHeader({ validatorId: bad as any }) }),
      ).not.toThrow();
    }
  });

  it('isValidVouchTarget survives every malformed argument', () => {
    for (const bad of MALFORMED) {
      expect(() => isValidVouchTarget(bad as any)).not.toThrow();
    }
  });

  // --- the specific throw sites named in the audit ---

  it('rejects a public key that is not 32 bytes (createPublicKey)', () => {
    expect(verifyPostSignature(goodPost, new Uint8Array(31))).toBe(false);
    expect(verifyPostSignature(goodPost, new Uint8Array(33))).toBe(false);
    expect(verifyPostSignature(goodPost, new Uint8Array(0))).toBe(false);
    expect(verifyPostSignature(goodPost, 'not-a-key' as any)).toBe(false);
    // 32 bytes that are not a valid curve point must still reject cleanly.
    expect(verifyPostSignature(goodPost, new Uint8Array(32).fill(0xff))).toBe(false);
  });

  it('rejects a post whose shape would throw inside signingHash', () => {
    expect(verifyPostSignature({ ...goodPost, parentRefs: 'nope' } as any, kp.publicKey)).toBe(false);
    expect(verifyPostSignature({ ...goodPost, parentRefs: [Symbol('x')] } as any, kp.publicKey)).toBe(false);
    expect(verifyPostSignature({ ...goodPost, challenge: undefined } as any, kp.publicKey)).toBe(false);
    expect(verifyPostSignature({ ...goodPost, author: undefined } as any, kp.publicKey)).toBe(false);
    expect(verifyPostSignature({ ...goodPost, author: 42 } as any, kp.publicKey)).toBe(false);
    expect(verifyPostSignature({ ...goodPost, content: 42 } as any, kp.publicKey)).toBe(false);
    expect(verifyPostSignature({ ...goodPost, signature: 'abc' } as any, kp.publicKey)).toBe(false);
    expect(verifyPostSignature(null as any, kp.publicKey)).toBe(false);
  });

  it('rejects non-string content instead of throwing in Buffer.byteLength', () => {
    expect(verifyContentLimits(42 as any).valid).toBe(false);
    expect(verifyContentLimits(null as any).valid).toBe(false);
    expect(verifyContentLimits(undefined as any).valid).toBe(false);
    expect(verifyContentLimits({} as any).valid).toBe(false);
    expect(verifyContentCharacters(42 as any).valid).toBe(false);
    expect(verifyContentCharacters(null as any).valid).toBe(false);
  });

  it('rejects non-array parent refs instead of throwing on .length', () => {
    expect(verifyParentRefsCount('nope' as any).valid).toBe(false);
    expect(verifyParentRefsCount(null as any).valid).toBe(false);
    expect(verifyParentRefsCount({ length: 99 } as any).valid).toBe(false);
  });

  it('rejects a malformed ordering block header instead of throwing in CBOR', () => {
    expect(verifyOrderingBlockPoW(null as any)).toBe(false);
    expect(verifyOrderingBlockPoW(makeHeader({ prevBlockHash: Symbol('s') as any }))).toBe(false);
    expect(verifyOrderingBlockPoW(makeHeader({ validatorId: undefined as any }))).toBe(false);
    expect(verifyOrderingBlockPoW(makeHeader({ powNonce: NaN }))).toBe(false);
    expect(verifyOrderingBlockPoW(makeHeader({ powNonce: -1 }))).toBe(false);
    expect(verifyOrderingBlockPoW(makeHeader({ powNonce: 1.5 }))).toBe(false);
    expect(verifyOrderingBlockPoW(makeHeader({ powTargetBits: NaN }))).toBe(false);
    // Wider than the digest — the old loop accepted every hash here.
    expect(verifyOrderingBlockPoW(makeHeader({ powTargetBits: 1_000_000 }))).toBe(false);
    expect(verifyBlockChainLink(null as any, goodBlock)).toBe(false);
    expect(verifyBlockChainLink(goodBlock, null as any)).toBe(false);
  });

  // --- the happy path is unchanged ---

  it('leaves the happy path intact', () => {
    expect(verifyPostSignature(goodPost, kp.publicKey)).toBe(true);
    expect(verifyContentLimits('hello')).toEqual({ valid: true });
    expect(verifyContentCharacters('hello')).toEqual({ valid: true });
    expect(verifyParentRefsCount([])).toEqual({ valid: true });
    expect(verifyOrderingBlockStructure(goodBlock)).toEqual({ valid: true });

    let mined: BlockHeader | undefined;
    for (let n = 0; n < 100000; n++) {
      const candidate = makeHeader({ powNonce: n });
      if (verifyOrderingBlockPoW(candidate)) {
        mined = candidate;
        break;
      }
    }
    expect(mined).toBeDefined();
    expect(verifyOrderingBlockPoW(mined!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Numeric guard on the signable-post fields (M-6 follow-up to the P1 encoder)
// ---------------------------------------------------------------------------

describe('integer guards on protocolVersion and timestamp (M-6)', () => {
  const kp = generateKeyPair();
  const priv = createPrivateKey({
    key: Buffer.from(kp.secretKey),
    format: 'der',
    type: 'pkcs8',
  });

  /** A correctly signed post — the signature covers the *stated* fields. */
  const signedPost = (over: Partial<Post> = {}): Post => {
    const post: Post = {
      content: 'guard me',
      author: kp.publicKey,
      parentRefs: [],
      challenge: new Uint8Array(32).fill(7),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: 1_700_000_000_000,
      signature: new Uint8Array(64),
      ...over,
    };
    post.signature = new Uint8Array(sign(null, signingHash(post), priv));
    return post;
  };

  const OUT_OF_DOMAIN = [
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['negative', -1],
    ['fractional', 1.5],
    ['above the safe range', Number.MAX_SAFE_INTEGER + 2],
    ['not a number', '1700000000000'],
  ] as const;

  it.each(OUT_OF_DOMAIN)('rejects a %s timestamp without throwing', (_label, value) => {
    // Signed over the malformed field, so only the guard can reject it.
    const post = signedPost({ timestamp: value as number });
    let result: boolean | undefined;
    expect(() => {
      result = verifyPostSignature(post, kp.publicKey);
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it.each(OUT_OF_DOMAIN)('rejects a %s protocolVersion without throwing', (_label, value) => {
    const post = signedPost({ protocolVersion: value as number });
    let result: boolean | undefined;
    expect(() => {
      result = verifyPostSignature(post, kp.publicKey);
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it('keeps the encoder sentinel out of reach: NaN and -1 no longer share a verdict path', () => {
    // Both encode to the same all-ones sentinel bytes in `signingHash`, so
    // before the guard a signature over one validated the other. Both are now
    // rejected outright.
    const withNaN = signedPost({ timestamp: NaN });
    const withNegative = { ...withNaN, timestamp: -1 };
    expect(signingHash(withNaN)).toEqual(signingHash(withNegative as Post));
    expect(verifyPostSignature(withNaN, kp.publicKey)).toBe(false);
    expect(verifyPostSignature(withNegative as Post, kp.publicKey)).toBe(false);
  });

  it('accepts a well-formed post (guard does not regress the happy path)', () => {
    expect(verifyPostSignature(signedPost(), kp.publicKey)).toBe(true);
    // Boundary values inside the domain still verify.
    expect(verifyPostSignature(signedPost({ timestamp: 0 }), kp.publicKey)).toBe(true);
    expect(
      verifyPostSignature(signedPost({ timestamp: Number.MAX_SAFE_INTEGER }), kp.publicKey),
    ).toBe(true);
    expect(verifyPostSignature(signedPost({ protocolVersion: 0 }), kp.publicKey)).toBe(true);
  });
});
