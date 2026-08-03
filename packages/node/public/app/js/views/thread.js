/**
 * views/thread.js — a single post with its conversation.
 *
 * The node returns a thread as `{ post, ancestors, descendants }`: ancestors
 * are a straight line from the root down to the immediate parent, descendants
 * are the whole subtree. Ancestors render above the focal post joined by a
 * rail, descendants below in reply order — X's conversation layout.
 */
import { html, raw } from '../dom.js';
import * as store from '../store.js';
import { viewRoot } from '../shell.js';
import { navigate, back, isCurrent } from '../router.js';
import { renderSidebar } from '../sidebar.js';
import { renderFocalPost, renderPost } from '../postcard.js';
import { renderComposer, bindComposer } from '../composer.js';
import { header, loading, errorState, bindTimeline } from './common.js';

/**
 * Order a descendant set into reply-tree order (depth-first, oldest first) and
 * mark which rows need a connecting rail above or below.
 */
function orderDescendants(descendants, focalId) {
  const childrenOf = new Map();
  for (const post of descendants) {
    for (const parentId of post.parentRefs) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId).push(post);
    }
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.timestamp - b.timestamp);

  const known = new Set(descendants.map((p) => p.id));
  const rows = [];
  const seen = new Set();

  const walk = (post, isChild) => {
    if (seen.has(post.id)) return;
    seen.add(post.id);
    const kids = childrenOf.get(post.id) ?? [];
    rows.push({ post, railAbove: isChild, railBelow: kids.length > 0 });
    for (const kid of kids) walk(kid, true);
  };

  // Direct replies first; then any descendant whose parents are all off-set, so
  // a reply to a pruned post still appears instead of vanishing.
  for (const post of childrenOf.get(focalId) ?? []) walk(post, false);
  for (const post of descendants) {
    if (!seen.has(post.id) && !post.parentRefs.some((ref) => known.has(ref))) walk(post, false);
  }
  return rows;
}

export async function mount({ params, token }) {
  const root = viewRoot();
  const postId = params.id;

  root.innerHTML =
    header({ title: 'Post', back: true }) + `<div id="thread">${loading()}</div>`;
  window.scrollTo(0, 0);

  root.querySelector('[data-back]')?.addEventListener('click', () => back());

  const container = () => root.querySelector('#thread');

  async function load() {
    let thread;
    try {
      thread = await store.fetchThread(postId);
    } catch (error) {
      if (!isCurrent(token) || !container()) return;
      container().innerHTML = errorState(
        error.status === 404 ? 'This post does not exist on this node, or it has been deleted.' : error.message,
        { retry: error.status !== 404 },
      );
      container().querySelector('[data-retry]')?.addEventListener('click', load);
      return;
    }

    if (!isCurrent(token) || !container()) return;

    if (!thread.post) {
      container().innerHTML = errorState('This post has no content on this node.', { retry: false });
      return;
    }

    const ancestors = thread.ancestors ?? [];
    const rows = orderDescendants(thread.descendants ?? [], thread.post.id);

    container().innerHTML = html`
      ${raw(ancestors.map((post) => renderPost(post, { railBelow: true, showQuote: false })).join(''))}
      ${raw(renderFocalPost(thread.post))}
      ${raw(renderComposer({ mode: 'reply', target: thread.post }))}
      ${rows.length === 0
        ? raw(html`<div class="empty-state" style="padding:24px 16px">
            <p style="margin:0">No replies yet. Replying locks 3 karma until the epoch tally.</p>
          </div>`)
        : raw(rows.map(({ post, railAbove, railBelow }) =>
            renderPost(post, { railAbove, railBelow, showQuote: false }),
          ).join(''))}
    `;

    bindComposer(container(), () => load());
    renderSidebar(store.state.posts);
  }

  bindTimeline(root, { repaint: load, reload: load });
  await load();
}
