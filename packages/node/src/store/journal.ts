import { getDb } from './db.js';
import { encode, decode } from 'cbor-x';
import type { AnyBox, UserId } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Journal types (node-owned — NODE_INTERFACE "Block Journal")
// ---------------------------------------------------------------------------

/** One primitive box mutation, in application order. */
export interface BoxMutation {
  op: 'insert' | 'remove';
  boxId: string;
  /** Full box — present iff op === 'insert'. */
  box?: AnyBox;
}

/**
 * Single source of truth for undoing a block and feeding the AVL prover.
 * `mutations` is the ordered primitive log; the remaining fields are typed
 * side-records for non-box effects, each with an exact inverse.
 */
export interface BlockJournal {
  blockHeight: number;
  /** Ordered, application order — box rollback + AVL feed. */
  mutations: BoxMutation[];
  /** Inverse: unconfirmPost; also mempool re-insertion. */
  confirmedSubBlockIds: string[];
  /** Mempool re-insertion only. */
  appliedUtxoTxs: Array<{ txId: string; txCbor: Uint8Array }>;
  /** Inverse: markFreeLikesUnprocessed. */
  processedFreeLikeIds: string[];
  /**
   * Inverse: deleteVouchCooldown, then restore `replaced` if present
   * (insertVouchCooldown is INSERT OR REPLACE — an exact inverse must
   * restore a row it overwrote).
   */
  vouchCooldownInsertions: Array<{
    voucherId: UserId;
    targetId: UserId;
    replaced?: { releaseAtBlock: number; karmaAmount: bigint };
  }>;
  /** Inverse: insertVouchCooldown (restores the escrow row — H-7). */
  vouchCooldownDeletions: Array<{
    voucherId: UserId;
    targetId: UserId;
    releaseAtBlock: number;
    karmaAmount: bigint;
  }>;
}

// ---------------------------------------------------------------------------
// Recording context
//
// Module-level singleton: block application is synchronous single-threaded
// better-sqlite3, so at most one journal is ever open. While open, the store
// mutation primitives (insertBox, consumeBox, markLikeBoxesTallied,
// markFreeLikesProcessed, insertVouchCooldown, deleteVouchCooldown) record
// automatically — call sites never maintain parallel mutation bookkeeping.
// The rollback inverses (deleteBox, unconsumeBox, markFreeLikesUnprocessed)
// never record.
// ---------------------------------------------------------------------------

let openJournal: BlockJournal | null = null;

/**
 * Open a journal for the block being applied. Throws if one is already open
 * (the apply funnel's totality catch turns that into a block rejection).
 */
export function beginBlockJournal(height: number): void {
  if (openJournal !== null) {
    throw new Error(
      `beginBlockJournal: journal for height ${openJournal.blockHeight} is still open`,
    );
  }
  openJournal = {
    blockHeight: height,
    mutations: [],
    confirmedSubBlockIds: [],
    appliedUtxoTxs: [],
    processedFreeLikeIds: [],
    vouchCooldownInsertions: [],
    vouchCooldownDeletions: [],
  };
}

/** Return the open journal and close it. Throws if none is open. */
export function finishBlockJournal(): BlockJournal {
  if (openJournal === null) {
    throw new Error('finishBlockJournal: no block journal is open');
  }
  const journal = openJournal;
  openJournal = null;
  return journal;
}

/** Discard the open journal. No-op when none is open. */
export function abortBlockJournal(): void {
  openJournal = null;
}

/** True while a block journal is open. */
export function isBlockJournalOpen(): boolean {
  return openJournal !== null;
}

// ---------------------------------------------------------------------------
// Recording hooks — called by the other store modules at their mutation
// choke points. Each is a silent no-op when no journal is open (bootstrap
// and non-block paths). Not re-exported from the store barrel: services
// record through the primitives, never directly.
// ---------------------------------------------------------------------------

/** Record a box insertion. The box must carry its final id. */
export function recordBoxInsert(box: AnyBox): void {
  if (openJournal === null) return;
  if (!box.id) {
    throw new Error('recordBoxInsert: box.id must be set while a block journal is open');
  }
  openJournal.mutations.push({ op: 'insert', boxId: box.id, box });
}

/** Record a box spend (consumeBox, markLikeBoxesTallied). */
export function recordBoxRemove(boxId: string): void {
  if (openJournal === null) return;
  openJournal.mutations.push({ op: 'remove', boxId });
}

/** Record free-like ids flipped to processed. */
export function recordFreeLikesProcessed(likeIds: string[]): void {
  if (openJournal === null) return;
  openJournal.processedFreeLikeIds.push(...likeIds);
}

/**
 * Record the block's confirmed sub-block refs — all refs, independent of
 * per-post confirm outcomes. Inverse: unconfirmPost; also mempool
 * re-insertion on reorg.
 */
export function recordConfirmedSubBlocks(ids: string[]): void {
  if (openJournal === null) return;
  openJournal.confirmedSubBlockIds.push(...ids);
}

/** Record an applied UTXO tx (mempool re-insertion on reorg only). */
export function recordAppliedUtxoTx(txId: string, txCbor: Uint8Array): void {
  if (openJournal === null) return;
  openJournal.appliedUtxoTxs.push({ txId, txCbor });
}

/**
 * Record a vouch-cooldown insertion, capturing the row it replaced (if any)
 * so rollback can restore what INSERT OR REPLACE overwrote.
 */
export function recordVouchCooldownInsertion(
  voucherId: UserId,
  targetId: UserId,
  replaced?: { releaseAtBlock: number; karmaAmount: bigint },
): void {
  if (openJournal === null) return;
  const entry: BlockJournal['vouchCooldownInsertions'][number] = { voucherId, targetId };
  if (replaced !== undefined) {
    entry.replaced = replaced;
  }
  openJournal.vouchCooldownInsertions.push(entry);
}

/** Record a vouch-cooldown deletion with the full row, so rollback can restore it (H-7). */
export function recordVouchCooldownDeletion(
  voucherId: UserId,
  targetId: UserId,
  releaseAtBlock: number,
  karmaAmount: bigint,
): void {
  if (openJournal === null) return;
  openJournal.vouchCooldownDeletions.push({ voucherId, targetId, releaseAtBlock, karmaAmount });
}

// ---------------------------------------------------------------------------
// Persistence — one CBOR-encoded row per applied block
// ---------------------------------------------------------------------------

function toBuffer(data: unknown): Buffer {
  return Buffer.from(encode(data) as unknown as Uint8Array);
}

export function insertBlockJournal(journal: BlockJournal): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO block_journal (block_height, journal_cbor) VALUES (?, ?)`,
  ).run(journal.blockHeight, toBuffer(journal));
}

// Note for consumers: CBOR round-trips the bigint and byte fields, but the
// side-record `voucherId`/`targetId` come back as plain Uint8Array — never
// assume Buffer.
export function getBlockJournal(height: number): BlockJournal | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT journal_cbor FROM block_journal WHERE block_height = ?',
  ).get(height) as { journal_cbor: Buffer } | undefined;
  if (!row) return null;
  return decode(row.journal_cbor) as BlockJournal;
}

export function deleteBlockJournal(height: number): void {
  getDb().prepare('DELETE FROM block_journal WHERE block_height = ?').run(height);
}

export function purgeOldJournals(belowHeight: number): void {
  getDb().prepare('DELETE FROM block_journal WHERE block_height < ?').run(belowHeight);
}
