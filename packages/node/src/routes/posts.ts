import { Router } from 'express';
import { computePostId, encodePost, MAX_CONTENT_BYTES } from '@dagsocial/types';
import type { Post } from '@dagsocial/types';
import type { VerifierDeps, VerificationResult } from '../services/verifier.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface PostsDeps extends VerifierDeps {
  insertPost(post: Post, rawCbor: Uint8Array): void;
  consumeChallenge(userId: string, challenge: Uint8Array): void;
  getPost(id: string): unknown | null;
  queryPosts(opts: {
    author?: string;
    limit?: number;
    offset?: number;
  }): Post[];
  encodePost(post: Post): Uint8Array;
  verifyPost(
    deps: VerifierDeps,
    post: Post,
    currentBlockHeight: number,
  ): VerificationResult;
  getCurrentHeight(): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: PostsDeps): Router {
  const router = Router();

  /**
   * Convert hex strings in request body to Uint8Array for the Post type.
   * Only `challenge` and `signature` are binary; the rest are primitives.
   */
  function hexToPost(body: Record<string, unknown>): Post {
    const challengeHex = body.challenge as string;
    const signatureHex = body.signature as string;

    let challenge: Uint8Array;
    let signature: Uint8Array;

    try {
      challenge = new Uint8Array(Buffer.from(challengeHex, 'hex'));
      signature = new Uint8Array(Buffer.from(signatureHex, 'hex'));
    } catch {
      throw new Error('Invalid hex encoding in challenge or signature');
    }

    return {
      content: body.content as string,
      author: body.author as string,
      parentRefs: (body.parentRefs ?? []) as string[],
      challenge,
      powNonce: body.powNonce as number,
      protocolVersion: body.protocolVersion as number,
      timestamp: body.timestamp as number,
      signature,
    };
  }

  /**
   * Convert a Post's Uint8Array fields to hex for JSON responses.
   */
  function postToJson(post: Post): Record<string, unknown> {
    return {
      content: post.content,
      author: post.author,
      parentRefs: post.parentRefs,
      challenge: Buffer.from(post.challenge).toString('hex'),
      powNonce: post.powNonce,
      protocolVersion: post.protocolVersion,
      timestamp: post.timestamp,
      signature: Buffer.from(post.signature).toString('hex'),
    };
  }

  // POST /posts — submit a new post
  router.post('/', (req, res) => {
    let post: Post;
    try {
      post = hexToPost(req.body as Record<string, unknown>);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    // Basic field presence check
    if (!post.content || !post.author) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    if (
      post.content.length < 1 ||
      post.content.length > MAX_CONTENT_BYTES
    ) {
      res.status(400).json({ error: 'Content must be 1-300 bytes' });
      return;
    }

    // Verify the post
    const currentHeight = deps.getCurrentHeight();
    const result = deps.verifyPost(deps, post, currentHeight);
    if (!result.valid) {
      res.status(400).json({ error: result.error });
      return;
    }

    // Compute post ID server-authoritatively
    const postId = computePostId(post);

    // Store post with raw CBOR
    const rawCbor = deps.encodePost(post);
    deps.insertPost(post, rawCbor);

    // Consume the challenge
    deps.consumeChallenge(post.author, post.challenge);

    res.status(201).json({ id: postId, status: 'pending' });
  });

  // GET /posts/:id — retrieve a specific post
  router.get('/:id', (req, res) => {
    const result = deps.getPost(req.params['id']!);
    if (!result) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    // Check if it's a Stump (has subtreeMerkleRoot)
    if (
      typeof result === 'object' &&
      result !== null &&
      'subtreeMerkleRoot' in result
    ) {
      // Return stump as-is (no hex conversion needed for stump fields in JSON)
      res.json(result);
      return;
    }

    res.json(postToJson(result as Post));
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
    const author = req.query['author'] as string | undefined;

    const posts = deps.queryPosts({ author, limit, offset });
    res.json(posts.map(postToJson));
  });

  return router;
}
