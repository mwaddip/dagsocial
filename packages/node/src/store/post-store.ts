/**
 * Backend-agnostic post store interface.
 *
 * Modeled on Ergo's ModifierStore trait. The store sees opaque
 * (typeId, id, sequence, data) tuples. It does NOT parse post content,
 * verify signatures, or validate the DAG structure.
 *
 * Implementations: SqlitePostStore (default), PgPostStore (deferred).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StoreEntry {
  /** Content type discriminator (maps to internal table routing). */
  typeId: number;
  /** 32-byte blake2b content hash. */
  id: Uint8Array;
  /** Caller-provided logical sequence number. The store never derives it. */
  sequence: number;
  /** Opaque serialized bytes. */
  data: Uint8Array;
}

export interface PeerRecord {
  peerId: string;
  lastSeenMs: number;
  addresses: string[];
  features: Uint8Array;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface PostStore {
  // ---- Core writes ----

  /**
   * Atomic batch write. All entries commit or none do.
   * Idempotent — duplicate (typeId, id) with same data is a no-op.
   */
  putBatch(entries: StoreEntry[]): void;

  /**
   * Single-entry put. Idempotent.
   */
  put(entry: StoreEntry): void;

  // ---- Core reads ----

  /** Lookup by content hash. Returns null if not found. */
  get(typeId: number, id: Uint8Array): Uint8Array | null;

  /** Check existence without reading full data. */
  has(typeId: number, id: Uint8Array): boolean;

  // ---- Canonical branch (populated in Phase 4) ----

  /** Best post at a given sequence number. Null if no post at that depth. */
  bestPostAt(sequence: number): Uint8Array | null;

  /**
   * Bulk sequential read of the canonical branch. Returns all entries in
   * ascending sequence order. Used at startup to rebuild in-memory DAG view.
   */
  canonicalBranchEntries(): Array<{ sequence: number; postId: Uint8Array }>;

  // ---- Metadata (delegated to dag_meta) ----

  metaGet(key: string): Uint8Array | null;
  metaPut(key: string, value: Uint8Array): void;

  // ---- Peer records ----

  listPeers(): PeerRecord[];
  putPeer(peer: PeerRecord): void;
  deletePeer(peerId: string): void;

  // ---- Maintenance ----

  /**
   * Prune non-structural data below the given horizon.
   * Structural types (post metadata, DAG edges, scores) are never pruned.
   * Idempotent — calling at the same horizon twice is a no-op.
   */
  pruneBelowHorizon(horizon: number, typeIds: number[]): void;

  /** Oldest sequence number present for a given type. */
  minSequencePresent(typeId: number): number;

  // ---- Versioning ----

  schemaVersion(): number;

  // ---- Lifecycle ----

  close(): void;
}
