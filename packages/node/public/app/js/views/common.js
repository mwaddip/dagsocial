/**
 * views/common.js — chrome and behaviour shared by every view.
 *
 * Views are plain functions that render an HTML string into the main column and
 * then wire it. The pieces they all need — the sticky header, tab strips, the
 * timeline list and the full set of post interactions — live here so a post
 * behaves identically wherever it appears.
 */
import {
  html, raw, toast, openMenu, openModal, closeOverlays, confirmDialog, copyText, shortHex,
} from '../dom.js';
import { icon } from '../icons.js';
import * as identity from '../identity.js';
import * as store from '../store.js';
import * as actions from '../actions.js';
import { renderPost, bindPostActions } from '../postcard.js';
import { openComposerModal } from '../composer.js';
import { navigate } from '../router.js';

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

/** X's sticky column header: optional back arrow, title, subtitle, trailing slot. */
export function header({ title, subtitle = null, back = false, trailing = '' }) {
  return html`
    <div class="header">
      <div class="header-row">
        ${back
          ? raw(html`<button class="icon-button" data-back aria-label="Back">${raw(icon('back', { size: 20 }))}</button>`)
          : ''}
        <div style="flex:1;min-width:0">
          <div class="header-title">${title}</div>
          ${subtitle ? raw(html`<div class="header-subtitle">${subtitle}</div>`) : ''}
        </div>
        ${raw(trailing)}
      </div>
    </div>
  `;
}

/** A tab strip. `tabs` is `[{ id, label }]`; the active tab gets the underline. */
export function tabStrip(tabs, activeId) {
  return html`
    <div class="tabs" role="tablist">
      ${raw(tabs.map((tab) => html`
        <button class="tab" role="tab" data-tab="${tab.id}" aria-selected="${tab.id === activeId}">
          <span style="position:relative;padding:16px 0">
            ${tab.label}
            ${tab.id === activeId ? raw('<span class="tab-underline" style="left:0;right:0"></span>') : ''}
          </span>
        </button>
      `).join(''))}
    </div>
  `;
}

/** Wire a tab strip. `onSelect` receives the tab id. */
export function bindTabs(container, onSelect) {
  container.querySelectorAll('[data-tab]').forEach((el) => {
    el.addEventListener('click', () => onSelect(el.dataset.tab));
  });
}

export const loading = () => '<div class="loading"><span class="spinner spinner-lg"></span></div>';

export function emptyState(title, body, actionMarkup = '') {
  return html`
    <div class="empty-state">
      <h2>${title}</h2>
      <p>${body}</p>
      ${raw(actionMarkup)}
    </div>
  `;
}

export function errorState(message, { retry = true } = {}) {
  return emptyState(
    'Something went wrong',
    message,
    retry ? '<button class="btn btn-inverse btn-lg" data-retry>Retry</button>' : '',
  );
}

// ---------------------------------------------------------------------------
// Timelines
// ---------------------------------------------------------------------------

/**
 * Render a list of posts.
 *
 * @param {object[]} posts
 * @param {object} [opts] forwarded to `renderPost` for every row
 */
export function renderTimeline(posts, opts = {}) {
  return posts.map((post) => renderPost(post, opts)).join('');
}

/**
 * Wire every post interaction on a container.
 *
 * Two callbacks, because the two jobs are different: `repaint` re-renders from
 * what is already in memory (used for the instant spinner on a like), while
 * `reload` re-reads from the node (used once a chain write has been accepted,
 * since the node — not the cache — decides what the post now looks like).
 *
 * @param {HTMLElement} container
 * @param {{ repaint: () => void, reload?: () => void | Promise<void> }
 *         | (() => void)} handlers
 */
export function bindTimeline(container, handlers) {
  const repaint = typeof handlers === 'function' ? handlers : handlers.repaint;
  const reload = (typeof handlers === 'function' ? null : handlers.reload) ?? repaint;

  bindPostActions(container, {
    open: (postId) => navigate(`/post/${postId}`),

    reply: (postId) => {
      const post = store.cachedPost(postId);
      if (post) openComposerModal({ mode: 'reply', target: post, onPublished: reload });
    },

    quote: (postId) => {
      const post = store.cachedPost(postId);
      if (post) openComposerModal({ mode: 'quote', target: post, onPublished: reload });
    },

    like: async (postId) => {
      const post = store.cachedPost(postId);
      if (!post) return;
      const liked = store.hasLiked(post);

      store.state.pendingLikes.add(postId);
      repaint();
      try {
        if (liked) {
          await actions.unlikePost(postId);
          toast('Like removed — 2 karma returned.');
        } else {
          await actions.likePost(postId);
          toast('Liked — 2 karma locked until the epoch tally.');
        }
      } catch (error) {
        toast(error.message, { error: true });
      } finally {
        store.state.pendingLikes.delete(postId);
        await reload();
      }
    },

    bookmark: (postId) => {
      const added = store.toggleBookmark(postId);
      toast(added ? 'Added to your Bookmarks (this browser).' : 'Removed from your Bookmarks.');
      repaint();
    },

    chain: () => {},

    share: (postId, element) => {
      const url = new URL(`#/post/${postId}`, window.location.href).toString();
      openMenu(element, html`
        <button class="menu-item" data-copy-link>${raw(icon('link', { size: 18 }))} Copy link to post</button>
        <button class="menu-item" data-copy-id>${raw(icon('key', { size: 18 }))} Copy post id</button>
      `).root.addEventListener('click', async (event) => {
        const target = event.target.closest('[data-copy-link], [data-copy-id]');
        if (!target) return;
        const value = target.hasAttribute('data-copy-link') ? url : postId;
        closeOverlays();
        toast((await copyText(value)) ? 'Copied to clipboard.' : 'Could not copy.', {
          error: false,
        });
      });
    },

    menu: (postId, element) => {
      const post = store.cachedPost(postId);
      if (!post) return;
      const mine = identity.isSelf(post.author);
      const following = store.isFollowing(post.author);

      const menu = openMenu(element, html`
        ${mine
          ? raw(html`<button class="menu-item is-danger" data-delete>${raw(icon('trash', { size: 18 }))} Delete post</button>`)
          : raw(html`<button class="menu-item" data-follow>
              ${raw(icon(following ? 'block' : 'profile', { size: 18 }))}
              ${following ? 'Unfollow' : 'Follow'} @${identity.handleOf(post.author)}
            </button>`)}
        <div class="menu-sep"></div>
        <button class="menu-item" data-raw>${raw(icon('analytics', { size: 18 }))} View chain record</button>
      `);

      menu.root.addEventListener('click', async (event) => {
        if (event.target.closest('[data-delete]')) {
          closeOverlays();
          const ok = await confirmDialog({
            title: 'Delete post?',
            body: 'This removes the post and every reply beneath it. Karma locked by replies is returned to their authors. This cannot be undone.',
          });
          if (!ok) return;
          try {
            await actions.deletePost(postId);
            toast('Post deleted.');
            await reload();
          } catch (error) {
            toast(error.message, { error: true });
          }
        }

        if (event.target.closest('[data-follow]')) {
          closeOverlays();
          try {
            if (following) {
              await actions.unfollow(post.author);
              toast(`Unvouched @${identity.handleOf(post.author)}.`);
            } else {
              await actions.follow(post.author);
              toast(`Vouched for @${identity.handleOf(post.author)}.`);
            }
            await reload();
          } catch (error) {
            toast(error.message, { error: true });
          }
        }

        if (event.target.closest('[data-raw]')) {
          closeOverlays();
          showChainRecord(post);
        }
      });
    },
  });
}

