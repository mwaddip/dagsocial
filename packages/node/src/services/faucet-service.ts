import {
  computeTxId,
  computeBoxId,
  PROTOCOL_VERSION,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type { KarmaBox, UtxoTransaction } from '@dagsocial/types';
import { insertUtxoTx } from '../store/mempool.js';
import { getSystemKeypair, ensureSystemKarmaBox, signWithSystemKey } from '../store/system.js';
import { validateTx } from './utxo-engine.js';
import type { UtxoEngineDeps } from './utxo-engine.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAUCET_AMOUNT = 100;

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class FaucetServiceError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = 'FaucetServiceError';
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface FaucetServiceDeps extends UtxoEngineDeps {
  getCurrentHeight: () => number;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface FaucetGrantResult {
  status: 'pending';
  txId: string;
  expiresAtHeight: number;
  tx: UtxoTransaction;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Grant karma from the system faucet box to a user.
 *
 * Builds and signs a faucet grant transaction, validates it, and inserts it
 * into the mempool. Broadcasting is handled by the route layer.
 */
export function faucetGrant(
  deps: FaucetServiceDeps,
  userIdBytes: Uint8Array,
): FaucetGrantResult {
  // ---- 1. Get system keypair and karma box ----
  const sysKeypair = getSystemKeypair();
  if (!sysKeypair) {
    throw new FaucetServiceError('System keypair not initialized', 500);
  }

  const currentHeight = deps.getCurrentHeight();
  const systemBox = ensureSystemKarmaBox(sysKeypair.publicKey, currentHeight);

  if (systemBox.value < FAUCET_AMOUNT) {
    throw new FaucetServiceError('Faucet depleted');
  }

  // ---- 2. Build faucet grant transaction ----
  // Consume: system KarmaBox (value V)
  // Create: system KarmaBox (value V - FAUCET_AMOUNT) + user KarmaBox (value FAUCET_AMOUNT)
  const systemPubKeyHex = Buffer.from(sysKeypair.publicKey).toString('hex');

  const newSystemBox: KarmaBox = {
    boxType: 'karma',
    value: systemBox.value - FAUCET_AMOUNT,
    createdAtBlock: currentHeight,
    owner: sysKeypair.publicKey,
    guard: 'owner_signature',
    proofSource: 'faucet:system',
    lastTouchBlock: currentHeight,
  };

  const userBox: KarmaBox = {
    boxType: 'karma',
    value: FAUCET_AMOUNT,
    createdAtBlock: currentHeight,
    owner: userIdBytes,
    guard: 'owner_signature',
    proofSource: 'faucet',
    lastTouchBlock: currentHeight,
  };

  const tx: UtxoTransaction = {
    inputs: [systemBox.id!],
    outputs: [
      { ...newSystemBox, id: computeBoxId(newSystemBox) },
      { ...userBox, id: computeBoxId(userBox) },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };

  // ---- 3. Sign with system key ----
  const txId = computeTxId(tx);
  const sig = signWithSystemKey(txId, sysKeypair.secretKey);
  tx.signatures[systemPubKeyHex] = sig;

  // ---- 4. Validate ----
  const result = validateTx(deps, tx, currentHeight);
  if (!result.valid) {
    throw new FaucetServiceError(result.error ?? 'transaction validation failed');
  }

  // ---- 5. Insert into mempool ----
  const expiresAtHeight = currentHeight + MEMPOOL_EXPIRY_BLOCKS;
  insertUtxoTx(tx, null, expiresAtHeight);

  return {
    status: 'pending',
    txId,
    expiresAtHeight,
    tx,
  };
}
