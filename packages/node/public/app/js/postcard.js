/**
 * postcard.js — rendering for posts, in all the shapes X uses.
 *
 *   list  — a row in a timeline
 *   focal — the subject of a thread page (larger text, split-out stats)
 *   quote — an embedded card inside another post
 *
 * Rendering is string-based and stateless; interaction is wired once by
 * `bindPostActions()` via event delegation, so timelines can re-render freely.
 */
import { html, raw, shortTime, fullTime, compactCount, renderText, shortHex } from './dom.js';
import { icon } from './icons.js';
import * as identity from './identity.js';
import * as store from './store.js';

/** Verified badge — shown for accounts the active identity vouches for. */
function verifiedBadge(authorHex) {
  if (!store.isFollowing(authorHex)) return '';
  return html`<span class="badge-verified" title="You vouch for this account">${raw(
    icon('verified', { size: 18 }),
  )}</span>`;
}

function authorHead(post, { time = true } = {}) {
  const name = identity.displayNameOf(post.author);
  const handle = identity.handleOf(post.author);
  return html`
    <a class="post-name" href="#/profile/${post.author}" data-stop>${name}</a>
    ${raw(verifiedBadge(post.author))}
    <span class="post-handle">@${handle}</span>
    ${time ? raw(html`<span class="post-dot">·</span>
      <a class="post-time" href="#/post/${post.id}" title="${fullTime(post.timestamp)}" data-stop>${shortTime(post.timestamp)}</a>`) : ''}
  `;
}

function avatar(authorHex, { size = 40, className = 'avatar' } = {}) {
  return html`<a href="#/profile/${authorHex}" data-stop
    ><img class="${className}" src="${identity.avatarFor(authorHex, size * 2)}" alt="" width="${size}" height="${size}"
  /></a>`;
}

/** An embedded quote card for a post's parent. */
export function renderQuote(post) {
  return html`
    <div class="quote-card" data-quote-id="${post.id}">
      <div class="quote-head">
        <img class="avatar avatar-sm" src="${identity.avatarFor(post.author, 40)}" alt="" width="20" height="20"
          style="width:20px;height:20px" />
        ${raw(authorHead(post))}
      </div>
      <div class="post-text">${raw(renderText(post.content))}</div>
    </div>
  `;
}

