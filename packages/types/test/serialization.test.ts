import { describe, it, expect } from 'vitest';
import { decode as cborDecode } from 'cbor-x';
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
  serializeBox,
  serializeTx,
} from '../src/serialization.js';
import type { Post } from '../src/post.js';
import type { Stump } from '../src/stump.js';
import type {
  SubBlock,
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
    subtreeMerkleRoot: new Uint8Array(32).fill(0x11),
    authorId: 'user456',
    pruneSignature: sig64,
    karmaDeltas: [
      { userId: 'user1', delta: 5 },
      { userId: 'user2', delta: -3 },
    ],
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
    likeBoxes: [],
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
    stumpIds: [],
  };
}

function makeUtxoTxTree(): UtxoTxTree {
  return {
    utxoTxIds: ['f'.repeat(64)],
    likeBoxIds: ['e'.repeat(64)],
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
    value: 100,
    createdAtBlock: 1,
    owner: new Uint8Array(32).fill(0xaa),
    guard: 'owner_signature',
    proofSource: 'genesis',
    lastTouchBlock: 1,
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

    it('serializeTx is deterministic', () => {
      const a = serializeTx(makeTx());
      const b = serializeTx(makeTx());
      expect(Buffer.compare(a, b)).toBe(0);
    });
  });

  describe('Box serialization', () => {
    it('serializeBox excludes id', () => {
      const box = { ...makeKarmaBox(), id: 'should-be-excluded' };
      const bytes = serializeBox(box);
      // Round-trip through decode to check id is really gone
      const decoded = cborDecode(Buffer.from(bytes));
      expect(decoded.id).toBeUndefined();
      expect(decoded.boxType).toBe('karma');
    });

    it('serializeBox is deterministic', () => {
      const box = makeKarmaBox();
      const a = serializeBox(box);
      const b = serializeBox(box);
      expect(Buffer.compare(a, b)).toBe(0);
    });
  });
});
