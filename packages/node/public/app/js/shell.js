/**
 * shell.js — the persistent frame: left navigation, the view column, the right
 * sidebar, and the mobile bottom bar.
 *
 * The shell renders once and then only patches: the active nav item, the
 * notification badge, and the account button. Views own the column between
 * them and are free to re-render it at will.
 */
import { html, raw, openMenu, openModal, closeOverlays, toast, downloadFile, confirmDialog } from './dom.js';
import { icon } from './icons.js';
import * as identity from './identity.js';
import * as store from './store.js';
import { navigate } from './router.js';
import { openComposerModal } from './composer.js';
import { openSettings } from './settings.js';

/** Nav items in X's order. `wallet` replaces X's Premium slot. */
const NAV_ITEMS = [
  { id: 'home', path: '/home', label: 'Home', icon: 'home' },
  { id: 'explore', path: '/explore', label: 'Explore', icon: 'search' },
  { id: 'notifications', path: '/notifications', label: 'Notifications', icon: 'notifications' },
  { id: 'messages', path: '/messages', label: 'Messages', icon: 'messages' },
  { id: 'bookmarks', path: '/bookmarks', label: 'Bookmarks', icon: 'bookmark' },
  { id: 'wallet', path: '/wallet', label: 'Wallet', icon: 'wallet' },
  { id: 'profile', path: '/profile', label: 'Profile', icon: 'profile' },
];

/** The subset that fits a phone's bottom bar. */
const BOTTOM_ITEMS = ['home', 'explore', 'notifications', 'bookmarks', 'profile'];

let unreadBadge = 0;

function navItem(item, { compact = false } = {}) {
  const badge =
    item.id === 'notifications' && unreadBadge
      ? html`<span class="nav-badge">${unreadBadge > 99 ? '99+' : unreadBadge}</span>`
      : '';
  return html`
    <a class="nav-item" href="#${item.path}" data-nav="${item.id}" aria-label="${item.label}">
      <span data-nav-icon>${raw(icon(item.icon, { size: 26 }))}</span>
      ${compact ? '' : raw(html`<span class="nav-label">${item.label}</span>`)}
      ${raw(badge)}
    </a>
  `;
}

function shellMarkup() {
  return html`
    <div class="app">
      <header class="nav">
        <div class="nav-inner">
          <a class="nav-logo" href="#/home" aria-label="Notis home">${raw(icon('logo', { size: 30 }))}</a>
          <nav class="nav-items">
            ${raw(NAV_ITEMS.map((item) => navItem(item)).join(''))}
            <button class="nav-item" data-more aria-label="More">
              ${raw(icon('more', { size: 26 }))}
              <span class="nav-label">More</span>
            </button>
          </nav>
          <button class="nav-post" data-compose aria-label="Post">
            ${raw(icon('compose', { size: 24 }))}
            <span class="nav-post-label">Post</span>
          </button>
          <button class="nav-account" data-account-switcher>
            <img class="avatar" data-account-avatar src="" alt="" width="40" height="40" />
            <span class="nav-account-text">
              <span class="nav-account-name" data-account-name></span><br />
              <span class="nav-account-handle" data-account-handle></span>
            </span>
            <span class="nav-label">${raw(icon('more', { size: 18 }))}</span>
          </button>
        </div>
      </header>

      <main class="main" id="view"></main>

      <aside class="sidebar" id="sidebar"></aside>
    </div>

    <nav class="bottom-bar">
      ${raw(NAV_ITEMS.filter((i) => BOTTOM_ITEMS.includes(i.id)).map((i) => navItem(i, { compact: true })).join(''))}
      <!-- The left rail is hidden at this width, and with it the only route to
           Wallet, Settings and the demo UI. This keeps them reachable. -->
      <button class="nav-item" data-more aria-label="More">${raw(icon('more', { size: 26 }))}</button>
    </nav>
    <button class="fab" data-compose aria-label="Post">${raw(icon('compose', { size: 24 }))}</button>
  `;
}

export const viewRoot = () => document.getElementById('view');
export const sidebarRoot = () => document.getElementById('sidebar');

/** Render the shell into `#app` and wire its persistent controls. */
export function mountShell() {
  const app = document.getElementById('app');
  app.innerHTML = shellMarkup();

  app.addEventListener('click', (event) => {
    if (event.target.closest('[data-compose]')) {
      openComposerModal({ onPublished: () => navigate('/home') });
    }
    if (event.target.closest('[data-account-switcher]')) {
      openAccountSwitcher(event.target.closest('[data-account-switcher]'));
    }
    if (event.target.closest('[data-more]')) {
      openMoreMenu(event.target.closest('[data-more]'));
    }
  });

  document.querySelector('.bottom-bar').addEventListener('click', (event) => {
    const link = event.target.closest('[data-nav]');
    if (link?.dataset.nav === 'profile') {
      event.preventDefault();
      navigate(`/profile/${identity.userId()}`);
    }
  });

  refreshAccountButton();
  store.subscribe(refreshAccountButton);
}

/** Highlight the nav item matching the current path. */
export function setActiveNav(path) {
  const active =
    NAV_ITEMS.find((item) => path === item.path || path.startsWith(item.path + '/'))?.id ??
    (path === '/' ? 'home' : null);

  document.querySelectorAll('[data-nav]').forEach((el) => {
    const isActive = el.dataset.nav === active;
    el.toggleAttribute('aria-current', isActive);
    if (isActive) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');

    const item = NAV_ITEMS.find((i) => i.id === el.dataset.nav);
    const holder = el.querySelector('[data-nav-icon]');
    if (item && holder) holder.innerHTML = icon(item.icon, { size: 26, filled: isActive });
  });

  // The Profile link needs the active account baked in.
  document.querySelectorAll('[data-nav="profile"]').forEach((el) => {
    el.setAttribute('href', `#/profile/${identity.userId() ?? ''}`);
  });
}

