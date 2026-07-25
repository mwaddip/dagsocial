import { getDb } from './db.js';
import {
  encodeHeader,
  decodeHeader,
  encodeSubBlockTree,
  decodeSubBlockTree,
  encodeUtxoTxTree,
  decodeUtxoTxTree,
} from '@dagsocial/types';
import type { OrderingBlock } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Row shape (blob-based)
// ---------------------------------------------------------------------------

interface OrderingBlockRow {
  height: number;
  header_cbor: Buffer;
  subblock_tree_cbor: Buffer;
  utxotx_tree_cbor: Buffer;
  validator_signature: Buffer;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToOrderingBlock(row: OrderingBlockRow): OrderingBlock {
  return {
    header: decodeHeader(new Uint8Array(row.header_cbor)),
    subBlockTree: decodeSubBlockTree(new Uint8Array(row.subblock_tree_cbor)),
    utxoTxTree: decodeUtxoTxTree(new Uint8Array(row.utxotx_tree_cbor)),
    validatorSignature: new Uint8Array(row.validator_signature),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new ordering block.
 */
export function createOrderingBlock(block: OrderingBlock): void {
  const db = getDb();

  db.prepare(
    `INSERT INTO ordering_blocks
       (height, header_cbor, subblock_tree_cbor, utxotx_tree_cbor,
        validator_signature, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    block.header.height,
    Buffer.from(encodeHeader(block.header)),
    Buffer.from(encodeSubBlockTree(block.subBlockTree)),
    Buffer.from(encodeUtxoTxTree(block.utxoTxTree)),
    Buffer.from(block.validatorSignature),
    block.header.createdAt,
  );
}

/**
 * Retrieve an ordering block by height.
 * Returns null if no block exists at that height.
 */
export function getOrderingBlock(height: number): OrderingBlock | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM ordering_blocks WHERE height = ?')
    .get(height) as OrderingBlockRow | undefined;
  return row ? rowToOrderingBlock(row) : null;
}

/**
 * Delete an ordering block at the given height (for rollback).
 */
export function deleteOrderingBlock(height: number): void {
  getDb().prepare('DELETE FROM ordering_blocks WHERE height = ?').run(height);
}

/**
 * Return the current chain height (max height in ordering_blocks).
 * Returns 0 if no blocks exist yet.
 */
export function getCurrentHeight(): number {
  const db = getDb();
  const row = db
    .prepare('SELECT COALESCE(MAX(height), 0) AS h FROM ordering_blocks')
    .get() as { h: number };
  return row.h;
}
