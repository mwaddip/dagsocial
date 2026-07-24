import { Router } from 'express';
import { Buffer } from 'buffer';
import { computeBlockBodyHash } from '@dagsocial/validation';
import type { OrderingBlock } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface MiningDeps {
  getCurrentTemplate(): OrderingBlock | null;
  submitMinedBlock(powNonce: number, height: number): string | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: MiningDeps): Router {
  const router = Router();

  // GET /mining/template — return current block template
  router.get('/template', (_req, res) => {
    const tpl = deps.getCurrentTemplate();
    if (!tpl) {
      res.status(404).json({ error: 'No block template available' });
      return;
    }

    // Compute bodyHash for the miner (covers everything except powNonce and signature)
    const bodyHash = computeBlockBodyHash(tpl);

    res.json({
      height: tpl.height,
      prevBlockHash: tpl.prevBlockHash,
      subBlockRefs: tpl.subBlockRefs,
      likeBoxIds: tpl.likeBoxIds,
      utxoTxIds: tpl.utxoTxIds,
      stumpIds: tpl.stumpIds,
      coinbaseOutputs: tpl.coinbaseOutputs.map((o) => ({
        owner: Buffer.from(o.owner).toString('hex'),
        value: o.value,
        lockedUntilBlock: o.lockedUntilBlock,
        isTreasury: o.isTreasury,
      })),
      powTargetBits: tpl.powTargetBits,
      protocolVersion: tpl.protocolVersion,
      createdAt: tpl.createdAt,
      bodyHash: bodyHash.toString('hex'),
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
