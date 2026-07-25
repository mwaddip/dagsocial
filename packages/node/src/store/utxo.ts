import { getDb } from './db.js';
import type {
  AnyBox,
  KarmaBox,
  CreditBox,
  LikeBox,
  InviteBox,
  BondBox,
  PostLockBox,
} from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

interface UtxoRow {
  id: string;
  box_type: string;
  value: number;
  created_at_block: number;
  spent_at_block: number | null;
  owner: Buffer | null;
  guard: string;
  proof_source: string | null;
  extra_data: string | null;
  last_touch_block: number | null;
}

// ---------------------------------------------------------------------------
// Extra data shapes (stored as JSON in extra_data column)
// ---------------------------------------------------------------------------

interface KarmaExtra {
  proofSource: string;
  lastTouchBlock: number;
  decayBurn?: boolean;
}

interface CreditExtra {
  proofSource: number;
  lockedUntilBlock?: number;
}

interface LikeExtra {
  likerId: string;       // hex-encoded pubkey in JSON (Uint8Array in code)
  targetPostId: string;
}

interface InviteExtra {
  secretHash: number[];
  inviterId: string;     // hex-encoded pubkey in JSON (Uint8Array in code)
}

interface BondExtra {
  inviterId: string;     // hex-encoded pubkey in JSON (Uint8Array in code)
  inviteePublicKey: number[] | null;
  probationStartBlock: number | null;
  probationEndBlock: number | null;
}

interface PostLockExtra {
  originalValue: number;
  owner: number[];
  targetPostId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a hex-encoded pubkey string (from JSON extra_data) to Uint8Array. */
function hexToPubkey(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/** Convert a Uint8Array pubkey to a hex string for JSON extra_data storage. */
function pubkeyToHex(pk: Uint8Array): string {
  return Buffer.from(pk).toString('hex');
}

/**
 * Reconstruct a typed box from a utxo_boxes row.
 *
 * Common columns (id, box_type, value, created_at_block, owner, guard,
 * proof_source, last_touch_block) are read directly.  Box-type-specific fields
 * are parsed from the extra_data JSON column.
 */
function rowToBox(row: UtxoRow): AnyBox {
  const extra = row.extra_data ? JSON.parse(row.extra_data) : {};
  const spentAtBlock = row.spent_at_block; // carried but not on the box type

  switch (row.box_type) {
    case 'karma': {
      const e = extra as KarmaExtra;
      const kb: KarmaBox = {
        id: row.id,
        boxType: 'karma',
        value: row.value,
        createdAtBlock: row.created_at_block,
        owner: new Uint8Array(row.owner!),
        guard: 'owner_signature',
        proofSource: e.proofSource,
        lastTouchBlock: e.lastTouchBlock,
      };
      if (e.decayBurn !== undefined) {
        kb.decayBurn = e.decayBurn;
      }
      return kb satisfies KarmaBox as KarmaBox;
    }

    case 'credit': {
      const e = extra as CreditExtra;
      const cb: CreditBox = {
        id: row.id,
        boxType: 'credit',
        value: row.value,
        createdAtBlock: row.created_at_block,
        owner: new Uint8Array(row.owner!),
        guard: 'owner_signature',
        proofSource: e.proofSource,
      };
      if (e.lockedUntilBlock !== undefined) {
        cb.lockedUntilBlock = e.lockedUntilBlock;
      }
      return cb satisfies CreditBox as CreditBox;
    }

    case 'like': {
      const e = extra as LikeExtra;
      return {
        id: row.id,
        boxType: 'like',
        value: 2,
        createdAtBlock: row.created_at_block,
        likerId: hexToPubkey(e.likerId),
        targetPostId: e.targetPostId,
        guard: 'epoch_tally',
      } satisfies LikeBox as LikeBox;
    }

    case 'invite': {
      const e = extra as InviteExtra;
      return {
        id: row.id,
        boxType: 'invite',
        value: row.value,
        createdAtBlock: row.created_at_block,
        secretHash: new Uint8Array(e.secretHash),
        inviterId: hexToPubkey(e.inviterId),
        guard: 'hash_preimage',
      } satisfies InviteBox as InviteBox;
    }

    case 'bond': {
      const e = extra as BondExtra;
      return {
        id: row.id,
        boxType: 'bond',
        value: row.value,
        createdAtBlock: row.created_at_block,
        inviterId: hexToPubkey(e.inviterId),
        inviteePublicKey: e.inviteePublicKey
          ? new Uint8Array(e.inviteePublicKey)
          : new Uint8Array(0),
        probationStartBlock: e.probationStartBlock ?? 0,
        probationEndBlock: e.probationEndBlock ?? 0,
        guard: 'inviter_signature',
      } satisfies BondBox as BondBox;
    }

    case 'post_lock': {
      const e = extra as PostLockExtra;
      return {
        id: row.id,
        boxType: 'post_lock',
        value: row.value,
        createdAtBlock: row.created_at_block,
        originalValue: e.originalValue,
        owner: new Uint8Array(e.owner),
        targetPostId: e.targetPostId,
        guard: 'epoch_tally',
      } satisfies PostLockBox as PostLockBox;
    }

    default:
      throw new Error(`Unknown box_type: ${row.box_type}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve a single box by its id.
 * Returns null if no row matches.
 */
export function getBox(boxId: string): AnyBox | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM utxo_boxes WHERE id = ?')
    .get(boxId) as UtxoRow | undefined;
  return row ? rowToBox(row) : null;
}

/**
 * Return all unspent boxes whose owner matches the given 32-byte public key.
 */
export function getUnspentBoxes(owner: Uint8Array): AnyBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT * FROM utxo_boxes WHERE owner = ? AND spent_at_block IS NULL',
    )
    .all(Buffer.from(owner)) as UtxoRow[];
  return rows.map(rowToBox);
}

/**
 * Return the single unspent karma box for the given owner, or null if none.
 */
export function getKarmaBox(owner: Uint8Array): KarmaBox | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE owner = ? AND box_type = 'karma' AND spent_at_block IS NULL
       LIMIT 1`,
    )
    .get(Buffer.from(owner)) as UtxoRow | undefined;
  return row ? (rowToBox(row) as KarmaBox) : null;
}

/**
 * Return all unspent karma boxes for the given owner, sorted by value
 * descending (largest-first for UTXO selection).
 */
export function getKarmaBoxes(owner: Uint8Array): KarmaBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE owner = ? AND box_type = 'karma' AND spent_at_block IS NULL
       ORDER BY value DESC`,
    )
    .all(Buffer.from(owner)) as UtxoRow[];
  return rows.map(rowToBox) as KarmaBox[];
}

/**
 * Return the single unspent credit box for the given owner, or null if none.
 */
export function getCreditBox(owner: Uint8Array): CreditBox | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE owner = ? AND box_type = 'credit' AND spent_at_block IS NULL
       LIMIT 1`,
    )
    .get(Buffer.from(owner)) as UtxoRow | undefined;
  return row ? (rowToBox(row) as CreditBox) : null;
}

/**
 * Return all unspent credit boxes for the given owner, sorted by value
 * descending (largest-first for UTXO selection).
 */
export function getCreditBoxes(owner: Uint8Array): CreditBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE owner = ? AND box_type = 'credit' AND spent_at_block IS NULL
       ORDER BY value DESC`,
    )
    .all(Buffer.from(owner)) as UtxoRow[];
  return rows.map(rowToBox) as CreditBox[];
}

/**
 * Return all unclaimed (unspent) invite boxes created by the given inviter.
 */
export function getPendingInvites(inviterId: Uint8Array): InviteBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'invite'
         AND spent_at_block IS NULL
         AND json_extract(extra_data, '$.inviterId') = ?`,
    )
    .all(pubkeyToHex(inviterId)) as UtxoRow[];
  return rows.map((r) => rowToBox(r) as InviteBox);
}

