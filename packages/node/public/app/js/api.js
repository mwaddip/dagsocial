/**
 * api.js — thin typed-ish wrapper over the node's HTTP API.
 *
 * Every call goes to the same endpoints the demo UI uses; nothing here is
 * mocked or simulated. Errors are normalised into `ApiError` so views can show
 * the node's own `reason`/`error` text instead of a generic failure.
 */

/**
 * Auto-detect the API base. The node serves this UI from `public/app/`, so a
 * direct hit is `/app/` → API at `/`. Behind the testnet nginx the whole node
 * is mounted under `/testnet`, with the API at `/testnet/api`.
 */
export const API = window.location.pathname.startsWith('/testnet') ? '/testnet/api' : '';

export class ApiError extends Error {
  /** @param {number} status HTTP status, or 0 when the request never landed. */
  constructor(message, status, body, options) {
    super(message, options);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(API + path, options);
  } catch (cause) {
    throw new ApiError('Node unreachable', 0, null, { cause });
  }

  // Some endpoints (preview, 404 HTML) do not return JSON.
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
    }
  }

  if (!res.ok) {
    const reason = body?.reason ?? body?.error ?? `HTTP ${res.status}`;
    throw new ApiError(String(reason), res.status, body);
  }
  return body;
}

function postJson(path, payload) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Node state
// ---------------------------------------------------------------------------

/** `{ networkMode, blockHeight, postCount, pendingPosts, identityCount, totalKarma, totalCredits }` */
export const getStatus = () => request('/status');

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

/** Newest-first page of posts, optionally filtered to a single author. */
export function getPosts({ limit = 50, offset = 0, author } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (author) params.set('author', author);
  return request('/posts?' + params.toString());
}

export const getPost = (id) => request('/posts/' + encodeURIComponent(id));

/** `{ post, ancestors, descendants }` — the full thread context for one post. */
export const getThread = (id) => request('/posts/' + encodeURIComponent(id) + '/thread');

/** Request a PoW challenge. Returns `{ challenge, targetBits }`. */
export const requestChallenge = (userId) => postJson('/challenge', { userId });

/** Submit a mined, signed post together with its karma-lock tx. */
export const submitPost = (payload) => postJson('/posts', payload);

export function deletePost(postId, { authorId, challenge, signature }) {
  return request('/posts/' + encodeURIComponent(postId), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorId, challenge, signature }),
  });
}

// ---------------------------------------------------------------------------
// Likes
// ---------------------------------------------------------------------------

export const submitLike = (tx) => postJson('/likes', { tx });
export const submitUnlike = (tx) => postJson('/likes/remove', { tx });

// ---------------------------------------------------------------------------
// Vouches — this UI's "follow" primitive
// ---------------------------------------------------------------------------

/** Accounts that vouch for `targetId` — i.e. that account's followers. */
export const getVouchesForTarget = (targetId) =>
  request('/vouches?target=' + encodeURIComponent(targetId));

/** Accounts `voucherId` vouches for — i.e. who that account follows. */
export const getVouchesByVoucher = (voucherId) =>
  request('/vouches?voucher=' + encodeURIComponent(voucherId));

export const castVouch = (userId, targetId) => postJson('/vouches', { userId, targetId });

export function removeVouch(userId, targetId) {
  return request('/vouches/' + encodeURIComponent(targetId), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
}

// ---------------------------------------------------------------------------
// UTXO state
// ---------------------------------------------------------------------------

/**
 * Karma boxes for a user, as `{ userId, total, boxes: [{ boxId, value }] }`.
 * Returns a zero-valued shape rather than throwing when the account has no
 * boxes yet — a brand-new identity is an expected state, not an error.
 */
export async function getKarma(userId) {
  try {
    return await request('/karma/' + encodeURIComponent(userId));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { userId, total: 0, boxes: [] };
    throw err;
  }
}

export async function getCredits(userId) {
  try {
    return await request('/credits/' + encodeURIComponent(userId));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { userId, total: 0, boxes: [] };
    throw err;
  }
}

/** `{ pending: InviteBox[], bonds: BondBox[] }` */
export async function getInviteState(userId) {
  try {
    return await request('/invites/' + encodeURIComponent(userId));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { pending: [], bonds: [] };
    throw err;
  }
}

export const grantKarmaFaucet = (userId, amount) => postJson('/faucet', { userId, amount });
export const grantCreditFaucet = (userId) => postJson('/credits/faucet', { to: userId });

export const transferCredits = (payload) => postJson('/credits/transfer', payload);

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export const createInvite = (tx) => postJson('/invites', { tx });
export const commitInvite = (tx) => postJson('/invites/commit', { tx });
export const claimInvite = (tx) => postJson('/invites/claim', { tx });
export const cancelInvite = (tx) => postJson('/invites/cancel', { tx });
