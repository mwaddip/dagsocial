/**
 * store.js — application state and the derived social graph.
 *
 * Everything here is either fetched from the node or derived from what the node
 * returned. Only three things live purely in the browser, and each is labelled
 * as local wherever the UI shows it:
 *
 *   - bookmarks       — the protocol has no bookmark record
 *   - like receipts   — the LikeBox ids needed to *un*like, which the node does
 *                       not index by liker; losing them only costs the ability
 *                       to undo a like from a different browser
 *   - the seen marker — how far the notifications list has been read
 */
import * as api from './api.js';
import * as identity from './identity.js';
import { extractHashtags } from './dom.js';

const BOOKMARKS_KEY = 'notis-x-bookmarks';
const LIKE_STATE_KEY = 'notis-x-like-state';
const NOTIFICATIONS_SEEN_KEY = 'notis-x-notifications-seen';

/** Feed page size. The node caps `limit` at 100. */
export const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Reactive state
// ---------------------------------------------------------------------------

export const state = {
  /** `/status` — `{ networkMode, blockHeight, postCount, ... }` or null. */
  status: null,
  /** Karma for the active identity: `{ total, boxes }`. */
  karma: { total: 0, boxes: [] },
  /** Credits for the active identity: `{ total, boxes }`. */
  credits: { total: 0, boxes: [] },
  /** Hex ids the active identity vouches for — its "following" set. */
  following: new Set(),
  /** Hex ids that vouch for the active identity — its "followers". */
  followers: new Set(),
  /** Latest feed page, newest first. */
  posts: [],
  /** postId → post, for every post seen this session. */
  postsById: new Map(),
  /** Post ids with an in-flight like/unlike. */
  pendingLikes: new Set(),
  /** True once the first status + identity load has settled. */
  ready: false,
};

const listeners = new Set();

/** Subscribe to state changes. Returns an unsubscribe function. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) fn();
}

// ---------------------------------------------------------------------------
// Local storage helpers
// ---------------------------------------------------------------------------

function readJson(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? 'null');
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

const writeJson = (key, value) => localStorage.setItem(key, JSON.stringify(value));

// ---------------------------------------------------------------------------
// Node state
// ---------------------------------------------------------------------------

export async function refreshStatus() {
  try {
    state.status = await api.getStatus();
  } catch {
    state.status = null;
  }
  return state.status;
}

/** Current block height — on-chain time. Transactions are stamped with this. */
export const height = () => state.status?.blockHeight ?? 0;
export const isTestnet = () => state.status?.networkMode === 'testnet';

/**
 * Refresh karma and credits for the active identity.
 *
 * A failed request keeps the previous figure rather than falling back to zero.
 * Showing 0 karma because a fetch timed out is worse than showing a stale
 * number: it reads as "you are broke" and makes the composer look unusable.
 * (A genuine "no boxes" answer is a 404, which `api.getKarma` already turns
 * into a real zero.)
 */
export async function refreshBalances() {
  const me = identity.userId();
  if (!me) return;
  const [karma, credits] = await Promise.all([
    api.getKarma(me).catch(() => null),
    api.getCredits(me).catch(() => null),
  ]);
  if (karma) state.karma = karma;
  if (credits) state.credits = credits;
}

// ---------------------------------------------------------------------------
// Social graph (vouches)
// ---------------------------------------------------------------------------

export async function refreshGraph() {
  const me = identity.userId();
  if (!me) return;
  const [outgoing, incoming] = await Promise.all([
    api.getVouchesByVoucher(me).catch(() => ({ vouches: [] })),
    api.getVouchesForTarget(me).catch(() => ({ vouches: [] })),
  ]);
  state.following = new Set((outgoing.vouches ?? []).map((v) => v.targetId));
  state.followers = new Set((incoming.vouches ?? []).map((v) => v.voucherId));
}

export const isFollowing = (hex) => state.following.has(hex);


// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

function indexPosts(posts) {
  for (const post of posts) {
    reconcileLikeState(post);
    state.postsById.set(post.id, post);
  }
}

