import { Router } from 'express';
import { computeBoxId } from '@dagsocial/types';
import type { KarmaBox } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAUCET_DEFAULT_AMOUNT = 100;
const FAUCET_MAX_AMOUNT = 1000;

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface FaucetDeps {
  getIdentity(userId: string): { userId: string; publicKey: Uint8Array; createdAt: number } | null;
  getKarmaBox(owner: Uint8Array): KarmaBox | null;
  insertBox(box: KarmaBox): void;
  consumeBox(boxId: string, consumedAtBlock: number): void;
  getCurrentHeight(): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: FaucetDeps): Router {
  const router = Router();

  // POST /faucet — grant karma to an identity (testnet only)
  router.post('/', (req, res) => {
    const body = req.body as {
      userId?: string;
      amount?: number;
    };

    const userId = body.userId;
    if (!userId || typeof userId !== 'string') {
      res.status(400).json({ error: 'userId required' });
      return;
    }

    const amount = typeof body.amount === 'number' && body.amount > 0
      ? Math.min(body.amount, FAUCET_MAX_AMOUNT)
      : FAUCET_DEFAULT_AMOUNT;

    // Look up identity
    const identity = deps.getIdentity(userId);
    if (!identity) {
      res.status(404).json({ error: 'Identity not found' });
      return;
    }

    const publicKey = identity.publicKey;
    const currentHeight = deps.getCurrentHeight();

    const existingBox = deps.getKarmaBox(publicKey);
    let newBalance: number;
    let newBox: KarmaBox;

    if (existingBox) {
      // Top-up existing karma box
      newBalance = existingBox.value + amount;
      newBox = {
        boxType: 'karma',
        value: newBalance,
        createdAtBlock: existingBox.createdAtBlock,
        owner: existingBox.owner,
        guard: 'owner_signature',
        proofSource: existingBox.proofSource,
        lastTouchBlock: existingBox.lastTouchBlock,
      };

      deps.consumeBox(existingBox.id!, currentHeight);
    } else {
      // Create new karma box
      newBalance = amount;
      newBox = {
        boxType: 'karma',
        value: newBalance,
        createdAtBlock: currentHeight > 0 ? currentHeight : 1,
        owner: publicKey,
        guard: 'owner_signature',
        proofSource: 'faucet',
        lastTouchBlock: currentHeight > 0 ? currentHeight : 1,
      };
    }

    const boxId = computeBoxId(newBox);
    const boxWithId: KarmaBox = { ...newBox, id: boxId };
    deps.insertBox(boxWithId);

    res.status(201).json({ userId, boxId, newBalance });
  });

  return router;
}
