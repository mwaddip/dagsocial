import { encode, decode } from 'cbor-x';
import type { Post } from './post.js';
import type { AnyBox, UtxoTransaction } from './utxo.js';
import type { Stump } from './stump.js';
import type {
  SubBlock,
  BlockHeader,
  SubBlockTree,
  UtxoTxTree,
  OrderingBlock,
} from './block.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBuffer(data: unknown): Uint8Array {
  return encode(data) as unknown as Uint8Array;
}

function fromBuffer<T>(bytes: Uint8Array): T {
  return decode(Buffer.from(bytes)) as T;
}

// ---------------------------------------------------------------------------
// Box
// ---------------------------------------------------------------------------

export function serializeBox(box: AnyBox): Uint8Array {
  // Exclude `id` for canonical encoding (id is derived from the rest)
  const { id, ...rest } = box;
  return toBuffer(rest);
}

// ---------------------------------------------------------------------------
// Post
// ---------------------------------------------------------------------------

export function encodePost(post: Post): Uint8Array {
  return toBuffer(post);
}

export function decodePost(bytes: Uint8Array): Post {
  return fromBuffer<Post>(bytes);
}

// ---------------------------------------------------------------------------
// Stump
// ---------------------------------------------------------------------------

export function encodeStump(stump: Stump): Uint8Array {
  return toBuffer(stump);
}

export function decodeStump(bytes: Uint8Array): Stump {
  return fromBuffer<Stump>(bytes);
}

// ---------------------------------------------------------------------------
// Sub-block
// ---------------------------------------------------------------------------

export function encodeSubBlock(sb: SubBlock): Uint8Array {
  return toBuffer(sb);
}

export function decodeSubBlock(bytes: Uint8Array): SubBlock {
  return fromBuffer<SubBlock>(bytes);
}

// ---------------------------------------------------------------------------
// Block header
// ---------------------------------------------------------------------------

export function encodeHeader(h: BlockHeader): Uint8Array {
  return toBuffer(h);
}

export function decodeHeader(bytes: Uint8Array): BlockHeader {
  return fromBuffer<BlockHeader>(bytes);
}

// ---------------------------------------------------------------------------
// Sub-block tree
// ---------------------------------------------------------------------------

export function encodeSubBlockTree(t: SubBlockTree): Uint8Array {
  return toBuffer(t);
}

export function decodeSubBlockTree(bytes: Uint8Array): SubBlockTree {
  return fromBuffer<SubBlockTree>(bytes);
}

// ---------------------------------------------------------------------------
// UTXO transaction tree
// ---------------------------------------------------------------------------

export function encodeUtxoTxTree(t: UtxoTxTree): Uint8Array {
  return toBuffer(t);
}

export function decodeUtxoTxTree(bytes: Uint8Array): UtxoTxTree {
  return fromBuffer<UtxoTxTree>(bytes);
}

// ---------------------------------------------------------------------------
// Ordering block — length-prefixed wire format
// ---------------------------------------------------------------------------

/**
 * Encode a full ordering block for the wire / on-disk storage.
 *
 * Wire format:
 *   u32BE(headerLen) || headerCbor || u32BE(subTreeLen) || subTreeCbor
 *   || u32BE(utxoTxTreeLen) || utxoTxTreeCbor || validatorSignature (64 bytes)
 */
export function encodeOrderingBlock(block: OrderingBlock): Uint8Array {
  const headerBytes = Buffer.from(encodeHeader(block.header));
  const subBytes = Buffer.from(encodeSubBlockTree(block.subBlockTree));
  const utxoBytes = Buffer.from(encodeUtxoTxTree(block.utxoTxTree));

  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32BE(headerBytes.length);
  const subLen = Buffer.alloc(4);
  subLen.writeUInt32BE(subBytes.length);
  const utxoLen = Buffer.alloc(4);
  utxoLen.writeUInt32BE(utxoBytes.length);

  return new Uint8Array(Buffer.concat([
    headerLen, headerBytes,
    subLen, subBytes,
    utxoLen, utxoBytes,
    Buffer.from(block.validatorSignature),
  ]));
}

/**
 * Decode a length-prefixed ordering block from the wire.
 */
export function decodeOrderingBlock(bytes: Uint8Array): OrderingBlock {
  const buf = Buffer.from(bytes);
  let offset = 0;

  const headerLen = buf.readUInt32BE(offset); offset += 4;
  const header = decodeHeader(buf.subarray(offset, offset + headerLen)); offset += headerLen;

  const subLen = buf.readUInt32BE(offset); offset += 4;
  const subBlockTree = decodeSubBlockTree(buf.subarray(offset, offset + subLen)); offset += subLen;

  const utxoLen = buf.readUInt32BE(offset); offset += 4;
  const utxoTxTree = decodeUtxoTxTree(buf.subarray(offset, offset + utxoLen)); offset += utxoLen;

  const validatorSignature = new Uint8Array(buf.subarray(offset, offset + 64));
  if (validatorSignature.length !== 64) throw new Error('decodeOrderingBlock: truncated validator signature');

  return { header, subBlockTree, utxoTxTree, validatorSignature };
}

// ---------------------------------------------------------------------------
// UTXO transaction
// ---------------------------------------------------------------------------

export function serializeTx(tx: UtxoTransaction): Uint8Array {
  // Exclude id from output boxes and only hash structural data
  return toBuffer({
    inputs: tx.inputs,
    outputs: tx.outputs.map(({ id, ...rest }) => rest),
    protocolVersion: tx.protocolVersion,
  });
}

export function encodeTx(tx: UtxoTransaction): Uint8Array {
  return toBuffer(tx);
}

export function decodeTx(bytes: Uint8Array): UtxoTransaction {
  return fromBuffer<UtxoTransaction>(bytes);
}