/** Fetch a feed page and index it. Does not mutate `state.posts`. */
export async function fetchPosts(options = {}) {
  const posts = await api.getPosts({ limit: PAGE_SIZE, ...options });
  indexPosts(posts);
  return posts;
}

/** Refresh the main timeline into `state.posts`. */
export async function refreshFeed() {
  state.posts = await fetchPosts();
  return state.posts;
}

export async function fetchThread(postId) {
  const thread = await api.getThread(postId);
  indexPosts([thread.post, ...(thread.ancestors ?? []), ...(thread.descendants ?? [])].filter(Boolean));
  return thread;
}

export const cachedPost = (id) => state.postsById.get(id) ?? null;


/** Reply count for a post, from the current cache (a floor, not a total). */
export function replyCount(postId) {
  let n = 0;
  for (const post of state.postsById.values()) if (post.parentRefs.includes(postId)) n++;
  return n;
}


// ---------------------------------------------------------------------------
// Likes
// ---------------------------------------------------------------------------

export const hasLiked = (post) => {
  const me = identity.userId();
  return Boolean(me && post.likers?.includes(me));
};

/**
 * Local record of the likes this browser has cast, `{ [postId]: { liked,
 * likeBoxId, isFree } }`, scoped to the identity that cast them so switching
 * accounts does not cross the wires.
 *
 * It exists for two reasons. Undoing a like has to consume the exact LikeBox it
 * created, and the node offers no lookup from (liker, post) back to that box.
 * And a like is accepted as *pending*: the post's liker list catches up a beat
 * later, so a feed re-read taken straight after the write still says "not
 * liked" — without this the button would spring back after a write the node
 * accepted.
 */
function likeState() {
  const all = readJson(LIKE_STATE_KEY, {});
  const me = identity.userId();
  return { all, mine: (me && all[me]) || {} };
}

/** The receipt needed to undo a like, or null if this browser did not cast it. */
export function getLikeReceipt(postId) {
  const entry = likeState().mine[postId];
  return entry?.liked ? entry : null;
}

/**
 * Record the outcome of a like or unlike the node has accepted, and patch the
 * cached post so the current render updates without waiting for a re-read.
 */
export function recordLike(postId, liked, receipt = {}) {
  const me = identity.userId();
  if (!me) return;

  const { all, mine } = likeState();
  all[me] = { ...mine, [postId]: { liked, ...receipt } };
  writeJson(LIKE_STATE_KEY, all);

  const post = state.postsById.get(postId);
  if (post) reconcileLikeState(post);
}

/**
 * Apply this browser's pending like state to a post the node just returned, and
 * drop the local record once the node agrees.
 *
 * The self-healing half matters: without it, a like that never made it into a
 * block would read as "liked" in this browser forever, and the local record
 * would quietly become a second, wrong source of truth.
 */
function reconcileLikeState(post) {
  const me = identity.userId();
  if (!me || !post) return;

  const { all, mine } = likeState();
  const entry = mine[post.id];
  if (!entry) return;

  const likers = new Set(post.likers ?? []);
  if (likers.has(me) === entry.liked) {
    // The node has caught up. An unlike leaves nothing worth keeping; a like
    // keeps its record, because undoing it still needs the LikeBox id.
    if (!entry.liked) {
      delete mine[post.id];
      all[me] = mine;
      writeJson(LIKE_STATE_KEY, all);
    }
    return;
  }

  if (entry.liked) likers.add(me);
  else likers.delete(me);
  post.likers = [...likers];
  post.likeCount = Math.max(0, (post.likeCount ?? 0) + (entry.liked ? 1 : -1));
}

// ---------------------------------------------------------------------------
// Bookmarks (local to this browser)
// ---------------------------------------------------------------------------

export const bookmarkIds = () => readJson(BOOKMARKS_KEY, []);
export const isBookmarked = (postId) => bookmarkIds().includes(postId);

export function toggleBookmark(postId) {
  const ids = bookmarkIds();
  const index = ids.indexOf(postId);
  if (index === -1) ids.unshift(postId);
  else ids.splice(index, 1);
  writeJson(BOOKMARKS_KEY, ids);
  return index === -1;
}

