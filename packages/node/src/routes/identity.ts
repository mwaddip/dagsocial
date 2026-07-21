import { Router } from 'express';
import { generateKeyPair, getUserId } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface IdentityStore {
  insertIdentity(userId: string, publicKey: Uint8Array): void;
  getIdentity(
    userId: string,
  ): { userId: string; publicKey: Uint8Array; createdAt: number } | null;
  /** Grant bootstrap karma to a new account (no-op if already has karma). */
  bootstrapKarma(userId: string, publicKey: Uint8Array): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: IdentityStore): Router {
  const router = Router();

  // POST /identity — generate key pair, store identity, return secretKey for demo
  router.post('/', (_req, res) => {
    const keyPair = generateKeyPair();
    const userId = getUserId(keyPair.publicKey);
    deps.insertIdentity(userId, keyPair.publicKey);
    deps.bootstrapKarma(userId, keyPair.publicKey);
    res.status(201).json({
      userId,
      publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
      secretKey: Buffer.from(keyPair.secretKey).toString('hex'),
    });
  });

  // POST /identity/import — import an existing public key
  router.post('/import', (req, res) => {
    const { publicKey } = req.body as { publicKey?: string };
    if (!publicKey || typeof publicKey !== 'string') {
      res.status(400).json({ error: 'publicKey required (hex)' });
      return;
    }

    let pubBytes: Uint8Array;
    try {
      pubBytes = new Uint8Array(Buffer.from(publicKey, 'hex'));
    } catch {
      res.status(400).json({ error: 'publicKey must be valid hex' });
      return;
    }

    if (pubBytes.length !== 32) {
      res
        .status(400)
        .json({ error: 'publicKey must be 32 bytes (64 hex chars)' });
      return;
    }

    const userId = getUserId(pubBytes);
    const existing = deps.getIdentity(userId);
    if (existing) {
      res.status(200).json({
        userId: existing.userId,
        publicKey: Buffer.from(existing.publicKey).toString('hex'),
        createdAt: existing.createdAt,
      });
      return;
    }

    deps.insertIdentity(userId, pubBytes);
    deps.bootstrapKarma(userId, pubBytes);
    res.status(201).json({
      userId,
      publicKey: Buffer.from(pubBytes).toString('hex'),
    });
  });

  // GET /identity/:userId — retrieve an identity
  router.get('/:userId', (req, res) => {
    const identity = deps.getIdentity(req.params['userId']!);
    if (!identity) {
      res.status(404).json({ error: 'Identity not found' });
      return;
    }
    res.json({
      userId: identity.userId,
      publicKey: Buffer.from(identity.publicKey).toString('hex'),
      createdAt: identity.createdAt,
    });
  });

  return router;
}
