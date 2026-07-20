import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { identityRouter } from './routes/identity.js';
import { slotsRouter } from './routes/slots.js';
import { postsRouter } from './routes/posts.js';
import { blocksRouter } from './routes/blocks.js';
import { statusRouter } from './routes/status.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(join(__dirname, '..', 'public')));
  app.use('/identity', identityRouter);
  app.use('/slots', slotsRouter);
  app.use('/posts', postsRouter);
  app.use('/blocks', blocksRouter);
  app.use('/status', statusRouter);
  return app;
}
