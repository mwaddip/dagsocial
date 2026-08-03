/**
 * composer.js — X's composer, inline at the top of the timeline and as a modal.
 *
 * The character ring counts **UTF-8 bytes against `MAX_CONTENT_BYTES`**, not
 * characters: the protocol's limit is a byte limit, so an emoji costs four and
 * the ring has to say so or the node would reject a post the UI called valid.
 *
 * Publishing mines proof of work on the main thread. At the difficulties a node
 * hands out this is imperceptible, but the button still enters a progress state
 * and reports each stage, because the wait is unbounded in principle.
 */
import { html, raw, autoGrow, toast, openModal, closeOverlays } from './dom.js';
import { icon } from './icons.js';
import * as identity from './identity.js';
import * as chain from './chain.js';
import * as actions from './actions.js';
import { renderQuote } from './postcard.js';

/** Toolbar affordances X shows that the protocol has no representation for. */
const UNSUPPORTED_TOOLS = [
  ['media', 'Images are not part of the post format — posts are 1–300 bytes of text'],
  ['gif', 'GIFs are not part of the post format'],
  ['poll', 'Polls are not part of the post format'],
  ['emoji', 'No emoji picker — type emoji directly (each costs ~4 of the 300 bytes)'],
  ['schedule', 'Scheduling would need a post to be held off-chain until its time'],
];

function meterRing(bytes) {
  const max = chain.MAX_CONTENT_BYTES;
  const ratio = Math.min(bytes / max, 1);
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const remaining = max - bytes;
  const near = remaining <= 40;
  const over = remaining < 0;

  return html`
    <div class="meter-ring ${over ? 'is-over' : near ? 'is-warning' : ''}">
      <svg width="24" height="24" viewBox="0 0 24 24">
        <circle class="meter-track" cx="12" cy="12" r="${radius}"></circle>
        <circle class="meter-value" cx="12" cy="12" r="${radius}"
          stroke-dasharray="${circumference}"
          stroke-dashoffset="${circumference * (1 - ratio)}"
          stroke-linecap="round"></circle>
      </svg>
    </div>
    ${near || over
      ? raw(html`<span class="meter-count ${over ? 'is-over' : ''}">${remaining}</span>`)
      : ''}
  `;
}

/**
 * Render a composer.
 *
 * @param {object} [opts]
 * @param {'post'|'reply'|'quote'} [opts.mode]
 * @param {object} [opts.target]     the post being replied to or quoted
 * @param {boolean} [opts.isModal]
 */
export function renderComposer({ mode = 'post', target = null, isModal = false } = {}) {
  const me = identity.userId();
  const placeholder =
    mode === 'reply' ? 'Post your reply' : mode === 'quote' ? 'Add a comment' : "What's happening?";
  const submitLabel = mode === 'reply' ? 'Reply' : 'Post';
  const lockCost = mode === 'post' ? chain.POST_LOCK_THREAD_COST : chain.POST_LOCK_REPLY_COST;

  return html`
    <div class="composer ${isModal ? 'is-modal' : ''}" data-composer data-mode="${mode}"
      data-target="${target?.id ?? ''}">
      <img class="avatar" src="${identity.avatarFor(me, 80)}" alt="" width="40" height="40" />
      <div class="composer-body">
        ${mode === 'reply' && target
          ? raw(html`<div class="composer-reply-to">Replying to
              <a href="#/profile/${target.author}">@${identity.handleOf(target.author)}</a>
            </div>`)
          : ''}

        <textarea class="composer-input" data-input rows="1" placeholder="${placeholder}"
          maxlength="600" ${isModal ? raw('autofocus') : ''}></textarea>

        ${mode === 'quote' && target ? raw(renderQuote(target)) : ''}

        <div class="composer-audience" title="Every post is public — the DAG has no private posts">
          ${raw(icon('search', { size: 14 }))} Everyone
        </div>

        <div class="composer-actions">
          ${raw(UNSUPPORTED_TOOLS.map(([name, why]) =>
            html`<button class="composer-tool" disabled title="${why}">${raw(icon(name, { size: 20 }))}</button>`,
          ).join(''))}

          <div class="composer-meter">
            <span data-meter>${raw(meterRing(0))}</span>
            <span class="divider-v"></span>
            <button class="btn btn-primary" data-submit disabled
              title="Locks ${lockCost} karma until the epoch tally">${submitLabel}</button>
          </div>
        </div>
        <div class="mining" data-progress hidden style="padding:8px 0 0;border:none"></div>
      </div>
    </div>
  `;
}

/**
 * Wire a rendered composer.
 *
 * @param {HTMLElement} root      element containing `[data-composer]`
 * @param {(result: object) => void} [onPublished]
 */
export function bindComposer(root, onPublished) {
  const composer = root.querySelector('[data-composer]');
  if (!composer) return;

  const input = composer.querySelector('[data-input]');
  const submit = composer.querySelector('[data-submit]');
  const meter = composer.querySelector('[data-meter]');
  const progress = composer.querySelector('[data-progress]');
  const mode = composer.dataset.mode;
  const targetId = composer.dataset.target || null;

  const sync = () => {
    const bytes = chain.utf8Length(input.value.trim());
    meter.innerHTML = meterRing(bytes);
    submit.disabled = bytes === 0 || bytes > chain.MAX_CONTENT_BYTES;
    autoGrow(input);
  };

  input.addEventListener('input', sync);

  // ⌘/Ctrl+Enter publishes, matching X.
  input.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !submit.disabled) {
      event.preventDefault();
      submit.click();
    }
  });

  submit.addEventListener('click', async () => {
    const content = input.value.trim();
    const parentRefs = targetId ? [targetId] : [];

    submit.disabled = true;
    progress.hidden = false;
    const setStage = (stage) => {
      progress.innerHTML = html`<span class="spinner"></span><span>${stage}…</span>`;
    };
    setStage('Preparing');

    try {
      const result = await actions.publishPost(content, parentRefs, setStage);
      input.value = '';
      sync();
      progress.hidden = true;
      progress.innerHTML = '';
      toast(
        result.status === 'confirmed'
          ? 'Your post was published.'
          : 'Your post was published — waiting for a block.',
      );
      onPublished?.(result);
    } catch (error) {
      progress.hidden = true;
      progress.innerHTML = '';
      toast(error.message, { error: true });
      submit.disabled = false;
    }
  });

  sync();
}

/** Open the composer as a modal (the "Post" button and the reply/quote flows). */
export function openComposerModal({ mode = 'post', target = null, onPublished } = {}) {
  const modal = openModal(html`
    <div class="modal" onclick="event.stopPropagation()">
      <div class="modal-head">
        <button class="icon-button" data-close aria-label="Close">${raw(icon('close', { size: 20 }))}</button>
      </div>
      ${raw(renderComposer({ mode, target, isModal: true }))}
    </div>
  `);

  bindComposer(modal.root, (result) => {
    closeOverlays();
    onPublished?.(result);
  });

  modal.root.querySelector('[data-input]')?.focus();
  return modal;
}
