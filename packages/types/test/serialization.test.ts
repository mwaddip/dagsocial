import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { subBlockFromPost } from '../src/block.js';
import {
  encodePost,
  decodePost,
  encodeStump,
  decodeStump,
  encodeSubBlock,
  decodeSubBlock,
  encodeHeader,
  decodeHeader,
  encodeSubBlockTree,
  decodeSubBlockTree,
  encodeUtxoTxTree,
  decodeUtxoTxTree,
  encodeOrderingBlock,
  decodeOrderingBlock,
  encodeTx,
  decodeTx,
} from '../src/serialization.js';
import type { Post } from '../src/post.js';
import type { Stump } from '../src/stump.js';
import type {
  SubBlock,
  SubBlockEntry,
  BlockHeader,
  SubBlockTree,
  UtxoTxTree,
  OrderingBlock,
} from '../src/block.js';
import type { KarmaBox, UtxoTransaction } from '../src/utxo.js';

const challenge = new Uint8Array(32).fill(0xab);
const sig64 = new Uint8Array(64).fill(0xcd);

function makePost(): Post {
  return {
    content: 'Hello, DAGsocial!',
    author: 'user123',
    parentRefs: ['ref1', 'ref2'],
    challenge,
    powNonce: 12345,
    protocolVersion: 2,
    timestamp: 1700000000000,
    signature: sig64,
  };
}

function makeStump(): Stump {
  return {
    rootPostHash: 'a'.repeat(64),
    authorId: 'user456',
    replyCount: 7,
    upvoteCount: 12,
    trigger: 'author',
    protocolVersion: 2,
    compactedAtBlockHeight: 500,
  };
}

function makeSubBlock(): SubBlock {
  return {
    subBlockId: 'b'.repeat(64),
    post: makePost(),
    producerId: 'user123',
    protocolVersion: 2,
  };
}

function makeBlockHeader(): BlockHeader {
  return {
    protocolVersion: 2,
    height: 1,
    prevBlockHash: '0'.repeat(64),
    subBlockRoot: '0'.repeat(64),
    utxoTxRoot: '0'.repeat(64),
    stateRoot: '00'.repeat(33),
    validatorId: 'validator1',
    powNonce: 0,
    powTargetBits: 12,
    createdAt: 1700000000000,
  };
}

function makeSubBlockTree(): SubBlockTree {
  return {
    subBlockRefs: ['d'.repeat(64)],
    subBlockEntries: [
      { postId: 'b'.repeat(64), parentRefs: [], author: 'c'.repeat(64) },
    ],
    pruneEntries: [],
  };
}

function makeUtxoTxTree(): UtxoTxTree {
  return {
    utxoTxIds: ['f'.repeat(64)],
    utxoTxs: [encodeTx(makeTx())],
    coinbaseOutputs: [],
  };
}

function makeOrderingBlock(): OrderingBlock {
  return {
    header: makeBlockHeader(),
    subBlockTree: makeSubBlockTree(),
    utxoTxTree: makeUtxoTxTree(),
    validatorSignature: sig64,
  };
}

function makeKarmaBox(): KarmaBox {
  return {
    boxType: 'karma',
    value: 100n,
    owner: new Uint8Array(32).fill(0xaa),
    guard: 'owner_signature',
    proofSource: 'genesis',
  };
}

function makeTx(): UtxoTransaction {
  return {
    inputs: [],
    outputs: [makeKarmaBox()],
    signatures: {},
    protocolVersion: 2,
  };
}

