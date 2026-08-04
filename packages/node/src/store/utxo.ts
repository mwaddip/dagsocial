import { getDb } from './db.js';
import type {
  AnyBox,
  KarmaBox,
  CreditBox,
  LikeBox,
  InviteBox,
  BondBox,
  PostLockBox,
  VouchBox,
} from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

// Row shape as returned by statements with .safeIntegers() — every INTEGER
// column arrives as bigint. `value` must stay bigint (loses precision above
// 2^53 otherwise); block-height columns are converted back to number in
// rowToBox.
interface UtxoRow {
  id: string;
  box_type: string;
  value: bigint;
  created_at_block: bigint;
  spent_at_block: bigint | null;
  owner: Buffer | null;
  guard: string;
  proof_source: string | null;
  extra_data: string | null;
  last_touch_block: bigint | null;
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
  inviterId: string;                // hex-encoded pubkey in JSON (Uint8Array in code)
  inviteBoxId: string;              // BoxId of the paired InviteBox
  inviteePublicKey: number[] | null;
  probationStartBlock: number | null;
  probationEndBlock: number | null;
}

interface PostLockExtra {
  originalValue: string;   // bigint as decimal string (JSON cannot carry bigint)
  owner: number[];
  targetPostId: string;
}

interface VouchExtra {
  voucherId: string;    // hex-encoded pubkey
  targetId: string;     // hex-encoded pubkey
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

  switch (row.box_type) {
    case 'karma': {
      const e = extra as KarmaExtra;
      const kb: KarmaBox = {
        id: row.id,
        boxType: 'karma',
        value: row.value,
        createdAtBlock: Number(row.created_at_block),
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
        createdAtBlock: Number(row.created_at_block),
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
        value: 2n,
        createdAtBlock: Number(row.created_at_block),
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
        createdAtBlock: Number(row.created_at_block),
        secretHash: new Uint8Array(e.secretHash),
        inviterId: hexToPubkey(e.inviterId),
        guard: 'hash_preimage_with_bond',
      } satisfies InviteBox as InviteBox;
    }

    case 'bond': {
      const e = extra as BondExtra;
      return {
        id: row.id,
        boxType: 'bond',
        value: row.value,
        createdAtBlock: Number(row.created_at_block),
        inviterId: hexToPubkey(e.inviterId),
        inviteBoxId: e.inviteBoxId ?? '',
        inviteePublicKey: e.inviteePublicKey
          ? new Uint8Array(e.inviteePublicKey)
          : new Uint8Array(0),
        probationStartBlock: e.probationStartBlock ?? 0,
        probationEndBlock: e.probationEndBlock ?? 0,
        guard: 'bond_dual',
      } satisfies BondBox as BondBox;
    }

    case 'post_lock': {
      const e = extra as PostLockExtra;
      return {
        id: row.id,
        boxType: 'post_lock',
        value: row.value,
        createdAtBlock: Number(row.created_at_block),
        originalValue: BigInt(e.originalValue),
        owner: new Uint8Array(e.owner),
        targetPostId: e.targetPostId,
        guard: 'epoch_tally',
      } satisfies PostLockBox as PostLockBox;
    }

    case 'vouch': {
      const e = extra as VouchExtra;
      return {
        id: row.id,
        boxType: 'vouch',
        value: 1n,
        createdAtBlock: Number(row.created_at_block),
        voucherId: hexToPubkey(e.voucherId),
        targetId: hexToPubkey(e.targetId),
        guard: 'owner_signature',
      } satisfies VouchBox as VouchBox;
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
    .prepare('SELECT * FROM utxo_boxes WHERE id = ? AND spent_at_block IS NULL')
    .safeIntegers()
    .get(boxId) as UtxoRow | undefined;
  return row ? rowToBox(row) : null;
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
    .safeIntegers()
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
    .safeIntegers()
    .all(Buffer.from(owner)) as UtxoRow[];
  return rows.map(rowToBox) as KarmaBox[];
}

/**
 * True if a faucet-origin karma box has ever existed for this owner.
 *
 * Deliberately ignores `spent_at_block` — a grant that has since been spent
 * still counts, otherwise an identity could spend its grant and draw again.
 * `'faucet'` enters the ledger only through `faucetGrant`; the system change
 * box carries `'faucet:system'` and does not match. This covers identities
 * funded before the faucet grant ledger existed.
 */
export function hasFaucetOriginKarmaBox(owner: Uint8Array): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 AS present FROM utxo_boxes
       WHERE owner = ? AND box_type = 'karma' AND proof_source = 'faucet'
       LIMIT 1`,
    )
    .get(Buffer.from(owner)) as { present: number } | undefined;
  return row !== undefined;
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
    .safeIntegers()
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
    .safeIntegers()
    .all(Buffer.from(owner)) as UtxoRow[];
  return rows.map(rowToBox) as CreditBox[];
}

/**
 * Return all unspent credit boxes for the given owner whose lockedUntilBlock
 * has passed (or is unset), sorted by value descending. Excludes boxes that
 * are still locked at the given block height.
 */
export function getUnlockedCreditBoxes(
  owner: Uint8Array,
  blockHeight: number,
): CreditBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE owner = ? AND box_type = 'credit' AND spent_at_block IS NULL
         AND (json_extract(extra_data, '$.lockedUntilBlock') IS NULL
              OR json_extract(extra_data, '$.lockedUntilBlock') <= ?)
       ORDER BY value DESC`,
    )
    .safeIntegers()
    .all(Buffer.from(owner), blockHeight) as UtxoRow[];
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
    .safeIntegers()
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
    .safeIntegers()
    .all(pubkeyToHex(inviterId)) as UtxoRow[];
  return rows.map((r) => rowToBox(r) as BondBox);
}

