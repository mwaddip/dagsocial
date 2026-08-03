/**
 * app.js — boot and routing table.
 *
 * Views are loaded lazily so the first paint only pays for the timeline; the
 * wallet's invite machinery and the settings panel arrive when asked for.
 */
import { toast } from './dom.js';
import { applyAppearance } from './settings.js';
import * as identity from './identity.js';
import * as store from './store.js';
import { mountShell, setActiveNav, viewRoot } from './shell.js';
import { route, start, navigate, current } from './router.js';

/** How often to re-check the notification badge and node status. */
const BADGE_POLL_MS = 30000;

/** Cleanup returned by the view currently on screen (timers, listeners). */
let disposeCurrentView = null;

/**
 * Wrap a lazily-imported view so route changes tear the previous one down.
 * A view may return a cleanup function; anything else is ignored.
 */
function view(load) {
  return async (ctx) => {
    try {
      disposeCurrentView?.();
    } catch {
      // A failing teardown must not block the next view.
    }
    disposeCurrentView = null;

    try {
      const module = await load();
      const cleanup = await module.mount(ctx);
      if (typeof cleanup === 'function') disposeCurrentView = cleanup;
    } catch (error) {
      console.error('View failed:', error);
      viewRoot().innerHTML =
        '<div class="empty-state"><h2>This page failed to load</h2>' +
        `<p>${error.message}</p></div>`;
    }
  };
}

async function boot() {
  applyAppearance();

  try {
    await identity.init();
  } catch (error) {
    document.getElementById('app').innerHTML =
      '<div class="empty-state" style="margin-top:20vh"><h2>Cannot start</h2>' +
      `<p>${error.message}</p><p>Ed25519 in WebCrypto is required — try a current Chrome, Firefox or Safari.</p></div>`;
    return;
  }

  mountShell();

  // Kick off the first data load, but do not block the first paint on it.
  store.init().catch(() => toast('Cannot reach the node.', { error: true }));

  route('/', () => navigate('/home', { replace: true }));
  route('/home', view(() => import('./views/home.js')));
  route('/explore', view(() => import('./views/explore.js')));
  route('/search', view(() => import('./views/explore.js')));
  route('/notifications', view(() => import('./views/notifications.js')));
  route('/messages', view(() => import('./views/messages.js')));
  route('/bookmarks', view(() => import('./views/bookmarks.js')));
  route('/wallet', view(() => import('./views/wallet.js')));
  route('/post/:id', view(() => import('./views/thread.js')));
  route('/profile', () => navigate(`/profile/${identity.userId()}`, { replace: true }));
  route('/profile/:id', view(() => import('./views/profile.js')));
  route('*', view(() => import('./views/notFound.js')));

  start({ onNavigate: setActiveNav });

  // The demo UI links posts as `?post=<id>`; honour that shape here too so a
  // link copied from either client opens in either client.
  const legacyPostId = new URLSearchParams(window.location.search).get('post');
  if (legacyPostId && current().path === '/home') navigate(`/post/${legacyPostId}`, { replace: true });

  const { refreshBadge } = await import('./views/notifications.js');
  refreshBadge();
  setInterval(() => {
    if (document.hidden) return;
    refreshBadge();
    store.refreshStatus();
  }, BADGE_POLL_MS);
}

boot();
