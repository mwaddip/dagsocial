/**
 * views/profile.js — an account page.
 *
 * The protocol stores no profile: an account is a public key and the posts it
 * signed. So the header is assembled from what the chain does know — the key
 * itself, its karma and credits, its vouches in both directions, and the age of
 * its oldest post — with the name and avatar derived from the key.
 */
import { html, raw, toast, copyText, openModal, closeOverlays, joinedDate, compactCount, shortHex } from '../dom.js';
import { icon } from '../icons.js';
import * as api from '../api.js';
import * as identity from '../identity.js';
import * as store from '../store.js';
import * as actions from '../actions.js';
import { viewRoot } from '../shell.js';
import { navigate, back, isCurrent } from '../router.js';
import { renderSidebar } from '../sidebar.js';
import { header, tabStrip, bindTabs, loading, emptyState, errorState, renderTimeline, bindTimeline, accountRow, bindAccountRows } from './common.js';

const TABS = [
  { id: 'posts', label: 'Posts' },
  { id: 'replies', label: 'Replies' },
  { id: 'likes', label: 'Likes' },
];

export async function mount({ params, query, token }) {
  const root = viewRoot();
  const accountId = params.id;
  const tab = TABS.some((t) => t.id === query.get('tab')) ? query.get('tab') : 'posts';
  const isMe = identity.isSelf(accountId);

  if (!/^[0-9a-f]{64}$/i.test(accountId)) {
    root.innerHTML =
      header({ title: 'Profile', back: true }) +
      errorState('That is not a valid account id. An account id is 64 hex characters.', { retry: false });
    root.querySelector('[data-back]')?.addEventListener('click', () => back());
    return;
  }

  root.innerHTML = header({ title: identity.displayNameOf(accountId), back: true }) + loading();
  root.querySelector('[data-back]')?.addEventListener('click', () => back());
  window.scrollTo(0, 0);

  // Everything the chain can tell us about this account, fetched together.
  const [authored, karma, credits, followers, following, timelineSample] = await Promise.all([
    store.fetchPosts({ author: accountId, limit: store.PAGE_SIZE }).catch(() => []),
    api.getKarma(accountId).catch(() => ({ total: 0 })),
    api.getCredits(accountId).catch(() => ({ total: 0 })),
    api.getVouchesForTarget(accountId).catch(() => ({ vouches: [] })),
    api.getVouchesByVoucher(accountId).catch(() => ({ vouches: [] })),
    store.fetchPosts({ limit: store.PAGE_SIZE }).catch(() => []),
  ]);

  const oldest = authored.reduce((min, p) => Math.min(min, p.timestamp), Infinity);
  const followerIds = (followers.vouches ?? []).map((v) => v.voucherId);
  const followingIds = (following.vouches ?? []).map((v) => v.targetId);

  function tabPosts() {
    if (tab === 'posts') return authored.filter((p) => p.parentRefs.length === 0);
    if (tab === 'replies') return authored.filter((p) => p.parentRefs.length > 0);
    return timelineSample.filter((p) => (p.likers ?? []).includes(accountId));
  }

  function followButton() {
    if (isMe) return html`<button class="btn btn-outline" data-edit-profile>Edit profile</button>`;
    const isFollowing = store.isFollowing(accountId);
    return html`<button class="btn ${isFollowing ? 'btn-outline' : 'btn-inverse'}" data-follow-toggle="${accountId}">
      ${isFollowing ? 'Following' : 'Follow'}
    </button>`;
  }

  function profileHeader() {
    return html`
      <div class="profile-banner" style="background:${identity.bannerFor(accountId)}"></div>
      <div class="profile-head">
        <div class="profile-avatar-row">
          <img class="avatar avatar-lg" src="${identity.avatarFor(accountId, 266)}" alt="" />
          <div class="row" style="padding-top:12px">
            <button class="icon-button" style="border:1px solid var(--border-strong)" data-copy-key
              aria-label="Copy account id">${raw(icon('key', { size: 18 }))}</button>
            ${raw(followButton())}
          </div>
        </div>

        <div class="profile-name">
          ${identity.displayNameOf(accountId)}
          ${store.isFollowing(accountId) ? raw(html`<span class="badge-verified" title="You vouch for this account">${raw(icon('verified', { size: 20 }))}</span>`) : ''}
        </div>
        <div class="profile-handle">@${identity.handleOf(accountId)}</div>

        <div class="profile-bio">
          ${isMe && identity.hasNicknameOverride(accountId)
            ? 'Your display name is overridden in this browser. Everyone else sees the name derived from your key.'
            : 'Name and avatar are derived from this account’s public key — the protocol stores no profile.'}
        </div>

        <div class="profile-meta">
          <span class="key-pill" title="${accountId}">${raw(icon('key', { size: 12 }))} ${shortHex(accountId, 16, 8)}</span>
          ${Number.isFinite(oldest)
            ? raw(html`<span>${raw(icon('schedule', { size: 16 }))} Joined ${joinedDate(oldest)}</span>`)
            : ''}
        </div>

        <div class="profile-stats">
          <button data-show="following"><b>${compactCount(followingIds.length) || 0}</b> Following</button>
          <button data-show="followers"><b>${compactCount(followerIds.length) || 0}</b> ${followerIds.length === 1 ? 'Voucher' : 'Vouchers'}</button>
          <span><b>${compactCount(karma.total) || 0}</b> Karma</span>
          <span><b>${compactCount(credits.total) || 0}</b> Credits</span>
        </div>
      </div>
    `;
  }

  function paint() {
    // Every field below came from requests that may have outlived this view.
    if (!isCurrent(token)) return;
    const posts = tabPosts();
    root.innerHTML = html`
      ${raw(header({
        title: identity.displayNameOf(accountId),
        subtitle: `${authored.length} ${authored.length === 1 ? 'post' : 'posts'}`,
        back: true,
      }))}
      ${raw(profileHeader())}
      ${raw(tabStrip(TABS, tab))}
      <div id="profile-timeline">
        ${posts.length === 0 ? raw(emptyTab()) : raw(renderTimeline(posts, { showQuote: tab !== 'posts' }))}
      </div>
    `;

    root.querySelector('[data-back]')?.addEventListener('click', () => back());
    bindTabs(root, (id) => navigate(`/profile/${accountId}?tab=${id}`));

    root.querySelector('[data-copy-key]')?.addEventListener('click', async () => {
      toast((await copyText(accountId)) ? 'Account id copied.' : 'Could not copy.');
    });

    root.querySelector('[data-edit-profile]')?.addEventListener('click', openEditProfile);

    root.querySelectorAll('[data-show]').forEach((el) => {
      el.addEventListener('click', () =>
        showAccountList(el.dataset.show === 'followers' ? followerIds : followingIds, el.dataset.show),
      );
    });

    bindAccountRows(root, paint);
    renderSidebar(timelineSample);
  }

  function emptyTab() {
    if (tab === 'posts') {
      return emptyState(
        isMe ? 'You have not posted yet' : 'No posts yet',
        isMe
          ? 'Your posts will appear here. A thread root locks 5 karma until the epoch tally.'
          : 'When this account posts, it will show up here.',
      );
    }
    if (tab === 'replies') {
      return emptyState('No replies yet', 'Replies this account has published will appear here.');
    }
    return emptyState(
      'No likes found',
      `Likes are read off each post's liker list, so this covers the latest ${timelineSample.length} posts on this node rather than all history.`,
    );
  }

  function showAccountList(ids, kind) {
    const title = kind === 'followers' ? 'Vouchers' : 'Vouching for';
    const modal = openModal(html`
      <div class="modal modal-sm" onclick="event.stopPropagation()">
        <div class="modal-head">
          <button class="icon-button" data-close aria-label="Close">${raw(icon('close', { size: 20 }))}</button>
          <div class="modal-title">${title}</div>
        </div>
        <div>
          ${ids.length === 0
            ? raw(html`<div class="panel" style="border:none"><p class="hint">
                ${kind === 'followers' ? 'No one vouches for this account yet.' : 'This account vouches for no one yet.'}
              </p></div>`)
            : raw(ids.map((id) => accountRow(id)).join(''))}
        </div>
      </div>
    `);
    bindAccountRows(modal.root, () => {});
    modal.root.addEventListener('click', (event) => {
      if (event.target.closest('[data-account]') && !event.target.closest('button')) closeOverlays();
    });
  }

  function openEditProfile() {
    const modal = openModal(html`
      <div class="modal modal-sm" onclick="event.stopPropagation()">
        <div class="modal-head">
          <button class="icon-button" data-close aria-label="Close">${raw(icon('close', { size: 20 }))}</button>
          <div class="modal-title">Edit profile</div>
        </div>
        <div class="panel" style="border:none">
          <p class="hint">
            The protocol has no profile record, so a display name cannot be published. This name is
            stored in this browser only — everyone else sees the name derived from your key
            (<b>${identity.displayNameOf(accountId, { derivedOnly: true })}</b>).
          </p>
          <div class="field">
            <label for="nickname">Display name</label>
            <input id="nickname" data-nickname maxlength="50" autofocus
              value="${identity.hasNicknameOverride(accountId) ? identity.displayNameOf(accountId) : ''}"
              placeholder="${identity.displayNameOf(accountId, { derivedOnly: true })}" />
          </div>
          <div class="row">
            <button class="btn btn-inverse" data-save>Save</button>
            <button class="btn btn-outline" data-reset>Use derived name</button>
          </div>
        </div>
      </div>
    `);

    const input = modal.root.querySelector('[data-nickname]');
    modal.root.querySelector('[data-save]').addEventListener('click', () => {
      identity.setNickname(accountId, input.value);
      closeOverlays();
      store.emit();
      paint();
      toast('Display name saved in this browser.');
    });
    modal.root.querySelector('[data-reset]').addEventListener('click', () => {
      identity.setNickname(accountId, '');
      closeOverlays();
      store.emit();
      paint();
      toast('Using the name derived from your key.');
    });
  }

  paint();
  bindTimeline(root, { repaint: paint, reload: () => mount({ params, query, token }) });
}
