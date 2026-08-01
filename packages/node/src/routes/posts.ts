import { Router } from 'express';
import { MAX_CONTENT_BYTES } from '@dagsocial/types';
import type { Post } from '@dagsocial/types';
import { createPost, PostServiceError } from '../services/post-service.js';
import type { PostServiceDeps } from '../services/post-service.js';
import { FeedService } from '../services/feed-service.js';
import type { FeedServiceDeps } from '../services/feed-service.js';
import { getNet } from '../services/net-instance.js';
import { jsonToTx } from './json-to-tx.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface PostsDeps extends PostServiceDeps, FeedServiceDeps {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert hex strings in request body to binary for the Post type.
 * `author`, `challenge`, and `signature` are binary (hex on wire).
 */
function hexToPost(body: Record<string, unknown>): Post {
  const authorHex = body.author as string;
  const challengeHex = body.challenge as string;
  const signatureHex = body.signature as string;

  let author: Uint8Array;
  let challenge: Uint8Array;
  let signature: Uint8Array;

  try {
    author = new Uint8Array(Buffer.from(authorHex, 'hex'));
    challenge = new Uint8Array(Buffer.from(challengeHex, 'hex'));
    signature = new Uint8Array(Buffer.from(signatureHex, 'hex'));
  } catch {
    throw new Error('Invalid hex encoding in author, challenge, or signature');
  }

  if (author.length !== 32) {
    throw new Error('author must be 32 bytes (64 hex chars) — Ed25519 public key');
  }

  return {
    content: body.content as string,
    author,
    parentRefs: (body.parentRefs ?? []) as string[],
    challenge,
    powNonce: body.powNonce as number,
    protocolVersion: body.protocolVersion as number,
    timestamp: body.timestamp as number,
    signature,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: PostsDeps): Router {
  const router = Router();
  const feedService = new FeedService(deps);

  // POST /posts — submit a new post
  router.post('/', (req, res) => {
    // ---- 1. Validate input shape ----
    let post: Post;
    try {
      post = hexToPost(req.body as Record<string, unknown>);
    } catch (err) {
      res.status(400).json({ error: 400, reason: (err as Error).message });
      return;
    }

    if (!post.content || !post.author) {
      res.status(400).json({ error: 400, reason: 'Missing required fields' });
      return;
    }

    if (
      post.content.length < 1 ||
      post.content.length > MAX_CONTENT_BYTES
    ) {
      res.status(400).json({ error: 400, reason: 'Content must be 1-300 bytes' });
      return;
    }

    // Parse karmaLockTx from body
    const rawKarmaLockTx = (req.body as { karmaLockTx?: Record<string, unknown> }).karmaLockTx;
    if (!rawKarmaLockTx) {
      res.status(400).json({ error: 400, reason: 'karmaLockTx required' });
      return;
    }

    let karmaLockTx;
    try {
      karmaLockTx = jsonToTx(rawKarmaLockTx);
    } catch (err) {
      res.status(400).json({ error: 400, reason: (err as Error).message });
      return;
    }

    // ---- 2. Delegate to service ----
    try {
      const result = createPost(deps, post, karmaLockTx);

      // ---- 3. Broadcast (fire-and-forget) ----
      const net = getNet();
      if (net) {
        net.broadcastSubBlock(result.subBlock).catch((err: Error) => {
          console.warn(`Failed to broadcast sub-block: ${err.message}`);
        });
        net.broadcastTx(result.karmaLockTx).catch((err: Error) => {
          console.warn(`Failed to broadcast karma-lock tx: ${err.message}`);
        });
      }

      // ---- 4. Serialize result ----
      res.status(200).json({
        postId: result.postId,
        status: result.status,
        expiresAtHeight: result.expiresAtHeight,
        txId: result.txId,
      });
    } catch (err) {
      if (err instanceof PostServiceError) {
        res.status(err.statusCode).json({ error: err.statusCode, reason: err.message });
      } else {
        res.status(500).json({ error: 500, reason: 'internal error' });
      }
    }
  });

  // GET /posts/:id/thread — fetch a post with full thread context
  router.get('/:id/thread', (req, res) => {
    const thread = feedService.getThread(req.params['id']!);
    if (!thread) {
      res.status(404).json({ error: 404, reason: 'Post not found' });
      return;
    }
    res.json(thread);
  });

  // GET /posts/:id — retrieve a specific post
  router.get('/:id', (req, res) => {
    const result = feedService.getPost(req.params['id']!);
    if (!result) {
      res.status(404).json({ error: 404, reason: 'Post not found' });
      return;
    }
    res.json(result);
  });

  // GET /posts — query posts with pagination
  router.get('/', (req, res) => {
    const limit = Math.min(
      parseInt((req.query['limit'] as string) ?? '50', 10),
      100,
    );
    const offset = parseInt(
      (req.query['offset'] as string) ?? '0',
      10,
    );
    const authorHex = req.query['author'] as string | undefined;
    const author = authorHex ? new Uint8Array(Buffer.from(authorHex, 'hex')) : undefined;

    const posts = feedService.queryPosts({ author, limit, offset });
    res.json(posts);
  });

  return router;
}
