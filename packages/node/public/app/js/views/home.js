/**
 * views/home.js — the timeline.
 *
 * "For you" is every post the node knows about, newest first. "Following" is
 * the same feed narrowed to accounts the active identity vouches for, which is
 * as close to a follow graph as the protocol gets.
 *
 * The list is flat, like X's: a reply carries the post it answers as an
 * embedded card rather than being nested, so the timeline stays scannable and
 * the thread view stays the place where structure is shown.
 */
import { html, raw, toast } from '../dom.js';
import { icon } from '../icons.js';
import * as identity from '../identity.js';
import * as store from '../store.js';
import { renderSidebar } from '../sidebar.js';
import { viewRoot } from '../shell.js';
import { navigate, isCurrent } from '../router.js';
import { renderComposer, bindComposer } from '../composer.js';
import { header, tabStrip, bindTabs, loading, emptyState, errorState, renderTimeline, bindTimeline } from './common.js';

/** How often to check for posts newer than the ones on screen. */
const POLL_MS = 15000;

export async function mount({ query, token }) {
  const root = viewRoot();
  const tab = query.get('tab') === 'following' ? 'following' : 'foryou';
  let posts = [];
  let timer = null;
  let newerCount = 0;
  /**
   * True once this view is no longer the one on screen. A poll or a load
   * already in flight will still resolve after that point, and must not write
   * into a column another view now owns.
   */
  const disposed = () => !isCurrent(token);

  const chrome = () => html`
    ${raw(header({
      title: 'Home',
      trailing: html`<button class="icon-button" data-refresh aria-label="Refresh">${raw(icon('spark', { size: 20 }))}</button>`,
    }))}
    ${raw(tabStrip([{ id: 'foryou', label: 'For you' }, { id: 'following', label: 'Following' }], tab))}
    ${raw(renderComposer())}
    <div id="timeline">${raw(loading())}</div>
  `;

  root.innerHTML = chrome();
  root.scrollIntoView({ block: 'start' });

  const timeline = () => root.querySelector('#timeline');

  function visiblePosts() {
    if (tab !== 'following') return posts;
    const me = identity.userId();
    return posts.filter((post) => store.isFollowing(post.author) || post.author === me);
  }

  function paint() {
    if (disposed() || !timeline()) return;
    const list = visiblePosts();
    const pill = newerCount
      ? html`<button class="new-posts-pill" data-show-new>Show ${newerCount} ${newerCount === 1 ? 'post' : 'posts'}</button>`
      : '';

    if (list.length === 0) {
      timeline().innerHTML =
        tab === 'following'
          ? emptyState(
              'Your Following feed is empty',
              store.state.following.size === 0
                ? 'You are not vouching for anyone yet. Vouching is this network’s follow: it stakes your standing on an account. Find someone in Explore.'
                : 'The accounts you vouch for have not posted in the latest page of the timeline.',
              '<button class="btn btn-inverse btn-lg" data-go-explore>Explore</button>',
            )
          : emptyState(
              'Nothing here yet',
              'No posts on this node. Write the first one — a thread root locks 5 karma until the epoch tally.',
            );
    } else {
      timeline().innerHTML = pill + renderTimeline(list);
    }

    timeline().querySelector('[data-show-new]')?.addEventListener('click', () => {
      newerCount = 0;
      load();
    });
    timeline().querySelector('[data-go-explore]')?.addEventListener('click', () => navigate('/explore'));

    renderSidebar(posts);
  }

  async function load() {
    if (disposed()) return;
    try {
      posts = await store.refreshFeed();
      newerCount = 0;
      paint();
    } catch (error) {
      if (disposed() || !timeline()) return;
      timeline().innerHTML = errorState(error.message);
      timeline().querySelector('[data-retry]')?.addEventListener('click', load);
    }
  }

  /**
   * Poll for posts newer than the newest on screen. New posts are announced
   * with a pill rather than injected, so the list never jumps under a reader —
   * the same choice X makes.
   */
  async function poll() {
    if (disposed() || document.hidden) return;
    try {
      const latest = await store.fetchPosts({ limit: store.PAGE_SIZE });
      const newestShown = posts[0]?.timestamp ?? 0;
      const fresh = latest.filter((p) => p.timestamp > newestShown).length;
      if (disposed()) return;
      if (fresh !== newerCount) {
        newerCount = fresh;
        paint();
      }
      await store.refreshStatus();
    } catch {
      // A failed poll is not worth surfacing; the next one may succeed.
    }
  }

  bindTabs(root, (id) => navigate(id === 'following' ? '/home?tab=following' : '/home'));
  bindComposer(root, () => load());
  bindTimeline(root, { repaint: paint, reload: load });
  root.querySelector('[data-refresh]')?.addEventListener('click', () => {
    load();
    toast('Timeline refreshed.');
  });

  await load();
  timer = setInterval(poll, POLL_MS);

  return () => clearInterval(timer);
}
