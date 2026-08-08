import { getDb } from './db.js';
import {
  isBlockJournalOpen,
  openBlockJournalHeight,
  recordBoxInsert,
  recordBoxRemove,
} from './journal.js';
import { getIdentityRecord, putIdentityRecord } from './identity-records.js';
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
  owner: Buffer | null;
  extra_data: string | null;
  // Creating-transaction provenance (Spec G phase B), NOT NULL as of G3b.
  tx_id: string;
  output_index: bigint;
}

// ---------------------------------------------------------------------------
// Extra data shapes (stored as JSON in extra_data column)
// ---------------------------------------------------------------------------

interface KarmaExtra {
  proofSource: string;
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
  inviteOutputIndex: number;        // Output position of the paired InviteBox in this bond's own tx
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
 * Provenance as the row carries it.
 *
 * `tx_id`/`output_index` became NOT NULL in phase G3b, so this is now
 * unconditional — the conditional-assignment discipline it replaced existed
 * because a nullable column could yield a box with no provenance, and setting a
 * key to explicit `undefined` is byte-visible in the AVL value (cbor-x encodes
 * it as `f7` *and* increments the fixed two-byte map header). With the columns
 * NOT NULL that shape is unrepresentable.
 *
 * Key **order** no longer matters either: both encoders sort keys as of G3b, so
 * the old "append provenance after every candidate field, and make every
 * producer do the same" rule is retired. That rule is what `post_lock` violated.
 */
function provenanceOf(row: UtxoRow): { txId: string; index: number } {
  return { txId: row.tx_id, index: Number(row.output_index) };
}

/**
 * The height to record in the `created_at_block` **store column**.
 *
 * Taken from the open block journal, never from the box (Spec G phase G checklist
 * item 7). Until G3b the box carried a `createdAtBlock` and `insertBox` wrote
 * that, which was indistinguishable from this because every production producer
 * set the field to the block height anyway — the rule was correct but
 * unenforceable. Deleting the field is what proves it: there is now nothing else
 * `insertBox` could read.
 *
 * `0` when no journal is open. That is every non-block path — genesis and
 * bootstrap — and it is honest rather than a fallback: those boxes were not
 * created by block application, and `0` is not a real block height. The column
 * is display and `getUnspentBoxes` ordering only; consensus must never read it
 * (Spec G D3), so an approximate value here cannot reach the `stateRoot`.
 */
function settledHeight(): number {
  return openBlockJournalHeight() ?? 0;
}

/**
 * Reconstruct a typed box from a utxo_boxes row.
 *
 * Columns id, box_type, value and owner are read directly; `guard` is a
 * per-boxType constant reconstructed from the discriminant. Everything else is
 * parsed from the extra_data JSON column.
 *
 * `created_at_block` is deliberately NOT read: it is a store column and never a
 * box field (Spec G D3), and putting it back on the object would change every
 * box id — `canonicalBoxBytes` strips only `id`/`txId`/`index`, so any stray key
 * enters the hash. The same is true of any other decoration a display path might
 * want; add a separate query instead.
 */
function rowToBox(row: UtxoRow): AnyBox {
  const extra = row.extra_data ? JSON.parse(row.extra_data) : {};
  const prov = provenanceOf(row);

  switch (row.box_type) {
    case 'karma': {
      const e = extra as KarmaExtra;
      const kb: KarmaBox = {
        id: row.id,
        boxType: 'karma',
        value: row.value,
        owner: new Uint8Array(row.owner!),
        guard: 'owner_signature',
        proofSource: e.proofSource,
        ...prov,
      };
      if (e.decayBurn !== undefined) {
        kb.decayBurn = e.decayBurn;
      }
      return kb;
    }

    case 'credit': {
      const e = extra as CreditExtra;
      const cb: CreditBox = {
        id: row.id,
        boxType: 'credit',
        value: row.value,
        owner: new Uint8Array(row.owner!),
        guard: 'owner_signature',
        proofSource: e.proofSource,
        ...prov,
      };
      if (e.lockedUntilBlock !== undefined) {
        cb.lockedUntilBlock = e.lockedUntilBlock;
      }
      return cb;
    }

    case 'like': {
      const e = extra as LikeExtra;
      return {
        id: row.id,
        boxType: 'like',
        // The row's real value, NOT the literal 2n this used to fabricate.
        // The box id hashes `canonicalBoxBytes` — value included — so a store
        // that rewrites the value on read returns a box whose bytes no longer
        // match its own id, and an AVL prover re-bootstrapped from SQLite
        // would diverge from one fed at insert time. Unlike vouch there is no
        // cast-time value pin (LIKE_COST is what every production builder
        // uses, but outputs arrive as client CBOR, and P2-D deletes the box
        // rather than pinning it); the store's job is to round-trip what is
        // actually on disk. The `as` cast bridges LikeBox's literal `2n`
        // value type, which documents the builders' constant rather than a
        // storage guarantee.
        value: row.value as LikeBox['value'],
        likerId: hexToPubkey(e.likerId),
        targetPostId: e.targetPostId,
        guard: 'epoch_tally',
        ...prov,
      };
    }

    case 'invite':
      return {
        id: row.id,
        boxType: 'invite',
        value: row.value,
        secretHash: new Uint8Array((extra as InviteExtra).secretHash),
        inviterId: hexToPubkey((extra as InviteExtra).inviterId),
        guard: 'hash_preimage_with_bond',
        ...prov,
      };

    case 'bond': {
      const e = extra as BondExtra;
      return {
        id: row.id,
        boxType: 'bond',
        value: row.value,
        inviterId: hexToPubkey(e.inviterId),
        inviteOutputIndex: e.inviteOutputIndex ?? 0,
        inviteePublicKey: e.inviteePublicKey
          ? new Uint8Array(e.inviteePublicKey)
          : new Uint8Array(0),
        probationStartBlock: e.probationStartBlock ?? 0,
        probationEndBlock: e.probationEndBlock ?? 0,
        guard: 'bond_dual',
        ...prov,
      };
    }

    case 'post_lock': {
      const e = extra as PostLockExtra;
      return {
        id: row.id,
        boxType: 'post_lock',
        value: row.value,
        originalValue: BigInt(e.originalValue),
        owner: new Uint8Array(e.owner),
        targetPostId: e.targetPostId,
        guard: 'epoch_tally',
        ...prov,
      };
    }

    case 'vouch': {
      const e = extra as VouchExtra;
      return {
        id: row.id,
        boxType: 'vouch',
        // The row's real value, NOT the literal 1n this used to fabricate.
        // The box id hashes `canonicalBoxBytes` — value included — so a store
        // that rewrites the value on read returns a box whose bytes no longer
        // match its own id, and an AVL prover re-bootstrapped from SQLite
        // would diverge from one fed at insert time. The cast pin
        // (`vouch.value == VOUCH_KARMA_AMOUNT`, P2-B phase 2) is what makes
        // every *new* vouch hold exactly 1; the store's job is to round-trip
        // what is actually on disk. The `as` cast bridges VouchBox's literal
        // `1n` value type, which documents the pinned constant rather than a
        // storage guarantee.
        value: row.value as VouchBox['value'],
        voucherId: hexToPubkey(e.voucherId),
        targetId: hexToPubkey(e.targetId),
        guard: 'owner_signature',
        ...prov,
      };
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
 * Resolve an unspent box by its creating-transaction provenance.
 *
 * `UNIQUE(tx_id, output_index)` makes the pair name at most one box, so no
 * `LIMIT` or ordering is needed — the index *is* the uniqueness argument.
 *
 * Added for the bond commit path (user decision, 2026-08-06): `BondBox` pairs
 * with its InviteBox by output index rather than by box id, because a box id in
 * a content field is circular under the provenance derivation. This is the
 * lookup that replaces `getBox(bond.inviteBoxId)`.
 */
export function getBoxByProvenance(txId: string, index: number): AnyBox | null {
  const row = getDb()
    .prepare(
      'SELECT * FROM utxo_boxes WHERE tx_id = ? AND output_index = ? AND spent_at_block IS NULL',
    )
    .safeIntegers()
    .get(txId, index) as UtxoRow | undefined;
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
 * Summed value of every unspent KarmaBox owned by `owner`.
 *
 * Consensus input, not a convenience read: bond settlement's unlock predicate
 * reads it at spend time (NODE_INTERFACE → "Bond transition rules"), so every
 * validation path — pool entry, relay, block application — must compute it
 * through this one function or nodes can split. It MUST sum all unspent boxes,
 * never read a single one: multiple unspent karma boxes per owner is reachable
 * (faucet grant + mint, or a karma split), and `getKarmaBox` above is `LIMIT 1`
 * with no `ORDER BY` — an arbitrary row, so a single-box read would give two
 * nodes with different physical row order different balances for the same
 * owner, and different unlock verdicts on the same settlement.
 *
 * Implemented over `getKarmaBoxes` so exactly one query names the
 * unspent-karma set — a second WHERE clause here would be a mirror
 * implementation.
 */
export function getKarmaValue(owner: Uint8Array): bigint {
  return getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n);
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
 * Return the hex-encoded liker IDs for everyone holding a like-record on
 * the given post (N4a — reads `like_records`, the source of truth since
 * per-block settlement). Used by the feed API to tell clients who has liked.
 * Ordered by liker id so the listing is a function of state, not row order.
 */
export function getLikersForPost(targetPostId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT liker_id FROM like_records
       WHERE target_post_id = ?
       ORDER BY liker_id`,
    )
    .all(targetPostId) as { liker_id: Buffer }[];
  return rows.map((r) => r.liker_id.toString('hex'));
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
 * Bump an identity's activity clock to the height of the block being applied
 * (Spec G phase D; NODE_INTERFACE → "Populating the record").
 *
 * Called from `insertBox` for every karma box with `decayBurn !== true` — which
 * is *exactly* the old staleness predicate ("no unspent non-decay karma box
 * newer than the threshold") read from the other end. Recording it at the store
 * choke point is what makes the clock swap behaviour-preserving by
 * construction rather than by re-derivation at each of the eight producers.
 *
 * `lastDecayBlock` is carried through untouched: the fields of the record
 * have different writers, and an activity bump that reset the decay clock would
 * hand the owner a free interval. `likeCarry` (P2-D) likewise — it is
 * settlement-owned, and zeroing it here would confiscate accrued likes on
 * every karma receipt.
 *
 * With no journal open — genesis, bootstrap, any non-block path — this records
 * nothing, consistent with every other choke-point hook. Consensus only reads
 * the record during block application, and a height invented outside a block
 * would not be a settled one.
 */
function bumpActivityClock(owner: Uint8Array): void {
  const height = openBlockJournalHeight();
  if (height === null) return;
  const existing = getIdentityRecord(owner);
  putIdentityRecord(owner, {
    lastActivityBlock: height,
    lastDecayBlock: existing?.lastDecayBlock ?? 0,
    likeCarry: existing?.likeCarry ?? 0n,
  });
}

/**
 * Insert a box into the utxo_boxes table.
 *
 * Common fields are stored directly; box-type-specific fields are serialised
 * into the extra_data JSON column.
 */
export function insertBox(box: AnyBox): void {
  // Never record an insert without its boxId — the apply funnel's totality
  // catch converts this throw into a block rejection.
  if (isBlockJournalOpen() && !box.id) {
    throw new Error('insertBox: box.id must be set while a block journal is open');
  }

  const db = getDb();

  // Build extra_data and column values per box type
  let extraData: unknown;
  let owner: Buffer | null = null;
  let proofSource: string | null = null;
  // Set below iff this box is a non-decay karma box — the identity whose
  // activity clock this insertion advances (Spec G phase D). Carried out of the
  // switch rather than bumped inside it so the record is written *after* the
  // box row and its journal entry, keeping reverse-order rollback in the order
  // the two writes happened.
  let activityOwner: Uint8Array | null = null;

  switch (box.boxType) {
    case 'karma': {
      const k = box as KarmaBox;
      const ke: KarmaExtra = {
        proofSource: k.proofSource,
      };
      if (k.decayBurn !== undefined) {
        ke.decayBurn = k.decayBurn;
      }
      extraData = ke satisfies KarmaExtra;
      owner = Buffer.from(k.owner);
      proofSource = k.proofSource;
      // `!== true`, not `=== undefined`: a decay-burn box is the one karma box
      // that must NOT reset the clock, and `decayBurn: false` is normal
      // activity. This is the same test `isIdentityStale` applied to boxes.
      if (k.decayBurn !== true) activityOwner = k.owner;
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
        inviteOutputIndex: b.inviteOutputIndex,
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

  // Plain INSERT, deliberately not INSERT OR REPLACE: two byte-identical boxes
  // in one block collide on the `id` PRIMARY KEY today, which the apply
  // funnel's totality catch turns into a block rejection. OR REPLACE would
  // silently drop the colliding box instead — state corruption in place of a
  // loud failure. Provenance-derived ids make the collision structurally
  // impossible at phase G; until then the loud failure is the correct
  // behaviour (NODE_INTERFACE → "Box provenance columns").
  db.prepare(
    `INSERT INTO utxo_boxes
       (id, box_type, value, created_at_block, spent_at_block,
        owner, guard, proof_source, extra_data,
        tx_id, output_index)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    box.id,
    box.boxType,
    box.value,
    settledHeight(),
    owner,
    box.guard,
    proofSource,
    JSON.stringify(extraData),
    box.txId,
    box.index,
  );

  recordBoxInsert(box);

  if (activityOwner !== null) bumpActivityClock(activityOwner);
}

/**
 * Mark a box as spent at the given block height.
 */
export function consumeBox(boxId: string, consumedAtBlock: number): void {
  getDb()
    .prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?')
    .run(consumedAtBlock, boxId);
  recordBoxRemove(boxId);
}

/**
 * Reverse a consumeBox by clearing spent_at_block.
 * Fork-rollback inverse — never records to the block journal.
 */
export function unconsumeBox(boxId: string): void {
  getDb().prepare('UPDATE utxo_boxes SET spent_at_block = NULL WHERE id = ?').run(boxId);
}

/**
 * Delete a box entirely (for rolling back an insertBox).
 * Fork-rollback inverse — never records to the block journal.
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
      `SELECT id, box_type, value, created_at_block, owner, extra_data,
              tx_id, output_index
       FROM utxo_boxes
       WHERE spent_at_block IS NULL
       ORDER BY created_at_block ASC`,
    )
    .safeIntegers()
    .all() as UtxoRow[];
  return rows.map(rowToBox);
}
