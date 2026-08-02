import type { Response } from 'express';
import { ClientError } from '../services/client-error.js';
import { MempoolFullError } from '../store/mempool.js';

/**
 * Shape of the body carrying an intentional rejection's message. Two shapes
 * exist across the API and clients read them directly (the demo UI reads
 * `data.error` on the invite routes, `data.reason || data.error` elsewhere), so
 * each route keeps the one it already returned. Unifying them is a separate,
 * client-visible change.
 */
export type ClientErrorBody = 'status+reason' | 'message';

/**
 * The route error policy in one place (audit L-12, M-8).
 *
 * - `ClientError` — an intentional, client-safe rejection: its message is
 *   returned with the status the service chose (400/403/409).
 * - `MempoolFullError` — the pool is at its cap: 503 with a generic body, so
 *   the client can retry once entries expire or confirm.
 * - anything else — unexpected (SQLite failure, decode crash): a generic 500
 *   body, with the real error logged server-side. Internals never reach the
 *   response.
 *
 * `context` labels the server-side log line ("POST /likes").
 */
export function respondError(
  res: Response,
  err: unknown,
  context: string,
  body: ClientErrorBody = 'status+reason',
): void {
  if (err instanceof ClientError) {
    if (body === 'message') {
      res.status(err.statusCode).json({ error: err.message });
    } else {
      res.status(err.statusCode).json({ error: err.statusCode, reason: err.message });
    }
    return;
  }

  if (err instanceof MempoolFullError) {
    res.status(503).json({ error: 'mempool full' });
    return;
  }

  console.error(`${context} failed with an unexpected error:`, err);
  res.status(500).json({ error: 'Internal error' });
}
