import { connect, el, richText, won } from './client.js';

const ORDER = ['chzzk', 'vts', 'obs', 'overlay'];
const LABELS = { chzzk: 'CHZZK', vts: 'VTube Studio', obs: 'OBS', overlay: 'Overlays' };
const STATE_TEXT = {
  connected: 'Connected',
  connecting: 'Connecting',
  disconnected: 'Offline',
  error: 'Error',
  disabled: 'Disabled',
  'action-needed': 'Action needed',
};
const statuses = new Map();

function stateText(s) {
  if (s.id === 'chzzk' && s.state === 'action-needed') return 'Login required';
  if (s.id === 'overlay' && s.state === 'disconnected') return 'None open';
  if (s.id === 'overlay' && s.state === 'connected') return 'Open';
  return STATE_TEXT[s.state] ?? s.state;
}

function stateDetail(s) {
  if (s.state === 'disabled') return 'Off in ojakgyo.yaml';
  if (s.id === 'vts' && s.state === 'disconnected') return 'Retrying. Is the API enabled in VTube Studio?';
  if (s.id === 'overlay' && s.state === 'disconnected') return 'Add a browser source in OBS';
  return s.detail ?? '';
}

function renderStatuses() {
  const root = document.getElementById('statuses');
  root.replaceChildren();
  for (const id of ORDER) {
    const s = statuses.get(id) ?? { id, label: LABELS[id], state: 'disabled' };
    const cell = el('div', 'status');
    cell.append(el('div', 'label', s.label ?? LABELS[id]));
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
      const a = el('a', 'btn secondary action', id === 'chzzk' ? 'Log in' : 'Open');
      a.href = s.link;
      cell.append(a);
    }
    root.append(cell);
  }
}

const KIND = { chat: 'Chat', donation: 'Donation', subscription: 'Sub' };
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
let count = 0;

function addEvent(event) {
  const feed = document.getElementById('feed');
  feed.querySelector('.empty')?.remove();

  const row = el('li', `ev ${event.type}`);
  row.append(el('span', 'time', timeFmt.format(event.receivedAt)));

  const kind = el('span', 'kind', KIND[event.type] ?? event.type);
  row.append(kind);

  const who = el('span', 'who', event.user?.nickname ?? '익명의 후원자');
  if (event.user && event.user.role !== 'viewer') who.append(el('small', '', event.user.role.replace('_', ' ')));
  who.title = `${event.user?.nickname ?? ''} · ${event.platform === 'mock' ? 'test' : event.platform}`;
  row.append(who);

  let amount = '';
  if (event.type === 'donation') amount = `${won(event.amount)}원`;
  if (event.type === 'subscription') amount = `${event.months}개월 · T${event.tier}`;
  row.append(el('span', 'amount', amount));

  const msg = richText(el('span', 'msg'), event.message, event.emojis);
  msg.title = event.message;
  if (event.platform === 'mock') row.title = 'Test event';
  row.append(msg);

  feed.prepend(row);
  while (feed.children.length > 200) feed.lastChild.remove();
  document.getElementById('evCount').textContent = String(++count);
}

function addLog(record) {
  const logs = document.getElementById('logs');
  logs.querySelector('.muted')?.remove();
  const line = el('div', record.level === 'info' ? '' : record.level, `${timeFmt.format(record.time)}  ${record.scope.padEnd(7)} ${record.message}`);
  logs.prepend(line);
  while (logs.children.length > 300) logs.lastChild.remove();
}

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
    for (const s of state.statuses) statuses.set(s.id, s);
    renderStatuses();
    for (const e of state.events) addEvent(e);
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
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = 'Copy'), 1400);
  });
}
