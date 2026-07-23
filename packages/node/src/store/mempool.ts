import { getDb } from './db.js';
import type { SubBlock, UtxoTransaction } from '@dagsocial/types';
import { encodeSubBlock, encodeTx } from '@dagsocial/types';

export interface PoolEntry {
  rowid: number;
  entryType: 'subblock' | 'utxo_tx';
  subblockCbor: Uint8Array | null;
  utxoTxCbor: Uint8Array | null;
  batchId: string | null;
  expiresAtHeight: number;
  createdAt: string;
}

interface MempoolRow {
  rowid: number;
  entry_type: string;
  subblock_cbor: Buffer | null;
  utxo_tx_cbor: Buffer | null;
  batch_id: string | null;
  expires_at_height: number;
  created_at: string;
}

function rowToEntry(row: MempoolRow): PoolEntry {
  return {
    rowid: row.rowid,
    entryType: row.entry_type as 'subblock' | 'utxo_tx',
    subblockCbor: row.subblock_cbor ? new Uint8Array(row.subblock_cbor) : null,
    utxoTxCbor: row.utxo_tx_cbor ? new Uint8Array(row.utxo_tx_cbor) : null,
    batchId: row.batch_id,
    expiresAtHeight: row.expires_at_height,
    createdAt: row.created_at,
  };
}

export function insertSubBlock(
  subBlock: SubBlock,
  expiresAtHeight: number,
  batchId: string | null = null,
): number {
  const db = getDb();
  const cbor = encodeSubBlock(subBlock);
  const result = db.prepare(
    `INSERT INTO mempool (entry_type, subblock_cbor, batch_id, expires_at_height)
     VALUES ('subblock', ?, ?, ?)`,
  ).run(Buffer.from(cbor), batchId, expiresAtHeight);
  return Number(result.lastInsertRowid);
}

export function insertUtxoTx(
  tx: UtxoTransaction,
  batchId: string | null,
  expiresAtHeight: number,
): number {
  const db = getDb();
  const cbor = encodeTx(tx);
  const result = db.prepare(
    `INSERT INTO mempool (entry_type, utxo_tx_cbor, batch_id, expires_at_height)
     VALUES ('utxo_tx', ?, ?, ?)`,
  ).run(Buffer.from(cbor), batchId, expiresAtHeight);
  return Number(result.lastInsertRowid);
}

export function getPendingEntries(limit: number): PoolEntry[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT rowid, entry_type, subblock_cbor, utxo_tx_cbor, batch_id,
            expires_at_height, created_at
     FROM mempool
     ORDER BY rowid ASC
     LIMIT ?`,
  ).all(limit) as MempoolRow[];
  return rows.map(rowToEntry);
}

export function purgeExpired(currentHeight: number): number {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM mempool WHERE expires_at_height < ?',
  ).run(currentHeight);
  return result.changes;
}

export function removeEntry(rowid: number): void {
  const db = getDb();
  db.prepare('DELETE FROM mempool WHERE rowid = ?').run(rowid);
}

export function removeBatch(batchId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM mempool WHERE batch_id = ?').run(batchId);
}
