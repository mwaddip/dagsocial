import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { computePowHash } from '@dagsocial/validation';
import type { OrderingBlock } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface MiningDeps {
  getCurrentTemplate(): OrderingBlock | null;
  submitMinedBlock(powNonce: number, height: number): string | null;
  setMinerPubkey(pubkey: Uint8Array | null): void;
  miningSecret: string;
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

/**
 * Bearer auth for every mining route. There is no unauthenticated mode: the
 * `?miner=` coinbase payout override is reachable only behind this check
 * (MINING_INTERFACE invariant 8, audit M-7).
 */
function authMiddleware(secret: string): import('express').RequestHandler {
  const expected = Buffer.from(`Bearer ${secret}`, 'utf8');
  return (req, res, next) => {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    // timingSafeEqual throws on unequal lengths, so the length check gates it.
    // A differing length is not a secret worth hiding — the secret's length is.
    const provided = Buffer.from(auth, 'utf8');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
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

  // Enforced at startup, not per-request: a router with no secret must not exist.
  if (!miningSecret) {
    throw new Error('Mining routes require a non-empty mining secret');
  }

  // Auth middleware on all mining routes
  router.use(authMiddleware(miningSecret));

  // GET /mining/template — return current block template
  router.get('/template', (req, res) => {
    // Optional miner pubkey override for coinbase reward destination
    const minerHex = typeof req.query.miner === 'string' ? req.query.miner : null;
    if (minerHex) {
      if (minerHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(minerHex)) {
        res.status(400).json({ error: 'Invalid miner pubkey — must be 64 hex chars' });
        return;
      }
      deps.setMinerPubkey(new Uint8Array(Buffer.from(minerHex, 'hex')));
    }

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
