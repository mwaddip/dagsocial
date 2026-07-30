import { getDb } from './db.js';

export function insertVouchCooldown(
  voucherId: Uint8Array,
  targetId: Uint8Array,
  releaseAtBlock: number,
  karmaAmount: number,
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO vouch_cooldowns (voucher_id, target_id, release_at_block, karma_amount)
       VALUES (?, ?, ?, ?)`,
    )
    .run(Buffer.from(voucherId), Buffer.from(targetId), releaseAtBlock, karmaAmount);
}

export function getVouchCooldowns(
  voucherId: Uint8Array,
): Array<{ targetId: Uint8Array; releaseAtBlock: number; karmaAmount: number }> {
  const rows = getDb()
    .prepare(
      `SELECT target_id, release_at_block, karma_amount
       FROM vouch_cooldowns WHERE voucher_id = ?`,
    )
    .all(Buffer.from(voucherId)) as Array<{
      target_id: Buffer; release_at_block: number; karma_amount: number;
    }>;
  return rows.map((r) => ({
    targetId: new Uint8Array(r.target_id),
    releaseAtBlock: r.release_at_block,
    karmaAmount: r.karma_amount,
  }));
}

export function getMaturedVouchCooldowns(
  currentHeight: number,
): Array<{ voucherId: Uint8Array; targetId: Uint8Array; karmaAmount: number }> {
  const rows = getDb()
    .prepare(
      `SELECT voucher_id, target_id, karma_amount
       FROM vouch_cooldowns WHERE release_at_block <= ?`,
    )
    .all(currentHeight) as Array<{
      voucher_id: Buffer; target_id: Buffer; karma_amount: number;
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
  getDb()
    .prepare(`DELETE FROM vouch_cooldowns WHERE voucher_id = ? AND target_id = ?`)
    .run(Buffer.from(voucherId), Buffer.from(targetId));
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
