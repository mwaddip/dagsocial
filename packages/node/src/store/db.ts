import Database from 'better-sqlite3';

let db: Database.Database | null = null;

const MIGRATIONS = [
  // Drop Phase 1 identities table (had secret_key NOT NULL)
  'DROP TABLE IF EXISTS identities',
  // Drop tables with TEXT id columns — rebuilt as BLOB below
  'DROP TABLE IF EXISTS challenges',
  'DROP TABLE IF EXISTS dag_posts',
  'DROP TABLE IF EXISTS dag_parent_refs',
  'DROP TABLE IF EXISTS dag_stumps',
  'DROP TABLE IF EXISTS dag_likes',
  'DROP TABLE IF EXISTS sub_blocks',
  'DROP TABLE IF EXISTS ordering_blocks',
  'DROP TABLE IF EXISTS utxo_boxes',
  // Identity (Phase 2 — no secret_key).
  // user_id IS the 32-byte Ed25519 public key (BLOB).
  `CREATE TABLE IF NOT EXISTS identities (
    user_id BLOB PRIMARY KEY,
    public_key BLOB NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Challenges
  `CREATE TABLE IF NOT EXISTS challenges (
    user_id BLOB PRIMARY KEY,
    challenge BLOB NOT NULL,
    expires_at_block INTEGER NOT NULL
  )`,

  // Posts DAG
  `CREATE TABLE IF NOT EXISTS dag_posts (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    author BLOB NOT NULL,             -- 32-byte Ed25519 public key
    parent_refs TEXT NOT NULL,       -- JSON array of PostId strings
    challenge BLOB NOT NULL,
    pow_nonce INTEGER NOT NULL,
    protocol_version INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    signature BLOB NOT NULL,
    raw_cbor BLOB NOT NULL,          -- Canonical CBOR bytes
    status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'confirmed' | 'pruned'
    block_height INTEGER             -- NULL until confirmed
  )`,

  `CREATE TABLE IF NOT EXISTS dag_parent_refs (
    post_id TEXT NOT NULL,
    parent_id TEXT NOT NULL,
    PRIMARY KEY (post_id, parent_id)
  )`,

  // Stumps
  `CREATE TABLE IF NOT EXISTS dag_stumps (
    id TEXT PRIMARY KEY,
    root_post_hash TEXT NOT NULL,
    subtree_merkle_root BLOB NOT NULL,
    author_id BLOB NOT NULL,          -- 32-byte Ed25519 public key
    prune_signature BLOB NOT NULL,
    karma_deltas TEXT NOT NULL,      -- JSON array of KarmaDelta
    reply_count INTEGER NOT NULL,
    upvote_count INTEGER NOT NULL,
    trigger TEXT NOT NULL,
    protocol_version INTEGER NOT NULL,
    compacted_at_block_height INTEGER NOT NULL,
    raw_cbor BLOB NOT NULL
  )`,

  // UTXO boxes
  `CREATE TABLE IF NOT EXISTS utxo_boxes (
    id TEXT PRIMARY KEY,
    box_type TEXT NOT NULL,           -- 'karma' | 'credit' | 'like' | 'invite' | 'bond' | 'post_lock'
    value INTEGER NOT NULL,
    created_at_block INTEGER NOT NULL,
    spent_at_block INTEGER,           -- NULL = unspent
    owner BLOB,                       -- 32-byte public key (NULL for like/invite boxes)
    guard TEXT NOT NULL,
    proof_source TEXT,                -- PostId | StumpHash | InviteTxId | block height
    extra_data TEXT,                  -- JSON for box-specific fields (secretHash, likerId, targetPostId, etc.)
    last_touch_block INTEGER          -- For karma boxes only
  )`,

  // Free likes (beyond LIKE_FREE_THRESHOLD * LIKE_THRESHOLD)
  `CREATE TABLE IF NOT EXISTS dag_likes (
    id TEXT PRIMARY KEY,
    target_post_id TEXT NOT NULL,
    liker_id BLOB NOT NULL,            -- 32-byte Ed25519 public key
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    processed INTEGER NOT NULL DEFAULT 0,  -- 0 = pending, 1 = processed at epoch
    UNIQUE(target_post_id, liker_id)
  )`,

  // Sub-blocks
  `CREATE TABLE IF NOT EXISTS sub_blocks (
    sub_block_id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    post_cbor BLOB NOT NULL,
    like_box_ids TEXT NOT NULL,       -- JSON array of BoxId
    producer_id BLOB NOT NULL,        -- 32-byte Ed25519 public key
    protocol_version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'confirmed'
    block_height INTEGER
  )`,

  // Mempool (unified sub-block + UTXO transaction pool)
  `CREATE TABLE IF NOT EXISTS mempool (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_type TEXT NOT NULL CHECK(entry_type IN ('subblock', 'utxo_tx')),
    subblock_cbor BLOB,
    utxo_tx_cbor BLOB,
    batch_id TEXT,
    expires_at_height INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // Ordering blocks
  `CREATE TABLE IF NOT EXISTS ordering_blocks (
    height INTEGER PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    prev_block_hash TEXT NOT NULL,
    sub_block_refs TEXT NOT NULL,     -- JSON array
    like_box_ids TEXT NOT NULL,       -- JSON array
    utxo_tx_ids TEXT NOT NULL,        -- JSON array
    stump_ids TEXT NOT NULL,          -- JSON array
    validator_id BLOB NOT NULL,       -- 32-byte Ed25519 public key
    validator_signature BLOB NOT NULL,
    pow_nonce INTEGER NOT NULL DEFAULT 0,
    pow_target_bits INTEGER NOT NULL DEFAULT 12,
    coinbase_outputs TEXT NOT NULL DEFAULT '[]',  -- JSON array of CoinbaseOutput
    epoch_tally_results TEXT,         -- JSON, nullable
    protocol_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

export function initDb(path: string): void {
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
