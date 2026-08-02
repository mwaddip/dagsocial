import { decodeTx } from '@dagsocial/types';
import type { KarmaBox, CreditBox } from '@dagsocial/types';
import { getDb } from './db.js';
import { getSystemKeypair } from './system.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The asset a faucet grant dispensed. One grant per (identity, asset), ever. */
export type FaucetAsset = 'karma' | 'credit';

// ---------------------------------------------------------------------------
// Grant ledger (settled + pending, durable)
// ---------------------------------------------------------------------------

/**
 * True if the faucet has ever granted `asset` to `userId` on this node.
 *
 * The row is written in the same SQLite transaction as the mempool insert, so
 * it covers a grant that is still pending as well as one that has settled into
 * a block — a repeat call within the same block sees the row and is rejected.
 *
 * Precondition: the database is initialised.
 */
export function hasFaucetGrantRecord(userId: Uint8Array, asset: FaucetAsset): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS present FROM faucet_grants WHERE user_id = ? AND asset = ? LIMIT 1')
    .get(Buffer.from(userId), asset) as { present: number } | undefined;
  return row !== undefined;
}

/**
 * Record that the faucet granted `asset` to `userId`.
 *
 * Precondition: called inside the same transaction that inserts the grant tx
 * into the mempool, so the record and the grant commit or roll back together.
 * Postcondition: `hasFaucetGrantRecord(userId, asset)` is true.
 *
 * Throws (SQLITE_CONSTRAINT) on a duplicate — the primary key is the durable
 * backstop behind the read check, not a redundancy.
 */
export function recordFaucetGrant(
  userId: Uint8Array,
  asset: FaucetAsset,
  txId: string,
  grantedAtHeight: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO faucet_grants (user_id, asset, tx_id, granted_at_height)
       VALUES (?, ?, ?, ?)`,
    )
    .run(Buffer.from(userId), asset, txId, grantedAtHeight);
}

// ---------------------------------------------------------------------------
// Pending grants in the mempool
// ---------------------------------------------------------------------------

/**
 * True if the mempool already holds a faucet grant of `asset` for `userId`.
 *
 * A faucet grant is the only class of mempool transaction signed by the system
 * key that pays a box to a non-system owner, so "system-signed with an `asset`
 * output owned by `userId`" identifies one exactly. This catches grants that
 * arrived by gossip from a peer node, which leave no local grant-ledger row.
 *
 * Returns false when the system keypair is not initialised — there can be no
 * faucet grant without it.
 */
export function hasPendingFaucetGrant(userId: Uint8Array, asset: FaucetAsset): boolean {
  const sysKeypair = getSystemKeypair();
  if (!sysKeypair) return false;
  const sysPubKeyHex = Buffer.from(sysKeypair.publicKey).toString('hex');

  const rows = getDb()
    .prepare(
      `SELECT utxo_tx_cbor FROM mempool
       WHERE entry_type = 'utxo_tx' AND utxo_tx_cbor IS NOT NULL`,
    )
    .all() as Array<{ utxo_tx_cbor: Buffer }>;

  const target = Buffer.from(userId);

  for (const row of rows) {
    let tx;
    try {
      tx = decodeTx(new Uint8Array(row.utxo_tx_cbor));
    } catch {
      // Mempool entries include gossip-relayed transactions; an undecodable
      // one is not a faucet grant and must not fault this scan.
      continue;
    }

    if (!(sysPubKeyHex in tx.signatures)) continue;

    for (const out of tx.outputs) {
      if (out.boxType !== asset) continue;
      const owner = (out as KarmaBox | CreditBox).owner;
      if (target.equals(Buffer.from(owner))) return true;
    }
  }

  return false;
}