/**
 * Return the hex-encoded liker IDs for all unspent LikeBoxes targeting
 * the given post. Used by the feed API to tell clients who has liked.
 */
export function getLikersForPost(targetPostId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT json_extract(extra_data, '$.likerId') AS likerId FROM utxo_boxes
       WHERE box_type = 'like'
         AND json_extract(extra_data, '$.targetPostId') = ?
         AND spent_at_block IS NULL`,
    )
    .all(targetPostId) as { likerId: string }[];
  return rows.map((r) => r.likerId);
}

/**
 * Return all unspent (unconsumed) like boxes targeting the given post.
 * Used by prune settlement to refund likers' locked karma.
 */
export function getUnspentLikeBoxes(targetPostId: string): LikeBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'like'
         AND json_extract(extra_data, '$.targetPostId') = ?
         AND spent_at_block IS NULL`,
    )
    .safeIntegers()
    .all(targetPostId) as UtxoRow[];
  return rows.map(rowToBox) as LikeBox[];
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
    .safeIntegers()
    .all(targetPostId) as UtxoRow[];
  return rows.map((r) => rowToBox(r) as LikeBox);
}

/**
 * Return all unprocessed (unspent) locked like boxes for epoch tally.
 *
 * Ordered by box id — content-derived, so every node walks these in the same
 * order regardless of the order it received the likes in.  Defence in depth
 * for the epoch tally: the consensus-relevant serialization is canonicalized
 * (`epoch-canonical.ts`), never left to rely on rowid order.
 */
export function getUnprocessedLockedLikeBoxes(): LikeBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'like' AND spent_at_block IS NULL
       ORDER BY id`,
    )
    .safeIntegers()
    .all() as UtxoRow[];
  return rows.map((r) => rowToBox(r) as LikeBox);
}

/**
 * Return all unspent post lock boxes for epoch tally.
 *
 * Ordered by box id, for the same reason as the like boxes above.
 */
export function getUnspentPostLockBoxes(): PostLockBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'post_lock' AND spent_at_block IS NULL
       ORDER BY id`,
    )
    .safeIntegers()
    .all() as UtxoRow[];
  return rows.map((r) => rowToBox(r) as PostLockBox);
}

/**
 * Return the unspent PostLockBox for a specific post, if any.
 */
export function getPostLockBox(targetPostId: string): PostLockBox | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'post_lock'
         AND json_extract(extra_data, '$.targetPostId') = ?
         AND spent_at_block IS NULL`,
    )
    .safeIntegers()
    .get(targetPostId) as UtxoRow | undefined;
  if (!row) return null;
  return rowToBox(row) as PostLockBox;
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
        inviteBoxId: b.inviteBoxId,
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
        originalValue: p.originalValue.toString(),
        owner: Array.from(p.owner),
        targetPostId: p.targetPostId,
      } satisfies PostLockExtra;
      break;
    }
    case 'vouch': {
      const v = box as VouchBox;
      extraData = {
        voucherId: pubkeyToHex(v.voucherId),
        targetId: pubkeyToHex(v.targetId),
      } satisfies VouchExtra;
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
 * Return all unspent boxes from the UTXO set.
 * Used to bootstrap the AVL prover on startup.
 */
export function getUnspentBoxes(): AnyBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, box_type, value, created_at_block, spent_at_block,
              owner, guard, proof_source, extra_data, last_touch_block
       FROM utxo_boxes
       WHERE spent_at_block IS NULL
       ORDER BY created_at_block ASC`,
    )
    .safeIntegers()
    .all() as UtxoRow[];
  return rows.map(rowToBox);
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
