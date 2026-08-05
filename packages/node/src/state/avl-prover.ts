import { BatchAVLProver, PersistentBatchAVLProver } from '@ergots/avltree';
import { SqliteAvlStorage } from './avl-storage.js';
import { serializeBox, serializeIdentityRecord } from './serialize-box.js';
import { getDb } from '../store/db.js';
import { config } from '../config.js';
import type { AnyBox } from '@dagsocial/types';
import type { IdentityRecord } from '../store/identity-records.js';

/** Sentinel key for block height metadata in additionalData. */
export const HEIGHT_SENTINEL = new Uint8Array(32); // all zeros

/** Encode a block height as 4-byte big-endian uint32. */
export function encodeHeight(h: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, h, false);
  return buf;
}

let persistentProver: PersistentBatchAVLProver | null = null;
let storage: SqliteAvlStorage | null = null;

export interface AvlProverHandle {
  prover: PersistentBatchAVLProver;
  storage: SqliteAvlStorage;
}

/**
 * Create or return the singleton AVL prover.
 * Must be called after initDb().
 *
 * Accepts an optional `db` parameter for testing; when omitted,
 * uses the global database from getDb().
 */
export function createAvlProver(db?: import('better-sqlite3').Database): AvlProverHandle {
  // Singleton only when using the global database (production mode).
  // When an explicit db is passed (testing), always create a fresh prover
  // so callers can get independent provers sharing the same underlying store.
  if (!db && persistentProver && storage) return { prover: persistentProver, storage };

  const database = db ?? getDb();
  const keyLength = config.avlKeyLength;
  const valueLengthOpt = null; // variable-length box values

  const newStorage = new SqliteAvlStorage(database, { keyLength, valueLengthOpt });
  const innerProver = new BatchAVLProver(keyLength, valueLengthOpt);

  const newProver = new PersistentBatchAVLProver(innerProver, newStorage, [
    [HEIGHT_SENTINEL, encodeHeight(0)], // initial height, updated on first block
  ]);

  // Only cache when using the global database
  if (!db) {
    storage = newStorage;
    persistentProver = newProver;
  }

  return { prover: newProver, storage: newStorage };
}

/** One identity-record write destined for the tree, keyed by its AVL key. */
export interface RecordPut {
  /** hex — H(IDENTITY_KEY_DOMAIN ‖ identityId). */
  key: string;
  record: IdentityRecord;
}

/**
 * Bootstrap the prover from committed state.
 * Called once on first AVL-aware startup if storage is empty but the chain DB
 * is populated — the documented "wipe the AVL store" deploy step.
 *
 * **`records` is required, and deliberately not defaulted** (Spec G phase D).
 * The tree holds two committed entity kinds; a rebuild that fed only boxes
 * would produce a tree missing every record and therefore a `stateRoot`
 * different from a node that never restarted — a restart-triggered consensus
 * fork, from nothing but a forgotten argument. `applyBlockMutations`' analogous
 * parameter *is* defaulted, for the ~20 pre-existing three-argument call sites;
 * this one has a single production caller, so requiring it costs nothing and
 * makes the omission a compile error at the only place it could matter.
 *
 * Both feeds are sorted by hex key, matching `applyBlockMutations`' canonical
 * order: all boxes, then all records. Boxes and records cannot collide — their
 * keys are hashes under different domain tags.
 */
export function bootstrapAvlProver(
  handle: AvlProverHandle,
  unspentBoxes: AnyBox[],
  currentHeight: number,
  records: RecordPut[],
): void {
  // Sorted here rather than in getUnspentBoxes' SQL: the canonical order is a
  // property of the prover feed, so it lives at this boundary and every other
  // caller of getUnspentBoxes keeps its own ordering.
  for (const box of sortByBoxId(unspentBoxes)) {
    const key = hexToBytes(box.id!);
    const value = serializeBox(box);
    handle.prover.performOneOperation({ tag: 'Insert', key, value });
  }
  // `Insert`, not `InsertOrUpdate`: the tree is empty and the store holds one
  // row per identity, so a repeat here would mean a duplicate key and should
  // fail loudly rather than silently keep the last one.
  for (const put of [...records].sort((a, b) => byHexBoxId(a.key, b.key))) {
    handle.prover.performOneOperation({
      tag: 'Insert',
      key: hexToBytes(put.key),
      value: serializeIdentityRecord(put.record),
    });
  }
  // Checkpoint at current tip
  handle.prover.generateProofAndUpdateStorage([
    [HEIGHT_SENTINEL, encodeHeight(currentHeight)],
  ]);
}