describe('CBOR serialization', () => {
  describe('Post', () => {
    it('round-trips a post', () => {
      const post = makePost();
      const decoded = decodePost(encodePost(post));
      expect(decoded).toEqual(post);
    });

    it('encoding is deterministic', () => {
      const post = makePost();
      const a = encodePost(post);
      const b = encodePost(post);
      expect(Buffer.compare(a, b)).toBe(0);
    });

    it('decodePost throws on garbage bytes', () => {
      expect(() => decodePost(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow();
    });
  });

  describe('Stump', () => {
    it('round-trips a stump', () => {
      const stump = makeStump();
      const decoded = decodeStump(encodeStump(stump));
      expect(decoded).toEqual(stump);
    });

    it('encoding is deterministic', () => {
      const stump = makeStump();
      const a = encodeStump(stump);
      const b = encodeStump(stump);
      expect(Buffer.compare(a, b)).toBe(0);
    });

    it('decodeStump throws on garbage bytes', () => {
      expect(() => decodeStump(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow();
    });
  });

  describe('SubBlock', () => {
    it('round-trips a sub-block', () => {
      const sb = makeSubBlock();
      const decoded = decodeSubBlock(encodeSubBlock(sb));
      expect(decoded).toEqual(sb);
    });

    it('decodeSubBlock throws on garbage bytes', () => {
      expect(() => decodeSubBlock(new Uint8Array([0x00, 0x01]))).toThrow();
    });

    it('T2b consensus pin: sub-block CBOR carries no likeBoxes key and moved off the old shape', () => {
      // Two-sided pin over a fully deterministic sub-block. Before-leg captured
      // on the pre-T2b tree (2026-08-08): the same post content with the field
      // (`likeBoxes: []`) encoded to 441 bytes containing the key, hashing to
      // OLD_SHAPE_ID. Deleting `SubBlock.likeBoxes` is a consensus change —
      // every hash over sub-block bytes moves; fresh-chain gate, no shims.
      const OLD_SHAPE_ID = '586ff286a6309e50e07f429cff6bccb026ccf3d6e1b67b7036e654c8c2a487cc';
      const NEW_SHAPE_ID = '9a1155ead5ddfb05d495a34df1f4be31482e2df4f9094925ba135b4679e0d114';
      const post: Post = {
        content: 'T2b consensus pin: sub-block CBOR shape',
        author: new Uint8Array(32).fill(7),
        parentRefs: [],
        challenge: new Uint8Array(32).fill(9),
        powNonce: 424242,
        protocolVersion: 1,
        timestamp: 1754600000000,
        signature: new Uint8Array(64).fill(3),
      };
      const sb = subBlockFromPost(post, 'ab'.repeat(32));
      expect(Object.keys(sb)).toEqual(['subBlockId', 'post', 'producerId', 'protocolVersion']);
      const bytes = encodeSubBlock(sb);
      const hex = Buffer.from(bytes).toString('hex');
      expect(hex).not.toContain(Buffer.from('likeBoxes', 'utf8').toString('hex'));
      const id = createHash('blake2b512').update(bytes).digest().subarray(0, 32).toString('hex');
      expect(id).not.toBe(OLD_SHAPE_ID);
      expect(id).toBe(NEW_SHAPE_ID);
    });
  });

  describe('BlockHeader', () => {
    it('round-trips a block header', () => {
      const header = makeBlockHeader();
      const decoded = decodeHeader(encodeHeader(header));
      expect(decoded).toEqual(header);
    });

    it('encoding is deterministic', () => {
      const header = makeBlockHeader();
      const a = encodeHeader(header);
      const b = encodeHeader(header);
      expect(Buffer.compare(a, b)).toBe(0);
    });

    it('decodeHeader throws on garbage bytes', () => {
      expect(() => decodeHeader(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow();
    });
  });

  describe('SubBlockTree', () => {
    it('round-trips a sub-block tree', () => {
      const tree = makeSubBlockTree();
      const decoded = decodeSubBlockTree(encodeSubBlockTree(tree));
      expect(decoded).toEqual(tree);
    });

    it('encoding is deterministic', () => {
      const tree = makeSubBlockTree();
      const a = encodeSubBlockTree(tree);
      const b = encodeSubBlockTree(tree);
      expect(Buffer.compare(a, b)).toBe(0);
    });

    it('decodeSubBlockTree throws on garbage bytes', () => {
      expect(() => decodeSubBlockTree(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow();
    });

    it('roundtrips SubBlockTree with subBlockEntries', () => {
      const tree: SubBlockTree = {
        subBlockRefs: ['aa'.repeat(32), 'bb'.repeat(32)],
        subBlockEntries: [
          { postId: 'aa'.repeat(32), parentRefs: [], author: 'cc'.repeat(32) },
          { postId: 'bb'.repeat(32), parentRefs: ['aa'.repeat(32)], author: 'dd'.repeat(32) },
        ],
        pruneEntries: [],
      };
      const encoded = encodeSubBlockTree(tree);
      const decoded = decodeSubBlockTree(encoded);
      expect(decoded.subBlockEntries).toEqual(tree.subBlockEntries);
      expect(decoded.subBlockRefs).toEqual(tree.subBlockRefs);
      expect(decoded.pruneEntries).toEqual(tree.pruneEntries);
    });
  });

  describe('UtxoTxTree', () => {
    it('round-trips a UTXO tx tree', () => {
      const tree = makeUtxoTxTree();
      const decoded = decodeUtxoTxTree(encodeUtxoTxTree(tree));
      expect(decoded).toEqual(tree);
    });

    it('encoding is deterministic', () => {
      const tree = makeUtxoTxTree();
      const a = encodeUtxoTxTree(tree);
      const b = encodeUtxoTxTree(tree);
      expect(Buffer.compare(a, b)).toBe(0);
    });

    it('decodeUtxoTxTree throws on garbage bytes', () => {
      expect(() => decodeUtxoTxTree(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow();
    });
  });

  describe('OrderingBlock', () => {
    it('round-trips an ordering block', () => {
      const block = makeOrderingBlock();
      const decoded = decodeOrderingBlock(encodeOrderingBlock(block));
      expect(decoded).toEqual(block);
    });

    it('encoding is deterministic', () => {
      const block = makeOrderingBlock();
      const a = encodeOrderingBlock(block);
      const b = encodeOrderingBlock(block);
      expect(Buffer.compare(a, b)).toBe(0);
    });

    it('wire format has u32BE length prefixes for each section', () => {
      const block = makeOrderingBlock();
      const bytes = Buffer.from(encodeOrderingBlock(block));

      // Read header length prefix, verify content decodes correctly
      const headerLen = bytes.readUInt32BE(0);
      expect(headerLen).toBeGreaterThan(0);
      const header = decodeHeader(bytes.subarray(4, 4 + headerLen));
      expect(header).toEqual(block.header);

      // Read sub-block tree prefix
      let offset = 4 + headerLen;
      const subLen = bytes.readUInt32BE(offset);
      expect(subLen).toBeGreaterThan(0);
      const subTree = decodeSubBlockTree(
        bytes.subarray(offset + 4, offset + 4 + subLen),
      );
      expect(subTree).toEqual(block.subBlockTree);

      // Read UTXO tx tree prefix
      offset += 4 + subLen;
      const utxoLen = bytes.readUInt32BE(offset);
      expect(utxoLen).toBeGreaterThan(0);
      const utxoTree = decodeUtxoTxTree(
        bytes.subarray(offset + 4, offset + 4 + utxoLen),
      );
      expect(utxoTree).toEqual(block.utxoTxTree);

      // Trailing 64-byte signature
      offset += 4 + utxoLen;
      const sig = bytes.subarray(offset, offset + 64);
      expect(sig).toEqual(Buffer.from(block.validatorSignature));
    });

    it('decodeOrderingBlock throws on truncated signature (only 32 bytes of sig)', () => {
      const block = makeOrderingBlock();
      // Encode full block, then slice off the last 32 bytes of the signature
      const fullBytes = Buffer.from(encodeOrderingBlock(block));
      // fullBytes layout: 4 + headerLen + 4 + subLen + 4 + utxoLen + 64
      // Remove last 32 bytes (half the signature)
      const truncated = fullBytes.subarray(0, fullBytes.length - 32);
      expect(() => decodeOrderingBlock(truncated)).toThrow(
        'decodeOrderingBlock: truncated at validator signature',
      );
    });

    it('decodeOrderingBlock throws on truncated input', () => {
      const encoded = encodeOrderingBlock(makeOrderingBlock());
      // Truncate to just the first length prefix + partial header CBOR
      const truncated = encoded.subarray(0, 10);
      expect(() => decodeOrderingBlock(truncated)).toThrow();
    });
  });

  describe('UtxoTransaction', () => {
    it('round-trips a transaction', () => {
      const tx = makeTx();
      const decoded = decodeTx(encodeTx(tx));
      expect(decoded).toEqual(tx);
    });

    it('round-trips a transaction with preimages', () => {
      const preimage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const tx = {
        ...makeTx(),
        inputs: ['aaaa'.padEnd(64, '0'), 'bbbb'.padEnd(64, '0')],
        preimages: { ['aaaa'.padEnd(64, '0')]: preimage },
      };
      const decoded = decodeTx(encodeTx(tx));
      expect(decoded.preimages).toBeDefined();
      expect(decoded.preimages!['aaaa'.padEnd(64, '0')]).toEqual(preimage);
      expect(decoded.inputs).toEqual(tx.inputs);
    });

  });

  // Box serialization moved to test/utxo.test.ts by Spec G phase 0: `serializeBox`
  // was deleted here, and its two cases ("excludes id", "is deterministic") now
  // run against `canonicalBoxBytes` — the encoder that actually computes ids.
  //
  // Phase G3b deleted `serializeTx` on the same grounds and dropped its
  // determinism case rather than re-pointing it: the re-point already existed.
  // `test/utxo.test.ts` → `computeTxId` → "is deterministic" asserts the same
  // property against the function that actually computes transaction ids.
});
