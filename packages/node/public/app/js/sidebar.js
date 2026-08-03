/**
 * sidebar.js — the right-hand column: search, chain status, trends, suggestions.
 *
 * X fills this space with trends and follow suggestions computed server-side.
 * There is no such endpoint here, so both are derived in the browser from the
 * timeline the node already returned: trends are the most-used hashtags,
 * suggestions are the most active authors the active identity has not vouched
 * for. Both are honest about their sample size.
 */
import { html, raw, compactCount } from './dom.js';
import { icon } from './icons.js';
import * as store from './store.js';
import { navigate } from './router.js';
import { accountRow, bindAccountRows } from './views/common.js';
import { sidebarRoot } from './shell.js';

function chainCard() {
  const status = store.state.status;
  if (!status) {
    return html`
      <section class="sidebar-card">
        <h2>Chain</h2>
        <div class="sidebar-row"><div class="sidebar-row-meta">Node unreachable.</div></div>
      </section>
    `;
  }

  // Only fields `GET /status` actually returns — it reports no account count.
  const rows = [
    ['Block height', compactCount(status.blockHeight) || '0'],
    ['Posts', `${compactCount(status.postCount) || '0'} confirmed · ${status.pendingPosts} pending`],
    ['Karma in circulation', compactCount(status.totalKarma) || '0'],
    ['Credits in circulation', compactCount(status.totalCredits) || '0'],
  ];

  return html`
    <section class="sidebar-card">
      <h2>Chain</h2>
      ${raw(rows.map(([label, value]) => html`
        <div class="sidebar-row">
          <div class="sidebar-row-body">
            <div class="sidebar-row-meta">${label}</div>
            <div class="sidebar-row-title">${value}</div>
          </div>
        </div>
      `).join(''))}
      <button class="sidebar-more" data-go="/wallet">Your karma and credits</button>
    </section>
  `;
}

function trendsCard(posts) {
  const items = store.trends(posts, 5);
  return html`
    <section class="sidebar-card">
      <h2>What's happening</h2>
      ${items.length === 0
        ? raw(html`<div class="sidebar-row"><div class="sidebar-row-meta">
            No hashtags in the latest ${posts.length} posts yet.
          </div></div>`)
        : raw(items.map((item, index) => html`
            <button class="sidebar-row" data-search="#${item.tag}">
              <div class="sidebar-row-body">
                <div class="sidebar-row-meta">Trending · ${index + 1}</div>
                <div class="sidebar-row-title">#${item.tag}</div>
                <div class="sidebar-row-meta">${item.count} ${item.count === 1 ? 'post' : 'posts'}</div>
              </div>
            </button>
          `).join(''))}
      <button class="sidebar-more" data-go="/explore">Show more</button>
    </section>
  `;
}

function suggestionsCard(posts) {
  const items = store.suggestions(posts, 3);
  if (items.length === 0) return '';
  return html`
    <section class="sidebar-card">
      <h2>Who to follow</h2>
      ${raw(items.map((item) => accountRow(item.author, {
        meta: `${item.posts} ${item.posts === 1 ? 'post' : 'posts'} recently`,
      })).join(''))}
      <button class="sidebar-more" data-go="/explore">Show more</button>
    </section>
  `;
}

function footer() {
  return html`
    <div class="sidebar-footer">
      <a href="../">Demo UI</a>
      <a href="https://github.com/mwaddip/notis" target="_blank" rel="noopener noreferrer">Source</a>
      <span>Following = vouching</span>
      <span>© Notis</span>
    </div>
  `;
}

/**
 * Render the sidebar.
 *
 * @param {object[]} posts    the timeline used to derive trends and suggestions
 * @param {object} [opts]
 * @param {boolean} [opts.showSearch]  hidden on Explore, which owns the search field
 */
export function renderSidebar(posts = store.state.posts, { showSearch = true } = {}) {
  const root = sidebarRoot();
  if (!root) return;

  root.innerHTML = html`
    ${showSearch
      ? raw(html`
          <div class="sidebar-search">
            <label class="search-field">
              ${raw(icon('search', { size: 18 }))}
              <input type="search" placeholder="Search Notis" data-search-input aria-label="Search Notis" />
            </label>
          </div>
        `)
      : ''}
    ${raw(chainCard())}
    ${raw(trendsCard(posts))}
    ${raw(suggestionsCard(posts))}
    ${raw(footer())}
  `;

  const input = root.querySelector('[data-search-input]');
  input?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const query = input.value.trim();
    if (query) navigate(`/search?q=${encodeURIComponent(query)}`);
  });

  // The sidebar element outlives its contents, so navigation is delegated once.
  if (!root.__sidebarBound) {
    root.__sidebarBound = true;
    root.addEventListener('click', (event) => {
      const search = event.target.closest('[data-search]');
      if (search) navigate(`/search?q=${encodeURIComponent(search.dataset.search)}`);
      const go = event.target.closest('[data-go]');
      if (go) navigate(go.dataset.go);
    });
  }

  bindAccountRows(root, () => renderSidebar(posts, { showSearch }));
}
