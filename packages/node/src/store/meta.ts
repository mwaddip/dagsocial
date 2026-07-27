import { getDb } from './db.js';

export const CURRENT_SCHEMA_VERSION = 0;

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
