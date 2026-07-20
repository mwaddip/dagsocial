import Database from 'better-sqlite3';

let db: Database.Database | null = null;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS identities (
    user_id      TEXT PRIMARY KEY,
    public_key   BLOB NOT NULL,
    secret_key   BLOB NOT NULL,
    created_at   INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS slots (
    user_id      TEXT NOT NULL,
    challenge    TEXT NOT NULL,
    nonce        INTEGER NOT NULL,
    token_hash   TEXT NOT NULL,
    issued_at    INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    consumed     INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, token_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS posts (
    id           TEXT PRIMARY KEY,
    content      TEXT NOT NULL,
    author       TEXT NOT NULL,
    slot_hash    TEXT NOT NULL,
    pow_nonce    INTEGER NOT NULL,
    signature    TEXT NOT NULL,
    status       TEXT DEFAULT 'pending',
    block_height INTEGER,
    created_at   INTEGER NOT NULL,
    raw_cbor     BLOB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS post_parents (
    post_id      TEXT NOT NULL,
    parent_id    TEXT NOT NULL,
    PRIMARY KEY (post_id, parent_id)
  )`,
  `CREATE TABLE IF NOT EXISTS blocks (
    height       INTEGER PRIMARY KEY AUTOINCREMENT,
    hash         TEXT NOT NULL,
    post_count   INTEGER NOT NULL,
    protocol_version INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS block_posts (
    block_height INTEGER NOT NULL,
    post_id      TEXT NOT NULL,
    position     INTEGER NOT NULL,
    PRIMARY KEY (block_height, post_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_posts_confirmed
    ON posts(block_height, created_at) WHERE status = 'confirmed'`,
  `CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author, created_at)`,
];

export function initDb(path: string): void {
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }
  // Idempotent migration for protocol_version column
  try {
    db.exec("ALTER TABLE blocks ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1");
  } catch { /* column already exists */ }
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
