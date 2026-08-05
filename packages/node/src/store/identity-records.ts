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
 *   stale       = (height − lastActivityBlock) > staleThresholdBlocks
 *   owedPeriods = floor( (height − max(lastActivityBlock, lastDecayBlock)) / interval )
 *
 * **Phase B builds this entity and does not populate it.** No producer calls
 * `putIdentityRecord` until phase D, and `decay.ts` keeps reading box heights
 * until then — so a phase-B tree provably contains zero records.
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
      `SELECT last_activity_block, last_decay_block
       FROM identity_records WHERE identity_id = ?`,
    )
    .safeIntegers()
    .get(Buffer.from(identityId)) as
      { last_activity_block: bigint; last_decay_block: bigint } | undefined;
  if (!row) return null;
  return {
    lastActivityBlock: Number(row.last_activity_block),
    lastDecayBlock: Number(row.last_decay_block),
  };
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
         (identity_id, last_activity_block, last_decay_block)
       VALUES (?, ?, ?)`,
    )
    .run(Buffer.from(identityId), record.lastActivityBlock, record.lastDecayBlock);
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
