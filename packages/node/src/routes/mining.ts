import { Router } from 'express';
import { blockHash, computePowHash } from '@dagsocial/validation';
import type { OrderingBlock } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface MiningDeps {
  getCurrentTemplate(): OrderingBlock | null;
  submitMinedBlock(powNonce: number, height: number): string | null;
  miningSecret: string;
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function authMiddleware(secret: string): import('express').RequestHandler {
  if (!secret) {
    // No auth configured — passthrough
    return (_req, _res, next) => next();
  }
  return (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: MiningDeps): Router {
  const router = Router();
  const { miningSecret } = deps;

  // Auth middleware on all mining routes
  router.use(authMiddleware(miningSecret));

  // GET /mining/template — return current block template
  router.get('/template', (_req, res) => {
    const tpl = deps.getCurrentTemplate();
    if (!tpl) {
      res.status(404).json({ error: 'No block template available' });
      return;
    }

    // Compute PoW preimage from the header
    const powPreimage = computePowHash(tpl.header);

    res.json({
      header: {
        protocolVersion: tpl.header.protocolVersion,
        height: tpl.header.height,
        prevBlockHash: tpl.header.prevBlockHash,
        subBlockRoot: tpl.header.subBlockRoot,
        utxoTxRoot: tpl.header.utxoTxRoot,
        stateRoot: tpl.header.stateRoot,
        validatorId: Buffer.from(tpl.header.validatorId).toString('hex'),
        powTargetBits: tpl.header.powTargetBits,
        createdAt: tpl.header.createdAt,
      },
      subBlockRefs: tpl.subBlockTree.subBlockRefs,
      subBlockEntries: tpl.subBlockTree.subBlockEntries,
      pruneEntries: tpl.subBlockTree.pruneEntries,
      likeBoxIds: tpl.utxoTxTree.likeBoxIds,
      utxoTxIds: tpl.utxoTxTree.utxoTxIds,
      coinbaseOutputs: tpl.utxoTxTree.coinbaseOutputs.map((o) => ({
        owner: Buffer.from(o.owner).toString('hex'),
        value: o.value,
        lockedUntilBlock: o.lockedUntilBlock,
        isTreasury: o.isTreasury,
      })),
      powPreimage: powPreimage.toString('hex'),
    });
  });

  // POST /mining/submit — submit a solved nonce
  router.post('/submit', (_req, res) => {
    const { powNonce, height } = _req.body as { powNonce?: number; height?: number };

    if (typeof powNonce !== 'number' || powNonce < 0) {
      res.status(400).json({ error: 'powNonce required (non-negative integer)' });
      return;
    }

    if (typeof height !== 'number' || height < 1) {
      res.status(400).json({ error: 'height required (positive integer)' });
      return;
    }

    const blockHash = deps.submitMinedBlock(powNonce, height);
    if (!blockHash) {
      res.status(422).json({ error: 'PoW invalid or template stale' });
      return;
    }

    res.status(201).json({ blockHash, height });
  });

  return router;
}
