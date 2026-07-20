import { encode, decode } from 'cbor-x';
import type { Post } from './post.js';
import type { AnyBox, UtxoTransaction } from './utxo.js';
import type { Stump } from './stump.js';
import type { SubBlock, OrderingBlock } from './block.js';

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
// Ordering block
// ---------------------------------------------------------------------------

export function encodeOrderingBlock(block: OrderingBlock): Uint8Array {
  return toBuffer(block);
}

export function decodeOrderingBlock(bytes: Uint8Array): OrderingBlock {
  return fromBuffer<OrderingBlock>(bytes);
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
