import { getDb } from './db.js';
import { config } from '../config.js';
import type {
  UtxoTransaction,
  PruneEntry,
  LikeBox,
  InviteBox,
  VouchBox,
} from '@dagsocial/types';
import { encodeTx, serializePruneEntry, computePruneEntryId } from '@dagsocial/types';
import { decode as cborDecode } from 'cbor-x';

/**
 * Thrown by every mempool insert when the pool is at `MAX_MEMPOOL_ENTRIES`.
 * Rejection, not eviction: eviction needs fee-based prioritization and there
 * are no fees yet (audit M-8). Routes map this to 503; the gossip relay and
 * reorg re-insertion drop the entry and log.
 */
export class MempoolFullError extends Error {
  constructor(public readonly cap: number) {
    super(`Mempool full: at capacity (${cap} entries)`);
    this.name = 'MempoolFullError';
  }
}

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

/**
 * Reject the insert when the pool is already at the configured cap. Checked by
 * every insert path — an unbounded pool was a disk-DoS lever (audit M-8).
 */
function assertCapacity(db: ReturnType<typeof getDb>): void {
  const cap = config.maxMempoolEntries;
  const row = db.prepare('SELECT COUNT(*) AS n FROM mempool').get() as { n: number };
  if (row.n >= cap) throw new MempoolFullError(cap);
}

interface GateMetadata {
  likeTarget: string | null;
  likeLiker: string | null;
  inviteInviter: string | null;
  vouchVoucher: string | null;
}

/**
 * Walk a transaction's outputs once and lift the fields the correctness gates
 * query on. This is the single chokepoint every insertion path (HTTP routes and
 * gossip relay alike) passes through, which is what makes the gates unable to
 * miss an entry. First output of each kind wins — the gate columns are singular
 * per the contract, matching the services' own `outputs.find(...)` semantics.
 */
function gateMetadata(tx: UtxoTransaction): GateMetadata {
  const meta: GateMetadata = {
    likeTarget: null,
    likeLiker: null,
    inviteInviter: null,
    vouchVoucher: null,
  };

  for (const output of tx.outputs ?? []) {
    if (output.boxType === 'like' && meta.likeTarget === null) {
      const like = output as LikeBox;
      meta.likeTarget = like.targetPostId;
      meta.likeLiker = Buffer.from(like.likerId).toString('hex');
    } else if (output.boxType === 'invite' && meta.inviteInviter === null) {
      meta.inviteInviter = Buffer.from((output as InviteBox).inviterId).toString('hex');
    } else if (output.boxType === 'vouch' && meta.vouchVoucher === null) {
      meta.vouchVoucher = Buffer.from((output as VouchBox).voucherId).toString('hex');
    }
  }

  return meta;
}

export function insertSubBlock(
  postId: string,
  expiresAtHeight: number,
  batchId: string | null = null,
): number {
  const db = getDb();
  assertCapacity(db);
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
  assertCapacity(db);
  const cbor = encodeTx(tx);
  const meta = gateMetadata(tx);
  const result = db.prepare(
    `INSERT INTO mempool (entry_type, utxo_tx_cbor, batch_id, expires_at_height,
                          like_target, like_liker, invite_inviter, vouch_voucher)
     VALUES ('utxo_tx', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Buffer.from(cbor),
    batchId,
    expiresAtHeight,
    meta.likeTarget,
    meta.likeLiker,
    meta.inviteInviter,
    meta.vouchVoucher,
  );
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Correctness gates (audit M-8)
//
// SQL over the gate-metadata columns — never a bounded scan. The previous
// implementations decoded getPendingEntries(1000) per request, so any entry
// past row 1000 was invisible to the duplicate-like and MAX_PENDING_INVITES
// checks. Parameters are hex strings, compared against the columns as stored.
// ---------------------------------------------------------------------------

export function hasPendingLike(targetPostId: string, likerId: string): boolean {
  const db = getDb();
  const row = db.prepare(
    `SELECT 1 FROM mempool WHERE like_target = ? AND like_liker = ? LIMIT 1`,
  ).get(targetPostId, likerId);
  return row !== undefined;
}

export function countPendingInvites(inviterId: string): number {
  const db = getDb();
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM mempool WHERE invite_inviter = ?`,
  ).get(inviterId) as { n: number };
  return row.n;
}

export function hasPendingVouch(voucherId: string): boolean {
  const db = getDb();
  const row = db.prepare(
    `SELECT 1 FROM mempool WHERE vouch_voucher = ? LIMIT 1`,
  ).get(voucherId);
  return row !== undefined;
}

/**
 * Delete confirmed sub-block entries by postId. Replaces block application's
 * fetch-1000-and-find loop, which stopped removing entries past row 1000
 * (bookkeeping only — no consensus behavior change). Chunked because a single
 * block may carry up to `maxSubBlocksPerBlock` refs, above SQLite's bound
 * parameter limit.
 */
export function removeSubBlockEntries(postIds: string[]): number {
  if (postIds.length === 0) return 0;
  const db = getDb();
  const CHUNK = 500;
  let removed = 0;
  for (let i = 0; i < postIds.length; i += CHUNK) {
    const chunk = postIds.slice(i, i + CHUNK);
    const result = db.prepare(
      `DELETE FROM mempool
       WHERE entry_type = 'subblock'
         AND subblock_id IN (${chunk.map(() => '?').join(',')})`,
    ).run(...chunk);
    removed += result.changes;
  }
  return removed;
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
  assertCapacity(db);
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