/** Show the node's exact JSON for a post — the receipt behind the rendering. */
function showChainRecord(post) {
  const fields = [
    ['Post id', post.id],
    ['Author', post.author],
    ['Status', post.status],
    ['Protocol version', post.protocolVersion],
    ['Timestamp', `${post.timestamp} (${new Date(post.timestamp).toISOString()})`],
    ['PoW nonce', post.powNonce],
    ['Challenge', post.challenge],
    ['Signature', post.signature],
    ['Parent refs', post.parentRefs.length ? post.parentRefs.join('\n') : '— (thread root)'],
    ['Likes', `${post.likeCount ?? 0}`],
  ];

  openModal(html`
    <div class="modal" onclick="event.stopPropagation()">
      <div class="modal-head">
        <button class="icon-button" data-close aria-label="Close">${raw(icon('close', { size: 20 }))}</button>
        <div class="modal-title">Chain record</div>
      </div>
      <div class="panel" style="border:none">
        <p class="hint">Exactly what this node returned for the post — the values its signature and proof of work were computed over.</p>
        ${raw(fields.map(([label, value]) => html`
          <div class="field">
            <label>${label}</label>
            <div class="result"><pre>${String(value)}</pre></div>
          </div>
        `).join(''))}
      </div>
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Account rows (suggestions, follower lists)
// ---------------------------------------------------------------------------

/** A "Who to follow"-style row with a Follow/Following button. */
export function accountRow(authorHex, { meta = null } = {}) {
  const following = store.isFollowing(authorHex);
  const self = identity.isSelf(authorHex);

  return html`
    <div class="sidebar-row" data-account="${authorHex}">
      <img class="avatar" src="${identity.avatarFor(authorHex, 80)}" alt="" width="40" height="40" />
      <div class="sidebar-row-body">
        <div class="sidebar-row-title">${identity.displayNameOf(authorHex)}</div>
        <div class="sidebar-row-meta">@${identity.handleOf(authorHex)}${meta ? ` · ${meta}` : ''}</div>
      </div>
      ${self
        ? raw('<span class="sidebar-row-meta">You</span>')
        : raw(html`<button class="btn ${following ? 'btn-outline' : 'btn-inverse'}" data-follow-toggle="${authorHex}">
            ${following ? 'Following' : 'Follow'}
          </button>`)}
    </div>
  `;
}

/** Latest refresh callback per container — see `bindPostActions` for why. */
const accountRefresh = new WeakMap();

/**
 * Wire follow buttons and account-row navigation on a container.
 *
 * Attaches once per container; later calls only swap the refresh callback, so
 * views that re-render in place can call this from inside their paint step.
 */
export function bindAccountRows(container, refresh) {
  accountRefresh.set(container, refresh);
  if (container.__accountRowsBound) return;
  container.__accountRowsBound = true;

  container.addEventListener('click', async (event) => {
    const toggle = event.target.closest('[data-follow-toggle]');
    if (toggle) {
      event.preventDefault();
      event.stopPropagation();
      const target = toggle.dataset.followToggle;
      const following = store.isFollowing(target);
      toggle.disabled = true;
      try {
        if (following) {
          await actions.unfollow(target);
          toast(`Unvouched @${identity.handleOf(target)}.`);
        } else {
          await actions.follow(target);
          toast(`Vouched for @${identity.handleOf(target)} — this stakes your own standing.`);
        }
        accountRefresh.get(container)?.();
      } catch (error) {
        toast(error.message, { error: true });
        toggle.disabled = false;
      }
      return;
    }

    const row = event.target.closest('[data-account]');
    if (row && !event.target.closest('button')) navigate(`/profile/${row.dataset.account}`);
  });
}
