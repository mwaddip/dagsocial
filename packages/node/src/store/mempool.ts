import { getDb } from './db.js';
import type { UtxoTransaction, PruneEntry } from '@dagsocial/types';
import { encodeTx, serializePruneEntry, computePruneEntryId } from '@dagsocial/types';
import { decode as cborDecode } from 'cbor-x';

export interface PoolEntry {
  rowid: number;
  entryType: 'subblock' | 'utxo_tx' | 'prune';
  subblockId: string | null;
  utxoTxCbor: Uint8Array | null;
  pruneEntryCbor: Uint8Array | null;
  batchId: string | null;
  expiresAtHeight: number;
  createdAt: string;
}

interface MempoolRow {
  rowid: number;
  entry_type: string;
  subblock_id: string | null;
  utxo_tx_cbor: Buffer | null;
  prune_entry_cbor: Buffer | null;
  batch_id: string | null;
  expires_at_height: number;
  created_at: string;
}

function rowToEntry(row: MempoolRow): PoolEntry {
  return {
    rowid: row.rowid,
    entryType: row.entry_type as 'subblock' | 'utxo_tx' | 'prune',
    subblockId: row.subblock_id,
    utxoTxCbor: row.utxo_tx_cbor ? new Uint8Array(row.utxo_tx_cbor) : null,
    pruneEntryCbor: row.prune_entry_cbor ? new Uint8Array(row.prune_entry_cbor) : null,
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
    `SELECT rowid, entry_type, subblock_id, utxo_tx_cbor, prune_entry_cbor, batch_id,
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

export function insertMempoolPrune(
  entry: PruneEntry,
  expiresAtHeight: number,
): number {
  const db = getDb();
  const cbor = Buffer.from(serializePruneEntry(entry));
  const result = db.prepare(
    `INSERT INTO mempool (entry_type, prune_entry_cbor, expires_at_height)
     VALUES ('prune', ?, ?)`,
  ).run(cbor, expiresAtHeight);
  return Number(result.lastInsertRowid);
}

export function drainMempoolPrunes(limit: number): PruneEntry[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT rowid, prune_entry_cbor FROM mempool
     WHERE entry_type = 'prune'
     ORDER BY rowid ASC LIMIT ?`,
  ).all(limit) as Array<{ rowid: number; prune_entry_cbor: Buffer }>;

  if (rows.length === 0) return [];

  const ids = rows.map(r => r.rowid);
  db.prepare(
    `DELETE FROM mempool WHERE rowid IN (${ids.map(() => '?').join(',')})`,
  ).run(...ids);

  return rows.map(r => cborDecode(r.prune_entry_cbor) as PruneEntry);
}

/**
 * Remove prune entries from the mempool by their computed entry IDs.
 * O(n) full scan over all prune entries in mempool — callsite is reorg(),
 * which is infrequent and typically operates on a small mempool.
 */
export function removeMempoolPrunes(entryIds: string[]): void {
  if (entryIds.length === 0) return;
  const db = getDb();

  // Read all prune entries, compute their IDs, and delete matches
  const rows = db.prepare(
    `SELECT rowid, prune_entry_cbor FROM mempool WHERE entry_type = 'prune'`,
  ).all() as Array<{ rowid: number; prune_entry_cbor: Buffer }>;

  const toDelete: number[] = [];
  for (const row of rows) {
    const entry = cborDecode(row.prune_entry_cbor) as PruneEntry;
    const id = computePruneEntryId(entry);
    if (entryIds.includes(id)) {
      toDelete.push(row.rowid);
    }
  }

  if (toDelete.length > 0) {
    db.prepare(
      `DELETE FROM mempool WHERE rowid IN (${toDelete.map(() => '?').join(',')})`,
    ).run(...toDelete);
  }
}
