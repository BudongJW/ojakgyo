import { connect, el, richText, won } from './client.js';
import { detectLang, getLang, saveLang, setLang, t, translateDetail, translatePage } from './i18n.js';
import { mountRules, rerenderRules } from './rules-editor.js';

const ORDER = ['chzzk', 'vts', 'obs', 'overlay'];
const statuses = new Map();
const events = [];
const seen = new Set();
const MAX_EVENTS = 200;

/* ── language ── */
function applyLang(lang) {
  setLang(lang);
  translatePage();
  for (const b of document.querySelectorAll('#lang button')) b.setAttribute('aria-pressed', String(b.dataset.lang === getLang()));
  renderStatuses();
  renderEvents();
  rerenderRules();
}

document.getElementById('lang').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  saveLang(btn.dataset.lang);
  applyLang(btn.dataset.lang);
});

/* ── connection status ── */
function stateText(s) {
  if (s.id === 'chzzk' && s.state === 'action-needed') return t('state.chzzk.login');
  if (s.id === 'overlay' && s.state === 'disconnected') return t('state.overlay.none');
  if (s.id === 'overlay' && s.state === 'connected') return t('state.overlay.open');
  return t(`state.${s.state}`);
}

function stateDetail(s) {
  if (s.state === 'disabled') return t('detail.disabled');
  if (s.id === 'vts' && s.state === 'disconnected') return t('detail.vts.retry');
  return translateDetail(s.detail);
}

function renderStatuses() {
  const root = document.getElementById('statuses');
  root.replaceChildren();
  for (const id of ORDER) {
    const s = statuses.get(id) ?? { id, state: 'disabled' };
    const cell = el('div', 'status');
    cell.append(el('div', 'label', t(`label.${id}`)));
    const state = el('div', 'state');
    // An overlay that isn't open is normal off-stream, not an error.
    const dot = s.id === 'overlay' && s.state === 'disconnected' ? 'idle' : s.state;
    state.append(el('span', `dot ${dot}`), el('span', '', stateText(s)));
    cell.append(state);
    const detail = stateDetail(s);
    if (detail) {
      const d = el('div', 'detail', detail);
      d.title = s.detail ?? detail;
      cell.append(d);
    }
    if (s.link && (s.link.startsWith('http://') || s.link.startsWith('/'))) {
      const a = el('a', 'btn secondary action', id === 'chzzk' ? t('action.login') : t('action.open'));
      a.href = s.link;
      cell.append(a);
    }
    root.append(cell);
  }
}

/* ── events ── */
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function eventRow(event) {
  const row = el('li', `ev ${event.type}`);
  row.append(el('span', 'time', timeFmt.format(event.receivedAt)));
  row.append(el('span', 'kind', t(`kind.${event.type}`)));

  const who = el('span', 'who', event.user?.nickname ?? t('anonymous'));
  if (event.user && event.user.role !== 'viewer') who.append(el('small', '', t(`role.${event.user.role}`)));
  row.append(who);

  let amount = '';
  if (event.type === 'donation') amount = t('won', { n: won(event.amount) });
  if (event.type === 'subscription') amount = `${t('months', { n: event.months })} · T${event.tier}`;
  row.append(el('span', 'amount', amount));

  const msg = richText(el('span', 'msg'), event.message, event.emojis);
  msg.title = event.message;
  row.append(msg);
  if (event.platform === 'mock') row.title = t('events.test');
  return row;
}

function renderEvents() {
  const feed = document.getElementById('feed');
  if (events.length === 0) {
    feed.replaceChildren(el('li', 'empty', t('events.empty')));
  } else {
    feed.replaceChildren(...events.map(eventRow));
  }
  document.getElementById('evCount').textContent = String(events.length);
}

function addEvent(event) {
  if (seen.has(event.id)) return;
  seen.add(event.id);
  events.unshift(event);
  if (events.length > MAX_EVENTS) events.pop();
  const feed = document.getElementById('feed');
  feed.querySelector('.empty')?.remove();
  feed.prepend(eventRow(event));
  while (feed.children.length > MAX_EVENTS) feed.lastChild.remove();
  document.getElementById('evCount').textContent = String(events.length);
}

/* ── log (kept in English: it is meant for troubleshooting and bug reports) ── */
function addLog(record) {
  const logs = document.getElementById('logs');
  logs.querySelector('.muted')?.remove();
  const line = el('div', record.level === 'info' ? '' : record.level, `${timeFmt.format(record.time)}  ${record.scope.padEnd(7)} ${record.message}`);
  logs.prepend(line);
  while (logs.children.length > 300) logs.lastChild.remove();
}

/* ── wiring ── */
applyLang(detectLang());
mountRules();

connect('dashboard', (msg) => {
  if (msg.kind === 'status') {
    for (const s of msg.statuses) statuses.set(s.id, s);
    renderStatuses();
  } else if (msg.kind === 'event') addEvent(msg.event);
  else if (msg.kind === 'log') addLog(msg.record);
});

fetch('/api/state')
  .then((r) => r.json())
  .then((state) => {
    document.getElementById('ver').textContent = `v${state.version}`;
    document.getElementById('host').textContent = location.host;
    document.getElementById('urlAlerts').textContent = state.overlays.alerts;
    document.getElementById('urlChat').textContent = state.overlays.chat;
    document.getElementById('urlAvatar').textContent = state.overlays.avatar;
    for (const s of state.statuses) statuses.set(s.id, s);
    renderStatuses();
    // Merge history with anything that already arrived live, newest first.
    for (const e of state.events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      events.push(e);
    }
    events.sort((a, b) => b.receivedAt - a.receivedAt);
    events.splice(MAX_EVENTS);
    renderEvents();
    for (const r of state.logs ?? []) addLog(r);
  });

/* ── test event form ── */
let simType = 'donation';
document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  simType = btn.dataset.type;
  for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-pressed', String(b === btn));
  document.getElementById('amountBox').hidden = simType !== 'donation';
  document.getElementById('subBox').hidden = simType !== 'subscription';
});
document.getElementById('amountPresets').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn) document.getElementById('amount').value = btn.dataset.v;
});
document.getElementById('sim').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    type: simType,
    nickname: document.getElementById('nick').value,
    amount: Number(document.getElementById('amount').value),
    months: Number(document.getElementById('months').value),
    message: document.getElementById('msg').value,
  };
  const res = await fetch('/api/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) addLog({ level: 'error', scope: 'test', message: (await res.json()).error, time: Date.now() });
});

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(document.getElementById(btn.dataset.copy).textContent);
    btn.textContent = t('copied');
    setTimeout(() => (btn.textContent = t('copy')), 1400);
  });
}
