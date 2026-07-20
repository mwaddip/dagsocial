import { Router } from 'express';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface LikesDeps {
  castLike(
    targetPostId: string,
    likerId: string,
    signature: Uint8Array,
    currentBlockHeight: number,
  ): { likeId: string; type: 'locked' | 'free' };
  getCurrentHeight(): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: LikesDeps): Router {
  const router = Router();

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

    // Decode signature from hex
    let signature: Uint8Array;
    try {
      signature = new Uint8Array(Buffer.from(body.signature, 'hex'));
    } catch {
      res.status(400).json({ error: 'Invalid hex encoding in signature' });
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
        body.likerId,
        signature,
        currentHeight,
      );
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
