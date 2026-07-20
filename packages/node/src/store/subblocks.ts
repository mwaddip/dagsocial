import { getDb } from './db.js';
import { getBox } from './utxo.js';
import { encodePost, decodePost } from '@dagsocial/types';
import type { SubBlock, LikeBox } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

interface SubBlockRow {
  sub_block_id: string;
  post_id: string;
  post_cbor: Buffer;
  like_box_ids: string;     // JSON array of BoxId
  producer_id: string;
  protocol_version: number;
  status: string;
  block_height: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToSubBlock(row: SubBlockRow): SubBlock {
  const post = decodePost(new Uint8Array(row.post_cbor));
  const likeBoxIds: string[] = JSON.parse(row.like_box_ids);
  const likeBoxes: LikeBox[] = likeBoxIds
    .map((id) => getBox(id))
    .filter((b): b is LikeBox => b !== null && b.boxType === 'like');

  return {
    subBlockId: row.sub_block_id,
    post,
    likeBoxes,
    producerId: row.producer_id,
    protocolVersion: row.protocol_version,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a sub-block row.
 */
export function insertSubBlock(sb: SubBlock): void {
  const db = getDb();
  const postCbor = Buffer.from(encodePost(sb.post));
  const likeBoxIds = JSON.stringify(sb.likeBoxes.map((b) => b.id));

  db.prepare(
    `INSERT INTO sub_blocks
       (sub_block_id, post_id, post_cbor, like_box_ids,
        producer_id, protocol_version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    sb.subBlockId,
    sb.subBlockId, // post_id is the same as subBlockId (sub-block IS the post)
    postCbor,
    likeBoxIds,
    sb.producerId,
    sb.protocolVersion,
  );
}

/**
 * Return pending sub-blocks, oldest first, up to `limit`.
 */
export function getPendingSubBlocks(limit: number): SubBlock[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM sub_blocks WHERE status = 'pending' ORDER BY rowid ASC LIMIT ?",
    )
    .all(limit) as SubBlockRow[];
  return rows.map(rowToSubBlock);
}

/**
 * Confirm a sub-block at a given block height.
 */
export function confirmSubBlock(subBlockId: string, blockHeight: number): void {
  getDb()
    .prepare(
      "UPDATE sub_blocks SET status = 'confirmed', block_height = ? WHERE sub_block_id = ?",
    )
    .run(blockHeight, subBlockId);
}
