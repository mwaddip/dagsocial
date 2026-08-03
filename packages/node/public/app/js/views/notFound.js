/**
 * views/notFound.js — the 404 page for an unrecognised hash route.
 */
import { html, raw } from '../dom.js';
import { viewRoot } from '../shell.js';
import { navigate, current } from '../router.js';
import { header } from './common.js';

export async function mount() {
  const root = viewRoot();
  root.innerHTML = html`
    ${raw(header({ title: 'Not found', back: true }))}
    <div class="empty-state" style="padding-top:64px">
      <h2>Hmm… this page doesn’t exist</h2>
      <p>Nothing is routed at <code>${current().path}</code>. Try searching for something else.</p>
      <button class="btn btn-inverse btn-lg" data-go-home>Go home</button>
    </div>
  `;
  root.querySelector('[data-go-home]').addEventListener('click', () => navigate('/home'));
  root.querySelector('[data-back]')?.addEventListener('click', () => window.history.back());
}
