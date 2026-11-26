// Dashboard rule editor: edit the rules in ojakgyo.yaml, save them back and apply at once.
// The action form is built from the catalogue the bridge derives from its config schema.
import { el, won } from './client.js';
import { t } from './i18n.js';

const S = {
  rules: [],
  catalog: [],
  events: ['chat', 'donation', 'subscription'],
  roles: [],
  file: null,
  writable: false,
  error: null,
};
let draft = [];
let selected = 0;
let dirty = false;
let issues = []; // [{ path: [ruleIndex, ...], message }]
let status = { text: '', tone: '' };
let mounted = false;
let placed = new Set(); // issue paths the current form shows next to a field

const clone = (v) => JSON.parse(JSON.stringify(v));
const $ = (id) => document.getElementById(id);
const asList = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const pathKey = (path) => path.join('.');
/** Server messages are English; the common one gets a translation. */
const issueText = (message) => (message === 'required' ? t('rules.fillIn') : message);

/* ── state ── */

async function load() {
  const res = await fetch('/api/rules');
  Object.assign(S, await res.json());
  draft = clone(S.rules);
  selected = Math.min(selected, Math.max(0, draft.length - 1));
  dirty = false;
  issues = [];
  render();
}

function touch() {
  dirty = true;
  status = { text: t('rules.dirty'), tone: 'dirty' };
  renderHead();
  renderList();
}

function issuesFor(prefix) {
  const k = pathKey(prefix);
  return issues.filter((i) => pathKey(i.path) === k || pathKey(i.path).startsWith(`${k}.`));
}

/* ── list ── */

function summary(rule) {
  const parts = asList(rule.on).map((type) => t(`type.${type}`));
  const w = rule.when ?? {};
  if (w.minAmount !== undefined) parts.push(t('rules.sum.min', { n: t('won', { n: won(w.minAmount) }) }));
  if (w.maxAmount !== undefined) parts.push(t('rules.sum.max', { n: t('won', { n: won(w.maxAmount) }) }));
  if (w.amounts?.length) parts.push(w.amounts.map((a) => t('won', { n: won(a) })).join(' / '));
  if (w.match) parts.push(t('rules.sum.match', { v: w.match }));
  if (w.contains?.length) parts.push(t('rules.sum.contains', { v: w.contains.join(', ') }));
  if (w.minTier !== undefined) parts.push(t('rules.sum.tier', { n: w.minTier }));
  if (w.minMonths !== undefined) parts.push(t('rules.sum.months', { n: w.minMonths }));
  const n = (rule.actions ?? []).length;
  parts.push(n === 1 ? t('rules.sum.action1') : t('rules.sum.actions', { n }));
  return parts.join(' · ');
}

function renderList() {
  const list = $('ruleList');
  list.replaceChildren();
  draft.forEach((rule, i) => {
    const item = el('div', `rule-item${rule.enabled === false ? ' off' : ''}${issuesFor([i]).length ? ' bad' : ''}`);
    item.setAttribute('aria-current', String(i === selected));
    const box = el('input');
    box.type = 'checkbox';
    box.checked = rule.enabled !== false;
    box.disabled = !S.writable;
    box.setAttribute('aria-label', `${t('rules.enabled')}: ${rule.name}`);
    box.addEventListener('change', () => {
      if (box.checked) delete rule.enabled;
      else rule.enabled = false;
      touch();
      if (i === selected) renderEditor();
    });
    const pick = el('button', 'rule-pick');
    pick.type = 'button';
    pick.append(el('span', 'rname', rule.name || '—'), el('span', 'rsum', summary(rule)));
    pick.addEventListener('click', () => {
      selected = i;
      renderList();
      renderEditor();
    });
    item.append(box, pick);
    list.append(item);
  });
  if (!draft.length) list.append(el('p', 'hint', t('rules.empty')));
  const add = el('button', 'btn secondary add-rule', t('rules.add'));
  add.type = 'button';
  add.disabled = !S.writable;
  add.addEventListener('click', () => {
    let n = draft.length + 1;
    while (draft.some((r) => r.name === t('rules.newName', { n }))) n++;
    draft.push({ name: t('rules.newName', { n }), on: 'donation', actions: [{ type: 'overlay.alert' }] });
    selected = draft.length - 1;
    touch();
    renderEditor();
  });
  list.append(add);
}

