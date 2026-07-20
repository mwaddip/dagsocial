import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRouter as createIdentityRouter } from './routes/identity.js';
import { createRouter as createPostsRouter } from './routes/posts.js';
import { createRouter as createBlocksRouter } from './routes/blocks.js';
import { slotsRouter } from './routes/slots.js';
import { insertIdentity, getIdentity } from './store/identities.js';
import { insertPost, getPost, queryPosts } from './store/posts.js';
import { consumeChallenge, getActiveChallenge } from './store/challenges.js';
import { getCurrentHeight, getOrderingBlock } from './store/ordering.js';
import { getKarmaBox } from './store/utxo.js';
import { getDb } from './store/db.js';
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

  // Blocks + Status routes (mounted at root; paths include /blocks and /status prefixes)
  const db = getDb();
  app.use(
    '/',
    createBlocksRouter({
      getOrderingBlock,
      getCurrentHeight,
      getPostCount: () =>
        (
          db
            .prepare(
              "SELECT COUNT(*) AS c FROM dag_posts WHERE status = 'confirmed'",
            )
            .get() as { c: number }
        ).c,
      getPendingPostCount: () =>
        (
          db
            .prepare(
              "SELECT COUNT(*) AS c FROM dag_posts WHERE status = 'pending'",
            )
            .get() as { c: number }
        ).c,
      getIdentityCount: () =>
        (
          db.prepare('SELECT COUNT(*) AS c FROM identities').get() as {
            c: number;
          }
        ).c,
      getTotalKarma: () => {
        const row = db
          .prepare(
            "SELECT COALESCE(SUM(value), 0) AS s FROM utxo_boxes WHERE box_type = 'karma' AND spent_at_block IS NULL",
          )
          .get() as { s: number };
        return row.s;
      },
      getTotalCredits: () => {
        const row = db
          .prepare(
            "SELECT COALESCE(SUM(value), 0) AS s FROM utxo_boxes WHERE box_type = 'credit' AND spent_at_block IS NULL",
          )
          .get() as { s: number };
        return row.s;
      },
    }),
  );

  app.use('/slots', slotsRouter);
  return app;
}
