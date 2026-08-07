import { Router } from 'express';
import type { UtxoTransaction } from '@dagsocial/types';
import type { UtxoEngineDeps } from '../services/utxo-engine.js';
import { getNet } from '../services/net-instance.js';
import { jsonToTx } from './json-to-tx.js';
import { respondError } from './respond-error.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface LikesDeps extends UtxoEngineDeps {
  castLike(
    deps: UtxoEngineDeps,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ): { castLikeResult: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction };
  getCurrentHeight(): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: LikesDeps): Router {
  const router = Router();

  // POST /likes — cast a like on a post (P2-D: a client-signed burn tx with
  // `likeTarget` set). This is the router's only route: unlike is not a
  // feature, so no removal endpoint exists.
  router.post('/', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };

    if (!body.tx) {
      res.status(400).json({ error: 400, reason: 'tx required' });
      return;
    }

    let tx: UtxoTransaction;
    try {
      tx = jsonToTx(body.tx);
    } catch (err) {
      respondError(res, err, 'POST /likes (tx decode)');
      return;
    }

    try {
      const currentHeight = deps.getCurrentHeight();
      const result = deps.castLike(deps, tx, currentHeight);

      // Broadcast the like transaction to peers (fire-and-forget)
      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast like tx: ${err.message}`);
        });
      }

      res.status(200).json({
        status: 'pending',
        txId: result.txId,
        expiresAtHeight: result.expiresAtHeight,
      });
    } catch (err) {
      respondError(res, err, 'POST /likes');
    }
  });

  return router;
}
