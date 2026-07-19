import { Router } from 'express';
import { getBlock } from '../store/blocks.js';

export const blocksRouter: Router = Router();

blocksRouter.get('/:height', (req, res) => {
  const height = parseInt(req.params['height']!, 10);
  if (isNaN(height)) { res.status(400).json({ error: 'Invalid height' }); return; }
  const block = getBlock(height);
  if (!block) { res.status(404).json({ error: 'Block not found' }); return; }
  res.json(block);
});
