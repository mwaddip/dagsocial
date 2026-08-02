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
  ):
    | { castLikeResult: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction }
    | { castLikeResult: 'free'; likeId: string };
  removeLike(
    deps: UtxoEngineDeps,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ): { removeLikeResult: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction };
  getCurrentHeight(): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: LikesDeps): Router {
  const router = Router();

  // POST /likes — cast a like on a post
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

      if (result.castLikeResult === 'free') {
        res.status(200).json({ status: 'free', likeId: result.likeId });
        return;
      }

      // Broadcast locked-like transaction to peers (fire-and-forget)
      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast like tx: ${err.message}`);
        });
      }

      const { tx: _tx, ...response } = result;
      res.status(200).json({
        status: 'pending',
        txId: response.txId,
        expiresAtHeight: response.expiresAtHeight,
      });
    } catch (err) {
      respondError(res, err, 'POST /likes');
    }
  });

  // POST /likes/remove — remove a previously cast like
  router.post('/remove', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };

    if (!body.tx) {
      res.status(400).json({ error: 400, reason: 'tx required' });
      return;
    }

    let tx: UtxoTransaction;
    try {
      tx = jsonToTx(body.tx);
    } catch (err) {
      respondError(res, err, 'POST /likes/remove (tx decode)');
      return;
    }

    try {
      const currentHeight = deps.getCurrentHeight();
      const result = deps.removeLike(deps, tx, currentHeight);

      // Broadcast transaction to peers (fire-and-forget)
      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast unlike tx: ${err.message}`);
        });
      }

      res.status(200).json({
        status: 'pending',
        txId: result.txId,
        expiresAtHeight: result.expiresAtHeight,
      });
    } catch (err) {
      respondError(res, err, 'POST /likes/remove');
    }
  });

  return router;
}
