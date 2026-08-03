/**
 * views/messages.js — the Messages slot.
 *
 * X's DMs have no counterpart here: every post in the DAG is public and signed,
 * and there is no encrypted-envelope type to carry a private one. Rather than
 * fake an inbox with browser-local "messages" that could never reach anyone,
 * this view says what is missing and what it would take.
 */
import { html, raw } from '../dom.js';
import { icon } from '../icons.js';
import { viewRoot } from '../shell.js';
import { navigate } from '../router.js';
import { renderSidebar } from '../sidebar.js';
import * as store from '../store.js';
import { header } from './common.js';

export async function mount() {
  const root = viewRoot();

  root.innerHTML = html`
    ${raw(header({ title: 'Messages' }))}
    <div class="empty-state" style="padding-top:64px">
      <div style="color:var(--text-secondary);margin-bottom:16px">${raw(icon('messages', { size: 40 }))}</div>
      <h2>Direct messages are not part of the protocol</h2>
      <p>
        Every post in the DAG is public and signed by its author, and the wire format has no encrypted
        envelope to carry a private one. Supporting DMs would mean a new message type and a key-exchange
        scheme — a protocol change, not a client feature.
      </p>
      <p>
        Until then, the closest thing to a private channel is an invite: its secret is generated in your
        browser, committed on-chain only as a hash, and shared out of band.
      </p>
      <button class="btn btn-inverse btn-lg" data-go-wallet>Create an invite</button>
    </div>
  `;
  window.scrollTo(0, 0);

  root.querySelector('[data-go-wallet]').addEventListener('click', () => navigate('/wallet'));
  renderSidebar(store.state.posts);
}