export const clearBookmarks = () => writeJson(BOOKMARKS_KEY, []);

// ---------------------------------------------------------------------------
// Notifications (derived from chain data)
// ---------------------------------------------------------------------------

/**
 * Build the notification list for the active identity.
 *
 * Everything is derived from data the node already serves:
 *   - likes    — `likers` on your posts
 *   - replies  — posts naming one of your posts as a parent
 *   - follows  — vouches whose target is you
 *
 * Likes and follows carry no timestamp of their own (a LikeBox records a block,
 * not a wall clock), so they are ordered by the post they attach to and by
 * block height respectively — which is the honest ordering available.
 */
export async function buildNotifications() {
  const me = identity.userId();
  if (!me) return [];

  const [mine, recent, vouches] = await Promise.all([
    fetchPosts({ author: me, limit: PAGE_SIZE }).catch(() => []),
    fetchPosts({ limit: PAGE_SIZE }).catch(() => []),
    api.getVouchesForTarget(me).catch(() => ({ vouches: [] })),
  ]);

  const myPostIds = new Set(mine.map((p) => p.id));
  const items = [];

  for (const post of mine) {
    for (const liker of post.likers ?? []) {
      if (liker === me) continue;
      items.push({
        kind: 'like',
        actor: liker,
        postId: post.id,
        text: post.content,
        // A LikeBox is stamped with a block, not a clock. The liked post's own
        // timestamp is the only wall-clock anchor that is actually true.
        sortKey: post.timestamp,
      });
    }
  }

  for (const post of recent) {
    if (post.author === me) continue;
    const target = post.parentRefs.find((ref) => myPostIds.has(ref));
    if (!target) continue;
    items.push({
      kind: 'reply',
      actor: post.author,
      postId: post.id,
      parentId: target,
      text: post.content,
      sortKey: post.timestamp,
    });
  }

  for (const vouch of vouches.vouches ?? []) {
    items.push({
      kind: 'follow',
      actor: vouch.voucherId,
      block: vouch.createdAtBlock,
      // Vouches have no wall clock at all; float them by block order above the
      // oldest posts but never above genuinely recent activity.
      sortKey: null,
      sortBlock: vouch.createdAtBlock,
    });
  }

  items.sort((a, b) => {
    if (a.sortKey !== null && b.sortKey !== null) return b.sortKey - a.sortKey;
    if (a.sortKey === null && b.sortKey === null) return (b.sortBlock ?? 0) - (a.sortBlock ?? 0);
    return a.sortKey === null ? 1 : -1;
  });

  return items;
}

export const notificationsSeenAt = () => Number(localStorage.getItem(NOTIFICATIONS_SEEN_KEY) ?? 0);
export const markNotificationsSeen = () =>
  localStorage.setItem(NOTIFICATIONS_SEEN_KEY, String(Date.now()));

/** Count of notifications newer than the last visit — the nav badge. */
export function unreadCount(items) {
  const seen = notificationsSeenAt();
  return items.filter((n) => (n.sortKey ?? 0) > seen).length;
}

// ---------------------------------------------------------------------------
// Trends and suggestions (derived from chain data)
// ---------------------------------------------------------------------------

/** Hashtags across the loaded posts, most-used first. */
export function trends(posts, limit = 5) {
  const counts = new Map();
  for (const post of posts) {
    for (const tag of extractHashtags(post.content)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }));
}

/**
 * Accounts to suggest following: authors in the timeline that the active
 * identity does not already vouch for, ranked by how much they post.
 */
export function suggestions(posts, limit = 3) {
  const me = identity.userId();
  const counts = new Map();
  for (const post of posts) {
    if (post.author === me || state.following.has(post.author)) continue;
    counts.set(post.author, (counts.get(post.author) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([author, count]) => ({ author, posts: count }));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/** Load everything that depends on the active identity. */
export async function refreshIdentityScoped() {
  await Promise.all([refreshBalances(), refreshGraph()]);
  emit();
}

export async function init() {
  await refreshStatus();
  await refreshIdentityScoped();
  state.ready = true;
  emit();
}