/* ── editor ── */

function fieldBox(label, input, path, hint) {
  const box = el('div', 'field');
  const id = `f-${pathKey(path).replace(/\W/g, '-')}`;
  const lab = el('label', '', label);
  lab.htmlFor = id;
  input.id = id;
  box.append(lab, input);
  if (hint) box.append(el('div', 'field-hint', hint));
  placed.add(pathKey(path));
  const errs = issues.filter((i) => pathKey(i.path) === pathKey(path));
  if (errs.length) {
    input.setAttribute('aria-invalid', 'true');
    box.append(el('div', 'err', errs.map((e) => issueText(e.message)).join(' · ')));
  }
  return box;
}

function textInput(value, onInput, placeholder = '') {
  const input = el('input', 'input');
  input.value = value ?? '';
  input.placeholder = placeholder;
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

function numberInput(value, onInput, { min, max, placeholder = '' } = {}) {
  const input = el('input', 'input num');
  input.type = 'number';
  input.step = 'any';
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  input.value = value ?? '';
  input.placeholder = placeholder;
  input.addEventListener('input', () => onInput(input.value === '' ? undefined : Number(input.value)));
  return input;
}

const parseList = (text, numeric) => {
  const items = text.split(',').map((s) => s.trim()).filter(Boolean);
  return numeric ? items.map(Number).filter((n) => Number.isFinite(n)) : items;
};

function setOrDelete(obj, key, value) {
  if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) delete obj[key];
  else obj[key] = value;
}

function checkbox(label, checked, onChange) {
  const wrap = el('label', 'check');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  wrap.append(box, document.createTextNode(label));
  return wrap;
}

function actionField(action, field, path) {
  const label = t(`rules.f.${field.key}`) === `rules.f.${field.key}` ? field.key : t(`rules.f.${field.key}`);
  const fullLabel = field.required ? `${label} · ${t('rules.required')}` : label;
  const placeholder = field.default !== undefined && typeof field.default !== 'object' ? String(field.default) : '';
  const set = (v) => {
    setOrDelete(action, field.key, v);
    touch();
  };
  switch (field.kind) {
    case 'boolean': {
      const box = el('div', 'field');
      box.append(checkbox(label, action[field.key] ?? field.default ?? false, (v) => set(v === (field.default ?? false) ? undefined : v)));
      return box;
    }
    case 'number':
      return fieldBox(fullLabel, numberInput(action[field.key], set, { min: field.min, max: field.max, placeholder }), path);
    case 'enum': {
      const select = el('select', 'input');
      for (const o of field.options ?? []) {
        const opt = el('option', '', o);
        opt.value = o;
        select.append(opt);
      }
      select.value = action[field.key] ?? field.default ?? field.options?.[0] ?? '';
      select.addEventListener('change', () => set(select.value === field.default ? undefined : select.value));
      return fieldBox(fullLabel, select, path);
    }
    case 'array':
      return fieldBox(fullLabel, textInput(asList(action[field.key]).join(', '), (v) => set(parseList(v, false))), path, t('rules.listHint'));
    case 'record': {
      const area = el('textarea', 'input mono');
      area.value = action[field.key] ? JSON.stringify(action[field.key], null, 2) : '';
      area.placeholder = '{ "text": "{nickname}" }';
      const box = fieldBox(fullLabel, area, path);
      const err = el('div', 'err');
      err.hidden = true;
      box.append(err);
      area.addEventListener('input', () => {
        if (!area.value.trim()) {
          err.hidden = true;
          return set(undefined);
        }
        try {
          const parsed = JSON.parse(area.value);
          err.hidden = true;
          set(parsed);
        } catch {
          err.textContent = t('rules.badJson');
          err.hidden = false;
        }
      });
      return box;
    }
    default:
      return fieldBox(fullLabel, textInput(action[field.key], set, placeholder), path);
  }
}