/** The card shown when a quoted parent is not in cache. */
function renderMissingQuote(parentId) {
  return html`
    <div class="quote-card" data-quote-id="${parentId}">
      <div class="sidebar-row-meta">
        Referenced post ${shortHex(parentId)} — open the thread to load it.
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Action bar
// ---------------------------------------------------------------------------

function action({ kind, iconName, filled = false, count = 0, active = false, label, title, disabled = false, extraClass = '' }) {
  const countText = count ? compactCount(count) : '';
  return html`
    <button class="action action-${kind} ${active ? 'is-active' : ''} ${extraClass}"
      data-action="${kind}" title="${title ?? label}" aria-label="${label}" ${disabled ? raw('disabled') : ''}>
      <span class="action-icon">${raw(icon(iconName, { filled: filled || active, size: 18 }))}</span>
      ${countText ? raw(html`<span class="action-count">${countText}</span>`) : ''}
    </button>
  `;
}

function actionBar(post, { focal = false } = {}) {
  const liked = store.hasLiked(post);
  const pending = store.state.pendingLikes.has(post.id);
  const bookmarked = store.isBookmarked(post.id);
  const replies = store.replyCount(post.id);
  const confirmed = post.status === 'confirmed';

  const likeButton = pending
    ? html`<button class="action action-like" disabled aria-label="Like pending">
        <span class="action-icon"><span class="spinner" style="width:18px;height:18px"></span></span>
      </button>`
    : action({
        kind: 'like',
        iconName: 'like',
        count: post.likeCount ?? 0,
        active: liked,
        label: liked ? 'Undo like' : 'Like',
        title: liked
          ? 'Undo like — returns the 2 locked karma'
          : 'Like — locks 2 karma in a LikeBox until the epoch tally',
      });

  return html`
    <div class="actions ${focal ? 'actions-focal' : ''}">
      ${raw(action({ kind: 'reply', iconName: 'reply', count: replies, label: 'Reply', title: 'Reply — locks 3 karma' }))}
      ${raw(action({ kind: 'quote', iconName: 'repost', label: 'Quote', title: 'Quote — publishes a new post referencing this one' }))}
      ${raw(likeButton)}
      ${raw(action({
        kind: 'chain',
        iconName: confirmed ? 'analytics' : 'schedule',
        label: confirmed ? 'Confirmed on chain' : 'Pending inclusion',
        title: confirmed
          ? 'Confirmed — included in an ordering block'
          : 'Pending — mined and accepted, waiting for a block',
        extraClass: confirmed ? '' : 'is-pending',
      }))}
      <div style="display:flex;gap:4px">
        ${raw(action({
          kind: 'bookmark',
          iconName: 'bookmark',
          active: bookmarked,
          label: bookmarked ? 'Remove bookmark' : 'Bookmark',
          title: 'Bookmark — stored locally in this browser',
        }))}
        ${raw(action({ kind: 'share', iconName: 'share', label: 'Share' }))}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Post shapes
// ---------------------------------------------------------------------------

/**
 * A timeline row.
 *
 * @param {object} post
 * @param {object} [opts]
 * @param {boolean} [opts.showQuote]     embed the parent post as a quote card
 * @param {boolean} [opts.railBelow]     draw the thread rail down from the avatar
 * @param {boolean} [opts.railAbove]     draw the thread rail up into the avatar
 * @param {string}  [opts.context]       small header line ("You reposted", …)
 */
export function renderPost(post, opts = {}) {
  const { showQuote = true, railBelow = false, railAbove = false, context = null } = opts;
  const parentId = post.parentRefs[0];
  const parent = parentId ? store.cachedPost(parentId) : null;

  let quoteMarkup = '';
  if (showQuote && parentId) {
    quoteMarkup = parent ? renderQuote(parent) : renderMissingQuote(parentId);
  }

  const replyingTo = parentId
    ? html`<div class="post-replying">Replying to
        <a href="#/profile/${parent?.author ?? ''}" data-stop
          >@${parent ? identity.handleOf(parent.author) : shortHex(parentId, 8, 0)}</a
        >${post.parentRefs.length > 1 ? ` and ${post.parentRefs.length - 1} more` : ''}
      </div>`
    : '';

  return html`
    ${context ? raw(html`<div class="post-context">${raw(icon('repost', { size: 16 }))}<span>${context}</span></div>`) : ''}
    <article class="post" data-post-id="${post.id}" tabindex="0">
      ${railAbove ? raw('<span class="rail-line-top"></span>') : ''}
      <div class="post-rail">
        ${raw(avatar(post.author))}
        ${railBelow ? raw('<span class="rail-line"></span>') : ''}
      </div>
      <div class="post-body">
        <div class="post-head">
          ${raw(authorHead(post))}
          <button class="post-menu" data-action="menu" aria-label="More">${raw(icon('more', { size: 18 }))}</button>
        </div>
        ${raw(replyingTo)}
        <div class="post-text">${raw(renderText(post.content))}</div>
        ${raw(quoteMarkup)}
        ${raw(actionBar(post))}
      </div>
    </article>
  `;
}

/** The subject of a thread page: bigger text, timestamp and stats broken out. */
export function renderFocalPost(post) {
  const liked = store.hasLiked(post);
  const replies = store.replyCount(post.id);

  return html`
    <article class="post is-focal" data-post-id="${post.id}">
      <div style="width:100%">
        <div style="display:flex;gap:12px;align-items:center">
          ${raw(avatar(post.author, { size: 40 }))}
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:4px">
              <a class="post-name" href="#/profile/${post.author}" data-stop>${identity.displayNameOf(post.author)}</a>
              ${raw(verifiedBadge(post.author))}
            </div>
            <div class="post-handle">@${identity.handleOf(post.author)}</div>
          </div>
          <button class="post-menu" data-action="menu" aria-label="More">${raw(icon('more', { size: 18 }))}</button>
        </div>

        <div class="post-text post-text-lg">${raw(renderText(post.content))}</div>

        <div class="sidebar-row-meta" style="padding-bottom:12px">
          ${fullTime(post.timestamp)}
          <span class="post-dot">·</span>
          ${post.status === 'confirmed' ? 'Confirmed on chain' : 'Pending inclusion'}
        </div>

        <div style="display:flex;gap:20px;padding:12px 0;border-top:1px solid var(--border);font-size:14px">
          <span><b>${replies}</b> <span class="post-handle">${replies === 1 ? 'Reply' : 'Replies'}</span></span>
          <span><b>${post.likeCount ?? 0}</b> <span class="post-handle">${(post.likeCount ?? 0) === 1 ? 'Like' : 'Likes'}</span></span>
          <span><b>${liked ? 'Yes' : 'No'}</b> <span class="post-handle">Liked by you</span></span>
        </div>

        ${raw(actionBar(post, { focal: true }))}
      </div>
    </article>
  `;
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

/** Latest handler set per container, so re-binding swaps rather than stacks. */
const boundHandlers = new WeakMap();

/**
 * Wire post interactions on a container.
 *
 * `handlers` receives the post id and the originating element. Clicking the
 * card body (but not a link, button, or `[data-stop]`) opens the thread — the
 * behaviour X has where the whole row is a target except its inner controls.
 *
 * Listeners attach once per container and read the current handlers through a
 * WeakMap: views re-render their lists constantly and call this again each
 * time, and stacking a fresh listener per render would fire every action once
 * per render.
 */
export function bindPostActions(container, handlers) {
  boundHandlers.set(container, handlers);
  if (container.__postActionsBound) return;
  container.__postActionsBound = true;

  const current = () => boundHandlers.get(container) ?? {};

  container.addEventListener('click', (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (actionEl && container.contains(actionEl)) {
      event.preventDefault();
      event.stopPropagation();
      const postId = actionEl.closest('[data-post-id]')?.dataset.postId;
      if (postId) current()[actionEl.dataset.action]?.(postId, actionEl);
      return;
    }

    const quote = event.target.closest('[data-quote-id]');
    if (quote && container.contains(quote)) {
      event.preventDefault();
      event.stopPropagation();
      current().open?.(quote.dataset.quoteId);
      return;
    }

    // Links inside the card navigate on their own.
    if (event.target.closest('a, button, [data-stop]')) return;

    const card = event.target.closest('.post:not(.is-focal)');
    if (card && container.contains(card)) current().open?.(card.dataset.postId);
  });

  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const card = event.target.closest('.post[tabindex]');
    if (card && container.contains(card)) current().open?.(card.dataset.postId);
  });
}
