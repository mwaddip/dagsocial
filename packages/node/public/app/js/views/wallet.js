/**
 * views/wallet.js — karma, credits and invites.
 *
 * X has no equivalent surface; Notis needs one, because karma is what pays for
 * posting and liking and an invite is how a new account gets any. This view
 * carries the whole of the demo UI's admin panel so nothing is lost by using
 * this client instead: faucets, credit transfer, and the full invite lifecycle.
 *
 * The faucets only exist on a testnet node, and the view hides them on mainnet
 * exactly as the node refuses them.
 */
import { html, raw, toast, copyText, shortHex } from '../dom.js';
import * as api from '../api.js';
import * as chain from '../chain.js';
import * as identity from '../identity.js';
import * as store from '../store.js';
import * as actions from '../actions.js';
import { viewRoot } from '../shell.js';
import { renderSidebar } from '../sidebar.js';
import { isCurrent } from '../router.js';
import { header, loading } from './common.js';

/** Remember an issued invite so the secret survives a re-render. */
let lastInvite = null;

function setResult(element, markup, kind = '') {
  if (!element) return;
  element.className = 'result' + (kind ? ` is-${kind}` : '');
  element.innerHTML = markup;
}

/**
 * Run an async handler with button disabling and uniform error reporting.
 *
 * `resultSelector` is re-queried rather than captured, because a successful
 * handler reloads balances and repaints the panel — a captured element would be
 * detached by the time the outcome is written to it.
 *
 * Successes are announced by toast, which survives the repaint; the result
 * block carries progress text and errors, which do not need to.
 */
