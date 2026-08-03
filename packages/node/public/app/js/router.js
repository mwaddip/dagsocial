/**
 * router.js — hash-based routing.
 *
 * Hash routing rather than the History API because the node serves this UI from
 * static files: there is no server-side rewrite, so `/app/profile/abc` would
 * 404 on reload. `#/profile/abc` always resolves to `/app/index.html`, which
 * keeps every link shareable and the back button honest.
 */

/** @type {{ pattern: RegExp, keys: string[], view: Function }[]} */
const routes = [];
let notFound = null;
let onNavigate = null;

/**
 * Register a route.
 *
 * @param {string} path  e.g. `/profile/:id`; `*` matches anything
 * @param {(ctx: { params: object, query: URLSearchParams, path: string }) => void} view
 */
export function route(path, view) {
  if (path === '*') {
    notFound = view;
    return;
  }
  const keys = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:[A-Za-z0-9_]+/g, (match) => {
        keys.push(match.slice(1));
        return '([^/]+)';
      }) +
      '/?$',
  );
  routes.push({ pattern, keys, view });
}

/** Parse the current hash into `{ path, query }`. */
export function current() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  const [path, search = ''] = hash.split('?');
  return { path: path || '/', query: new URLSearchParams(search) };
}

/**
 * Navigate to a path. Replaces the history entry when `replace` is set, which
 * is what a redirect (`/` → `/home`) should do.
 */
export function navigate(path, { replace = false } = {}) {
  const target = '#' + (path.startsWith('/') ? path : '/' + path);
  if (window.location.hash === target) {
    resolve();
    return;
  }
  if (replace) window.history.replaceState(null, '', target);
  else window.location.hash = target;
  if (replace) resolve();
}

export const back = () => window.history.back();

/**
 * Monotonic navigation counter.
 *
 * Views are async: a fetch started by one can resolve after the user has moved
 * on, and writing its result into the column would clobber whatever view owns
 * it now. Each mount gets the token of its navigation and checks `isCurrent`
 * before touching the DOM after an await.
 */
let epoch = 0;

/** True while `token` still identifies the view on screen. */
export const isCurrent = (token) => token === epoch;

/** Match the current hash and invoke its view. */
export function resolve() {
  const { path, query } = current();
  const token = ++epoch;

  for (const { pattern, keys, view } of routes) {
    const match = path.match(pattern);
    if (!match) continue;
    const params = Object.fromEntries(keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
    onNavigate?.(path);
    view({ params, query, path, token });
    return;
  }
  onNavigate?.(path);
  notFound?.({ params: {}, query, path, token });
}

/**
 * Start routing. `hooks.onNavigate` fires before every view, which is how the
 * nav highlights the active item and the column scrolls back to the top.
 */
export function start(hooks = {}) {
  onNavigate = hooks.onNavigate ?? null;
  window.addEventListener('hashchange', resolve);
  resolve();
}
