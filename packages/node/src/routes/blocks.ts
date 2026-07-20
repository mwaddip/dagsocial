import { Router } from 'express';
import type { OrderingBlock } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface BlocksDeps {
  getOrderingBlock(height: number): OrderingBlock | null;
  getCurrentHeight(): number;
  getPostCount(): number;
  getPendingPostCount(): number;
  getIdentityCount(): number;
  getTotalKarma(): number;
  getTotalCredits(): number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an OrderingBlock to a JSON-safe shape.
 * BLOB fields → hex, JSON string fields → parsed arrays.
 */
function blockToJson(block: OrderingBlock): Record<string, unknown> {
  return {
    height: block.height,
    hash: block.hash,
    prevBlockHash: block.prevBlockHash,
    subBlockRefs: block.subBlockRefs,
    likeBoxIds: block.likeBoxIds,
    utxoTxIds: block.utxoTxIds,
    stumpIds: block.stumpIds,
    validatorId: block.validatorId,
    validatorSignature: Buffer.from(block.validatorSignature).toString('hex'),
    protocolVersion: block.protocolVersion,
    createdAt: block.createdAt,
    ...(block.epochTallyResults
      ? { epochTallyResults: block.epochTallyResults }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: BlocksDeps): Router {
  const router = Router();

  // GET /blocks/current — must be defined BEFORE /blocks/:height
  router.get('/blocks/current', (_req, res) => {
    const height = deps.getCurrentHeight();
    if (height === 0) {
      res.json({ height: 0, hash: null });
      return;
    }

    const block = deps.getOrderingBlock(height);
    res.json({
      height,
      hash: block?.hash ?? null,
    });
  });

  // GET /blocks/:height — retrieve an ordering block by height
  router.get('/blocks/:height', (req, res) => {
    const height = parseInt(req.params['height']!, 10);
    if (isNaN(height)) {
      res.status(400).json({ error: 'Invalid height' });
      return;
    }

    const block = deps.getOrderingBlock(height);
    if (!block) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }

    res.json(blockToJson(block));
  });

  // GET /status — aggregated node status
  router.get('/status', (_req, res) => {
    res.json({
      blockHeight: deps.getCurrentHeight(),
      postCount: deps.getPostCount(),
      pendingPosts: deps.getPendingPostCount(),
      identityCount: deps.getIdentityCount(),
      totalKarma: deps.getTotalKarma(),
      totalCredits: deps.getTotalCredits(),
    });
  });

  return router;
}
