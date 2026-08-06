import express from 'express';
import { createRouter as challengeRoutes } from './routes/challenges.js';
import { createRouter as postRoutes } from './routes/posts.js';
import { createRouter as likeRoutes } from './routes/likes.js';
import { createRouter as inviteRoutes } from './routes/invites.js';
import { createRouter as faucetRoutes } from './routes/faucet.js';
import { deleteRoutes } from './routes/delete.js';
import { createRouter as utxoRoutes } from './routes/utxo.js';
import { createRouter as vouchRoutes } from './routes/vouches.js';
import { createRouter as blockRoutes } from './routes/blocks.js';
import { createRouter as miningRoutes } from './routes/mining.js';
import * as store from './store/index.js';
import { getSystemKeypair } from './store/system.js';
import { generateChallenge } from './services/pow.js';
import { verifyPost } from './services/verifier.js';
import { onSubBlockReceived, getCurrentTemplate, submitMinedBlock, setMinerPubkey } from './services/block-creator.js';
import { castLike, removeLike } from './services/likes.js';
import { castVouch, initiateUnvouch } from './services/vouch.js';
import { createInvite, claimInvite, cancelInvite, commitInvite } from './services/invites.js';
import { executePrune } from './services/stump-engine.js';
import { readFileSync } from 'fs';
import { encodePost } from '@dagsocial/types';
import { computePostId } from '@dagsocial/types';
import { getDb } from './store/db.js';
import { validateTx } from './services/utxo-engine.js';
import { createAdminRouter } from './routes/admin.js';
import { registerProofEndpoint } from './state/avl-endpoint.js';
import { tryGetAvlProver } from './state/avl-prover.js';
import type { Config } from './config.js';
import type { Server } from 'http';

// ---------------------------------------------------------------------------
// createAdminApp
// ---------------------------------------------------------------------------

export function createAdminApp(config: Config): Server {
  const adminApp = express();
  adminApp.use(createAdminRouter());

  // WARN if not loopback
  if (config.adminBindAddress !== '127.0.0.1' && config.adminBindAddress !== '::1') {
    console.warn(
      `Admin listener binding to non-loopback address: ${config.adminBindAddress}:${config.adminPort}. ` +
      `This exposes internal metrics to the network.`,
    );
  }

  const server = adminApp.listen(config.adminPort, config.adminBindAddress, () => {
    console.log(`Admin listener on ${config.adminBindAddress}:${config.adminPort}`);
  });

  return server;
}

// ---------------------------------------------------------------------------
// createApp
// ---------------------------------------------------------------------------

