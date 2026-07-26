import express from 'express';
import { createRouter as challengeRoutes } from './routes/challenges.js';
import { createRouter as postRoutes } from './routes/posts.js';
import { createRouter as likeRoutes } from './routes/likes.js';
import { createRouter as inviteRoutes } from './routes/invites.js';
import { createRouter as faucetRoutes } from './routes/faucet.js';
import { createRouter as pruningRoutes } from './routes/pruning.js';
import { createRouter as utxoRoutes } from './routes/utxo.js';
import { createRouter as blockRoutes } from './routes/blocks.js';
import { createRouter as miningRoutes } from './routes/mining.js';
import * as store from './store/index.js';
import { getSystemKeypair } from './store/system.js';
import { generateChallenge } from './services/pow.js';
import { verifyPost } from './services/verifier.js';
import { onSubBlockReceived, getCurrentTemplate, submitMinedBlock } from './services/block-creator.js';
import { castLike, removeLike } from './services/likes.js';
import { createInvite, claimInvite, cancelInvite, commitInvite } from './services/invites.js';
import { createPruneIntent, executePrune } from './services/stump-engine.js';
import { computeStumpId, encodePost } from '@dagsocial/types';
import { getDb } from './store/db.js';
import { validateTx } from './services/utxo-engine.js';
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

  // ---- Shared UTXO engine deps (curried into validateTx for routes) ----

  const utxoEngineDeps = {
    getBox: store.getBox,
    insertBox: store.insertBox,
    consumeBox: store.consumeBox,
    getKarmaBox: store.getKarmaBox,
    getKarmaBoxes: store.getKarmaBoxes,
    runInTransaction: (fn: () => void) => getDb().transaction(fn)(),
    isSystemBox: (boxId: string) => {
      const sysKey = getSystemKeypair();
      if (!sysKey) return false;
      const box = store.getBox(boxId);
      if (!box || box.boxType !== 'karma') return false;
      return Buffer.from((box as import('@dagsocial/types').KarmaBox).owner).equals(
        Buffer.from(sysKey.publicKey),
      );
    },
  };

  // ---- Routes ----

  // Challenges — /challenge
  app.use(
    '/challenge',
    challengeRoutes({
      generateChallenge,
      createChallenge: store.createChallenge,
      getActiveChallenge: store.getActiveChallenge,
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
      getPostRaw: store.getPostRaw,
      queryPosts: store.queryPosts,
      getActiveChallenge: store.getActiveChallenge,
      getKarmaBoxes: store.getKarmaBoxes,
      getCurrentHeight: store.getCurrentHeight,
      getLikeCount: store.getLikeCount,
      insertMempoolSubBlock: store.insertMempoolSubBlock,
      insertUtxoTx: store.insertUtxoTx,
      onSubBlockReceived,
      validateTx: (tx, currentBlockHeight) =>
        validateTx(utxoEngineDeps, tx, currentBlockHeight),
      getBox: store.getBox,
      metaPut: store.metaPut,
      metaGet: store.metaGet,
    }),
  );

  // Likes — /likes
  app.use(
    '/likes',
    likeRoutes({
      castLike,
      removeLike,
      getCurrentHeight: store.getCurrentHeight,
      getBox: store.getBox,
      insertBox: store.insertBox,
      consumeBox: store.consumeBox,
      getKarmaBox: store.getKarmaBox,
      runInTransaction: (fn: () => void) => getDb().transaction(fn)(),
    }),
  );

  // Invites — /invites
  app.use(
    '/invites',
    inviteRoutes({
      createInvite,
      claimInvite,
      cancelInvite,
      commitInvite,
      getCurrentHeight: store.getCurrentHeight,
      getBox: store.getBox,
      insertBox: store.insertBox,
      consumeBox: store.consumeBox,
      getKarmaBox: store.getKarmaBox,
      runInTransaction: (fn: () => void) => getDb().transaction(fn)(),
    }),
  );

  // Faucet — /faucet (testnet only)
  if (config.networkMode === 'testnet') {
    app.use(
      '/faucet',
      faucetRoutes({
        getKarmaBox: store.getKarmaBox,
        getCurrentHeight: store.getCurrentHeight,
        getBox: store.getBox,
        insertBox: store.insertBox,
        consumeBox: store.consumeBox,
        runInTransaction: (fn: () => void) => getDb().transaction(fn)(),
        isSystemBox: utxoEngineDeps.isSystemBox,
      }),
    );
  } else {
    app.use('/faucet', (_req, res) => {
      res.status(403).json({ error: 'faucet disabled in production mode' });
    });
  }

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
      getKarmaBox: store.getKarmaBox,
      getKarmaBoxes: store.getKarmaBoxes,
      getCreditBox: store.getCreditBox,
      getCreditBoxes: store.getCreditBoxes,
      getPendingInvites: store.getPendingInvites,
      getBondBoxes: store.getBondBoxes,
      getCurrentHeight: store.getCurrentHeight,
      getUtxoEngineDeps: () => utxoEngineDeps,
    }),
  );

  // Mining — /mining (miner role only)
  if (config.nodeRole === 'miner') {
    app.use(
      '/mining',
      miningRoutes({
        getCurrentTemplate,
        submitMinedBlock,
      }),
    );
  }

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