function actionCard(rule, a, j) {
  const spec = S.catalog.find((c) => c.type === a.type);
  const card = el('div', `action-card${issuesFor([selected, 'actions', j]).length ? ' bad' : ''}`);
  const head = el('div', 'action-head');
  head.append(el('span', 'idx num', String(j + 1)), el('span', 'atype', t(`rules.action.${a.type}`)));
  const tools = el('span', 'tools');
  const mk = (label, fn, disabled = false) => {
    const b = el('button', 'btn secondary small', label);
    b.type = 'button';
    b.disabled = disabled || !S.writable;
    b.addEventListener('click', fn);
    return b;
  };
  tools.append(
    mk(t('rules.up'), () => move(rule.actions, j, -1), j === 0),
    mk(t('rules.down'), () => move(rule.actions, j, 1), j === rule.actions.length - 1),
    mk(t('rules.remove'), () => {
      rule.actions.splice(j, 1);
      touch();
      renderEditor();
    }),
  );
  head.append(tools);
  const body = el('div', 'action-body row2');
  for (const field of spec?.fields ?? []) body.append(actionField(a, field, [selected, 'actions', j, field.key]));
  card.append(head, body);
  return card;
}

function move(list, i, d) {
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  touch();
  renderEditor();
}

function renderEditor() {
  const root = $('ruleEditor');
  root.replaceChildren();
  const rule = draft[selected];
  if (!rule) return;
  const i = selected;
  rule.when ??= {};
  const w = rule.when;
  placed = new Set();

  // Name and on/off
  const top = el('div', 'row2');
  top.append(fieldBox(t('rules.name'), textInput(rule.name, (v) => {
    rule.name = v;
    touch();
  }), [i, 'name']));
  root.append(top);

  // Trigger: one or more event types
  root.append(el('div', 'subhead', t('rules.on')));
  const seg = el('div', 'seg multi');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', t('rules.on'));
  for (const type of S.events) {
    const b = el('button', '', t(`type.${type}`));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(asList(rule.on).includes(type)));
    b.addEventListener('click', () => {
      const on = asList(rule.on);
      const next = on.includes(type) ? on.filter((x) => x !== type) : [...on, type];
      if (!next.length) return; // a rule needs at least one trigger
      rule.on = next.length === 1 ? next[0] : S.events.filter((x) => next.includes(x));
      touch();
      renderEditor();
    });
    seg.append(b);
  }
  root.append(seg);
  const onErr = issues.filter((x) => pathKey(x.path) === `${i}.on` || pathKey(x.path).startsWith(`${i}.on.`));
  for (const x of onErr) placed.add(pathKey(x.path));
  if (onErr.length) root.append(el('div', 'err', onErr.map((x) => issueText(x.message)).join(' · ')));

  // Conditions that fit the chosen triggers
  const on = asList(rule.on);
  root.append(el('div', 'subhead', t('rules.conditions')));
  root.append(el('p', 'hint', t('rules.conditionsHint')));
  const cond = el('div', 'row2');
  const wset = (key) => (v) => {
    setOrDelete(w, key, v);
    touch();
  };
  if (on.includes('donation')) {
    cond.append(fieldBox(t('rules.minAmount'), numberInput(w.minAmount, wset('minAmount'), { min: 0 }), [i, 'when', 'minAmount']));
    cond.append(fieldBox(t('rules.maxAmount'), numberInput(w.maxAmount, wset('maxAmount'), { min: 0 }), [i, 'when', 'maxAmount']));
    cond.append(fieldBox(t('rules.amounts'), textInput(asList(w.amounts).join(', '), (v) => wset('amounts')(parseList(v, true)), t('rules.eg', { v: '1004, 10004' })), [i, 'when', 'amounts'], t('rules.listHint')));
  }
  if (on.includes('subscription')) {
    cond.append(fieldBox(t('rules.minTier'), numberInput(w.minTier, wset('minTier'), { min: 1 }), [i, 'when', 'minTier']));
    cond.append(fieldBox(t('rules.minMonths'), numberInput(w.minMonths, wset('minMonths'), { min: 0 }), [i, 'when', 'minMonths']));
  }
  cond.append(fieldBox(t('rules.match'), textInput(w.match, wset('match'), t('rules.eg', { v: '^!hat$' })), [i, 'when', 'match']));
  cond.append(fieldBox(t('rules.contains'), textInput(asList(w.contains).join(', '), (v) => wset('contains')(parseList(v, false))), [i, 'when', 'contains'], t('rules.listHint')));
  root.append(cond);

  const roles = el('div', 'field');
  roles.append(el('label', '', t('rules.roles')));
  const roleRow = el('div', 'checks');
  for (const role of S.roles) {
    roleRow.append(checkbox(t(`role.${role}`), asList(w.roles).includes(role), (checked) => {
      const next = asList(w.roles).filter((r) => r !== role);
      if (checked) next.push(role);
      setOrDelete(w, 'roles', S.roles.filter((r) => next.includes(r)));
      touch();
    }));
  }
  roles.append(roleRow, el('div', 'field-hint', t('rules.rolesHint')));
  root.append(roles);

  const timing = el('div', 'row2');
  timing.append(fieldBox(t('rules.cooldown'), numberInput(rule.cooldown, (v) => {
    setOrDelete(rule, 'cooldown', v === 0 ? undefined : v);
    touch();
  }, { min: 0, placeholder: '0' }), [i, 'cooldown']));
  const stop = el('div', 'field align-end wide');
  stop.append(checkbox(t('rules.stop'), rule.stop === true, (v) => {
    setOrDelete(rule, 'stop', v ? true : undefined);
    touch();
  }));
  timing.append(stop);
  root.append(timing);

  // Actions
  root.append(el('div', 'subhead', t('rules.actions')));
  rule.actions ??= [];
  rule.actions.forEach((a, j) => root.append(actionCard(rule, a, j)));
  const add = el('select', 'input add-action');
  add.disabled = !S.writable;
  const first = el('option', '', t('rules.addAction'));
  first.value = '';
  add.append(first);
  for (const c of S.catalog) {
    const opt = el('option', '', t(`rules.action.${c.type}`));
    opt.value = c.type;
    add.append(opt);
  }
  add.addEventListener('change', () => {
    if (!add.value) return;
    rule.actions.push({ type: add.value });
    touch();
    renderEditor();
  });
  root.append(add, el('p', 'hint template-hint', t('rules.templateHint')));

  // Footer
  const foot = el('div', 'editor-foot');
  const tryBtn = el('button', 'btn secondary', t('rules.try'));
  tryBtn.type = 'button';
  tryBtn.addEventListener('click', () => tryRule(rule));
  const up = el('button', 'btn secondary', t('rules.up'));
  up.type = 'button';
  up.disabled = i === 0 || !S.writable;
  up.addEventListener('click', () => {
    moveRule(i, -1);
  });
  const down = el('button', 'btn secondary', t('rules.down'));
  down.type = 'button';
  down.disabled = i === draft.length - 1 || !S.writable;
  down.addEventListener('click', () => moveRule(i, 1));
  const del = el('button', 'btn secondary danger', t('rules.delete'));
  del.type = 'button';
  del.disabled = !S.writable;
  del.addEventListener('click', () => {
    if (!confirm(t('rules.deleteConfirm', { name: rule.name }))) return;
    draft.splice(i, 1);
    selected = Math.max(0, i - 1);
    touch();
    renderEditor();
  });
  const tryNote = el('span', 'try-note', '');
  tryNote.id = 'tryNote';
  foot.append(tryBtn, up, down, del, tryNote);
  root.append(foot);

  // Problems without a field of their own (no actions, an unknown action type …) go on top.
  const loose = issuesFor([i]).filter((x) => !placed.has(pathKey(x.path)));
  if (loose.length) {
    const box = el('div', 'issues');
    for (const x of loose) box.append(el('div', '', x.path.length > 1 ? `${x.path.slice(1).join(' › ')}: ${issueText(x.message)}` : issueText(x.message)));
    root.prepend(box);
  }

  if (!S.writable) for (const input of root.querySelectorAll('input, select, textarea')) input.disabled = true;
}