export function createApp(config: Config): express.Express {
  const app = express();

  // ---- Middleware ----

  app.use(express.json({ limit: '1mb' }));

  // Demo UI
  const publicDir = new URL('../public', import.meta.url).pathname;
  const indexPath = new URL('../public/index.html', import.meta.url).pathname;
  const indexHtml = readFileSync(indexPath, 'utf-8');

  // Inject OG meta tags into index.html when ?post=<id> is present.
  // This handles the case where a user copies the browser URL bar to share.
  app.get('/', (req, res, next) => {
    const postId = req.query['post'] as string | undefined;
    if (!postId) return next();

    const result = store.getPost(postId);
    if (!result || !('content' in result)) return next();

    const post = result as import('@dagsocial/types').Post;
    const authorHex = Buffer.from(post.author).toString('hex');
    const shortAuthor = authorHex.slice(0, 12);
    const descRaw = post.content.length > 200
      ? post.content.slice(0, 197).replace(/\s+\S*$/, '') + '...'
      : post.content;
    const desc = descRaw.replace(/\s+/g, ' ').replace(/"/g, '&quot;').trim();

    const publicBase = config.publicUrl.replace(/\/$/, '');
    const apiBase = publicBase ? `${publicBase}/api` : '';
    const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
    const host = (req.headers['x-forwarded-host'] as string) ?? req.get('host') ?? 'localhost';
    const canonicalUrl = `${proto}://${host}${publicBase}/?post=${encodeURIComponent(postId)}`;

    const ogTags = `
<meta property="og:title" content="Post by ${shortAuthor}... — Notis">
<meta name="description" content="${desc}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="article">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:site_name" content="Notis">
<meta name="twitter:card" content="summary">`;

    const html = indexHtml.replace('</head>', `${ogTags}\n</head>`);
    res.type('html').send(html);
  });

  app.use(express.static(publicDir));

  // GET /preview/:id — Open Graph preview page for link sharing (Telegram, etc.)
  app.get('/preview/:id', (req, res) => {
    const postId = req.params['id']!;
    const result = store.getPost(postId);
    if (!result || !('content' in result)) {
      res.status(404).type('html').send('<!DOCTYPE html><html><body><p>Post not found.</p></body></html>');
      return;
    }

    const post = result as import('@dagsocial/types').Post;
    const authorHex = Buffer.from(post.author).toString('hex');
    const shortAuthor = authorHex.slice(0, 12);
    // Truncate content to ~200 chars for og:description. Collapse whitespace
    // (newlines break HTML attribute parsing) and escape for HTML.
    const descRaw = post.content.length > 200
      ? post.content.slice(0, 197).replace(/\s+\S*$/, '') + '...'
      : post.content;
    const desc = descRaw.replace(/\s+/g, ' ').replace(/"/g, '&quot;').trim();

    // Build absolute URL for og:url (Telegram requires absolute URLs).
    // The Express app may be behind nginx with a path prefix (e.g. /testnet/api).
    const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
    const host = (req.headers['x-forwarded-host'] as string) ?? req.get('host') ?? 'localhost';
    const publicBase = config.publicUrl.replace(/\/$/, ''); // e.g. "" or "/testnet"
    const apiBase = publicBase ? `${publicBase}/api` : '';
    const previewUrl = `${proto}://${host}${apiBase}/preview/${encodeURIComponent(postId)}`;
    const uiUrl = `${publicBase}/?post=${encodeURIComponent(postId)}`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Post by ${shortAuthor}... — Notis</title>
<meta property="og:title" content="Post by ${shortAuthor}... — Notis">
<meta name="description" content="${desc}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="article">
<meta property="og:url" content="${previewUrl.replace(/"/g, '&quot;')}">
<meta property="og:site_name" content="Notis">
<meta name="twitter:card" content="summary">
<script>window.location.href = '${uiUrl.replace(/'/g, "\\'")}';</script>
</head>
<body>
<p><a href="${uiUrl.replace(/"/g, '&quot;')}">View post</a></p>
</body>
</html>`;
    res.type('html').send(html);
  });

  // ---- Shared UTXO engine deps (curried into validateTx for routes) ----

  const utxoEngineDeps = {
    getBox: store.getBox,
      getBoxByProvenance: store.getBoxByProvenance,
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
      getLikersForPost: store.getLikersForPost,
      getAncestors: store.getAncestors,
      getSubtree: store.getSubtree,
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
      getBoxByProvenance: store.getBoxByProvenance,
      insertBox: store.insertBox,
      consumeBox: store.consumeBox,
      getKarmaBox: store.getKarmaBox,
      runInTransaction: (fn: () => void) => getDb().transaction(fn)(),
    }),
  );

  // Vouches — /vouches
  app.use(
    '/vouches',
    vouchRoutes({
      castVouch,
      initiateUnvouch,
      getCurrentHeight: store.getCurrentHeight,
      getBox: store.getBox,
      getBoxByProvenance: store.getBoxByProvenance,
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
      getBoxByProvenance: store.getBoxByProvenance,
      insertBox: store.insertBox,
      consumeBox: store.consumeBox,
      getKarmaBox: store.getKarmaBox,
      runInTransaction: (fn: () => void) => getDb().transaction(fn)(),
    }),
  );

  // Faucet — /faucet (every network but mainnet; NODE_INTERFACE §Faucet).
  // Gate matches the system-box provisioning in index.ts and the
  // /credits/faucet handler in routes/utxo.ts — the three move together.
  if (config.networkType !== 'mainnet') {
    app.use(
      '/faucet',
      faucetRoutes({
        getKarmaBox: store.getKarmaBox,
        getCurrentHeight: store.getCurrentHeight,
        getBox: store.getBox,
      getBoxByProvenance: store.getBoxByProvenance,
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

  // Delete — POST /posts/:id/prune
  app.use(
    '/',
    deleteRoutes({
      executePrune,
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

  // Mining — /mining (external-mode miners only; internal mining is in-process
  // and exposes no mining HTTP surface at all — audit M-7)
  if (config.nodeRole === 'miner' && config.miningMode === 'external') {
    app.use(
      '/mining',
      miningRoutes({
        getCurrentTemplate,
        submitMinedBlock,
        setMinerPubkey,
        miningSecret: config.miningSecret,
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
          .safeIntegers()
          .get() as { s: bigint };
        return row.s;
      },
      getTotalCredits: () => {
        const row = db
          .prepare(
            "SELECT COALESCE(SUM(value), 0) AS s FROM utxo_boxes WHERE box_type = 'credit' AND spent_at_block IS NULL",
          )
          .safeIntegers()
          .get() as { s: bigint };
        return row.s;
      },
      networkType: config.networkType,
    }),
  );

  // Proof endpoint — GET /api/v1/proof/:boxId (light-client AVL proofs)
  const proverHandle = tryGetAvlProver();
  if (proverHandle) {
    registerProofEndpoint(app, proverHandle);
  } else {
    console.warn('AVL prover not initialized — /api/v1/proof endpoint unavailable');
  }

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