export function setUnreadBadge(count) {
  unreadBadge = count;
  document.querySelectorAll('[data-nav="notifications"]').forEach((el) => {
    el.querySelector('.nav-badge')?.remove();
    if (!count) return;
    const badge = document.createElement('span');
    badge.className = 'nav-badge';
    badge.textContent = count > 99 ? '99+' : String(count);
    el.appendChild(badge);
  });
}

function refreshAccountButton() {
  const me = identity.userId();
  const avatar = document.querySelector('[data-account-avatar]');
  if (avatar) avatar.src = identity.avatarFor(me, 80);
  const name = document.querySelector('[data-account-name]');
  if (name) name.textContent = identity.displayNameOf(me);
  const handle = document.querySelector('[data-account-handle]');
  if (handle) handle.textContent = '@' + identity.handleOf(me);
}

// ---------------------------------------------------------------------------
// Account switcher
// ---------------------------------------------------------------------------

function openAccountSwitcher(anchor) {
  const active = identity.activeIdentityIndex();
  const rows = identity.listIdentities().map((hex, index) => html`
    <button class="menu-item" data-switch="${index}">
      <img class="avatar avatar-sm" src="${identity.avatarFor(hex, 64)}" alt="" width="32" height="32" />
      <span style="flex:1;min-width:0">
        <span style="display:block">${identity.displayNameOf(hex)}</span>
        <span class="sidebar-row-meta">@${identity.handleOf(hex)}</span>
      </span>
      ${index === active ? raw(icon('check', { size: 18 })) : ''}
    </button>
  `);

  const menu = openMenu(anchor, html`
    ${raw(rows.join(''))}
    <div class="menu-sep"></div>
    <button class="menu-item" data-new>${raw(icon('plus', { size: 18 }))} Create a new account</button>
    <button class="menu-item" data-import>${raw(icon('key', { size: 18 }))} Add an existing account</button>
    <button class="menu-item" data-export>${raw(icon('download', { size: 18 }))} Export the active key</button>
    <div class="menu-sep"></div>
    <button class="menu-item is-danger" data-forget>${raw(icon('trash', { size: 18 }))} Forget the active key</button>
  `);

  menu.root.addEventListener('click', async (event) => {
    const switchTo = event.target.closest('[data-switch]');
    if (switchTo) {
      closeOverlays();
      await identity.activate(Number(switchTo.dataset.switch));
      await store.refreshIdentityScoped();
      navigate('/home');
      return;
    }

    if (event.target.closest('[data-new]')) {
      closeOverlays();
      await identity.createIdentity();
      await store.refreshIdentityScoped();
      toast('New account created. It starts with no karma — use the faucet on testnet.');
      navigate(`/profile/${identity.userId()}`);
    }

    if (event.target.closest('[data-import]')) {
      closeOverlays();
      openImportDialog();
    }

    if (event.target.closest('[data-export]')) {
      closeOverlays();
      const json = identity.exportActive();
      if (!json) return;
      downloadFile(`notis-identity-${identity.handleOf(identity.userId())}.json`, json);
      toast('Key exported. Anyone holding this file controls the account.');
    }

    if (event.target.closest('[data-forget]')) {
      closeOverlays();
      const ok = await confirmDialog({
        title: 'Forget this key?',
        body: 'The private key is erased from this browser. If you have not exported it, the account and any karma it holds are gone for good.',
        confirmLabel: 'Forget key',
      });
      if (!ok) return;
      await identity.removeIdentity(identity.activeIdentityIndex());
      await store.refreshIdentityScoped();
      toast('Key forgotten.');
      navigate('/home');
    }
  });
}

function openImportDialog() {
  const modal = openModal(html`
    <div class="modal modal-sm" onclick="event.stopPropagation()">
      <div class="modal-head">
        <button class="icon-button" data-close aria-label="Close">${raw(icon('close', { size: 20 }))}</button>
        <div class="modal-title">Add an existing account</div>
      </div>
      <div class="modal-body">
        <p>Choose an identity file exported from this UI or from the demo UI.</p>
        <input type="file" accept="application/json,.json" data-file />
      </div>
    </div>
  `);

  modal.root.querySelector('[data-file]').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await identity.importIdentity(await file.text());
      await store.refreshIdentityScoped();
      closeOverlays();
      toast('Account added.');
      navigate(`/profile/${identity.userId()}`);
    } catch (error) {
      toast(error.message, { error: true });
    }
  });
}

// ---------------------------------------------------------------------------
// "More" menu
// ---------------------------------------------------------------------------

function openMoreMenu(anchor) {
  const menu = openMenu(anchor, html`
    <button class="menu-item" data-go="/wallet">${raw(icon('wallet', { size: 18 }))} Wallet &amp; invites</button>
    <button class="menu-item" data-settings>${raw(icon('settings', { size: 18 }))} Settings &amp; privacy</button>
    <div class="menu-sep"></div>
    <a class="menu-item" href="../" style="color:inherit">${raw(icon('analytics', { size: 18 }))} Open the demo UI</a>
  `);

  menu.root.addEventListener('click', (event) => {
    const go = event.target.closest('[data-go]');
    if (go) {
      closeOverlays();
      navigate(go.dataset.go);
    }
    if (event.target.closest('[data-settings]')) {
      closeOverlays();
      openSettings();
    }
  });
}