function moveRule(i, d) {
  const j = i + d;
  if (j < 0 || j >= draft.length) return;
  [draft[i], draft[j]] = [draft[j], draft[i]];
  selected = j;
  touch();
  renderEditor();
}

/* ── head: count, file, save ── */

function renderHead() {
  $('rulesCount').textContent = String(draft.length);
  $('rulesFile').textContent = S.file ? t('rules.file', { file: S.file }) : '';
  const st = $('rulesStatus');
  st.textContent = status.text;
  st.className = `save-state ${status.tone}`;
  $('rulesSave').disabled = !S.writable || !dirty;
  $('rulesRevert').disabled = !dirty;
  const note = $('rulesNote');
  note.textContent = S.error ? t('rules.fileError', { error: S.error }) : !S.writable ? t('rules.readonly') : t('rules.backupHint', { file: S.file });
  note.classList.toggle('warn', !S.writable);
}

function render() {
  if (!mounted) return;
  renderHead();
  renderList();
  renderEditor();
}

/* ── server calls ── */

async function save() {
  const res = await fetch('/api/rules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: draft }) });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    S.rules = body.rules;
    draft = clone(body.rules);
    selected = Math.min(selected, Math.max(0, draft.length - 1));
    dirty = false;
    issues = [];
    status = { text: t('rules.saved', { file: S.file }), tone: 'ok' };
  } else if (body.issues) {
    issues = body.issues;
    const firstBad = issues[0]?.path?.[0];
    if (typeof firstBad === 'number') selected = firstBad;
    status = { text: t('rules.invalid'), tone: 'bad' };
  } else {
    status = { text: t('rules.failed', { error: body.error ?? res.status }), tone: 'bad' };
  }
  render();
}