/**
 * Apply a block's committed-state mutations to the prover and return the new
 * 33-byte digest.
 *
 * The feed is sorted internally, so callers MUST NOT rely on their input order
 * reaching the tree — it is deliberately discarded.
 *
 * @param consumed - hex-encoded box IDs consumed in this block, any order
 * @param created - full box objects created in this block, any order
 * @param recordPuts - identity-record writes, any order, **one entry per key**
 *   (the journal feed collapses duplicates to the last write before this point;
 *   record puts are not commutative, so that collapse must happen where
 *   application order is still authoritative)
 * @returns 33-byte digest (root label || height)
 */
export function applyBlockMutations(
  prover: PersistentBatchAVLProver,
  consumed: string[],
  created: AnyBox[],
  recordPuts: RecordPut[] = [],
): Uint8Array {
  // Canonical order (M-12): all removes, then all inserts, then all record
  // puts, each lexicographically by hex key.
  //
  // The remove and insert groups are disjoint by construction. A key in the
  // remove group was in the tree before this block; a key in the insert group
  // is created by it. Under provenance-derived ids a box id is a function of
  // (candidate, txId, index), so two boxes share an id only if they share all
  // three — i.e. the same transaction applied at two heights. A real tx cannot
  // be: its inputs are consumed on first application. **That step depends on
  // every user tx having at least one input**, which the UTXO engine enforces
  // by rejecting empty-input txs — a zero-input user tx would be replayable and
  // would break this argument, so that rejection is load-bearing for identity,
  // not merely for value. A synthetic mint tx cannot recur either: mintTxId
  // commits to the height. Intra-block insert+remove pairs for one id were
  // netted out upstream. So the split can never reorder ops on a single key.
  //
  // (This replaces the pre-Spec-G argument from "box ids commit to
  // createdAtBlock", a premise Spec G deletes. The property survives and
  // strengthens: an id cannot recur across blocks at all, where the old
  // argument only ruled out same-block recurrence.)
  //
  // Boxes and records are disjoint by **domain separation**, not by luck: box
  // ids and record keys are hashes under different domain tags. That is why the
  // record key is hashed rather than the raw 32-byte pubkey, which an attacker
  // chooses.
  for (const boxId of [...consumed].sort(byHexBoxId)) {
    const key = hexToBytes(boxId);
    prover.performOneOperation({ tag: 'Remove', key });
  }

  // Insert created boxes, same canonical order
  for (const box of sortByBoxId(created)) {
    const key = hexToBytes(box.id!);
    const value = serializeBox(box);
    prover.performOneOperation({ tag: 'Insert', key, value });
  }

  // Record puts use InsertOrUpdate: a put is a create on first write and an
  // update afterwards, and the feed does not know which — InsertOrUpdate
  // collapses that distinction so the feed needs no existence lookup.
  for (const put of [...recordPuts].sort((a, b) => byHexBoxId(a.key, b.key))) {
    prover.performOneOperation({
      tag: 'InsertOrUpdate',
      key: hexToBytes(put.key),
      value: serializeIdentityRecord(put.record),
    });
  }

  const digest = prover.digest();
  if (!digest) throw new Error('Prover digest is null after block mutations');
  return digest;
}

/**
 * Checkpoint the prover state at a block height.
 * Called after all mutations for a block are applied.
 */
export function checkpointProver(
  handle: AvlProverHandle,
  height: number,
): void {
  handle.prover.generateProofAndUpdateStorage([
    [HEIGHT_SENTINEL, encodeHeight(height)],
  ]);

  // Prune versions older than the retention window
  const cutoff = height - config.maxProofHistory;
  if (cutoff > 0) {
    handle.storage.pruneVersionsBefore(cutoff);
  }
}

/** Decode hex string to bytes. */
function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/**
 * Lexicographic order over hex box ids — the canonical prover-feed order
 * (M-12; NODE_INTERFACE "AVL+ State Root"). Ids are fixed-width lowercase hex,
 * so code-unit order is byte order over the underlying key.
 */
function byHexBoxId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Boxes in canonical id order, without mutating the caller's array. */
function sortByBoxId<T extends { id?: string }>(boxes: T[]): T[] {
  return [...boxes].sort((a, b) => byHexBoxId(a.id!, b.id!));
}

/** Get the singleton prover handle (throws if not initialized). */
export function getAvlProver(): AvlProverHandle {
  if (!persistentProver || !storage) {
    throw new Error('AVL prover not initialized. Call createAvlProver() first.');
  }
  return { prover: persistentProver, storage };
}

/** Get the singleton prover handle, or null if not initialized. */
export function tryGetAvlProver(): AvlProverHandle | null {
  if (!persistentProver || !storage) return null;
  return { prover: persistentProver, storage };
}
