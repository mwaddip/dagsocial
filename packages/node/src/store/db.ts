import Database from 'better-sqlite3';

let db: Database.Database | null = null;

const MIGRATIONS = [
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

  // Mempool (unified sub-block + UTXO transaction pool)
  // Schema change: subblock_cbor BLOB → subblock_id TEXT (ID-based, not CBOR-based).
  // Existing databases with the old schema will fail — pre-stable, DB reset acceptable.
  `CREATE TABLE IF NOT EXISTS mempool (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_type TEXT NOT NULL CHECK(entry_type IN ('subblock', 'utxo_tx')),
    subblock_id TEXT,
    utxo_tx_cbor BLOB,
    batch_id TEXT,
    expires_at_height INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // System config (persistent node-level keypairs, etc.)
  `CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value BLOB NOT NULL
  )`,

  // Ordering blocks
  `CREATE TABLE IF NOT EXISTS ordering_blocks (
    height INTEGER PRIMARY KEY,
    header_cbor BLOB NOT NULL,
    subblock_tree_cbor BLOB NOT NULL,
    utxotx_tree_cbor BLOB NOT NULL,
    validator_signature BLOB NOT NULL,  -- 64 bytes
    created_at INTEGER NOT NULL
  )`,

  // Block journal (CBOR-encoded undo data per block)
  `CREATE TABLE IF NOT EXISTS block_journal (
    block_height INTEGER PRIMARY KEY,
    journal_cbor BLOB NOT NULL
  )`,

  // Clean invite/bond boxes with old guard types (pre commit-reveal)
  `DELETE FROM utxo_boxes WHERE (box_type = 'invite' AND guard = 'hash_preimage') OR (box_type = 'bond' AND guard = 'inviter_signature')`,

  // dag_meta key-value metadata table
  `CREATE TABLE IF NOT EXISTS dag_meta (
    key   TEXT PRIMARY KEY,
    value BLOB NOT NULL
  )`,

  // Canonical DAG branch — depth → post_id mapping for fork-choice view
  `CREATE TABLE IF NOT EXISTS canonical_branch (
    depth    INTEGER PRIMARY KEY,
    post_id  TEXT NOT NULL
  )`,

  // Cumulative PoW scores per post for fork-choice rule
  `CREATE TABLE IF NOT EXISTS post_scores (
    post_id           TEXT PRIMARY KEY,
    cumulative_score  INTEGER NOT NULL
  )`,
];

function migrateMempoolForStumps(database: Database.Database): void {
  // Check if migration already applied, or if verifiablePrune migration has superseded this
  const cols = database.prepare("PRAGMA table_info('mempool')").all() as Array<{ name: string }>;
  if (cols.some(c => c.name === 'stump_id' || c.name === 'prune_entry_cbor')) return;

  database.exec(`
    ALTER TABLE mempool RENAME TO mempool_old;

    CREATE TABLE mempool (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('subblock', 'utxo_tx', 'stump')),
      subblock_id TEXT,
      utxo_tx_cbor BLOB,
      stump_id TEXT,
      batch_id TEXT,
      expires_at_height INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO mempool (rowid, entry_type, subblock_id, utxo_tx_cbor, batch_id, expires_at_height, created_at)
    SELECT rowid, entry_type, subblock_id, utxo_tx_cbor, batch_id, expires_at_height, created_at
    FROM mempool_old;

    DROP TABLE mempool_old;
  `);
}

function migrateAvlTree(database: Database.Database): void {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='avl_tree_versions'")
    .all() as Array<{ name: string }>;
  if (tables.length > 0) return;

  database.exec(`
    CREATE TABLE avl_tree_versions (
      version BLOB PRIMARY KEY,
      height INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE avl_tree_nodes (
      version BLOB NOT NULL REFERENCES avl_tree_versions(version),
      label BLOB NOT NULL,
      node_data BLOB NOT NULL,
      PRIMARY KEY (version, label)
    );
  `);
}

function migrateBlockTopology(database: Database.Database): void {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='block_topology'")
    .all() as Array<{ name: string }>;
  if (tables.length > 0) return;

  database.exec(`
    CREATE TABLE IF NOT EXISTS block_topology (
      post_id TEXT PRIMARY KEY,
      parent_refs TEXT NOT NULL,
      block_height INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_block_topology_height
      ON block_topology(block_height);
  `);
}

function migrateVerifiablePrune(database: Database.Database): void {
  // Check if migration already applied (prune_entry_cbor column exists in mempool)
  const cols = database.prepare("PRAGMA table_info('mempool')").all() as Array<{ name: string }>;
  if (cols.some(c => c.name === 'prune_entry_cbor')) return;

  console.warn('migrateVerifiablePrune: applying one-time mempool and dag_stumps schema migration');

  // Drop and recreate mempool with prune_entry_cbor, entry_type 'prune' instead of 'stump'
  database.exec(`
    DROP TABLE IF EXISTS mempool;
    CREATE TABLE mempool (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('subblock', 'utxo_tx', 'prune')),
      subblock_id TEXT,
      utxo_tx_cbor BLOB,
      prune_entry_cbor BLOB,
      batch_id TEXT,
      expires_at_height INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Drop and recreate dag_stumps with simplified schema
  // Removed columns: subtree_merkle_root, prune_signature, karma_deltas
  database.exec(`
    DROP TABLE IF EXISTS dag_stumps;
    CREATE TABLE dag_stumps (
      id TEXT PRIMARY KEY,
      root_post_hash TEXT NOT NULL,
      author_id BLOB NOT NULL,
      reply_count INTEGER NOT NULL,
      upvote_count INTEGER NOT NULL,
      trigger TEXT NOT NULL,
      protocol_version INTEGER NOT NULL,
      compacted_at_block_height INTEGER NOT NULL,
      raw_cbor BLOB NOT NULL
    );
  `);
}

function migrateVouchCooldowns(database: Database.Database): void {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vouch_cooldowns'")
    .all() as Array<{ name: string }>;
  if (tables.length > 0) return;

  database.exec(`
    CREATE TABLE vouch_cooldowns (
      voucher_id BLOB NOT NULL,
      target_id BLOB NOT NULL,
      release_at_block INTEGER NOT NULL,
      karma_amount INTEGER NOT NULL,
      PRIMARY KEY (voucher_id, target_id)
    );
  `);
}

export function initDb(path: string): void {
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }
  migrateMempoolForStumps(db);
  migrateAvlTree(db);
  migrateBlockTopology(db);
  migrateVerifiablePrune(db);
  migrateVouchCooldowns(db);
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
