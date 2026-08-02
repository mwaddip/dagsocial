/**
 * Intentional, client-safe rejection (audit L-12).
 *
 * Services throw this for rejections whose message is *meant* for the caller
 * ("Already liked this post", "Cannot vouch for yourself"). Route handlers
 * return its message with the mapped status; anything else that reaches a
 * catch block is an unexpected error (SQLite failure, decode crash) and gets a
 * generic 500 body with the detail logged server-side. Before this split, one
 * blanket `catch` forwarded `err.message` for both kinds and leaked internals
 * into HTTP responses.
 *
 * `PostServiceError` and `FaucetServiceError` are the same pattern, predating
 * this module and scoped to their own services.
 */
export class ClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'ClientError';
  }
}
