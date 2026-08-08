import { createHash } from 'node:crypto';
import { IDENTITY_KEY_DOMAIN } from '@dagsocial/types';
import { getDb } from './db.js';
import { isBlockJournalOpen, recordIdentityRecordPut } from './journal.js';
import type { UserId } from '@dagsocial/types';

/**
 * The per-identity decay clock — the second committed entity alongside boxes
 * (Spec G D4). Once boxes carry no height, `decay.ts` has nothing to read from
 * them, and consensus may not read an uncommitted store column, so the clock
 * lives in committed state:
 *
 *   stale       = (height − lastActivityBlock) >= staleThresholdBlocks
 *   owedPeriods = floor( (height − max(lastActivityBlock, lastDecayBlock)) / interval )
 *
 * `>=`, not `>`: the box-height predicate this replaced was
 * `createdAtBlock > height − threshold`, i.e. stale iff `height − A >= threshold`.
 * The contract's prose said `>` and was off by one; `decay.ts` carries the full
 * argument, and Spec G D10 requires the swap to be behaviour-identical.
 *
 * **Phase D populates this.** `insertBox` bumps `lastActivityBlock` from the
 * open journal's height for every karma box with `decayBurn !== true`;
 * `applyKarmaDecay` bumps `lastDecayBlock` when it fires; and
 * `ensureSystemKarmaBox` writes genesis's own record, since it runs outside
 * block application where the choke point has no height to read.
 *
 * **Key type is `UserId`** — the raw 32 Ed25519 public-key bytes. There is no
 * separate identity type: Spec G D5's branded `IdentityId` is **withdrawn**,
 * because box `owner`/`likerId`/`inviterId`/`voucherId` are the same pubkey and
 * all `UserId`, so key rotation would have to move box ownership too. The two
 * types move together or not at all, and branding two semantically identical
 * things buys no safety while costing a cast at every boundary.
 *
 * The SQL table keys on those raw bytes; the **AVL** key is derived from them
 * (see `identityRecordKey`). Both are total functions of the identity, so the
 * two representations cannot drift.
 */
export interface IdentityRecord {
  /** u32 — bumped when a non-decay karma box is created for the owner. */
  lastActivityBlock: number;
  /** u32 — bumped when decay fires. */
  lastDecayBlock: number;
  /**
   * Outstanding like accrual, `< LIKES_PER_KARMA_PAYOUT` — written ONLY by
   * per-block like settlement (P2-D). No other path may touch it; every other
   * writer of this record carries the stored value through unchanged.
   *
   * `bigint` although the value is tiny: it is karma-denominated committed
   * state, and the row boundary (`safeIntegers`) hands back bigint — keeping
   * the type end-to-end means no `Number()` coercion can silently appear in a
   * consensus path.
   */
  likeCarry: bigint;
}

/**
 * The record's **AVL** key: `blake2b512(IDENTITY_KEY_DOMAIN ‖ identityId)[0:32]`,
 * hex — never the raw `identityId`.
 *
 * Records and boxes share one 32-byte AVL keyspace, and an `identityId` is 32
 * *attacker-chosen* bytes (a public key): used raw, someone could grind a
 * keypair whose pubkey equals a live box id and collide the two entity kinds in
 * the tree. Hashing under a domain tag makes that infeasible, and is what makes
 * the two kinds provably disjoint — by domain separation, not by luck.
 */
export function identityRecordKey(identityId: UserId): string {
  return createHash('blake2b512')
    .update(IDENTITY_KEY_DOMAIN)
    .update(identityId)
    .digest()
    .subarray(0, 32)
    .toString('hex');
}

/** The record for an identity, or null if it has none yet. */
export function getIdentityRecord(identityId: UserId): IdentityRecord | null {
  const row = getDb()
    .prepare(
      `SELECT last_activity_block, last_decay_block, like_carry
       FROM identity_records WHERE identity_id = ?`,
    )
    .safeIntegers()
    .get(Buffer.from(identityId)) as
      { last_activity_block: bigint; last_decay_block: bigint; like_carry: bigint }
      | undefined;
  if (!row) return null;
  return {
    lastActivityBlock: Number(row.last_activity_block),
    lastDecayBlock: Number(row.last_decay_block),
    likeCarry: row.like_carry,
  };
}

/**
 * Every identity record in the store, ordered by raw identity bytes.
 *
 * Its one production caller — `bootstrapAvlProver` in `src/index.ts` — was
 * deleted in P2-B phase 4: the rebuild-from-store path was unreachable under
 * `@ergots/avltree` 0.4.0 and unsound anyway (NODE_INTERFACE → the SUPERSEDED
 * note on `bootstrapAvlProver`, 2026-08-07). The full-set read remains for the
 * store's own unit tests.
 *
 * The SQL `ORDER BY` is not the canonical order — the AVL key is a *hash* of
 * these bytes, so a prover feed sorts by that instead. This ordering only
 * makes the read deterministic.
 */
export function getAllIdentityRecords(): Array<{ identityId: UserId; record: IdentityRecord }> {
  const rows = getDb()
    .prepare(
      `SELECT identity_id, last_activity_block, last_decay_block, like_carry
       FROM identity_records ORDER BY identity_id`,
    )
    .safeIntegers()
    .all() as Array<{
      identity_id: Buffer;
      last_activity_block: bigint;
      last_decay_block: bigint;
      like_carry: bigint;
    }>;
  return rows.map((row) => ({
    identityId: new Uint8Array(row.identity_id),
    record: {
      lastActivityBlock: Number(row.last_activity_block),
      lastDecayBlock: Number(row.last_decay_block),
      likeCarry: row.like_carry,
    },
  }));
}

/**
 * Upsert an identity record.
 *
 * Created on first karma receipt, **never deleted** in normal operation — only
 * by rollback. Deleting at zero balance would keep the tree smaller but would
 * require revert to resurrect records with their exact prior values;
 * unbounded-but-simple is the deliberate choice at this stage.
 *
 * While a block journal is open this captures the row it replaces **before**
 * writing and records the mutation — the same discipline `insertVouchCooldown`
 * applies to its own INSERT OR REPLACE, and the record-once choke point that
 * keeps the AVL feed and the rollback inverse derived from one log.
 */
export function putIdentityRecord(identityId: UserId, record: IdentityRecord): void {
  const replaced = isBlockJournalOpen()
    ? (getIdentityRecord(identityId) ?? undefined)
    : undefined;
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO identity_records
         (identity_id, last_activity_block, last_decay_block, like_carry)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      Buffer.from(identityId),
      record.lastActivityBlock,
      record.lastDecayBlock,
      record.likeCarry,
    );
  recordIdentityRecordPut(identityRecordKey(identityId), identityId, record, replaced);
}

/**
 * Remove an identity record.
 *
 * Fork-rollback inverse only — the inverse of a *first* `putIdentityRecord` for
 * a key. Never records to the block journal.
 */
export function deleteIdentityRecord(identityId: UserId): void {
  getDb()
    .prepare('DELETE FROM identity_records WHERE identity_id = ?')
    .run(Buffer.from(identityId));
}
