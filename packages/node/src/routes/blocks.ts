import { Router } from 'express';
import { blockHash } from '@dagsocial/validation';
import type { EpochTally, OrderingBlock } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface BlocksDeps {
  getOrderingBlock(height: number): OrderingBlock | null;
  getCurrentHeight(): number;
  getPostCount(): number;
  getPendingPostCount(): number;
  getTotalKarma(): bigint;
  getTotalCredits(): bigint;
  networkType: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an OrderingBlock to a JSON-safe shape.
 * Returns the nested header/subBlockTree/utxoTxTree structure.
 */
function blockToJson(block: OrderingBlock): Record<string, unknown> {
  return {
    header: {
      protocolVersion: block.header.protocolVersion,
      height: block.header.height,
      prevBlockHash: block.header.prevBlockHash,
      subBlockRoot: block.header.subBlockRoot,
      utxoTxRoot: block.header.utxoTxRoot,
      stateRoot: block.header.stateRoot,
      validatorId: Buffer.from(block.header.validatorId).toString('hex'),
      powNonce: block.header.powNonce,
      powTargetBits: block.header.powTargetBits,
      createdAt: block.header.createdAt,
    },
    subBlockTree: {
      subBlockRefs: block.subBlockTree.subBlockRefs,
      subBlockEntries: block.subBlockTree.subBlockEntries,
      pruneEntries: block.subBlockTree.pruneEntries,
    },
    utxoTxTree: {
      utxoTxIds: block.utxoTxTree.utxoTxIds,
      // CBOR fields omitted from JSON — UTXO tx CBOR has no meaningful
      // textual representation.
      utxoTxs: [],
      likeBoxIds: block.utxoTxTree.likeBoxIds,
      coinbaseOutputs: block.utxoTxTree.coinbaseOutputs.map((o) => ({
        owner: Buffer.from(o.owner).toString('hex'),
        value: o.value.toString(),
        lockedUntilBlock: o.lockedUntilBlock,
        isTreasury: o.isTreasury,
      })),
      ...(block.utxoTxTree.epochTallyResults
        ? { epochTallyResults: epochTallyToJson(block.utxoTxTree.epochTallyResults) }
        : {}),
    },
    validatorSignature: Buffer.from(block.validatorSignature).toString('hex'),
  };
}

/**
 * JSON-safe shape of an EpochTally: bigint amounts as decimal strings,
 * binary owner keys as hex.
 */
function epochTallyToJson(tally: EpochTally): Record<string, unknown> {
  const rewards: Record<string, unknown> = {};
  for (const [postId, r] of Object.entries(tally.rewards)) {
    const likerRefunds: Record<string, string> = {};
    for (const [likerId, refund] of Object.entries(r.likerRefunds)) {
      likerRefunds[likerId] = refund.toString();
    }
    rewards[postId] = {
      targetPostId: r.targetPostId,
      likeCount: r.likeCount,
      authorReward: r.authorReward.toString(),
      likerRefunds,
      ...(r.postLockKarmaUnlocked !== undefined
        ? { postLockKarmaUnlocked: r.postLockKarmaUnlocked.toString() }
        : {}),
    };
  }
  return {
    rewards,
    talliedLockedLikeBoxIds: tally.talliedLockedLikeBoxIds,
    processedFreeLikeIds: tally.processedFreeLikeIds,
    consumedPostLockBoxIds: tally.consumedPostLockBoxIds,
    newPostLockBoxes: tally.newPostLockBoxes.map((b) => ({
      id: b.id,
      boxType: b.boxType,
      value: b.value.toString(),
      originalValue: b.originalValue.toString(),
      owner: Buffer.from(b.owner).toString('hex'),
      targetPostId: b.targetPostId,
      guard: b.guard,
    })),
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
      hash: block ? blockHash(block.header) : null,
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
      networkType: deps.networkType,
      blockHeight: deps.getCurrentHeight(),
      postCount: deps.getPostCount(),
      pendingPosts: deps.getPendingPostCount(),
      totalKarma: deps.getTotalKarma().toString(),
      totalCredits: deps.getTotalCredits().toString(),
    });
  });

  return router;
}
