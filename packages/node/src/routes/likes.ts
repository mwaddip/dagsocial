import { Router } from 'express';
import type { UtxoTransaction } from '@dagsocial/types';
import { getNet } from '../services/net-instance.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface LikesDeps {
  castLike(
    targetPostId: string,
    likerId: Uint8Array,
    signature: Uint8Array,
    currentBlockHeight: number,
  ):
    | { castLikeResult: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction }
    | { castLikeResult: 'free'; likeId: string };
  removeLike(
    targetPostId: string,
    likerId: Uint8Array,
    signature: Uint8Array,
    currentBlockHeight: number,
  ): { removeLikeResult: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction };
  getCurrentHeight(): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: LikesDeps): Router {
  const router = Router();

  // POST /likes/remove — remove a previously cast like
  router.post('/remove', (req, res) => {
    const body = req.body as {
      targetPostId?: string;
      likerId?: string;
      signature?: string;
    };

    // Validate required fields
    if (!body.targetPostId || !body.likerId || !body.signature) {
      res.status(400).json({ error: 'targetPostId, likerId, and signature required' });
      return;
    }

    // Decode likerId and signature from hex
    let likerId: Uint8Array;
    let signature: Uint8Array;
    try {
      likerId = new Uint8Array(Buffer.from(body.likerId, 'hex'));
      signature = new Uint8Array(Buffer.from(body.signature, 'hex'));
    } catch {
      res.status(400).json({ error: 'Invalid hex encoding in likerId or signature' });
      return;
    }

    if (signature.length !== 64) {
      res.status(400).json({ error: 'Signature must be 64 bytes (128 hex chars)' });
      return;
    }

    // Call the service
    try {
      const currentHeight = deps.getCurrentHeight();
      const result = deps.removeLike(
        body.targetPostId,
        likerId,
        signature,
        currentHeight,
      );

      // Broadcast transaction to peers (fire-and-forget)
      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast unlike tx: ${err.message}`);
        });
      }

      const { tx: _tx, ...response } = result;
      res.status(200).json({
        status: 'pending',
        txId: response.txId,
        expiresAtHeight: response.expiresAtHeight,
      });
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'Like not found') {
        res.status(404).json({ error: message });
      } else {
        res.status(400).json({ error: message });
      }
    }
  });

  // POST /likes — cast a like on a post
  router.post('/', (req, res) => {
    const body = req.body as {
      targetPostId?: string;
      likerId?: string;
      timestamp?: number;
      signature?: string;
    };

    // Validate required fields
    if (!body.targetPostId || !body.likerId || !body.signature) {
      res.status(400).json({ error: 'targetPostId, likerId, and signature required' });
      return;
    }

    // Decode likerId and signature from hex
    let likerId: Uint8Array;
    let signature: Uint8Array;
    try {
      likerId = new Uint8Array(Buffer.from(body.likerId, 'hex'));
      signature = new Uint8Array(Buffer.from(body.signature, 'hex'));
    } catch {
      res.status(400).json({ error: 'Invalid hex encoding in likerId or signature' });
      return;
    }

    if (signature.length !== 64) {
      res.status(400).json({ error: 'Signature must be 64 bytes (128 hex chars)' });
      return;
    }

    // Call the service
    try {
      const currentHeight = deps.getCurrentHeight();
      const result = deps.castLike(
        body.targetPostId,
        likerId,
        signature,
        currentHeight,
      );

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

      res.status(200).json({
        status: 'pending',
        txId: result.txId,
        expiresAtHeight: result.expiresAtHeight,
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
