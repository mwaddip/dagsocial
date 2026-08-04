import { getDb } from './db.js';
import {
  isBlockJournalOpen,
  recordVouchCooldownInsertion,
  recordVouchCooldownDeletion,
} from './journal.js';

/** Fetch the cooldown row for a (voucher, target) pair, or null if none. */
function getCooldownRow(
  voucherId: Uint8Array,
  targetId: Uint8Array,
): { releaseAtBlock: number; karmaAmount: bigint } | null {
  const row = getDb()
    .prepare(
      `SELECT release_at_block, karma_amount
       FROM vouch_cooldowns WHERE voucher_id = ? AND target_id = ?`,
    )
    .safeIntegers()
    .get(Buffer.from(voucherId), Buffer.from(targetId)) as
      { release_at_block: bigint; karma_amount: bigint } | undefined;
  if (!row) return null;
  return {
    releaseAtBlock: Number(row.release_at_block),
    karmaAmount: row.karma_amount,
  };
}

export function insertVouchCooldown(
  voucherId: Uint8Array,
  targetId: Uint8Array,
  releaseAtBlock: number,
  karmaAmount: bigint,
): void {
  // INSERT OR REPLACE — while a journal is open, capture any row this
  // overwrites so the rollback inverse can restore it exactly.
  const replaced = isBlockJournalOpen()
    ? (getCooldownRow(voucherId, targetId) ?? undefined)
    : undefined;
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO vouch_cooldowns (voucher_id, target_id, release_at_block, karma_amount)
       VALUES (?, ?, ?, ?)`,
    )
    .run(Buffer.from(voucherId), Buffer.from(targetId), releaseAtBlock, karmaAmount);
  recordVouchCooldownInsertion(voucherId, targetId, replaced);
}

export function getVouchCooldowns(
  voucherId: Uint8Array,
): Array<{ targetId: Uint8Array; releaseAtBlock: number; karmaAmount: bigint }> {
  const rows = getDb()
    .prepare(
      `SELECT target_id, release_at_block, karma_amount
       FROM vouch_cooldowns WHERE voucher_id = ?`,
    )
    .safeIntegers()
    .all(Buffer.from(voucherId)) as Array<{
      target_id: Buffer; release_at_block: bigint; karma_amount: bigint;
    }>;
  return rows.map((r) => ({
    targetId: new Uint8Array(r.target_id),
    releaseAtBlock: Number(r.release_at_block),
    karmaAmount: r.karma_amount,
  }));
}

export function getMaturedVouchCooldowns(
  currentHeight: number,
): Array<{ voucherId: Uint8Array; targetId: Uint8Array; karmaAmount: bigint }> {
  const rows = getDb()
    .prepare(
      `SELECT voucher_id, target_id, karma_amount
       FROM vouch_cooldowns WHERE release_at_block <= ?`,
    )
    .safeIntegers()
    .all(currentHeight) as Array<{
      voucher_id: Buffer; target_id: Buffer; karma_amount: bigint;
    }>;
  return rows.map((r) => ({
    voucherId: new Uint8Array(r.voucher_id),
    targetId: new Uint8Array(r.target_id),
    karmaAmount: r.karma_amount,
  }));
}

export function deleteVouchCooldown(
  voucherId: Uint8Array,
  targetId: Uint8Array,
): void {
  // While a journal is open, capture the escrow row before deleting so the
  // rollback inverse can restore it (H-7). Fork rollback calls this with no
  // journal open — plain delete, nothing recorded.
  const captured = isBlockJournalOpen() ? getCooldownRow(voucherId, targetId) : null;
  getDb()
    .prepare(`DELETE FROM vouch_cooldowns WHERE voucher_id = ? AND target_id = ?`)
    .run(Buffer.from(voucherId), Buffer.from(targetId));
  if (captured !== null) {
    recordVouchCooldownDeletion(
      voucherId,
      targetId,
      captured.releaseAtBlock,
      captured.karmaAmount,
    );
  }
}

export function hasActiveVouchCooldown(
  voucherId: Uint8Array,
  targetId: Uint8Array,
): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM vouch_cooldowns WHERE voucher_id = ? AND target_id = ?`)
    .get(Buffer.from(voucherId), Buffer.from(targetId));
  return row !== undefined;
}
