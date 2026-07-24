import { Router } from 'express';
import {
  computePostId,
  MAX_CONTENT_BYTES,
} from '@dagsocial/types';
import type { Post, KarmaBox, UtxoTransaction, AnyBox } from '@dagsocial/types';
import type { VerifierDeps, VerificationResult } from '../services/verifier.js';
import { getNet } from '../services/net-instance.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface PostsDeps extends VerifierDeps {
  insertPost(post: Post, rawCbor: Uint8Array): void;
  consumeChallenge(userId: Uint8Array, challenge: Uint8Array): void;
  getPost(id: string): unknown | null;
  queryPosts(opts: {
    author?: Uint8Array;
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
  getLikeCount(postId: string): { locked: number; free: number };
  insertMempoolSubBlock(subBlock: { subBlockId: string; post: Post; likeBoxes: unknown[]; producerId: Uint8Array; protocolVersion: number }, expiresAtHeight: number, batchId: string | null): number;
  insertUtxoTx(tx: UtxoTransaction, batchId: string | null, expiresAtHeight: number): number;
  onSubBlockReceived(): void;
  validateTx: (tx: UtxoTransaction, currentBlockHeight: number) => { valid: boolean; error?: string; computedOutputs?: AnyBox[]; txId?: string };
  getBox: (id: string) => AnyBox | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: PostsDeps): Router {
  const router = Router();

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

  /**
   * Convert a Post's Uint8Array fields to hex for JSON responses.
   * Includes likeCount derived from the likes store.
   */
  function postToJson(post: Post): Record<string, unknown> {
    const postId = computePostId(post);
    const counts = deps.getLikeCount(postId);
    return {
      content: post.content,
      author: Buffer.from(post.author).toString('hex'),
      parentRefs: post.parentRefs,
      challenge: Buffer.from(post.challenge).toString('hex'),
      powNonce: post.powNonce,
      protocolVersion: post.protocolVersion,
      timestamp: post.timestamp,
      signature: Buffer.from(post.signature).toString('hex'),
      likeCount: counts.locked + counts.free,
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
      // Consume challenge on failure so the user can request a fresh one.
      // Swallow errors: the challenge may be malformed or already consumed.
      try { deps.consumeChallenge(post.author, post.challenge); } catch { /* ok */ }
      res.status(400).json({ error: result.error });
      return;
    }

    // Compute post ID server-authoritatively
    const postId = computePostId(post);

    // Store post with raw CBOR
    const rawCbor = deps.encodePost(post);
    deps.insertPost(post, rawCbor);

    // Extract karma-lock tx from request body
    const karmaLockTx = (req.body as { karmaLockTx?: UtxoTransaction }).karmaLockTx;
    if (!karmaLockTx) {
      res.status(400).json({ error: 'karmaLockTx required' });
      return;
    }

    // Validate the karma-lock tx via the UTXO engine
    const txResult = deps.validateTx(karmaLockTx, currentHeight);
    if (!txResult.valid) {
      try { deps.consumeChallenge(post.author, post.challenge); } catch { /* ok */ }
      res.status(400).json({ error: txResult.error });
      return;
    }

    // Verify the karma-lock tx matches the post author
    if (!karmaLockTx.inputs[0]) {
      res.status(400).json({ error: 'karmaLockTx has no inputs' });
      return;
    }
    const karmaInput = deps.getBox(karmaLockTx.inputs[0]);
    if (!karmaInput || karmaInput.boxType !== 'karma') {
      try { deps.consumeChallenge(post.author, post.challenge); } catch { /* ok */ }
      res.status(400).json({ error: 'karmaLockTx first input must be a karma box' });
      return;
    }
    const karmaOwner = (karmaInput as KarmaBox).owner;
    if (!karmaOwner || karmaOwner.length !== 32) {
      try { deps.consumeChallenge(post.author, post.challenge); } catch { /* ok */ }
      res.status(400).json({ error: 'Karma box has invalid owner' });
      return;
    }
    if (!Buffer.from(post.author).equals(Buffer.from(karmaOwner))) {
      try { deps.consumeChallenge(post.author, post.challenge); } catch { /* ok */ }
      res.status(400).json({ error: 'karmaLockTx does not belong to post author' });
      return;
    }

    // Consume the challenge
    deps.consumeChallenge(post.author, post.challenge);

    // Assemble sub-block — the post rides its own sub-block
    const subBlock = {
      subBlockId: postId,
      post,
      likeBoxes: [],
      producerId: post.author,
      protocolVersion: post.protocolVersion,
    };

    // Insert both as a batch into the mempool (same batchId = postId)
    const batchId = postId;
    const expiresAtHeight = currentHeight + 720;
    deps.insertMempoolSubBlock(subBlock, expiresAtHeight, batchId);
    deps.insertUtxoTx(karmaLockTx, batchId, expiresAtHeight);

    // Broadcast sub-block and UTXO transaction to peers (fire-and-forget)
    const net = getNet();
    if (net) {
      net.broadcastSubBlock(subBlock).catch((err: Error) => {
        console.warn(`Failed to broadcast sub-block: ${err.message}`);
      });
      net.broadcastTx(karmaLockTx).catch((err: Error) => {
        console.warn(`Failed to broadcast karma-lock tx: ${err.message}`);
      });
    }

    // Signal the block creator to pick up this sub-block
    deps.onSubBlockReceived();

    res.status(200).json({
      postId,
      status: 'pending',
      expiresAtHeight,
      txId: txResult.txId,
    });
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
    const authorHex = req.query['author'] as string | undefined;
    const author = authorHex ? new Uint8Array(Buffer.from(authorHex, 'hex')) : undefined;

    const posts = deps.queryPosts({ author, limit, offset });
    res.json(posts.map(postToJson));
  });

  return router;
}
