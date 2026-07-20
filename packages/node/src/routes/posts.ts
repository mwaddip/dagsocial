import { Router } from 'express';
import { computePostId, encodePost, MAX_CONTENT_BYTES } from '@dagsocial/types';
import { verifyPost } from '../services/verifier.js';
import { insertPendingPost, getPost, queryPosts } from '../store/posts.js';
import { consumeSlot } from '../store/slots.js';
import { getCurrentHeight } from '../store/blocks.js';
import { onPostReceived } from '../services/blockCreator.js';
import type { Post } from '@dagsocial/types';

export const postsRouter: Router = Router();

postsRouter.post('/', (req, res) => {
  const submitted = req.body as Post;
  if (!submitted.content || !submitted.author) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  if (submitted.content.length < 1 || submitted.content.length > MAX_CONTENT_BYTES) {
    res.status(400).json({ error: 'Content must be 1-300 bytes' });
    return;
  }

  const result = verifyPost(submitted, getCurrentHeight());
  if (!result.valid) {
    res.status(400).json({ error: result.error });
    return;
  }

  submitted.id = computePostId(submitted);

  const rawCbor = Buffer.from(encodePost(submitted));
  insertPendingPost(submitted, rawCbor);
  consumeSlot(submitted.author, submitted.slotHash);
  onPostReceived();

  res.status(201).json({ id: submitted.id, status: 'pending' });
});

postsRouter.get('/:id', (req, res) => {
  const post = getPost(req.params['id']!);
  if (!post) { res.status(404).json({ error: 'Post not found' }); return; }
  res.json(post);
});

postsRouter.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query['limit'] as string ?? '50', 10), 100);
  const offset = parseInt(req.query['offset'] as string ?? '0', 10);
  const author = req.query['author'] as string | undefined;
  res.json(queryPosts({ author, limit, offset }));
});
