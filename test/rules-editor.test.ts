import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app.js';
import { parseConfig, validateRules } from '../src/config.js';
import { MemoryStore } from '../src/core/store.js';
import { actionCatalog, compactRule, replaceRulesSection } from '../src/rules-file.js';
import { chat, donation } from './helpers.js';

describe('action catalogue', () => {
  it('describes every action field from the config schema', () => {
    const catalog = new Map(actionCatalog().map((a) => [a.type, new Map(a.fields.map((f) => [f.key, f]))]));
    expect(catalog.size).toBe(13);
    expect(catalog.get('overlay.alert')!.get('title')).toEqual({ key: 'title', kind: 'string', required: false, default: '{nickname}' });
    expect(catalog.get('overlay.alert')!.get('accent')).toEqual({ key: 'accent', kind: 'string', required: false });
    expect(catalog.get('obs.scene')!.get('scene')!.required).toBe(true);
    expect(catalog.get('vts.item')!.get('size')).toMatchObject({ kind: 'number', min: 0, max: 1, default: 0.32 });
    expect(catalog.get('webhook')!.get('method')).toMatchObject({ kind: 'enum', options: ['POST', 'PUT', 'GET'], default: 'POST' });
    expect(catalog.get('webhook')!.get('body')!.kind).toBe('record');
    expect(catalog.get('obs.source')!.get('visible')).toMatchObject({ kind: 'boolean', default: true });
  });
});

describe('writing rules', () => {
  it('leaves defaults and blanks out', () => {
    expect(
      compactRule({
        name: 'Big',
        enabled: true,
        on: ['donation'],
        when: { minAmount: 10000, contains: [], match: '' },
        cooldown: 0,
        stop: false,
        actions: [{ type: 'overlay.alert', title: '{nickname}', message: 'Thanks!', duration: 6, accent: '' }, { type: 'obs.source', scene: 'Main', source: 'Cam', visible: false }],
      }),
    ).toEqual({
      name: 'Big',
      on: 'donation',
      when: { minAmount: 10000 },
      actions: [{ type: 'overlay.alert', message: 'Thanks!' }, { type: 'obs.source', scene: 'Main', source: 'Cam', visible: false }],
    });
    expect(compactRule({ name: 'Off', enabled: false, on: ['chat', 'donation'], stop: true, cooldown: 5, actions: [{ type: 'delay', seconds: 1 }] })).toEqual({
      name: 'Off',
      enabled: false,
      on: ['chat', 'donation'],
      cooldown: 5,
      stop: true,
      actions: [{ type: 'delay', seconds: 1 }],
    });
  });

  const rules = [{ name: 'Hello', on: 'chat', when: { contains: ['hi', 'hello'] }, actions: [{ type: 'tts.speak', text: '{nickname} hi' }] }];

  it('swaps only the rules section and keeps the rest byte for byte', () => {
    const before = 'server:\n  port: 7979        # aligned comment\n  hosts: [a, b]\n\n# Rules below\nrules:\n  - name: Old # old note\n    on: chat\n    actions: [{ type: delay, seconds: 1 }]\n\n# After the rules\nanonymousName: 익명\n';
    const after = replaceRulesSection(before, rules);
    expect(after.startsWith('server:\n  port: 7979        # aligned comment\n  hosts: [a, b]\n\n# Rules below\nrules:\n')).toBe(true);
    expect(after.endsWith('\n\n# After the rules\nanonymousName: 익명\n')).toBe(true);
    expect(after).not.toContain('old note');
    expect(after).toContain('when: { contains: [ hi, hello ] }');
    expect(parse(after).rules).toEqual([{ name: 'Hello', on: 'chat', when: { contains: ['hi', 'hello'] }, actions: [{ type: 'tts.speak', text: '{nickname} hi' }] }]);
  });

  it('handles CRLF files, empty and missing sections', () => {
    const crlf = replaceRulesSection('a: 1\r\nrules: []\r\nb: 2\r\n', rules);
    expect(crlf.startsWith('a: 1\r\nrules:\r\n')).toBe(true);
    expect(crlf.endsWith('\r\nb: 2\r\n')).toBe(true);
    expect(crlf.replace(/\r\n/g, '')).not.toContain('\n');
    expect(parse(replaceRulesSection('a: 1\nrules:\nb: 2\n', rules))).toMatchObject({ a: 1, b: 2, rules: [{ name: 'Hello' }] });
    expect(replaceRulesSection('# only a comment\na: 1', rules)).toMatch(/^# only a comment\na: 1\n\nrules:\n/);
    expect(parse(replaceRulesSection('', rules)).rules).toHaveLength(1);
    expect(() => replaceRulesSection('a: [1, 2\n', rules)).toThrow(/syntax error/);
  });
});

describe('rule validation for the editor', () => {
  it('checks rules as written, placeholders included', () => {
    const ok = validateRules([{ name: 'Hook', on: 'donation', actions: [{ type: 'webhook', url: '${HOOK_URL}' }] }], { HOOK_URL: 'https://example.com/x' });
    expect(ok.ok).toBe(true);
  });

  it('points at the field that is wrong', () => {
    const result = validateRules([
      { name: 'A', on: 'chat', when: { match: '(' }, actions: [{ type: 'obs.scene' }] },
      { name: 'A', on: 'donation', actions: [{ type: 'delay', seconds: 1 }] },
    ]);
    expect(result.ok).toBe(false);
    const issues = result.ok ? [] : result.issues;
    expect(issues).toContainEqual({ path: [0, 'when', 'match'], message: 'invalid regular expression' });
    expect(issues).toContainEqual({ path: [0, 'actions', 0, 'scene'], message: 'required' });
    const dup = validateRules([{ name: 'A', on: 'chat', actions: [{ type: 'delay', seconds: 1 }] }, { name: 'A', on: 'chat', actions: [{ type: 'delay', seconds: 1 }] }]);
    expect(dup).toEqual({ ok: false, issues: [{ path: [1, 'name'], message: 'another rule already has this name' }] });
  });
});

let app: App | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

const CONFIG = `# my settings
server: { port: PORT }   # keep this comment

rules:
  - name: Hook
    on: donation
    actions:
      - type: webhook
        url: \${OJAKGYO_TEST_HOOK:-https://example.com/hook}
`;

async function boot(withFile = true) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dir = mkdtempSync(join(tmpdir(), 'ojakgyo-rules-'));
  const text = CONFIG.replace('PORT', String(port));
  const path = join(dir, 'ojakgyo.yaml');
  writeFileSync(path, text);
  app = new App({ config: parseConfig(text), path: withFile ? path : null, dataDir: join(dir, '.ojakgyo') }, { store: new MemoryStore() });
  await app.start();
  return { base: `http://127.0.0.1:${port}`, path, text };
}

