import { getDb } from './db.js';
import type { UtxoTransaction } from '@dagsocial/types';
import { encodeTx } from '@dagsocial/types';

export interface PoolEntry {
  rowid: number;
  entryType: 'subblock' | 'utxo_tx' | 'stump';
  subblockId: string | null;
  utxoTxCbor: Uint8Array | null;
  stumpId: string | null;
  batchId: string | null;
  expiresAtHeight: number;
  createdAt: string;
}

interface MempoolRow {
  rowid: number;
  entry_type: string;
  subblock_id: string | null;
  utxo_tx_cbor: Buffer | null;
  stump_id: string | null;
  batch_id: string | null;
  expires_at_height: number;
  created_at: string;
}

function rowToEntry(row: MempoolRow): PoolEntry {
  return {
    rowid: row.rowid,
    entryType: row.entry_type as 'subblock' | 'utxo_tx' | 'stump',
    subblockId: row.subblock_id,
    utxoTxCbor: row.utxo_tx_cbor ? new Uint8Array(row.utxo_tx_cbor) : null,
    stumpId: row.stump_id,
    batchId: row.batch_id,
    expiresAtHeight: row.expires_at_height,
    createdAt: row.created_at,
  };
}

export function insertSubBlock(
  postId: string,
  expiresAtHeight: number,
  batchId: string | null = null,
): number {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO mempool (entry_type, subblock_id, batch_id, expires_at_height)
     VALUES ('subblock', ?, ?, ?)`,
  ).run(postId, batchId, expiresAtHeight);
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
    `SELECT rowid, entry_type, subblock_id, utxo_tx_cbor, batch_id,
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

export function insertMempoolStump(
  stumpId: string,
  expiresAtHeight: number,
): number {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO mempool (entry_type, stump_id, expires_at_height)
     VALUES ('stump', ?, ?)`,
  ).run(stumpId, expiresAtHeight);
  return Number(result.lastInsertRowid);
}

export function drainMempoolStumps(limit: number): string[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT rowid, stump_id FROM mempool
     WHERE entry_type = 'stump'
     ORDER BY rowid ASC
     LIMIT ?`,
  ).all(limit) as Array<{ rowid: number; stump_id: string }>;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.stump_id);
  const rowids = rows.map((r) => r.rowid);
  db.prepare(
    `DELETE FROM mempool WHERE rowid IN (${rowids.map(() => '?').join(',')})`,
  ).run(...rowids);
  return ids;
}

export function removeMempoolStumps(stumpIds: string[]): void {
  if (stumpIds.length === 0) return;
  const db = getDb();
  const placeholders = stumpIds.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM mempool WHERE entry_type = 'stump' AND stump_id IN (${placeholders})`,
  ).run(...stumpIds);
}
