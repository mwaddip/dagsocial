import { Router } from 'express';
import { createSlotChallenge, claimSlot } from '../services/slots.js';
import { config } from '../config.js';

export const slotsRouter: Router = Router();

slotsRouter.post('/request', (req, res) => {
  const { userId } = req.body as { userId: string };
  if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
  const challenge = createSlotChallenge(userId);
  res.json({ challenge, targetBits: config.pow.slotTargetBits });
});

slotsRouter.post('/claim', (req, res) => {
  const { userId, challenge, nonce } = req.body as { userId: string; challenge: string; nonce: number };
  if (!userId || !challenge || nonce === undefined) {
    res.status(400).json({ error: 'userId, challenge, and nonce required' }); return;
  }
  const token = claimSlot(userId, challenge, nonce);
  if (!token) { res.status(400).json({ error: 'Invalid or expired PoW' }); return; }
  res.json({ token });
});
