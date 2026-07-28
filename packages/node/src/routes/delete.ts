import { Router } from 'express';
import { computeStumpId } from '@dagsocial/types';
import type { PruneIntent, Stump } from '@dagsocial/types';
import { verifyAuthorSignature } from '../services/verifier.js';
import type { AuthorVerifierDeps } from '../services/verifier.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface DeleteDeps extends AuthorVerifierDeps {
  executePrune(intent: PruneIntent, signature: Uint8Array): Stump;
  computeStumpId(stump: Stump): string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: DeleteDeps): Router {
  const router = Router();

  // DELETE /posts/:id — delete a post and its reply subtree
  router.delete('/posts/:id', (req, res) => {
    const postId = req.params['id']!;
    const body = req.body as {
      authorId?: string;
      challenge?: string;
      signature?: string;
    };

    if (!body.authorId || !body.challenge || !body.signature) {
      res
        .status(400)
        .json({ error: 'authorId, challenge, and signature required' });
      return;
    }

    // Decode authorId from hex
    let authorId: Uint8Array;
    try {
      authorId = new Uint8Array(Buffer.from(body.authorId, 'hex'));
    } catch {
      res.status(400).json({ error: 'Invalid hex encoding in authorId' });
      return;
    }

    // Verify author ownership via challenge-response
    const authResult = verifyAuthorSignature(
      deps,
      authorId,
      body.challenge,
      body.signature,
    );
    if (!authResult.valid) {
      res.status(403).json({ error: authResult.error });
      return;
    }

    // Build prune intent (delete always uses trigger 'author')
    const intent: PruneIntent = {
      rootPostHash: postId,
      trigger: 'author',
      authorId,
      signature: new Uint8Array(64), // placeholder; executePrune checks author match, sig already verified above
    };

    try {
      const stump = deps.executePrune(intent, new Uint8Array(64));
      const stumpId = deps.computeStumpId(stump);
      res.status(200).json({
        status: 'deleted',
        stumpId,
        postId,
        replyCount: stump.replyCount,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('Author mismatch') || msg.includes('author does not match')) {
        res.status(403).json({ error: msg });
      } else if (
        msg.includes('not found') ||
        msg.includes('already pruned')
      ) {
        res.status(400).json({ error: msg });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  return router;
}
