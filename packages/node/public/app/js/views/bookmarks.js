/**
 * views/bookmarks.js — saved posts.
 *
 * The protocol has no bookmark record, so this list is ids in localStorage.
 * Posts are re-fetched from the node on every visit, which means a bookmarked
 * post that has since been deleted disappears here too rather than lingering as
 * a stale copy.
 */
import { html, raw, toast, confirmDialog } from '../dom.js';
import { icon } from '../icons.js';
import * as api from '../api.js';
import * as identity from '../identity.js';
import * as store from '../store.js';
import { viewRoot } from '../shell.js';
import { navigate, isCurrent } from '../router.js';
import { renderSidebar } from '../sidebar.js';
import { header, loading, emptyState, renderTimeline, bindTimeline } from './common.js';

export async function mount({ token } = {}) {
  const root = viewRoot();

  const chrome = () => header({
    title: 'Bookmarks',
    subtitle: `@${identity.handleOf(identity.userId())}`,
    trailing: html`<button class="icon-button" data-clear aria-label="Clear bookmarks">${raw(icon('more', { size: 20 }))}</button>`,
  });

  root.innerHTML = chrome() + `<div id="bookmarks">${loading()}</div>`;
  window.scrollTo(0, 0);

  const container = () => root.querySelector('#bookmarks');

  async function load() {
    const ids = store.bookmarkIds();
    if (ids.length === 0) {
      if (!container()) return;
      container().innerHTML = emptyState(
        'Save posts for later',
        'Bookmark a post and it lands here. Bookmarks live in this browser only — the protocol has no bookmark record, so they do not follow your key to another device.',
      );
      renderSidebar(store.state.posts);
      return;
    }

    // Settled, not all: one deleted post should not empty the whole list.
    const results = await Promise.allSettled(ids.map((id) => api.getPost(id)));
    const posts = results
      .filter((r) => r.status === 'fulfilled' && r.value && 'content' in r.value)
      .map((r) => r.value);
    for (const post of posts) store.state.postsById.set(post.id, post);

    if (!isCurrent(token) || !container()) return;

    const missing = ids.length - posts.length;
    container().innerHTML =
      renderTimeline(posts) +
      (missing
        ? html`<div class="sidebar-footer" style="justify-content:center">
            ${missing} bookmarked ${missing === 1 ? 'post is' : 'posts are'} no longer on this node.
          </div>`
        : '');

    renderSidebar(store.state.posts);
  }

  root.querySelector('[data-clear]')?.addEventListener('click', async () => {
    if (store.bookmarkIds().length === 0) return;
    const ok = await confirmDialog({
      title: 'Clear all Bookmarks?',
      body: 'This removes every bookmark from this browser. The posts themselves are untouched.',
      confirmLabel: 'Clear',
    });
    if (!ok) return;
    store.clearBookmarks();
    toast('Bookmarks cleared.');
    load();
  });

  bindTimeline(root, { repaint: load, reload: load });
  await load();
}
