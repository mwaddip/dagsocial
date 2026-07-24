import { Router } from 'express';
import { computeTxId, PROTOCOL_VERSION } from '@dagsocial/types';
import type { KarmaBox, UtxoTransaction } from '@dagsocial/types';
import { insertUtxoTx } from '../store/mempool.js';
import { getNet } from '../services/net-instance.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAUCET_DEFAULT_AMOUNT = 100;
const FAUCET_MAX_AMOUNT = 1000;

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface FaucetDeps {
  getIdentity(userId: Uint8Array): { userId: Uint8Array; publicKey: Uint8Array; createdAt: number } | null;
  getKarmaBox(owner: Uint8Array): KarmaBox | null;
  getCurrentHeight(): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: FaucetDeps): Router {
  const router = Router();

  // POST /faucet — grant karma to an identity (testnet only)
  router.post('/', (req, res) => {
    const body = req.body as {
      userId?: string;
      amount?: number;
    };

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

    const amount = typeof body.amount === 'number' && body.amount > 0
      ? Math.min(body.amount, FAUCET_MAX_AMOUNT)
      : FAUCET_DEFAULT_AMOUNT;

    // Look up identity
    const identity = deps.getIdentity(userIdBytes);
    if (!identity) {
      res.status(404).json({ error: 'Identity not found' });
      return;
    }

    const publicKey = identity.publicKey;
    const currentHeight = deps.getCurrentHeight();

    const existingBox = deps.getKarmaBox(publicKey);
    let inputs: string[] = [];
    let newBox: KarmaBox;

    if (existingBox) {
      // Top-up existing karma box
      inputs = [existingBox.id!];
      newBox = {
        boxType: 'karma',
        value: existingBox.value + amount,
        createdAtBlock: existingBox.createdAtBlock,
        owner: existingBox.owner,
        guard: 'owner_signature',
        proofSource: existingBox.proofSource,
        lastTouchBlock: existingBox.lastTouchBlock,
      };
    } else {
      // Create new karma box
      const blockHeight = currentHeight > 0 ? currentHeight : 1;
      newBox = {
        boxType: 'karma',
        value: amount,
        createdAtBlock: blockHeight,
        owner: publicKey,
        guard: 'owner_signature',
        proofSource: 'faucet',
        lastTouchBlock: blockHeight,
      };
    }

    // Build UTXO transaction
    const tx: UtxoTransaction = {
      inputs,
      outputs: [newBox],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    // Insert into mempool
    const expiresAtHeight = currentHeight + 720;
    insertUtxoTx(tx, null, expiresAtHeight);

    const txId = computeTxId(tx);

    // Broadcast to peers (fire-and-forget)
    const net = getNet();
    if (net) {
      net.broadcastTx(tx).catch((err: Error) => {
        console.warn(`Failed to broadcast faucet tx: ${err.message}`);
      });
    }

    res.status(201).json({
      status: 'pending',
      txId,
      expiresAtHeight,
    });
  });

  return router;
}
