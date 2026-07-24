import { Router } from 'express';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface ChallengeStore {
  generateChallenge(): Uint8Array;
  createChallenge(
    userId: Uint8Array,
    challenge: Uint8Array,
    expiresAtBlock: number,
  ): void;
  getActiveChallenge(
    userId: Uint8Array,
  ): { challenge: Uint8Array; expiresAtBlock: number } | null;
  getIdentity(
    userId: Uint8Array,
  ): { userId: Uint8Array; publicKey: Uint8Array; createdAt: number } | null;
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
      res.status(400).json({ error: 'userId required (hex-encoded public key)' });
      return;
    }
    let userIdBytes: Uint8Array;
    try {
      userIdBytes = new Uint8Array(Buffer.from(userId, 'hex'));
    } catch {
      res.status(400).json({ error: 'userId must be a hex string' });
      return;
    }
    if (userIdBytes.length !== 32) {
      res.status(400).json({ error: 'userId must be 32 bytes (64 hex chars)' });
      return;
    }

    // Check identity exists
    const identity = deps.getIdentity(userIdBytes);
    if (!identity) {
      res.status(400).json({ error: 'Identity not found' });
      return;
    }

    // Replace any existing challenge (upsert — no 409 blocking)
    const challenge = deps.generateChallenge();
    const currentHeight = deps.getCurrentHeight();
    const expiresAtBlock =
      currentHeight + deps.challengeWindowBlocks;

    deps.createChallenge(userIdBytes, challenge, expiresAtBlock);

    res.status(201).json({
      challenge: Buffer.from(challenge).toString('hex'),
      targetBits: deps.postPowTargetBits,
      expiresAtBlock,
    });
  });

  return router;
}
