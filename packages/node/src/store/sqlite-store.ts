import { getDb } from './db.js';
import { metaGet, metaPut, schemaVersion } from './meta.js';
import type { PostStore, StoreEntry, PeerRecord } from './post-store.js';

export class SqlitePostStore implements PostStore {
  putBatch(entries: StoreEntry[]): void {
    const db = getDb();
    db.transaction(() => {
      for (const entry of entries) {
        this.putInTransaction(entry);
      }
    })();
  }

  put(entry: StoreEntry): void {
    const db = getDb();
    db.transaction(() => {
      this.putInTransaction(entry);
    })();
  }

  private putInTransaction(entry: StoreEntry): void {
    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO dag_posts
       (id, content, author, parent_refs, challenge, pow_nonce,
        protocol_version, timestamp, signature, raw_cbor, status, block_height)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)`
    ).run(
      Buffer.from(entry.id).toString('hex'),
      '', // content parsed from entry.data by caller
      Buffer.alloc(32),
      '[]',
      Buffer.alloc(32),
      0,
      1,
      Date.now(),
      Buffer.alloc(64),
      Buffer.from(entry.data),
    );
  }

  get(typeId: number, id: Uint8Array): Uint8Array | null {
    const db = getDb();
    const row = db.prepare(
      'SELECT raw_cbor FROM dag_posts WHERE id = ?'
    ).get(Buffer.from(id).toString('hex')) as { raw_cbor: Buffer } | undefined;
    if (!row) return null;
    return new Uint8Array(row.raw_cbor);
  }

  has(typeId: number, id: Uint8Array): boolean {
    const db = getDb();
    const row = db.prepare(
      'SELECT 1 FROM dag_posts WHERE id = ?'
    ).get(Buffer.from(id).toString('hex'));
    return row !== undefined;
  }

  bestPostAt(sequence: number): Uint8Array | null {
    const db = getDb();
    const row = db.prepare(
      'SELECT post_id FROM canonical_branch WHERE depth = ?'
    ).get(sequence) as { post_id: string } | undefined;
    if (!row) return null;
    return new Uint8Array(Buffer.from(row.post_id, 'hex'));
  }

  canonicalBranchEntries(): Array<{ sequence: number; postId: Uint8Array }> {
    const db = getDb();
    const rows = db.prepare(
      'SELECT depth, post_id FROM canonical_branch ORDER BY depth ASC'
    ).all() as Array<{ depth: number; post_id: string }>;
    return rows.map(r => ({
      sequence: r.depth,
      postId: new Uint8Array(Buffer.from(r.post_id, 'hex')),
    }));
  }

  metaGet(key: string): Uint8Array | null {
    return metaGet(key);
  }

  metaPut(key: string, value: Uint8Array): void {
    metaPut(key, value);
  }

  listPeers(): PeerRecord[] {
    const db = getDb();
    const rows = db.prepare(
      'SELECT peer_id, last_seen_ms, addresses, features FROM peers'
    ).all() as Array<{
      peer_id: string; last_seen_ms: number; addresses: string; features: Buffer;
    }>;
    return rows.map(r => ({
      peerId: r.peer_id,
      lastSeenMs: r.last_seen_ms,
      addresses: JSON.parse(r.addresses),
      features: new Uint8Array(r.features),
    }));
  }

  putPeer(peer: PeerRecord): void {
    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO peers (peer_id, last_seen_ms, addresses, features)
       VALUES (?, ?, ?, ?)`
    ).run(peer.peerId, peer.lastSeenMs, JSON.stringify(peer.addresses), Buffer.from(peer.features));
  }

  deletePeer(peerId: string): void {
    const db = getDb();
    db.prepare('DELETE FROM peers WHERE peer_id = ?').run(peerId);
  }

  pruneBelowHorizon(horizon: number, typeIds: number[]): void {
    // Deferred — structural types are never pruned
    // Content-type-specific pruning goes here in future
  }

  minSequencePresent(typeId: number): number {
    const db = getDb();
    const row = db.prepare(
      'SELECT MIN(block_height) as min_h FROM dag_posts WHERE block_height IS NOT NULL'
    ).get() as { min_h: number | null } | undefined;
    return row?.min_h ?? 0;
  }

  schemaVersion(): number {
    return schemaVersion();
  }

  close(): void {
    // closeDb() is called at the process level — SqlitePostStore doesn't own the connection
  }
}
