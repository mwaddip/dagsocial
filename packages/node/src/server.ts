import express from 'express';
import { createRouter as identityRoutes } from './routes/identity.js';
import { createRouter as challengeRoutes } from './routes/challenges.js';
import { createRouter as postRoutes } from './routes/posts.js';
import { createRouter as likeRoutes } from './routes/likes.js';
import { createRouter as inviteRoutes } from './routes/invites.js';
import { createRouter as pruningRoutes } from './routes/pruning.js';
import { createRouter as utxoRoutes } from './routes/utxo.js';
import { createRouter as blockRoutes } from './routes/blocks.js';
import * as store from './store/index.js';
import { generateChallenge } from './services/pow.js';
import { verifyPost } from './services/verifier.js';
import { onSubBlockReceived } from './services/block-creator.js';
import { castLike } from './services/likes.js';
import { createInvite, claimInvite, cancelInvite } from './services/invites.js';
import { createPruneIntent, executePrune } from './services/stump-engine.js';
import { computeStumpId, encodePost } from '@dagsocial/types';
import { getDb } from './store/db.js';
import type { Config } from './config.js';

// ---------------------------------------------------------------------------
// createApp
// ---------------------------------------------------------------------------

export function createApp(config: Config): express.Express {
  const app = express();

  // ---- Middleware ----

  app.use(express.json({ limit: '1mb' }));

  // Demo UI
  const publicDir = new URL('../public', import.meta.url).pathname;
  app.use(express.static(publicDir));

  // ---- Routes ----

  // Identity — /identity
  app.use(
    '/identity',
    identityRoutes({
      insertIdentity: store.insertIdentity,
      getIdentity: store.getIdentity,
    }),
  );

  // Challenges — /challenge
  app.use(
    '/challenge',
    challengeRoutes({
      generateChallenge,
      createChallenge: store.createChallenge,
      getActiveChallenge: store.getActiveChallenge,
      getIdentity: store.getIdentity,
      getCurrentHeight: store.getCurrentHeight,
      challengeWindowBlocks: config.challengeWindowBlocks,
      postPowTargetBits: config.postPowTargetBits,
    }),
  );

  // Posts — /posts
  app.use(
    '/posts',
    postRoutes({
      verifyPost,
      encodePost,
      insertPost: store.insertPost,
      consumeChallenge: store.consumeChallenge,
      getPost: store.getPost,
      queryPosts: store.queryPosts,
      getActiveChallenge: store.getActiveChallenge,
      getIdentity: store.getIdentity,
      getKarmaBox: store.getKarmaBox,
      getCurrentHeight: store.getCurrentHeight,
      insertSubBlock: store.insertSubBlock,
      onSubBlockReceived,
    }),
  );

  // Likes — /likes
  app.use(
    '/likes',
    likeRoutes({
      castLike,
      getCurrentHeight: store.getCurrentHeight,
    }),
  );

  // Invites — /invites
  app.use(
    '/invites',
    inviteRoutes({
      createInvite,
      claimInvite,
      cancelInvite,
      getIdentity: store.getIdentity,
      getCurrentHeight: store.getCurrentHeight,
    }),
  );

  // Pruning — mounts at /, routes include /posts/:id/prune
  app.use(
    '/',
    pruningRoutes({
      executePrune,
      computeStumpId,
    }),
  );

  // UTXO — mounts at /, routes include /karma/:userId, /credits/:userId, /invites/:userId
  app.use(
    '/',
    utxoRoutes({
      getIdentity: store.getIdentity,
      getKarmaBox: store.getKarmaBox,
      getCreditBox: store.getCreditBox,
      getPendingInvites: store.getPendingInvites,
      getBondBoxes: store.getBondBoxes,
    }),
  );

  // Blocks + Status — mounts at /, routes include /blocks/current, /blocks/:height, /status
  const db = getDb();
  app.use(
    '/',
    blockRoutes({
      getOrderingBlock: store.getOrderingBlock,
      getCurrentHeight: store.getCurrentHeight,
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
      networkMode: config.networkMode,
    }),
  );

  // ---- Error handler ----

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error('500 error:', err instanceof Error ? err.stack : err);
      res.status(500).json({ error: 'internal' });
    },
  );

  return app;
}