async function tryRule(rule) {
  const res = await fetch('/api/rules/try', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rule }) });
  const body = await res.json().catch(() => ({}));
  const note = $('tryNote');
  if (res.ok) {
    issues = issues.filter((x) => x.path[0] !== selected);
    renderList();
    const kind = t(`type.${body.event.type}`);
    const text = body.matched ? t('rules.tried', { kind }) : t('rules.triedNoMatch', { kind });
    $('tryNote').textContent = text;
    $('tryNote').className = `try-note ${body.matched ? 'ok' : 'warn'}`;
  } else if (body.issues) {
    issues = [...issues.filter((x) => x.path[0] !== selected), ...body.issues.map((x) => ({ ...x, path: [selected, ...x.path] }))];
    status = { text: t('rules.invalid'), tone: 'bad' };
    render();
  } else if (note) {
    note.textContent = body.error ?? String(res.status);
  }
}

/** Mount once; call again (or rerenderRules) after a language change. */
export function mountRules() {
  if (mounted) return;
  mounted = true;
  $('rulesSave').addEventListener('click', save);
  $('rulesRevert').addEventListener('click', () => {
    status = { text: '', tone: '' };
    load();
  });
  window.addEventListener('beforeunload', (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = t('rules.leave');
  });
  load().catch((err) => {
    status = { text: String(err?.message ?? err), tone: 'bad' };
    renderHead();
  });
}

export function rerenderRules() {
  if (status.tone === 'dirty') status.text = t('rules.dirty');
  render();
}