/**
 * Return the count of unclaimed invite boxes for the given inviter.
 */
export function getPendingInviteCount(inviterId: Uint8Array): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM utxo_boxes
       WHERE box_type = 'invite'
         AND spent_at_block IS NULL
         AND json_extract(extra_data, '$.inviterId') = ?`,
    )
    .get(pubkeyToHex(inviterId)) as { cnt: number };
  return row.cnt;
}

/**
 * Return all bond boxes associated with the given inviter.
 */
export function getBondBoxes(inviterId: Uint8Array): BondBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'bond'
         AND json_extract(extra_data, '$.inviterId') = ?`,
    )
    .all(pubkeyToHex(inviterId)) as UtxoRow[];
  return rows.map((r) => rowToBox(r) as BondBox);
}

/**
 * Return the unspent locked like box for a specific liker on a specific post,
 * or null if none exists.
 */
export function getUnspentLikeForLiker(
  targetPostId: string,
  likerId: Uint8Array,
): LikeBox | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'like'
         AND json_extract(extra_data, '$.targetPostId') = ?
         AND json_extract(extra_data, '$.likerId') = ?
         AND spent_at_block IS NULL
       LIMIT 1`,
    )
    .get(targetPostId, pubkeyToHex(likerId)) as UtxoRow | undefined;
  return row ? (rowToBox(row) as LikeBox) : null;
}

/**
 * Return all locked like boxes targeting the given post.
 */
export function getLockedLikeBoxes(targetPostId: string): LikeBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'like'
         AND json_extract(extra_data, '$.targetPostId') = ?`,
    )
    .all(targetPostId) as UtxoRow[];
  return rows.map((r) => rowToBox(r) as LikeBox);
}

/**
 * Return all unprocessed (unspent) locked like boxes for epoch tally.
 */
export function getUnprocessedLockedLikeBoxes(): LikeBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'like' AND spent_at_block IS NULL`,
    )
    .all() as UtxoRow[];
  return rows.map((r) => rowToBox(r) as LikeBox);
}

/**
 * Return all unspent post lock boxes for epoch tally.
 */
export function getUnspentPostLockBoxes(): PostLockBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'post_lock' AND spent_at_block IS NULL`,
    )
    .all() as UtxoRow[];
  return rows.map((r) => rowToBox(r) as PostLockBox);
}

