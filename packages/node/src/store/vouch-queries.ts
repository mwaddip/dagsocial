import { getDb } from './db.js';
import { getBox } from './utxo.js';
import type { VouchBox } from '@dagsocial/types';

function pubkeyToHex(pk: Uint8Array): string {
  return Buffer.from(pk).toString('hex');
}

export function getVouchBox(
  voucherId: Uint8Array,
  targetId: Uint8Array,
): VouchBox | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id FROM utxo_boxes
       WHERE box_type = 'vouch' AND spent_at_block IS NULL
         AND json_extract(extra_data, '$.voucherId') = ?
         AND json_extract(extra_data, '$.targetId') = ?`,
    )
    .get(pubkeyToHex(voucherId), pubkeyToHex(targetId)) as
    | { id: string } | undefined;
  if (!row) return null;
  return getBox(row.id) as VouchBox | null;
}

export function getVouchesForTarget(targetId: Uint8Array): VouchBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id FROM utxo_boxes
       WHERE box_type = 'vouch' AND spent_at_block IS NULL
         AND json_extract(extra_data, '$.targetId') = ?`,
    )
    .all(pubkeyToHex(targetId)) as Array<{ id: string }>;
  return rows
    .map((r) => getBox(r.id))
    .filter((b): b is VouchBox => b !== null && b.boxType === 'vouch');
}

export function getVouchesByVoucher(voucherId: Uint8Array): VouchBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id FROM utxo_boxes
       WHERE box_type = 'vouch' AND spent_at_block IS NULL
         AND json_extract(extra_data, '$.voucherId') = ?`,
    )
    .all(pubkeyToHex(voucherId)) as Array<{ id: string }>;
  return rows
    .map((r) => getBox(r.id))
    .filter((b): b is VouchBox => b !== null && b.boxType === 'vouch');
}

export function hasActiveVouch(
  voucherId: Uint8Array,
  targetId: Uint8Array,
): boolean {
  return getVouchBox(voucherId, targetId) !== null;
}
