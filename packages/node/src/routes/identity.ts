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

identityRouter.get('/:userId', (req, res) => {
  const identity = getIdentity(req.params['userId']!);
  if (!identity) { res.status(404).json({ error: 'Identity not found' }); return; }
  res.json(identity);
});
