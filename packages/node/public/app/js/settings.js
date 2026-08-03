/**
 * settings.js — X's Display settings: theme, accent colour, font size.
 *
 * All three are attributes on `<html>` so the whole cascade re-themes with no
 * re-render, and all three persist per browser. `applyAppearance()` runs before
 * first paint (see index.html) so there is no flash of the wrong theme.
 */
import { html, raw, openModal } from './dom.js';
import { icon } from './icons.js';
import * as store from './store.js';

const KEY = 'notis-x-appearance';

const THEMES = [
  { id: 'default', label: 'Default', dot: '#ffffff' },
  { id: 'dim', label: 'Dim', dot: '#15202b' },
  { id: 'lightsout', label: 'Lights out', dot: '#000000' },
];

const ACCENTS = [
  { id: 'blue', color: '#1d9bf0' },
  { id: 'yellow', color: '#ffd400' },
  { id: 'pink', color: '#f91880' },
  { id: 'purple', color: '#7856ff' },
  { id: 'orange', color: '#ff7a00' },
  { id: 'green', color: '#00ba7c' },
];

const FONT_SIZES = ['xs', 'sm', 'md', 'lg', 'xl'];

const DEFAULTS = { theme: 'lightsout', accent: 'blue', font: 'md' };

export function readAppearance() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Write the appearance attributes onto `<html>`. */
export function applyAppearance(next = readAppearance()) {
  const root = document.documentElement;
  root.dataset.theme = next.theme;
  root.dataset.accent = next.accent;
  root.dataset.font = next.font;
  // Keeps the browser's own UI (form controls, scrollbars) in step.
  root.style.colorScheme = next.theme === 'default' ? 'light' : 'dark';
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

function update(patch) {
  return applyAppearance({ ...readAppearance(), ...patch });
}

export function openSettings() {
  const current = readAppearance();

  const modal = openModal(html`
    <div class="modal modal-sm" onclick="event.stopPropagation()">
      <div class="modal-head">
        <button class="icon-button" data-close aria-label="Close">${raw(icon('close', { size: 20 }))}</button>
        <div class="modal-title">Display</div>
      </div>
      <div class="panel" style="border:none">
        <p class="hint">Manage the font size, colour and background. These settings affect this browser only.</p>

        <div class="field">
          <label>Font size</label>
          <div class="row" style="justify-content:space-between">
            <span style="font-size:13px">Aa</span>
            <input type="range" min="0" max="4" step="1" value="${FONT_SIZES.indexOf(current.font)}"
              data-font style="flex:1;margin:0 12px" />
            <span style="font-size:20px">Aa</span>
          </div>
        </div>

        <div class="field">
          <label>Colour</label>
          <div class="accent-grid">
            ${raw(ACCENTS.map((accent) => html`
              <button class="accent-swatch" data-accent="${accent.id}" style="background:${accent.color}"
                aria-label="${accent.id}" aria-pressed="${accent.id === current.accent}">
                ${accent.id === current.accent ? raw(icon('check', { size: 20 })) : ''}
              </button>
            `).join(''))}
          </div>
        </div>

        <div class="field">
          <label>Background</label>
          <div class="theme-grid">
            ${raw(THEMES.map((theme) => html`
              <button class="theme-swatch" data-theme="${theme.id}" role="radio"
                aria-checked="${theme.id === current.theme}"
                style="background:${theme.dot};color:${theme.id === 'default' ? '#0f1419' : '#e7e9ea'}">
                <span class="theme-dot" style="background:${theme.dot}"></span>${theme.label}
              </button>
            `).join(''))}
          </div>
        </div>

        ${raw(nodeInfo())}
      </div>
    </div>
  `);

  const root = modal.root;

  root.querySelectorAll('[data-theme]').forEach((el) => {
    el.addEventListener('click', () => {
      update({ theme: el.dataset.theme });
      root.querySelectorAll('[data-theme]').forEach((other) =>
        other.setAttribute('aria-checked', String(other === el)),
      );
    });
  });

  root.querySelectorAll('[data-accent]').forEach((el) => {
    el.addEventListener('click', () => {
      update({ accent: el.dataset.accent });
      root.querySelectorAll('[data-accent]').forEach((other) => {
        const selected = other === el;
        other.setAttribute('aria-pressed', String(selected));
        other.innerHTML = selected ? icon('check', { size: 20 }) : '';
      });
    });
  });

  root.querySelector('[data-font]').addEventListener('input', (event) => {
    update({ font: FONT_SIZES[Number(event.target.value)] ?? 'md' });
  });
}

/** The node this UI is talking to — useful enough to keep one click away. */
function nodeInfo() {
  const status = store.state.status;
  if (!status) return '<p class="hint">Node status unavailable.</p>';
  return html`
    <div class="field">
      <label>Node</label>
      <div class="result">
        Network <b>${status.networkMode}</b> · block height <b>${status.blockHeight}</b> ·
        <b>${status.postCount}</b> confirmed posts, <b>${status.pendingPosts}</b> pending
      </div>
    </div>
  `;
}
