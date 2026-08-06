import {
  computeTxId,
  PROTOCOL_VERSION,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type { CandidateOf, KarmaBox, UtxoTransaction } from '@dagsocial/types';
import { insertUtxoTx } from '../store/mempool.js';
import { getSystemKeypair, ensureSystemKarmaBox, signWithSystemKey } from '../store/system.js';
import {
  hasFaucetGrantRecord,
  hasPendingFaucetGrant,
  recordFaucetGrant,
} from '../store/faucet-grants.js';
import { hasFaucetOriginKarmaBox } from '../store/utxo.js';
import { validateTx } from './utxo-engine.js';
import type { UtxoEngineDeps } from './utxo-engine.js';
import { ClientError } from './client-error.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAUCET_AMOUNT = 100n;

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class FaucetServiceError extends ClientError {
  constructor(message: string, statusCode: number = 400) {
    super(message, statusCode);
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
 * Throw 409 if this identity has already drawn a karma grant.
 *
 * Three sources, cheapest first, together covering every window in which a
 * grant can exist:
 *  - the grant ledger — every grant this node has issued, pending or settled;
 *  - a faucet-origin karma box — identities funded before the ledger existed,
 *    including ones that have since spent the grant;
 *  - the mempool — a grant relayed from a peer, which leaves no local row.
 */
function assertNotAlreadyFunded(userIdBytes: Uint8Array): void {
  if (
    hasFaucetGrantRecord(userIdBytes, 'karma') ||
    hasFaucetOriginKarmaBox(userIdBytes) ||
    hasPendingFaucetGrant(userIdBytes, 'karma')
  ) {
    throw new FaucetServiceError(
      'userId already funded by the faucet — one grant per identity',
      409,
    );
  }
}

/**
 * Grant karma from the system faucet box to a user, once per identity ever.
 *
 * Builds and signs a faucet grant transaction, validates it, inserts it into
 * the mempool, and records the grant. Broadcasting is handled by the route
 * layer.
 *
 * The eligibility check, the mempool insert and the ledger write share one
 * SQLite transaction, so two calls for the same `userId` in the same block
 * cannot both succeed: the second sees the first's row.
 *
 * Throws `FaucetServiceError` with status 409 if `userIdBytes` was already
 * funded, 500 if the system keypair is missing, 400 if the faucet is depleted
 * or the built transaction fails validation.
 */
export function faucetGrant(
  deps: FaucetServiceDeps,
  userIdBytes: Uint8Array,
): FaucetGrantResult {
  // ---- 1. Get system keypair ----
  const sysKeypair = getSystemKeypair();
  if (!sysKeypair) {
    throw new FaucetServiceError('System keypair not initialized', 500);
  }

  const currentHeight = deps.getCurrentHeight();
  const systemPubKeyHex = Buffer.from(sysKeypair.publicKey).toString('hex');

  let granted: FaucetGrantResult | undefined;

  deps.runInTransaction(() => {
    // ---- 2. One grant per identity, ever ----
    assertNotAlreadyFunded(userIdBytes);

    const systemBox = ensureSystemKarmaBox(sysKeypair.publicKey, currentHeight);
    if (systemBox.value < FAUCET_AMOUNT) {
      throw new FaucetServiceError('Faucet depleted');
    }

    // ---- 3. Build faucet grant transaction ----
    // Consume: system KarmaBox (value V)
    // Create: system KarmaBox (value V - FAUCET_AMOUNT) + user KarmaBox (value FAUCET_AMOUNT)
    // Candidates, not boxes. This builder deliberately attaches no provenance —
    // it inserts nothing and returns no predicted id, so its outputs get theirs
    // when block application materializes them (NODE_INTERFACE → "Which
    // producers attach provenance, and which deliberately do not").
    const newSystemBox: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: systemBox.value - FAUCET_AMOUNT,
      owner: sysKeypair.publicKey,
      guard: 'owner_signature',
      proofSource: 'faucet:system',
    };

    const userBox: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: FAUCET_AMOUNT,
      owner: userIdBytes,
      guard: 'owner_signature',
      proofSource: 'faucet',
    };

    // The precomputed output `id`s are gone: nothing read them, and `computeTxId`
    // strips them through `canonicalBoxBytes` before hashing, so the id the
    // system key signs below is byte-identical to what it was.
    const tx: UtxoTransaction = {
      inputs: [systemBox.id!],
      outputs: [newSystemBox, userBox],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    // ---- 4. Sign with system key ----
    const txId = computeTxId(tx);
    const sig = signWithSystemKey(txId, sysKeypair.secretKey);
    tx.signatures[systemPubKeyHex] = sig;

    // ---- 5. Validate ----
    const result = validateTx(deps, tx, currentHeight);
    if (!result.valid) {
      throw new FaucetServiceError(result.error ?? 'transaction validation failed');
    }

    // ---- 6. Insert into mempool and record the grant ----
    const expiresAtHeight = currentHeight + MEMPOOL_EXPIRY_BLOCKS;
    insertUtxoTx(tx, null, expiresAtHeight);
    recordFaucetGrant(userIdBytes, 'karma', txId, currentHeight);

    granted = {
      status: 'pending',
      txId,
      expiresAtHeight,
      tx,
    };
  });

  if (!granted) {
    throw new FaucetServiceError('faucet grant did not complete', 500);
  }
  return granted;
}
