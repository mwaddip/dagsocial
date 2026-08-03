/**
 * views/explore.js — Explore and search.
 *
 * The node has no search endpoint, so search runs over the timeline page it
 * does serve: a substring match on post text, plus account-id and handle
 * prefixes. That is a real search over real posts, but only over the most
 * recent page, and the view says so instead of pretending otherwise.
 */
import { html, raw } from '../dom.js';
import { icon } from '../icons.js';
import * as identity from '../identity.js';
import * as store from '../store.js';
import { viewRoot } from '../shell.js';
import { navigate, isCurrent } from '../router.js';
import { renderSidebar } from '../sidebar.js';
import { header, tabStrip, bindTabs, loading, emptyState, errorState, renderTimeline, bindTimeline, accountRow, bindAccountRows } from './common.js';

const TABS = [
  { id: 'top', label: 'Top' },
  { id: 'latest', label: 'Latest' },
  { id: 'people', label: 'People' },
];

function searchBar(value) {
  return html`
    <div class="header">
      <div class="header-row">
        <label class="search-field" style="flex:1">
          ${raw(icon('search', { size: 18 }))}
          <input type="search" data-q value="${value}" placeholder="Search Notis" aria-label="Search Notis" />
        </label>
      </div>
    </div>
  `;
}

/** Match a post against a query: `#tag`, `@handle`/account id, or free text. */
function matches(post, query) {
  const q = query.toLowerCase();
  if (q.startsWith('@')) return post.author.toLowerCase().startsWith(q.slice(1));
  return (
    post.content.toLowerCase().includes(q) ||
    post.author.toLowerCase().startsWith(q) ||
    identity.displayNameOf(post.author).toLowerCase().includes(q)
  );
}

export async function mount({ query, token }) {
  const root = viewRoot();
  const term = (query.get('q') ?? '').trim();
  const tab = TABS.some((t) => t.id === query.get('tab')) ? query.get('tab') : 'top';

  root.innerHTML = searchBar(term) + (term ? tabStrip(TABS, tab) : '') + `<div id="explore">${loading()}</div>`;
  window.scrollTo(0, 0);

  const input = root.querySelector('[data-q]');
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const next = input.value.trim();
    navigate(next ? `/search?q=${encodeURIComponent(next)}` : '/explore');
  });

  bindTabs(root, (id) => navigate(`/search?q=${encodeURIComponent(term)}&tab=${id}`));

  const container = () => root.querySelector('#explore');

  let posts = [];
  try {
    posts = await store.fetchPosts({ limit: store.PAGE_SIZE });
  } catch (error) {
    if (!isCurrent(token) || !container()) return;
    container().innerHTML = errorState(error.message);
    container().querySelector('[data-retry]')?.addEventListener('click', () => mount({ query, token }));
    return;
  }

  function paint() {
    if (!isCurrent(token) || !container()) return;
    container().innerHTML = term ? renderResults() : renderDiscover();
    renderSidebar(posts, { showSearch: false });
    bindAccountRows(container(), paint);
  }

  function renderResults() {
    const hits = posts.filter((post) => matches(post, term));

    if (tab === 'people') {
      const authors = [...new Set(hits.map((p) => p.author))];
      return authors.length
        ? authors.map((hex) => accountRow(hex)).join('') + scopeNote()
        : emptyState('No people found', `No account in the latest ${posts.length} posts matches “${term}”.`);
    }

    const ordered =
      tab === 'latest'
        ? [...hits].sort((a, b) => b.timestamp - a.timestamp)
        : [...hits].sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0) || b.timestamp - a.timestamp);

    return ordered.length
      ? renderTimeline(ordered) + scopeNote()
      : emptyState(
          `No results for “${term}”`,
          `Nothing in the latest ${posts.length} posts on this node matches. Search covers that page only.`,
        );
  }

  function renderDiscover() {
    const trends = store.trends(posts, 10);
    const suggestions = store.suggestions(posts, 5);

    return html`
      ${raw(tabStrip([{ id: 'trending', label: 'Trending' }], 'trending'))}
      <section>
        <div class="panel">
          <h2>Trends</h2>
          <p class="hint">Hashtags in the latest ${posts.length} posts on this node.</p>
        </div>
        ${trends.length === 0
          ? raw(emptyState('No trends yet', 'Post something with a #hashtag and it will show up here.'))
          : raw(trends.map((item, index) => html`
              <button class="sidebar-row" data-search-tag="${item.tag}" style="border-bottom:1px solid var(--border)">
                <div class="sidebar-row-body">
                  <div class="sidebar-row-meta">Trending · ${index + 1}</div>
                  <div class="sidebar-row-title">#${item.tag}</div>
                  <div class="sidebar-row-meta">${item.count} ${item.count === 1 ? 'post' : 'posts'}</div>
                </div>
              </button>
            `).join(''))}
      </section>
      ${suggestions.length
        ? raw(html`
            <section>
              <div class="panel"><h2>Who to follow</h2>
                <p class="hint">Active accounts you do not vouch for yet. Following here means vouching — it stakes your standing on them.</p>
              </div>
              ${raw(suggestions.map((s) => accountRow(s.author, { meta: `${s.posts} recent ${s.posts === 1 ? 'post' : 'posts'}` })).join(''))}
            </section>
          `)
        : ''}
    `;
  }

  const scopeNote = () => html`
    <div class="sidebar-footer" style="justify-content:center">
      Searched the latest ${posts.length} posts on this node.
    </div>
  `;

  // The fetch above may have outlived this view; anything below touches the DOM.
  if (!isCurrent(token) || !container()) return;

  paint();

  container().addEventListener('click', (event) => {
    const tag = event.target.closest('[data-search-tag]');
    if (tag) navigate(`/search?q=${encodeURIComponent('#' + tag.dataset.searchTag)}`);
  });

  bindTimeline(root, { repaint: paint, reload: () => mount({ query, token }) });
}
