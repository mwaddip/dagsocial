import { Router } from 'express';
import { computeStumpId } from '@dagsocial/types';
import type { PruneIntent, Stump } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface PruningDeps {
  executePrune(intent: PruneIntent, signature: Uint8Array): Stump;
  computeStumpId(stump: Stump): string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: PruningDeps): Router {
  const router = Router();

  // POST /posts/:id/prune — prune a root post's reply subtree
  router.post('/posts/:id/prune', (req, res) => {
    const rootPostId = req.params['id']!;
    const body = req.body as {
      authorId?: string;
      trigger?: string;
      signature?: string;
    };

    if (!body.authorId || !body.signature) {
      res
        .status(400)
        .json({ error: 'authorId and signature required' });
      return;
    }

    // Validate trigger
    const trigger = body.trigger ?? 'author';
    if (
      trigger !== 'author' &&
      trigger !== 'drep' &&
      trigger !== 'storage_prune'
    ) {
      res.status(400).json({ error: 'Invalid trigger type' });
      return;
    }

    // Decode signature
    let signature: Uint8Array;
    try {
      signature = new Uint8Array(Buffer.from(body.signature, 'hex'));
    } catch {
      res.status(400).json({ error: 'Invalid hex signature' });
      return;
    }

    // Build prune intent
    const intent: PruneIntent = {
      rootPostHash: rootPostId,
      trigger: trigger as PruneIntent['trigger'],
      authorId: body.authorId,
      signature: new Uint8Array(64), // placeholder; real sig passed to executePrune
    };

    try {
      const stump = deps.executePrune(intent, signature);
      const stumpId = deps.computeStumpId(stump);
      res.status(201).json({ stumpId });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('Author mismatch') || msg.includes('author does not match')) {
        res.status(403).json({ error: msg });
      } else if (
        msg.includes('Only root posts') ||
        msg.includes('parentRefs') ||
        msg.includes('not found') ||
        msg.includes('already pruned')
      ) {
        res.status(400).json({ error: msg });
      } else {
        res.status(400).json({ error: msg });
      }
    }
  });

  return router;
}
