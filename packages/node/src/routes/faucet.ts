import { Router } from 'express';
import { faucetGrant } from '../services/faucet-service.js';
import type { FaucetServiceDeps } from '../services/faucet-service.js';
import { getNet } from '../services/net-instance.js';
import { respondError } from './respond-error.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface FaucetDeps extends FaucetServiceDeps {}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: FaucetDeps): Router {
  const router = Router();

  // POST /faucet — grant 100 karma from the system box (testnet only)
  router.post('/', (req, res) => {
    // ---- 1. Validate input shape ----
    const body = req.body as { userId?: string };
    const userId = body.userId;
    if (!userId || typeof userId !== 'string') {
      res.status(400).json({ error: 400, reason: 'userId required' });
      return;
    }
    let userIdBytes: Uint8Array;
    try {
      userIdBytes = new Uint8Array(Buffer.from(userId, 'hex'));
    } catch {
      res.status(400).json({ error: 400, reason: 'userId must be a hex string' });
      return;
    }
    if (userIdBytes.length !== 32) {
      res.status(400).json({ error: 400, reason: 'userId must be 32 bytes (64 hex chars)' });
      return;
    }

    // ---- 2. Delegate to service ----
    try {
      const result = faucetGrant(deps, userIdBytes);

      // ---- 3. Broadcast (fire-and-forget) ----
      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast faucet tx: ${err.message}`);
        });
      }

      // ---- 4. Serialize result ----
      res.status(200).json({
        status: result.status,
        txId: result.txId,
        expiresAtHeight: result.expiresAtHeight,
      });
    } catch (err) {
      respondError(res, err, 'POST /faucet');
    }
  });

  return router;
}
