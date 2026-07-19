import { Router } from 'express';
import { getDb } from '../store/db.js';

export const statusRouter: Router = Router();

statusRouter.get('/', (_req, res) => {
  const db = getDb();
  const blockHeight = (db.prepare(
    'SELECT COALESCE(MAX(height), 0) as h FROM blocks'
  ).get() as { h: number }).h;
  const postCount = (db.prepare(
    "SELECT COUNT(*) as c FROM posts WHERE status = 'confirmed'"
  ).get() as { c: number }).c;
  const pendingPosts = (db.prepare(
    "SELECT COUNT(*) as c FROM posts WHERE status = 'pending'"
  ).get() as { c: number }).c;
  const identityCount = (db.prepare(
    'SELECT COUNT(*) as c FROM identities'
  ).get() as { c: number }).c;

  res.json({ blockHeight, postCount, pendingPosts, identityCount });
});
