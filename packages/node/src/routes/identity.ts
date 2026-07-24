import { Router } from 'express';
import { generateKeyPair } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface IdentityStore {
  insertIdentity(userId: Uint8Array, publicKey: Uint8Array): void;
  getIdentity(
    userId: Uint8Array,
  ): { userId: Uint8Array; publicKey: Uint8Array; createdAt: number } | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: IdentityStore): Router {
  const router = Router();

  // POST /identity — generate key pair, store identity, return secretKey for demo
  router.post('/', (_req, res) => {
    const keyPair = generateKeyPair();
    // userId IS the public key
    deps.insertIdentity(keyPair.publicKey, keyPair.publicKey);
    res.status(201).json({
      userId: Buffer.from(keyPair.publicKey).toString('hex'),
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

    // userId IS the public key
    const existing = deps.getIdentity(pubBytes);
    if (existing) {
      res.status(200).json({
        userId: Buffer.from(existing.userId).toString('hex'),
        publicKey: Buffer.from(existing.publicKey).toString('hex'),
        createdAt: existing.createdAt,
      });
      return;
    }

    deps.insertIdentity(pubBytes, pubBytes);
    res.status(201).json({
      userId: Buffer.from(pubBytes).toString('hex'),
      publicKey: Buffer.from(pubBytes).toString('hex'),
    });
  });

  // GET /identity/:userId — retrieve an identity by public key (hex-encoded)
  router.get('/:userId', (req, res) => {
    let userId: Uint8Array;
    try {
      userId = new Uint8Array(Buffer.from(req.params['userId']!, 'hex'));
    } catch {
      res.status(400).json({ error: 'userId must be hex-encoded public key' });
      return;
    }
    if (userId.length !== 32) {
      res.status(400).json({ error: 'userId must be 32 bytes (64 hex chars)' });
      return;
    }

    const identity = deps.getIdentity(userId);
    if (!identity) {
      res.status(404).json({ error: 'Identity not found' });
      return;
    }
    res.json({
      userId: Buffer.from(identity.userId).toString('hex'),
      publicKey: Buffer.from(identity.publicKey).toString('hex'),
      createdAt: identity.createdAt,
    });
  });

  return router;
}
