import { getDb } from './db.js';
import { encode, decode } from 'cbor-x';
import type { AnyBox, UserId } from '@dagsocial/types';
// Type-only: erased at compile time, so this does not create a runtime cycle
// with identity-records.ts, which imports the recording hook below.
import type { IdentityRecord } from './identity-records.js';

// ---------------------------------------------------------------------------
// Journal types (node-owned — NODE_INTERFACE "Block Journal")
// ---------------------------------------------------------------------------

/** One primitive box mutation, in application order. */
export interface BoxMutation {
  kind: 'box';
  op: 'insert' | 'remove';
  boxId: string;
  /** Full box — present iff op === 'insert'. */
  box?: AnyBox;
}

/** One identity-record write, in application order (Spec G phase B). */
export interface RecordMutation {
  kind: 'record';
  /** hex — H(IDENTITY_KEY_DOMAIN ‖ identityId), the AVL key. */
  key: string;
  /** The raw 32 bytes, so rollback can address the SQL row. */
  identityId: UserId;
  /** The value written. */
  record: IdentityRecord;
  /** Prior value — absent iff the key did not exist. */
  replaced?: IdentityRecord;
}

/**
 * A mutation of any **committed** entity.
 *
 * This is one discriminated union rather than a box log with a sibling
 * `recordMutations` array, and that is load-bearing. A committed entity that
 * never reaches the prover feed is silently absent from the `stateRoot`, and
 * **no test can catch it** — producer and verifier omit it identically, so they
 * agree on a digest over incomplete state. Making the feed derivation switch on
 * `kind` turns "a new entity kind was added and nobody updated the prover feed"
 * into a TypeScript exhaustiveness error. That compile-time check is the only
 * enforcement this invariant has; a parallel array would reinstate exactly the
 * drift-by-omission shape P1 removed.
 *
 * The typed side-records below (`confirmedSubBlockIds`, `vouchCooldown*`, …)
 * stay separate arrays because they are **not** in the `stateRoot` — they are
 * node-local bookkeeping with an exact inverse. `kind: 'record'` is the first
 * entry that is both journaled *and* committed, and that is the whole
 * distinction.
 */
export type JournalMutation = BoxMutation | RecordMutation;

/**
 * Single source of truth for undoing a block and feeding the AVL prover.
 * `mutations` is the ordered primitive log; the remaining fields are typed
 * side-records for non-box effects, each with an exact inverse.
 */
export interface BlockJournal {
  blockHeight: number;
  /** Ordered, application order — state rollback + AVL feed. */
  mutations: JournalMutation[];
  /** Inverse: unconfirmPost; also mempool re-insertion. */
  confirmedSubBlockIds: string[];
  /** Mempool re-insertion only. */
  appliedUtxoTxs: Array<{ txId: string; txCbor: Uint8Array }>;
  /** Inverse: markFreeLikesUnprocessed. RETIRED tier — stays until P2-D N4. */
  processedFreeLikeIds: string[];
  /** Inverse: deleteLikeRecord (P2-D). */
  likeRecordInsertions: Array<{ targetPostId: string; likerId: UserId }>;
  /**
   * Inverse: restoreLikeRecord — a reverted prune restores the pruned
   * subtree's like-records exactly, all three columns (P2-D).
   */
  likeRecordDeletions: Array<{
    targetPostId: string;
    likerId: UserId;
    appliedAtBlock: number;
  }>;
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
// putIdentityRecord, markFreeLikesProcessed, insertLikeRecord,
// deleteLikeRecordsForPosts, insertVouchCooldown, deleteVouchCooldown) record
// automatically — call sites never maintain parallel mutation bookkeeping.
// The rollback inverses (deleteBox, unconsumeBox, deleteIdentityRecord,
// markFreeLikesUnprocessed, deleteLikeRecord, restoreLikeRecord) never
// record.
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
    likeRecordInsertions: [],
    likeRecordDeletions: [],
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

/**
 * The height of the block currently being applied, or null when no journal is
 * open (Spec G phase D).
 *
 * The identity record's activity clock is bumped at the `insertBox` choke
 * point, and that choke point has no height of its own: `insertBox` takes no
 * height argument, and the box field it could read — `createdAtBlock` — is the
 * one Spec G deletes, so reading it would reintroduce exactly the dependency
 * phase D exists to remove and would break outright at phase G.
 *
 * `beginBlockJournal(height)` already carries the *settled* height, and the
 * record is only meaningful during block application, which is precisely when a
 * journal is open. So this is the narrow seam rather than a new parameter
 * threaded through every producer.
 *
 * Read-only: nothing may set the height through here, because the height is a
 * property of the open journal and outlives no part of it.
 */
export function openBlockJournalHeight(): number | null {
  return openJournal === null ? null : openJournal.blockHeight;
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
  openJournal.mutations.push({ kind: 'box', op: 'insert', boxId: box.id, box });
}

/** Record a box spend (consumeBox, markLikeBoxesTallied). */
export function recordBoxRemove(boxId: string): void {
  if (openJournal === null) return;
  openJournal.mutations.push({ kind: 'box', op: 'remove', boxId });
}

/**
 * Record an identity-record write, capturing the row it replaced (if any) so
 * rollback can restore what the upsert overwrote.
 *
 * A record written **twice in one block** (activity bump then decay, at the same
 * height) appends two entries, and both are kept: `revertBlock` replays in
 * reverse, so the last inverse applied is the *first* write's `replaced` — the
 * true pre-block value. Collapsing them per key would restore an intra-block
 * intermediate instead.
 */
export function recordIdentityRecordPut(
  key: string,
  identityId: UserId,
  record: IdentityRecord,
  replaced?: IdentityRecord,
): void {
  if (openJournal === null) return;
  const entry: RecordMutation = { kind: 'record', key, identityId, record };
  if (replaced !== undefined) {
    entry.replaced = replaced;
  }
  openJournal.mutations.push(entry);
}

/** Record free-like ids flipped to processed. RETIRED tier — until P2-D N4. */
export function recordFreeLikesProcessed(likeIds: string[]): void {
  if (openJournal === null) return;
  openJournal.processedFreeLikeIds.push(...likeIds);
}

/** Record an applied like-record insertion (insertLikeRecord — P2-D). */
export function recordLikeRecordInsertion(targetPostId: string, likerId: UserId): void {
  if (openJournal === null) return;
  openJournal.likeRecordInsertions.push({ targetPostId, likerId });
}

/**
 * Record like-record rows captured BEFORE deletion
 * (deleteLikeRecordsForPosts — P2-D), full rows so rollback restores them
 * exactly.
 */
export function recordLikeRecordDeletions(
  rows: Array<{ targetPostId: string; likerId: UserId; appliedAtBlock: number }>,
): void {
  if (openJournal === null) return;
  openJournal.likeRecordDeletions.push(...rows);
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
// side-record `voucherId`/`targetId`/`likerId` come back as plain Uint8Array
// — never assume Buffer.
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
