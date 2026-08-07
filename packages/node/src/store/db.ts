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
  //
  // created_at_block is a STORE column, never a consensus input (Spec G D3):
  // it is not committed in the stateRoot, so a node bootstrapping from an AVL
  // snapshot cannot reconstruct it. Legitimate readers are getUnspentBoxes
  // ordering and display only. See NODE_INTERFACE "created_at_block is a store
  // column, never a consensus input".
  //
  // tx_id/output_index are the box's creating-transaction provenance (Spec G
  // phase B) and became NOT NULL in phase G3b, in the same commit as the
  // box-field deletions: tightening them invalidates the same test fixtures the
  // deletions do, so two passes would edit every one of them twice.
  //
  // NOT NULL is also the only thing here that fails LOUDLY. `TextEncoder`
  // encodes `undefined` as zero bytes and `u32BE` maps it to the sentinel, so a
  // box with missing provenance derives a stable *wrong* id rather than
  // throwing — invisible in a phase where every golden legitimately moves. The
  // constraint is what turns that into an error.
  //
  // A (tx_id, output_index) pair names exactly one box by construction, so no
  // valid block can trip the constraint — it turns a derivation bug into a loud
  // failure instead of silent state corruption.
  //
  // `last_touch_block` was here and is gone with phase G3b: `lastTouchBlock`
  // left the box protocol, and the column had no reader anywhere — only the
  // INSERT that wrote it.
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
    tx_id TEXT NOT NULL,              -- Creating transaction — real or synthetic mint (Spec G)
    output_index INTEGER NOT NULL,    -- u32 position within that transaction's outputs
    UNIQUE(tx_id, output_index)
  )`,

  // Identity records — the second committed entity alongside boxes (Spec G D4).
  // Per-identity decay clock; once boxes carry no height, decay.ts has nothing
  // to read from them, so the clock lives in committed state.
  //
  // Keyed on the raw 32 Ed25519 public-key bytes (UserId — Spec G D5 withdrawn,
  // there is no separate IdentityId type). The AVL key is DERIVED as
  // blake2b512(IDENTITY_KEY_DOMAIN ‖ identityId)[0:32], never the raw bytes —
  // both are total functions of the identity, so the two cannot drift.
  //
  // like_carry (P2-D): outstanding like accrual < LIKES_PER_KARMA_PAYOUT,
  // written only by per-block like settlement. Committed state — it enters the
  // record's AVL value encoding as an always-present field.
  `CREATE TABLE IF NOT EXISTS identity_records (
    identity_id BLOB PRIMARY KEY,
    last_activity_block INTEGER NOT NULL,
    last_decay_block INTEGER NOT NULL,
    like_carry INTEGER NOT NULL DEFAULT 0
  )`,

  // Free likes (beyond LIKE_FREE_THRESHOLD * LIKE_THRESHOLD)
  //
  // RETIRED (P2-D): the free tier is gone from the contract; this table and
  // its functions run the retired system until N4 drops them. Do not add
  // readers.
  `CREATE TABLE IF NOT EXISTS dag_likes (
    id TEXT PRIMARY KEY,
    target_post_id TEXT NOT NULL,
    liker_id BLOB NOT NULL,            -- 32-byte Ed25519 public key
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    processed INTEGER NOT NULL DEFAULT 0,  -- 0 = pending, 1 = processed at epoch
    UNIQUE(target_post_id, liker_id)
  )`,

  // Like-records (P2-D — replaces dag_likes): (liker, targetPostId) pairs,
  // written ONLY at block application, never by an HTTP route. Content-layer
  // consensus state (the block_topology tier): deterministic by replay,
  // journalled with exact inverses, not in the stateRoot. Records die with
  // the post on prune and survive withdraw; applied_at_block is the height
  // the like's block settled at.
  `CREATE TABLE IF NOT EXISTS like_records (
    target_post_id TEXT NOT NULL,
    liker_id BLOB NOT NULL,            -- 32-byte Ed25519 public key
    applied_at_block INTEGER NOT NULL,
    PRIMARY KEY (target_post_id, liker_id)
  )`,

  // Mempool (unified sub-block + UTXO transaction pool)
  // Schema change: subblock_cbor BLOB → subblock_id TEXT (ID-based, not CBOR-based).
  // Existing databases with the old schema will fail — pre-stable, DB reset acceptable.
  //
  // The like_/invite_/vouch_ columns are gate metadata (audit M-8): populated by
  // insertUtxoTx from the tx outputs so the correctness gates are plain SQL over
  // every row, not a decode-scan of the first 1000.
  `CREATE TABLE IF NOT EXISTS mempool (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_type TEXT NOT NULL CHECK(entry_type IN ('subblock', 'utxo_tx')),
    subblock_id TEXT,
    utxo_tx_cbor BLOB,
    batch_id TEXT,
    expires_at_height INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    like_target TEXT,
    like_liker TEXT,
    invite_inviter TEXT,
    vouch_voucher TEXT
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

  // Faucet grant ledger — one row per (identity, asset) that the testnet
  // faucet has ever funded. Written in the same transaction as the mempool
  // insert, so the row exists from the moment a grant is pending and survives
  // after it settles. The composite primary key is the durable enforcement of
  // the one-grant-per-identity rule.
  `CREATE TABLE IF NOT EXISTS faucet_grants (
    user_id           BLOB NOT NULL,
    asset             TEXT NOT NULL CHECK(asset IN ('karma', 'credit')),
    tx_id             TEXT NOT NULL,
    granted_at_height INTEGER NOT NULL,
    PRIMARY KEY (user_id, asset)
  )`,

  // Discovered peers — persistence behind net's PeerStorage seam (audit L-14).
  // Shaped to net's PeerRecord, keyed by multiaddr: PeerDb dedupes by address,
  // and a libp2p peerId is freely regenerable so it makes a worthless key.
  `CREATE TABLE IF NOT EXISTS peers (
    address           TEXT PRIMARY KEY,
    last_seen_ms      INTEGER NOT NULL,
    agent_name        TEXT NOT NULL,
    node_name         TEXT NOT NULL,
    protocol_version  INTEGER NOT NULL,
    capabilities      TEXT NOT NULL    -- JSON array of message codes
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
      author TEXT NOT NULL,
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      like_target TEXT,
      like_liker TEXT,
      invite_inviter TEXT,
      vouch_voucher TEXT
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

/**
 * Partial indexes over the mempool gate-metadata columns (audit M-8). Created
 * after the mempool migrations so they land on whichever CREATE TABLE ran last.
 * A database predating the gate columns fails loudly here at startup rather
 * than silently at the first insert — pre-stable, DB reset acceptable.
 */
function createMempoolGateIndexes(database: Database.Database): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_mempool_like
      ON mempool(like_target, like_liker) WHERE like_target IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mempool_invite
      ON mempool(invite_inviter) WHERE invite_inviter IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mempool_vouch
      ON mempool(vouch_voucher) WHERE vouch_voucher IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mempool_subblock_id
      ON mempool(subblock_id) WHERE subblock_id IS NOT NULL;
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
  createMempoolGateIndexes(db);
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
