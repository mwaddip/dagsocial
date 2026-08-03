/**
 * views/notifications.js — likes, replies and vouches aimed at you.
 *
 * The node has no notification feed, so this view derives one: it reads the
 * liker list on your posts, scans the recent timeline for replies naming one of
 * your posts, and lists the vouches whose target is you. That means it sees as
 * far back as one page of the timeline and no further — the view says so rather
 * than implying it is complete.
 */
import { html, raw, shortTime } from '../dom.js';
import { icon } from '../icons.js';
import * as identity from '../identity.js';
import * as store from '../store.js';
import { viewRoot, setUnreadBadge } from '../shell.js';
import { navigate, isCurrent } from '../router.js';
import { renderSidebar } from '../sidebar.js';
import { header, tabStrip, bindTabs, loading, emptyState, errorState, bindTimeline } from './common.js';

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'mentions', label: 'Replies' },
  { id: 'likes', label: 'Likes' },
];

const KIND_ICON = {
  like: { name: 'like', filled: true, color: 'var(--like)' },
  reply: { name: 'reply', filled: false, color: 'var(--accent)' },
  follow: { name: 'profile', filled: true, color: 'var(--repost)' },
};

function renderNotification(item) {
  const glyph = KIND_ICON[item.kind];
  const actorName = identity.displayNameOf(item.actor);
  const handle = identity.handleOf(item.actor);

  const line =
    item.kind === 'like'
      ? html`<b>${actorName}</b> liked your post`
      : item.kind === 'reply'
        ? html`<b>${actorName}</b> replied to your post`
        : html`<b>${actorName}</b> vouched for you${item.block ? ` at block ${item.block}` : ''}`;

  const target = item.kind === 'follow' ? `/profile/${item.actor}` : `/post/${item.postId}`;

  return html`
    <article class="notification" data-open="${target}">
      <div class="notification-icon" style="color:${glyph.color}">
        ${raw(icon(glyph.name, { filled: glyph.filled, size: 30 }))}
      </div>
      <div class="notification-body">
        <img class="avatar avatar-sm" src="${identity.avatarFor(item.actor, 64)}" alt="" width="32" height="32" />
        <div class="notification-text">
          ${raw(line)}
          <span class="post-handle">@${handle}</span>
          ${item.sortKey ? raw(html`<span class="post-dot">·</span><span class="post-handle">${shortTime(item.sortKey)}</span>`) : ''}
        </div>
        ${item.text ? raw(html`<div class="notification-detail">${item.text}</div>`) : ''}
      </div>
    </article>
  `;
}

export async function mount({ query, token }) {
  const root = viewRoot();
  const tab = TABS.some((t) => t.id === query.get('tab')) ? query.get('tab') : 'all';

  root.innerHTML =
    header({ title: 'Notifications' }) + tabStrip(TABS, tab) + `<div id="notifications">${loading()}</div>`;
  window.scrollTo(0, 0);

  bindTabs(root, (id) => navigate(id === 'all' ? '/notifications' : `/notifications?tab=${id}`));

  const container = () => root.querySelector('#notifications');

  try {
    const items = await store.buildNotifications();
    if (!isCurrent(token) || !container()) return;
    const filtered =
      tab === 'mentions' ? items.filter((i) => i.kind === 'reply')
      : tab === 'likes' ? items.filter((i) => i.kind === 'like')
      : items;

    if (filtered.length === 0) {
      container().innerHTML = emptyState(
        'Nothing to see here — yet',
        tab === 'all'
          ? 'When someone likes your post, replies to it, or vouches for you, it shows up here.'
          : `No ${tab === 'likes' ? 'likes' : 'replies'} yet.`,
      );
    } else {
      container().innerHTML =
        filtered.map(renderNotification).join('') +
        html`<div class="sidebar-footer" style="justify-content:center">
          Derived from the latest ${store.PAGE_SIZE} posts on this node — older activity is not shown.
        </div>`;
    }

    store.markNotificationsSeen();
    setUnreadBadge(0);
    renderSidebar(store.state.posts);
  } catch (error) {
    if (!isCurrent(token) || !container()) return;
    container().innerHTML = errorState(error.message);
    container().querySelector('[data-retry]')?.addEventListener('click', () => mount({ query, token }));
  }

  container().addEventListener('click', (event) => {
    const item = event.target.closest('[data-open]');
    if (item) navigate(item.dataset.open);
  });

  bindTimeline(root, { repaint: () => mount({ query, token }) });
}

/** Refresh the nav badge without navigating — called on a timer from app.js. */
export async function refreshBadge() {
  try {
    const items = await store.buildNotifications();
    setUnreadBadge(store.unreadCount(items));
  } catch {
    // Badge accuracy is not worth surfacing an error for.
  }
}
