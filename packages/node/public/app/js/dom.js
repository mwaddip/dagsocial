/**
 * dom.js — small DOM and formatting helpers.
 *
 * Views build HTML strings and assign them; anything interpolated into those
 * strings goes through `esc()`. Post content is user-controlled and unsanitised
 * on the node, so escaping is the only thing standing between a post body and
 * script injection — there is no framework doing it for us.
 */

/** Escape a value for interpolation into HTML text or a quoted attribute. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Tagged template that escapes every interpolation.
 *
 * Arrays are joined without separators so `${items.map(html`...`)}` composes,
 * and values wrapped by `raw()` pass through unescaped for pre-built markup.
 */
export function html(strings, ...values) {
  return strings.reduce((acc, str, i) => {
    if (i === 0) return str;
    const v = values[i - 1];
    let rendered;
    if (v === null || v === undefined || v === false) rendered = '';
    else if (Array.isArray(v)) rendered = v.map((x) => (x?.__raw ? x.value : esc(x))).join('');
    else if (v?.__raw) rendered = v.value;
    else rendered = esc(v);
    return acc + rendered + str;
  }, '');
}

/** Mark a string as already-safe HTML for `html`. */
export const raw = (value) => ({ __raw: true, value: String(value ?? '') });

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * X's timestamp rule: seconds/minutes/hours for the first day, then "12 Mar",
 * then "12 Mar 24" once the year differs.
 */
export function shortTime(ts) {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: '2-digit' }),
  });
}

/** "3:42 PM · 12 Mar 2026" — the focal-post timestamp in a thread. */
export function fullTime(ts) {
  const date = new Date(ts);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return `${time} · ${day}`;
}

/** "Joined March 2026" */
export function joinedDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}


/** X's count abbreviation: 1234 → "1.2K", 1234567 → "1.2M". */
export function compactCount(n) {
  if (!n) return '';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

/** Shorten a 64-char hex id for display: "a3f9c2d1…7b4e". */
export function shortHex(hex, lead = 8, tail = 4) {
  if (!hex || hex.length <= lead + tail + 1) return hex ?? '';
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}

/**
 * Linkify post text: #hashtags, @handles (8+ hex chars) and bare URLs become
 * anchors. Input is escaped first, so the regexes only ever run over safe text
 * and the hrefs they build cannot smuggle markup.
 */
export function renderText(text) {
  const escaped = esc(text);
  return escaped
    .replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
    .replace(/(^|\s)#([\p{L}\p{N}_]{1,50})/gu, (_m, pre, tag) => `${pre}<a href="#/search?q=%23${encodeURIComponent(tag)}">#${tag}</a>`)
    .replace(/(^|\s)@([0-9a-f]{8,64})/g, (_m, pre, id) => `${pre}<a href="#/profile/${id}">@${id.slice(0, 8)}</a>`);
}

/** Extract #hashtags from post text — the raw material for the trends panel. */
export function extractHashtags(text) {
  return [...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_]{1,50})/gu)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toastHost() {
  let host = document.querySelector('.toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  return host;
}

/**
 * X's bottom-centre toast. Returns a handle so long operations can update it.
 *
 * Errors linger longer than confirmations: a failed post usually carries a
 * reason the reader has to act on ("not enough karma"), and four seconds is not
 * enough to read one and decide what to do.
 */
export function toast(message, { error = false, duration = error ? 7000 : 4000 } = {}) {
  const node = document.createElement('div');
  node.className = 'toast' + (error ? ' is-error' : '');
  node.textContent = message;
  toastHost().appendChild(node);

  let timer = duration ? setTimeout(() => node.remove(), duration) : null;

  return {
    update(text, opts = {}) {
      node.textContent = text;
      node.classList.toggle('is-error', Boolean(opts.error));
      if (timer) clearTimeout(timer);
      if (opts.duration !== 0) timer = setTimeout(() => node.remove(), opts.duration ?? duration);
    },
    dismiss() {
      if (timer) clearTimeout(timer);
      node.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Overlays: modals and dropdown menus
// ---------------------------------------------------------------------------

let closeActiveOverlay = null;

/**
 * Show a modal. `markup` is the modal's inner HTML; the returned object exposes
 * `root` (for wiring handlers) and `close()`.
 *
 * Closes on Escape, on a backdrop click, and on any `[data-close]` element.
 */
export function openModal(markup, { onClose } = {}) {
  closeOverlays();

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = markup;
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  const close = () => {
    if (!overlay.isConnected) return;
    overlay.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
    closeActiveOverlay = null;
    onClose?.();
  };

  function onKey(event) {
    if (event.key === 'Escape') close();
  }

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', onKey);
  closeActiveOverlay = close;

  overlay.querySelector('[autofocus]')?.focus();
  return { root: overlay, close };
}

/**
 * Show a dropdown anchored to an element, flipped up or left as needed so it
 * stays on screen.
 */
export function openMenu(anchor, markup) {
  closeOverlays();

  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = markup;
  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const top = rect.bottom + height > window.innerHeight - 8 ? rect.top - height : rect.bottom;
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  const close = () => {
    if (!menu.isConnected) return;
    menu.remove();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('click', onDocClick, true);
    closeActiveOverlay = null;
  };

  function onKey(event) {
    if (event.key === 'Escape') close();
  }
  function onDocClick(event) {
    if (!menu.contains(event.target)) close();
  }

  // Deferred so the click that opened the menu does not immediately close it.
  setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
  document.addEventListener('keydown', onKey);
  closeActiveOverlay = close;

  return { root: menu, close };
}

export function closeOverlays() {
  closeActiveOverlay?.();
}

/** Promise-based confirm styled like X's destructive-action dialog. */
export function confirmDialog({ title, body, confirmLabel = 'Delete', danger = true }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const modal = openModal(
      html`
        <div class="modal modal-sm" onclick="event.stopPropagation()">
          <div class="modal-body">
            <h2>${title}</h2>
            <p>${body}</p>
            <button class="btn ${danger ? 'btn-primary' : 'btn-inverse'} btn-lg btn-block" data-confirm
              style="${danger ? 'background:var(--danger);color:#fff' : ''}">${confirmLabel}</button>
            <div style="height:12px"></div>
            <button class="btn btn-outline btn-lg btn-block" data-close>Cancel</button>
          </div>
        </div>
      `,
      { onClose: () => finish(false) },
    );

    modal.root.querySelector('[data-confirm]').addEventListener('click', () => {
      finish(true);
      modal.close();
    });
  });
}

/** Copy text to the clipboard, falling back for non-secure contexts. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const ok = document.execCommand('copy');
    input.remove();
    return ok;
  }
}

/** Trigger a file download of `content`. */
export function downloadFile(filename, content, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Grow a textarea to fit its content, the way X's composer does. */
export function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}