const put = (base: string, rules: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/rules`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ rules }) });

describe('rules API', () => {
  it('serves the rules as written, without filling in the environment', async () => {
    const { base } = await boot();
    const state = await (await fetch(`${base}/api/rules`)).json();
    expect(state).toMatchObject({ file: 'ojakgyo.yaml', writable: true, events: ['chat', 'donation', 'subscription'] });
    expect(state.rules[0].actions[0].url).toBe('${OJAKGYO_TEST_HOOK:-https://example.com/hook}');
    expect(state.catalog).toHaveLength(13);
  });

  it('saves, keeps a backup and applies without a restart', async () => {
    const { base, path, text } = await boot();
    const next = [{ name: 'Hat', on: 'chat', when: { match: '^!hat$' }, cooldown: 0, actions: [{ type: 'delay', seconds: 0 }] }];
    const res = await put(base, next);
    expect(res.status).toBe(200);
    expect((await res.json()).rules).toEqual([{ name: 'Hat', on: 'chat', when: { match: '^!hat$' }, actions: [{ type: 'delay', seconds: 0 }] }]);
    const saved = readFileSync(path, 'utf8');
    expect(saved.startsWith(text.slice(0, text.indexOf('rules:')))).toBe(true);
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe(text);
    expect((await app!.engine.dispatch(chat('!hat'))).map((r) => r.rule)).toEqual(['Hat']);
    expect(await app!.engine.dispatch(donation(5000))).toEqual([]);
  });

  it('refuses invalid rules and leaves the file alone', async () => {
    const { base, path, text } = await boot();
    const res = await put(base, [{ name: 'Broken', on: 'chat', actions: [] }]);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues[0].path).toEqual([0, 'actions']);
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it('only accepts writes from the dashboard origin', async () => {
    const { base } = await boot();
    const res = await put(base, [], { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect((await fetch(`${base}/api/rules`, { method: 'DELETE' })).status).toBe(405);
  });

  it('tries a rule with a fitting sample event', async () => {
    const { base } = await boot();
    const tryRule = async (rule: unknown) => (await fetch(`${base}/api/rules/try`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rule }) })).json();
    const big = await tryRule({ name: 'Big', on: 'donation', when: { minAmount: 50000 }, actions: [{ type: 'delay', seconds: 0 }] });
    expect(big).toMatchObject({ ok: true, matched: true, event: { type: 'donation', amount: 50000 } });
    const cmd = await tryRule({ name: 'Cmd', on: 'chat', when: { match: '^!hat$' }, actions: [{ type: 'delay', seconds: 0 }] });
    expect(cmd).toMatchObject({ matched: true, event: { message: '!hat' } });
    const fuzzy = await tryRule({ name: 'Fuzzy', on: 'chat', when: { match: 'ab+c' }, actions: [{ type: 'delay', seconds: 0 }] });
    expect(fuzzy.matched).toBe(false);
    const bad = await tryRule({ name: 'Bad', on: 'chat', actions: [{ type: 'obs.scene' }] });
    expect(bad.issues).toEqual([{ path: ['actions', 0, 'scene'], message: 'required' }]);
  });

  it('is read-only when running without a config file', async () => {
    const { base } = await boot(false);
    expect(await (await fetch(`${base}/api/rules`)).json()).toMatchObject({ file: null, writable: false });
    expect((await put(base, [])).status).toBe(409);
  });
});
