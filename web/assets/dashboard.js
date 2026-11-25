import { connect, el, richText, won, sprinkleStars } from './client.js';

sprinkleStars(document.getElementById('sky'));

const ORDER = ['chzzk', 'vts', 'obs', 'overlay'];
const LABELS = { chzzk: 'CHZZK', vts: 'VTube Studio', obs: 'OBS', overlay: 'Overlays' };
const STATE_TEXT = {
  connected: 'live',
  connecting: 'connecting',
  disconnected: 'offline',
  error: 'error',
  disabled: 'off',
  'action-needed': 'action needed',
};
const statuses = new Map();

function renderStatuses() {
  const root = document.getElementById('statuses');
  root.replaceChildren();
  for (const id of ORDER) {
    const s = statuses.get(id) ?? { id, label: LABELS[id], state: 'disabled' };
    const card = el('div', 'status');
    const name = el('div', 'name');
    name.append(el('span', `dot ${s.state}`), el('span', '', s.label ?? LABELS[id]), el('span', 'state-tag', STATE_TEXT[s.state] ?? s.state));
    card.append(name);
    const detail = s.detail || (s.state === 'disabled' ? 'Disabled in ojakgyo.yaml' : '');
    if (detail) card.append(el('div', 'detail', detail));
    if (s.link && (s.link.startsWith('http://') || s.link.startsWith('/'))) {
      const a = el('a', 'btn small', id === 'chzzk' ? 'Log in to CHZZK →' : 'Open →');
      a.href = s.link;
      card.append(a);
    }
    root.append(card);
  }
}

const ICON = { chat: '💬', donation: '💝', subscription: '⭐' };
let count = 0;

function addEvent(event) {
  const feed = document.getElementById('feed');
  feed.querySelector('.empty')?.remove();
  const row = el('div', `ev ${event.type}`);
  row.append(el('div', 'ico', ICON[event.type] ?? '✦'));

  const body = el('div');
  const who = el('div', 'who');
  who.append(el('span', '', event.user?.nickname ?? '익명의 후원자'));
  if (event.type === 'donation') who.append(el('span', 'amt', `${won(event.amount)}원`));
  if (event.type === 'subscription') who.append(el('span', 'amt', `${event.months}개월 · 티어 ${event.tier}`));
  if (event.user && event.user.role !== 'viewer') who.append(el('span', 'tag', event.user.role.replace('_', ' ')));
  body.append(who);
  if (event.message) body.append(richText(el('div', 'msg'), event.message, event.emojis));
  row.append(body);

  const meta = el('div', 'meta');
  meta.append(el('div', `tag ${event.platform}`, event.platform), el('div', '', new Date(event.receivedAt).toLocaleTimeString()));
  row.append(meta);

  feed.prepend(row);
  while (feed.children.length > 80) feed.lastChild.remove();
  document.getElementById('evCount').textContent = String(++count);
}

function addLog(record) {
  const logs = document.getElementById('logs');
  const line = el('div', record.level, `${new Date(record.time).toLocaleTimeString()}  ${record.scope.padEnd(7)} ${record.message}`);
  logs.prepend(line);
  while (logs.children.length > 200) logs.lastChild.remove();
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
    document.getElementById('urlAlerts').textContent = state.overlays.alerts;
    document.getElementById('urlChat').textContent = state.overlays.chat;
    for (const s of state.statuses) statuses.set(s.id, s);
    renderStatuses();
    for (const e of state.events) addEvent(e);
    for (const r of state.logs ?? []) addLog(r);
  });

/* ── test bench ── */
let simType = 'donation';
document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  simType = btn.dataset.type;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b === btn);
  document.getElementById('amountBox').hidden = simType !== 'donation';
  document.getElementById('subBox').hidden = simType !== 'subscription';
});
document.getElementById('amountChips').addEventListener('click', (e) => {
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
  if (!res.ok) addLog({ level: 'error', scope: 'bench', message: (await res.json()).error, time: Date.now() });
});

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(document.getElementById(btn.dataset.copy).textContent);
    btn.textContent = 'Copied ✓';
    setTimeout(() => (btn.textContent = 'Copy'), 1400);
  });
}
