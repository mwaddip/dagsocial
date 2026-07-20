import { Router } from 'express';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface ChallengeStore {
  generateChallenge(): Uint8Array;
  createChallenge(
    userId: string,
    challenge: Uint8Array,
    expiresAtBlock: number,
  ): void;
  getActiveChallenge(
    userId: string,
  ): { challenge: Uint8Array; expiresAtBlock: number } | null;
  getIdentity(
    userId: string,
  ): { userId: string; publicKey: Uint8Array; createdAt: number } | null;
  getCurrentHeight(): number;
  challengeWindowBlocks: number;
  postPowTargetBits: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: ChallengeStore): Router {
  const router = Router();

  // POST /challenge — request a PoW challenge for posting
  router.post('/', (req, res) => {
    const { userId } = req.body as { userId?: string };
    if (!userId || typeof userId !== 'string') {
      res.status(400).json({ error: 'userId required' });
      return;
    }

    // Check identity exists
    const identity = deps.getIdentity(userId);
    if (!identity) {
      res.status(400).json({ error: 'Identity not found' });
      return;
    }

    // Check no active challenge
    const existing = deps.getActiveChallenge(userId);
    if (existing) {
      res.status(409).json({ error: 'An active challenge already exists' });
      return;
    }

    // Generate and store challenge
    const challenge = deps.generateChallenge();
    const currentHeight = deps.getCurrentHeight();
    const expiresAtBlock =
      currentHeight + deps.challengeWindowBlocks;

    deps.createChallenge(userId, challenge, expiresAtBlock);

    res.status(201).json({
      challenge: Buffer.from(challenge).toString('hex'),
      targetBits: deps.postPowTargetBits,
      expiresAtBlock,
    });
  });

  return router;
}