async function withButton(button, resultSelector, busyText, run) {
  const result = () => document.querySelector(resultSelector);
  button.disabled = true;
  setResult(result(), busyText);
  try {
    await run((text) => setResult(result(), text));
    setResult(result(), '');
  } catch (error) {
    setResult(result(), error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

/**
 * Balances are re-read on this interval.
 *
 * A karma box is consumed and re-minted whenever it is touched — by the epoch
 * tally, by decay, by any transaction that spends it — and there is a moment in
 * between when the node has no live box to report. A wallet that read once
 * would latch onto whatever it saw, including that gap.
 */
const BALANCE_POLL_MS = 10000;

export async function mount({ token } = {}) {
  const root = viewRoot();
  root.innerHTML = header({ title: 'Wallet' }) + `<div id="wallet">${loading()}</div>`;
  window.scrollTo(0, 0);

  const container = () => root.querySelector('#wallet');

  async function load() {
    await Promise.all([store.refreshStatus(), store.refreshBalances()]);
    const invites = await api.getInviteState(identity.userId()).catch(() => ({ pending: [], bonds: [] }));
    paint(invites);
  }

  /** Re-read balances without disturbing anything the user has typed. */
  async function poll() {
    if (document.hidden) return;
    if (container()?.querySelector('input:focus, button:disabled')) return;
    await load();
  }

  function paint(invites) {
    if (!isCurrent(token) || !container()) return;
    container().innerHTML = html`
      ${raw(balancePanel())}
      ${store.isTestnet() ? raw(faucetPanel()) : raw(mainnetNotice())}
      ${raw(transferPanel())}
      ${raw(invitePanel(invites))}
    `;
    wire(invites);
    renderSidebar(store.state.posts);
  }

  // -- Panels -------------------------------------------------------------

  function balancePanel() {
    const { karma, credits } = store.state;
    return html`
      <div class="panel">
        <h2>Balances</h2>
        <p class="hint">
          Karma is non-tradeable and pays for activity: ${chain.POST_LOCK_THREAD_COST} locked per thread,
          ${chain.POST_LOCK_REPLY_COST} per reply, ${chain.LIKE_COST} per like. Locked karma is returned at
          the epoch tally, never burned. Credits are tradeable.
        </p>
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label">Karma</div>
            <div class="stat-value">${karma.total}</div>
            <div class="stat-label">${karma.boxes.length} ${karma.boxes.length === 1 ? 'box' : 'boxes'}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Credits</div>
            <div class="stat-value">${credits.total}</div>
            <div class="stat-label">${credits.boxes.length} ${credits.boxes.length === 1 ? 'box' : 'boxes'}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Block height</div>
            <div class="stat-value">${store.height()}</div>
            <div class="stat-label">${store.state.status?.networkMode ?? 'unknown'}</div>
          </div>
        </div>
        <div class="field field-mono">
          <label>Your account id</label>
          <div class="row">
            <input readonly value="${identity.userId() ?? ''}" style="flex:1" />
            <button class="btn btn-outline" data-copy-id>Copy</button>
          </div>
        </div>
      </div>
    `;
  }

  function mainnetNotice() {
    return html`
      <div class="panel">
        <h2>Faucets</h2>
        <p class="hint">
          This node runs in mainnet mode, so it refuses faucet requests. Karma arrives by redeeming an
          invite or by earning it at the epoch tally.
        </p>
      </div>
    `;
  }

  function faucetPanel() {
    return html`
      <div class="panel">
        <h2>Faucets</h2>
        <p class="hint">Testnet only. Both mint from the system account, so they move the chain's totals.</p>
        <div class="field">
          <label for="karma-amount">Karma</label>
          <div class="row">
            <input id="karma-amount" type="number" min="1" max="1000" value="100" style="width:120px" />
            <button class="btn btn-inverse" data-karma-faucet>Grant karma</button>
          </div>
        </div>
        <div class="result" data-karma-result></div>
        <div class="field" style="margin-top:16px">
          <label>Credits</label>
          <button class="btn btn-inverse" data-credit-faucet>Grant 1000 credits</button>
        </div>
        <div class="result" data-credit-result></div>
      </div>
    `;
  }

  function transferPanel() {
    return html`
      <div class="panel">
        <h2>Send credits</h2>
        <p class="hint">Signed here and submitted to the node; locked boxes are skipped automatically.</p>
        <div class="field field-mono">
          <label for="recipient">Recipient account id (64 hex characters)</label>
          <input id="recipient" data-recipient placeholder="0000…" />
        </div>
        <div class="row">
          <input type="number" min="1" value="10" data-amount style="width:120px" />
          <button class="btn btn-inverse" data-send>Send</button>
        </div>
        <div class="result" data-send-result></div>
      </div>
    `;
  }

  function invitePanel(invites) {
    const pending = invites.pending ?? [];
    const cost = chain.INVITE_KARMA_AMOUNT + chain.INVITE_BOND_KARMA;

    return html`
      <div class="panel">
        <h2>Invites</h2>
        <p class="hint">
          An invite costs ${cost} karma: ${chain.INVITE_KARMA_AMOUNT} gifted to the invitee and
          ${chain.INVITE_BOND_KARMA} held as a bond that stays at risk for
          ${chain.INVITE_PROBATION_BLOCKS} blocks. Cancel an unclaimed invite to get both back.
        </p>

        <button class="btn btn-inverse" data-create-invite>Create invite</button>
        <div class="result" data-invite-result>${raw(lastInvite ? inviteDetails(lastInvite) : '')}</div>

        ${pending.length
          ? raw(html`
              <div class="field" style="margin-top:16px">
                <label>Your pending invites</label>
                ${raw(pending.map((box) => html`
                  <div class="row" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
                    <span class="key-pill">${shortHex(box.id, 12, 6)}</span>
                    <span class="sidebar-row-meta">${box.value} karma</span>
                    <button class="btn btn-danger" data-cancel-invite="${box.id}">Cancel</button>
                  </div>
                `).join(''))}
              </div>
              <div class="result" data-cancel-result></div>
            `)
          : ''}

        <div class="field" style="margin-top:24px">
          <label>Redeem an invite</label>
          <p class="hint">
            Two on-chain steps: commit proves you know the secret, then reveal publishes it once the
            commit is in a block. The wait between them is a block, not a spinner.
          </p>
        </div>
        <div class="field field-mono"><label for="invite-box">Invite box id</label><input id="invite-box" data-invite-box /></div>
        <div class="field field-mono"><label for="bond-box">Bond box id</label><input id="bond-box" data-bond-box /></div>
        <div class="field field-mono"><label for="inviter">Inviter account id</label><input id="inviter" data-inviter /></div>
        <div class="field field-mono"><label for="secret">Secret</label><input id="secret" data-secret /></div>
        <button class="btn btn-inverse" data-redeem>Redeem</button>
        <div class="result" data-redeem-result></div>
      </div>
    `;
  }

  function inviteDetails(invite) {
    const rows = [
      ['Invite box id', invite.inviteBoxId],
      ['Bond box id', invite.bondBoxId],
      ['Inviter account id', invite.inviterId],
      ['Secret — send this privately', invite.secretHex],
    ];
    return html`
      <div class="is-ok" style="margin-bottom:8px">Invite created. Send the four values below to your invitee.</div>
      ${raw(rows.map(([label, value]) => html`
        <div class="field"><label>${label}</label><pre>${value}</pre></div>
      `).join(''))}
      <button class="btn btn-outline" data-copy-invite>Copy all</button>
    `;
  }

  // -- Wiring -------------------------------------------------------------

  function wire(invites) {
    const root = container();
    const q = (selector) => root.querySelector(selector);

    q('[data-copy-id]')?.addEventListener('click', async () => {
      toast((await copyText(identity.userId())) ? 'Account id copied.' : 'Could not copy.');
    });

    q('[data-karma-faucet]')?.addEventListener('click', (event) =>
      withButton(event.currentTarget, '[data-karma-result]', 'Requesting…', async () => {
        const amount = Number(q('#karma-amount').value) || 100;
        const result = await actions.requestKarmaFaucet(amount);
        toast(
          result.status === 'pending'
            ? `Granted ${amount} karma — waiting for a block.`
            : `Granted ${amount} karma.`,
        );
        await load();
      }),
    );

    q('[data-credit-faucet]')?.addEventListener('click', (event) =>
      withButton(event.currentTarget, '[data-credit-result]', 'Requesting…', async () => {
        const result = await actions.requestCreditFaucet();
        toast(`Granted ${result.amount ?? 1000} credits.`);
        await load();
      }),
    );

    q('[data-send]')?.addEventListener('click', (event) =>
      withButton(event.currentTarget, '[data-send-result]', 'Signing and submitting…', async () => {
        const result = await actions.sendCredits(
          q('[data-recipient]').value.trim(),
          Number(q('[data-amount]').value),
        );
        toast(`Sent ${result.sent} credits${result.change ? ` (change ${result.change})` : ''}.`);
        await load();
      }),
    );

    q('[data-create-invite]')?.addEventListener('click', (event) =>
      withButton(event.currentTarget, '[data-invite-result]', 'Building and signing…', async () => {
        // Stored before the reload so paint() re-renders the secret afterwards.
        lastInvite = await actions.createInvite();
        toast('Invite created — copy the secret before you leave this page.');
        await load();
      }),
    );

    wireInviteCopy();

    root.querySelectorAll('[data-cancel-invite]').forEach((button) => {
      button.addEventListener('click', () =>
        withButton(button, '[data-cancel-result]', 'Cancelling…', async () => {
          await actions.cancelInvite(button.dataset.cancelInvite);
          toast('Invite cancelled — gift and bond refunded.');
          await load();
        }),
      );
    });

    q('[data-redeem]')?.addEventListener('click', (event) =>
      withButton(event.currentTarget, '[data-redeem-result]', 'Starting…', async (progress) => {
        const result = await actions.redeemInvite(
          {
            inviteBoxId: q('[data-invite-box]').value.trim(),
            bondBoxId: q('[data-bond-box]').value.trim(),
            inviterId: q('[data-inviter]').value.trim(),
            secretHex: q('[data-secret]').value.trim(),
          },
          (stage) => progress(`${stage}…`),
        );
        toast(`Invite claimed — karma box ${shortHex(result.karmaBoxId ?? '', 8, 4)} is yours.`);
        await load();
      }),
    );

    function wireInviteCopy() {
      root.querySelector('[data-copy-invite]')?.addEventListener('click', async () => {
        if (!lastInvite) return;
        const text = [
          `Invite box id: ${lastInvite.inviteBoxId}`,
          `Bond box id:   ${lastInvite.bondBoxId}`,
          `Inviter id:    ${lastInvite.inviterId}`,
          `Secret:        ${lastInvite.secretHex}`,
        ].join('\n');
        toast((await copyText(text)) ? 'Invite details copied.' : 'Could not copy.');
      });
    }
  }

  await load();

  const timer = setInterval(poll, BALANCE_POLL_MS);
  return () => clearInterval(timer);
}
