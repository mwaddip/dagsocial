import { Router } from 'express';
import { generateKeyPair, getUserId } from '@dagsocial/types';
import { insertIdentity, getIdentity } from '../store/identities.js';

export const identityRouter: Router = Router();

identityRouter.post('/', (_req, res) => {
  const keyPair = generateKeyPair();
  const userId = getUserId(keyPair.publicKey);
  insertIdentity(userId, keyPair);
  res.status(201).json({
    userId,
    publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
  });
});

identityRouter.post('/import', (req, res) => {
  const { publicKey } = req.body as { publicKey: string };
  if (!publicKey) { res.status(400).json({ error: 'publicKey required (hex)' }); return; }
  const pubBytes = new Uint8Array(Buffer.from(publicKey, 'hex'));
  if (pubBytes.length !== 32) { res.status(400).json({ error: 'publicKey must be 32 bytes (64 hex chars)' }); return; }
  const userId = getUserId(pubBytes);
  const existing = getIdentity(userId);
  if (existing) { res.json(existing); return; }
  insertIdentity(userId, { publicKey: pubBytes, secretKey: new Uint8Array(0) });
  res.status(201).json({ userId, publicKey });
});

identityRouter.get('/:userId', (req, res) => {
  const identity = getIdentity(req.params['userId']!);
  if (!identity) { res.status(404).json({ error: 'Identity not found' }); return; }
  res.json(identity);
});
