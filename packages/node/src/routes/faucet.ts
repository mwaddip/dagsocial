import { Router } from 'express';
import { computeTxId, computeBoxId, PROTOCOL_VERSION } from '@dagsocial/types';
import type { KarmaBox, UtxoTransaction } from '@dagsocial/types';
import { insertUtxoTx } from '../store/mempool.js';
import { getSystemKeypair, ensureSystemKarmaBox, signWithSystemKey } from '../store/system.js';
import { validateTx } from '../services/utxo-engine.js';
import type { UtxoEngineDeps } from '../services/utxo-engine.js';
import { getNet } from '../services/net-instance.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAUCET_AMOUNT = 100;

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface FaucetDeps extends UtxoEngineDeps {
  // Inherits: getBox, insertBox, consumeBox, getKarmaBox, getIdentity,
  //           runInTransaction, isSystemBox (optional)
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: FaucetDeps): Router {
  const router = Router();

  // POST /faucet — grant 100 karma from the system box (testnet only)
  router.post('/', (req, res) => {
    const body = req.body as {
      userId?: string;
    };

    // ---- 1. Decode userId ----
    const userId = body.userId;
    if (!userId || typeof userId !== 'string') {
      res.status(400).json({ error: 'userId required' });
      return;
    }
    let userIdBytes: Uint8Array;
    try {
      userIdBytes = new Uint8Array(Buffer.from(userId, 'hex'));
    } catch {
      res.status(400).json({ error: 'userId must be a hex string' });
      return;
    }
    if (userIdBytes.length !== 32) {
      res.status(400).json({ error: 'userId must be 32 bytes (64 hex chars)' });
      return;
    }

    // ---- 2. Verify identity exists ----
    const identity = deps.getIdentity(userIdBytes);
    if (!identity) {
      res.status(404).json({ error: 'Identity not found' });
      return;
    }

    // ---- 3. Get system keypair and karma box ----
    const sysKeypair = getSystemKeypair();
    if (!sysKeypair) {
      res.status(500).json({ error: 'System keypair not initialized' });
      return;
    }

    const currentHeight = deps.getCurrentHeight();
    const systemBox = ensureSystemKarmaBox(sysKeypair.publicKey, currentHeight);

    if (systemBox.value < FAUCET_AMOUNT) {
      res.status(400).json({ error: 'Faucet depleted' });
      return;
    }

    // ---- 4. Build faucet grant transaction ----
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

    // ---- 5. Sign with system key ----
    const txId = computeTxId(tx);
    const sig = signWithSystemKey(txId, sysKeypair.secretKey);
    tx.signatures[systemPubKeyHex] = sig;

    // ---- 6. Validate ----
    const result = validateTx(deps, tx, currentHeight);
    if (!result.valid) {
      res.status(400).json({ error: result.error });
      return;
    }

    // ---- 7. Insert into mempool ----
    const expiresAtHeight = currentHeight + 720;
    insertUtxoTx(tx, null, expiresAtHeight);

    // ---- 8. Broadcast ----
    const net = getNet();
    if (net) {
      net.broadcastTx(tx).catch((err: Error) => {
        console.warn(`Failed to broadcast faucet tx: ${err.message}`);
      });
    }

    res.status(200).json({
      status: 'pending',
      txId,
      expiresAtHeight,
    });
  });

  return router;
}
