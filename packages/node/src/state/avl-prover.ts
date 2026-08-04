import { BatchAVLProver, PersistentBatchAVLProver } from '@ergots/avltree';
import { SqliteAvlStorage } from './avl-storage.js';
import { serializeBox } from './serialize-box.js';
import { getDb } from '../store/db.js';
import { config } from '../config.js';
import type { AnyBox } from '@dagsocial/types';

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

/**
 * Bootstrap the prover from the current UTXO set.
 * Called once on first AVL-aware startup if storage is empty but UTXO set exists.
 */
export function bootstrapAvlProver(
  handle: AvlProverHandle,
  unspentBoxes: AnyBox[],
  currentHeight: number,
): void {
  // Sorted here rather than in getUnspentBoxes' SQL: the canonical order is a
  // property of the prover feed, so it lives at this boundary and every other
  // caller of getUnspentBoxes keeps its own ordering.
  for (const box of sortByBoxId(unspentBoxes)) {
    const key = hexToBytes(box.id!);
    const value = serializeBox(box);
    handle.prover.performOneOperation({ tag: 'Insert', key, value });
  }
  // Checkpoint at current tip
  handle.prover.generateProofAndUpdateStorage([
    [HEIGHT_SENTINEL, encodeHeight(currentHeight)],
  ]);
}

/**
 * Apply a block's UTXO mutations to the prover and return the new 33-byte digest.
 *
 * The feed is sorted internally, so callers MUST NOT rely on their input order
 * reaching the tree — it is deliberately discarded.
 *
 * @param consumed - hex-encoded box IDs consumed in this block, any order
 * @param created - full box objects created in this block, any order
 * @returns 33-byte digest (root label || height)
 */
export function applyBlockMutations(
  prover: PersistentBatchAVLProver,
  consumed: string[],
  created: AnyBox[],
): Uint8Array {
  // Remove consumed boxes, canonically ordered (M-12). All removes precede all
  // inserts; the two groups are disjoint by construction — box ids commit to
  // createdAtBlock, and any intra-block insert+remove pair for one id was
  // netted out upstream — so the split can never reorder ops on a single key.
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
