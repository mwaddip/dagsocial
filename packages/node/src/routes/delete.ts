import { Router } from 'express';
import { computePruneEntryId } from '@dagsocial/types';
import type { PruneIntent, PruneEntry } from '@dagsocial/types';
import { MempoolFullError } from '../store/mempool.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface DeleteDeps {
  executePrune: (intent: PruneIntent) => PruneEntry;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function deleteRoutes(deps: DeleteDeps): Router {
  const router = Router();

  // POST /posts/:id/prune — submit a client-signed PruneIntent
  router.post('/posts/:id/prune', (req, res) => {
    try {
      const {
        rootPostHash,
        authorId,
        subtreeMerkleRoot,
        subtreePostIds,
        signature,
        trigger,
      } = req.body;

      // Validate required fields
      if (
        !rootPostHash ||
        !authorId ||
        !subtreeMerkleRoot ||
        !subtreePostIds ||
        !signature
      ) {
        return res.status(400).json({
          error:
            'Missing required fields: rootPostHash, authorId, subtreeMerkleRoot, subtreePostIds, signature',
        });
      }

      // Validate types
      if (!Array.isArray(subtreePostIds) || subtreePostIds.length === 0) {
        return res
          .status(400)
          .json({ error: 'subtreePostIds must be a non-empty array' });
      }

      if (!/^[0-9a-f]{64}$/.test(rootPostHash)) {
        return res.status(400).json({ error: 'Invalid rootPostHash format' });
      }

      if (!/^[0-9a-f]{64}$/.test(authorId)) {
        return res.status(400).json({ error: 'Invalid authorId format' });
      }

      if (!/^[0-9a-f]{64}$/.test(subtreeMerkleRoot)) {
        return res
          .status(400)
          .json({ error: 'Invalid subtreeMerkleRoot format' });
      }

      if (!/^[0-9a-f]{128}$/.test(signature)) {
        return res.status(400).json({ error: 'Invalid signature format' });
      }

      const intent: PruneIntent = {
        rootPostHash,
        trigger: trigger === 'storage_prune' ? 'storage_prune' : 'author',
        authorId: Buffer.from(authorId, 'hex'),
        subtreeMerkleRoot: Buffer.from(subtreeMerkleRoot, 'hex'),
        subtreePostIds,
        signature: Buffer.from(signature, 'hex'),
      };

      const entry = deps.executePrune(intent);
      const entryId = computePruneEntryId(entry);

      return res.status(201).json({
        status: 'deleted',
        entryId,
        postId: rootPostHash,
        replyCount: subtreePostIds.length - 1,
      });
    } catch (err: any) {
      if (err.statusCode === 404) {
        return res.status(404).json({ error: 'Post not found' });
      }
      if (err.statusCode === 403) {
        return res.status(403).json({ error: err.message });
      }
      if (err.statusCode === 400) {
        return res.status(400).json({ error: err.message });
      }
      if (err instanceof MempoolFullError) {
        return res.status(503).json({ error: 'mempool full' });
      }
      console.error('DELETE /posts/:id failed with an unexpected error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
