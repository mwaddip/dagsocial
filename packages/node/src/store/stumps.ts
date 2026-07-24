import { getDb } from './db.js';
import { computeStumpId, encodeStump } from '@dagsocial/types';
import type { Stump, KarmaDelta } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

interface StumpRow {
  id: string;
  root_post_hash: string;
  subtree_merkle_root: Buffer;
  author_id: Buffer; // 32-byte Ed25519 public key
  prune_signature: Buffer;
  karma_deltas: string;              // JSON array
  reply_count: number;
  upvote_count: number;
  trigger: string;
  protocol_version: number;
  compacted_at_block_height: number;
  raw_cbor: Buffer;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToStump(row: StumpRow): Stump {
  return {
    rootPostHash: row.root_post_hash,
    subtreeMerkleRoot: new Uint8Array(row.subtree_merkle_root),
    authorId: new Uint8Array(row.author_id),
    pruneSignature: new Uint8Array(row.prune_signature),
    karmaDeltas: (JSON.parse(row.karma_deltas) as Array<{ userId: string; delta: number }>).map(d => ({
      userId: new Uint8Array(Buffer.from(d.userId, 'hex')),
      delta: d.delta,
    })),
    replyCount: row.reply_count,
    upvoteCount: row.upvote_count,
    trigger: row.trigger as Stump['trigger'],
    protocolVersion: row.protocol_version,
    compactedAtBlockHeight: row.compacted_at_block_height,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a stump into dag_stumps.
 */
export function insertStump(stump: Stump): void {
  const db = getDb();
  const stumpId = computeStumpId(stump);

  db.prepare(
    `INSERT INTO dag_stumps
       (id, root_post_hash, subtree_merkle_root, author_id, prune_signature,
        karma_deltas, reply_count, upvote_count, trigger, protocol_version,
        compacted_at_block_height, raw_cbor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    stumpId,
    stump.rootPostHash,
    Buffer.from(stump.subtreeMerkleRoot),
    Buffer.from(stump.authorId),
    Buffer.from(stump.pruneSignature),
    JSON.stringify(stump.karmaDeltas.map(d => ({ userId: Buffer.from(d.userId).toString('hex'), delta: d.delta }))),
    stump.replyCount,
    stump.upvoteCount,
    stump.trigger,
    stump.protocolVersion,
    stump.compactedAtBlockHeight,
    Buffer.from(encodeStump(stump)),
  );
}

/**
 * Retrieve a stump by its id.
 * Returns null if no stump with that id exists.
 */
export function getStump(stumpId: string): Stump | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM dag_stumps WHERE id = ?')
    .get(stumpId) as StumpRow | undefined;
  return row ? rowToStump(row) : null;
}