/**
 * Return the total lifetime like count for a post.
 * Counts ALL like boxes (including spent/tallied) plus ALL free likes
 * (including processed). This is needed because post lock unlocking is
 * cumulative — past likes still count.
 */
export function getPostTotalLikes(targetPostId: string): number {
  const db = getDb();
  const likeRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM utxo_boxes
       WHERE box_type = 'like'
         AND json_extract(extra_data, '$.targetPostId') = ?`,
    )
    .get(targetPostId) as { cnt: number };
  const freeRow = db
    .prepare(
      'SELECT COUNT(*) AS cnt FROM dag_likes WHERE target_post_id = ?',
    )
    .get(targetPostId) as { cnt: number };
  return likeRow.cnt + freeRow.cnt;
}

/**
 * Insert a box into the utxo_boxes table.
 *
 * Common fields are stored directly; box-type-specific fields are serialised
 * into the extra_data JSON column.
 */
export function insertBox(box: AnyBox): void {
  const db = getDb();

  // Build extra_data and column values per box type
  let extraData: unknown;
  let owner: Buffer | null = null;
  let proofSource: string | null = null;
  let lastTouchBlock: number | null = null;

  switch (box.boxType) {
    case 'karma': {
      const k = box as KarmaBox;
      const ke: KarmaExtra = {
        proofSource: k.proofSource,
        lastTouchBlock: k.lastTouchBlock,
      };
      if (k.decayBurn !== undefined) {
        ke.decayBurn = k.decayBurn;
      }
      extraData = ke satisfies KarmaExtra;
      owner = Buffer.from(k.owner);
      proofSource = k.proofSource;
      lastTouchBlock = k.lastTouchBlock;
      break;
    }
    case 'credit': {
      const c = box as CreditBox;
      const ce: CreditExtra = { proofSource: c.proofSource };
      if (c.lockedUntilBlock !== undefined) {
        ce.lockedUntilBlock = c.lockedUntilBlock;
      }
      extraData = ce satisfies CreditExtra;
      owner = Buffer.from(c.owner);
      proofSource = String(c.proofSource);
      break;
    }
    case 'like': {
      const l = box as LikeBox;
      extraData = {
        likerId: pubkeyToHex(l.likerId),
        targetPostId: l.targetPostId,
      } satisfies LikeExtra;
      break;
    }
    case 'invite': {
      const i = box as InviteBox;
      extraData = {
        secretHash: Array.from(i.secretHash),
        inviterId: pubkeyToHex(i.inviterId),
      } satisfies InviteExtra;
      break;
    }
    case 'bond': {
      const b = box as BondBox;
      extraData = {
        inviterId: pubkeyToHex(b.inviterId),
        inviteePublicKey:
          b.inviteePublicKey.length > 0
            ? Array.from(b.inviteePublicKey)
            : null,
        probationStartBlock:
          b.probationStartBlock > 0 ? b.probationStartBlock : null,
        probationEndBlock:
          b.probationEndBlock > 0 ? b.probationEndBlock : null,
      } satisfies BondExtra;
      break;
    }
    case 'post_lock': {
      const p = box as PostLockBox;
      owner = Buffer.from(p.owner);
      extraData = {
        originalValue: p.originalValue,
        owner: Array.from(p.owner),
        targetPostId: p.targetPostId,
      } satisfies PostLockExtra;
      break;
    }
    default:
      throw new Error(`Unknown box type: ${(box as AnyBox).boxType}`);
  }

  db.prepare(
    `INSERT INTO utxo_boxes
       (id, box_type, value, created_at_block, spent_at_block,
        owner, guard, proof_source, extra_data, last_touch_block)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    box.id,
    box.boxType,
    box.value,
    box.createdAtBlock,
    owner,
    box.guard,
    proofSource,
    JSON.stringify(extraData),
    lastTouchBlock,
  );
}

/**
 * Mark a box as spent at the given block height.
 */
export function consumeBox(boxId: string, consumedAtBlock: number): void {
  getDb()
    .prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?')
    .run(consumedAtBlock, boxId);
}

/**
 * Reverse a consumeBox by clearing spent_at_block.
 */
export function unconsumeBox(boxId: string): void {
  getDb().prepare('UPDATE utxo_boxes SET spent_at_block = NULL WHERE id = ?').run(boxId);
}

/**
 * Delete a box entirely (for rolling back an insertBox).
 */
export function deleteBox(boxId: string): void {
  getDb().prepare('DELETE FROM utxo_boxes WHERE id = ?').run(boxId);
}

/**
 * Bulk-mark like boxes as tallied (spent) in a single statement.
 *
 * Uses a temporary table-less approach with a variable number of ? placeholders.
 * For an empty array this is a no-op.
 */
export function markLikeBoxesTallied(boxIds: string[]): void {
  if (boxIds.length === 0) return;
  const db = getDb();
  const placeholders = boxIds.map(() => '?').join(', ');
  db.prepare(
    `UPDATE utxo_boxes SET spent_at_block = -1 WHERE id IN (${placeholders})`,
  ).run(...boxIds);
}
