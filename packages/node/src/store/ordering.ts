import { getDb } from './db.js';
import type { OrderingBlock, CoinbaseOutput, EpochTally } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

interface OrderingBlockRow {
  height: number;
  hash: string;
  prev_block_hash: string;
  sub_block_refs: string;    // JSON array
  like_box_ids: string;      // JSON array
  utxo_tx_ids: string;       // JSON array
  stump_ids: string;         // JSON array
  validator_id: Buffer;      // 32-byte Ed25519 public key
  validator_signature: Buffer;
  pow_nonce: number;
  pow_target_bits: number;
  coinbase_outputs: string;  // JSON array
  epoch_tally_results: string | null;  // JSON, nullable
  protocol_version: number;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCoinbaseOutputs(json: string): CoinbaseOutput[] {
  const raw: { owner: number[]; value: number; lockedUntilBlock: number; isTreasury: boolean }[] = JSON.parse(json);
  return raw.map((o) => ({
    owner: new Uint8Array(o.owner),
    value: o.value,
    lockedUntilBlock: o.lockedUntilBlock,
    isTreasury: o.isTreasury,
  }));
}

function rowToOrderingBlock(row: OrderingBlockRow): OrderingBlock {
  const block: OrderingBlock = {
    height: row.height,
    hash: row.hash,
    prevBlockHash: row.prev_block_hash,
    subBlockRefs: JSON.parse(row.sub_block_refs) as string[],
    likeBoxIds: JSON.parse(row.like_box_ids) as string[],
    utxoTxIds: JSON.parse(row.utxo_tx_ids) as string[],
    stumpIds: JSON.parse(row.stump_ids) as string[],
    validatorId: new Uint8Array(row.validator_id),
    validatorSignature: new Uint8Array(row.validator_signature),
    powNonce: row.pow_nonce,
    powTargetBits: row.pow_target_bits,
    coinbaseOutputs: parseCoinbaseOutputs(row.coinbase_outputs),
    protocolVersion: row.protocol_version,
    createdAt: row.created_at,
  };

  if (row.epoch_tally_results !== null) {
    block.epochTallyResults = JSON.parse(
      row.epoch_tally_results,
    ) as EpochTally;
  }

  return block;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serialize coinbase outputs to JSON — owner Uint8Array → number[].
 */
function serializeCoinbaseOutputs(outputs: CoinbaseOutput[]): string {
  return JSON.stringify(
    outputs.map((o) => ({
      owner: Array.from(o.owner),
      value: o.value,
      lockedUntilBlock: o.lockedUntilBlock,
      isTreasury: o.isTreasury,
    })),
  );
}

/**
 * Insert a new ordering block.
 */
export function createOrderingBlock(block: OrderingBlock): void {
  const db = getDb();

  db.prepare(
    `INSERT INTO ordering_blocks
       (height, hash, prev_block_hash, sub_block_refs, like_box_ids,
        utxo_tx_ids, stump_ids, validator_id, validator_signature,
        pow_nonce, pow_target_bits, coinbase_outputs,
        epoch_tally_results, protocol_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    block.height,
    block.hash,
    block.prevBlockHash,
    JSON.stringify(block.subBlockRefs),
    JSON.stringify(block.likeBoxIds),
    JSON.stringify(block.utxoTxIds),
    JSON.stringify(block.stumpIds),
    Buffer.from(block.validatorId),
    Buffer.from(block.validatorSignature),
    block.powNonce,
    block.powTargetBits,
    serializeCoinbaseOutputs(block.coinbaseOutputs),
    block.epochTallyResults
      ? JSON.stringify(block.epochTallyResults)
      : null,
    block.protocolVersion,
    block.createdAt,
  );
}

/**
 * Retrieve an ordering block by height.
 * Returns null if no block exists at that height.
 */
export function getOrderingBlock(height: number): OrderingBlock | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM ordering_blocks WHERE height = ?')
    .get(height) as OrderingBlockRow | undefined;
  return row ? rowToOrderingBlock(row) : null;
}

/**
 * Return the current chain height (max height in ordering_blocks).
 * Returns 0 if no blocks exist yet.
 */
export function getCurrentHeight(): number {
  const db = getDb();
  const row = db
    .prepare('SELECT COALESCE(MAX(height), 0) AS h FROM ordering_blocks')
    .get() as { h: number };
  return row.h;
}
