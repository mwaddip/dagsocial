import { getDb } from './db.js';

/**
 * Bumped 0 → 1 by Spec G phase G3b — the first time this counter has ever
 * moved, and the first time it could earn its keep.
 *
 * Bumped 1 → 2 by P2-D N2a: the `like_records` table and
 * `identity_records.like_carry`. `CREATE TABLE IF NOT EXISTS` does not tighten
 * an existing database, so a v1 `dagsocial.db` would keep an `identity_records`
 * with no `like_carry` column and fail at the first record read — late,
 * confusing, and exactly the outcome `db.ts`'s own precedent rules out ("a DB
 * predating a schema change should fail loudly at startup; pre-stable, reset
 * acceptable"). `ensureSchemaVersion` below is that loud failure; `index.ts`
 * calls it before anything reads the store. No bespoke guard belongs alongside
 * it.
 */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * Retrieve a metadata value by key. Returns null if the key does not exist.
 */
export function metaGet(key: string): Uint8Array | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM dag_meta WHERE key = ?').get(key) as
    | { value: Buffer }
    | undefined;
  if (!row) return null;
  return new Uint8Array(row.value);
}

/**
 * Store a metadata value. Overwrites existing keys (INSERT OR REPLACE).
 */
export function metaPut(key: string, value: Uint8Array): void {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO dag_meta (key, value) VALUES (?, ?)').run(
    key,
    Buffer.from(value),
  );
}

/**
 * Delete a metadata key. No-op if the key does not exist.
 */
export function metaDelete(key: string): void {
  const db = getDb();
  db.prepare('DELETE FROM dag_meta WHERE key = ?').run(key);
}

/**
 * Check if a metadata key exists.
 */
export function metaHas(key: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM dag_meta WHERE key = ?').get(key);
  return row !== undefined;
}

/**
 * Read the schema version from dag_meta. Returns 0 if not set.
 */
export function schemaVersion(): number {
  const bytes = metaGet('schema_version');
  if (!bytes || bytes.length < 4) return 0;
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
}

/**
 * Write the schema version to dag_meta.
 */
export function writeSchemaVersion(version: number): void {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, version, true);
  metaPut('schema_version', new Uint8Array(buf));
}

/**
 * The startup schema-version gate. Called from `index.ts` after `initDb`,
 * before anything reads the store. Three outcomes:
 *
 * - **stored === CURRENT_SCHEMA_VERSION** — proceed;
 * - **stored === 0** — a never-stamped database: stamp it and proceed. Exact
 *   for every file stamped since G3b; a pre-G3b file also reads 0 and would be
 *   adopted, accepted because every such file predates several fresh-DB
 *   mandates and cannot hold a valid chain;
 * - **anything else** — THROW. There are no registered migrations
 *   (pre-stable, DB reset acceptable), and silently stamping a stale file
 *   would defeat the counter: the tables keep their old shape (`CREATE TABLE
 *   IF NOT EXISTS` never tightens), so a v1 file would run until the first
 *   `like_carry` read instead of failing at startup.
 *
 * When a migration path is introduced it runs here, guarded by sentinel keys,
 * before the comparison. The caller maps the throw to a clean exit; tests
 * call this directly and assert the refusal.
 */
export function ensureSchemaVersion(): void {
  const stored = schemaVersion();
  if (stored === CURRENT_SCHEMA_VERSION) return;
  if (stored === 0) {
    writeSchemaVersion(CURRENT_SCHEMA_VERSION);
    return;
  }
  throw new Error(
    `Database schema version is ${stored} but this build expects ` +
    `${CURRENT_SCHEMA_VERSION}, and no migration path exists. ` +
    `Delete the database and resync (pre-stable).`,
  );
}

/**
 * Read the reorg floor from dag_meta. Returns 0 if not set.
 * Encoded as 4-byte LE uint32, same as schema_version.
 */
export function getReorgFloor(): number {
  const bytes = metaGet('reorg_floor');
  if (!bytes || bytes.length < 4) return 0;
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
}

/**
 * Write the reorg floor to dag_meta. Set to 0 to disable.
 */
export function setReorgFloor(depth: number): void {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, depth, true);
  metaPut('reorg_floor', new Uint8Array(buf));
}
