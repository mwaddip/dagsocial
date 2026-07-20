import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRouter as createIdentityRouter } from './routes/identity.js';
import { createRouter as createPostsRouter } from './routes/posts.js';
import { slotsRouter } from './routes/slots.js';
import { blocksRouter } from './routes/blocks.js';
import { statusRouter } from './routes/status.js';
import { insertIdentity, getIdentity } from './store/identities.js';
import { insertPost, getPost, queryPosts } from './store/posts.js';
import { consumeChallenge, getActiveChallenge } from './store/challenges.js';
import { getCurrentHeight } from './store/ordering.js';
import { getKarmaBox } from './store/utxo.js';
import { encodePost } from '@dagsocial/types';
import { verifyPost } from './services/verifier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(join(__dirname, '..', 'public')));

  // Identity routes
  app.use('/identity', createIdentityRouter({ insertIdentity, getIdentity }));

  // Posts routes
  app.use(
    '/posts',
    createPostsRouter({
      insertPost,
      consumeChallenge,
      getPost,
      queryPosts,
      encodePost,
      verifyPost,
      getActiveChallenge,
      getIdentity,
      getKarmaBox,
      getCurrentHeight,
    }),
  );

  app.use('/slots', slotsRouter);
  app.use('/blocks', blocksRouter);
  app.use('/status', statusRouter);
  return app;
}
