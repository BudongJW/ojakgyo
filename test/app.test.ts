import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { App } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { MemoryStore } from '../src/core/store.js';
import { until } from './helpers.js';

let app: App | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

async function boot(yaml: string): Promise<{ app: App; base: string; port: number }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const config = parseConfig(`server: { port: ${port} }\n${yaml}`);
  app = new App({ config, path: null, dataDir: '' }, { store: new MemoryStore() });
  await app.start();
  return { app, base: `http://127.0.0.1:${port}`, port };
}

function overlay(port: number, role: string, origin?: string): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?client=${role}`, origin ? { origin } : {});
    const messages: any[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

describe('App end-to-end', () => {
  it('turns a simulated donation into a rendered alert on the overlay', async () => {
    const { base, port } = await boot(`
outputs: { tts: { provider: browser } }
rules:
  - name: thanks
    on: donation
    when: { minAmount: 1000 }
    actions:
      - type: overlay.alert
        title: "{nickname} 님 {amount}원!"
        message: "{message}"
        tts: "{nickname}님 감사합니다 {message}"
`);
    const { ws, messages } = await overlay(port, 'alerts', `http://localhost:${port}`);

    const res = await fetch(`${base}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'donation', nickname: '별빛', amount: 10000, message: '최고ㅋㅋㅋㅋㅋㅋ' }),
    });
    expect(res.status).toBe(200);

    await until(() => messages.some((m) => m.kind === 'alert'));
    const alert = messages.find((m) => m.kind === 'alert');
    expect(alert).toMatchObject({
      title: '별빛 님 10,000원!',
      message: '최고ㅋㅋㅋㅋㅋㅋ',
      eventType: 'donation',
      speech: { mode: 'browser', text: '별빛님 감사합니다 최고ㅋㅋㅋ', lang: 'ko-KR' },
    });
    ws.close();
  });

  it('serves the dashboard, overlays and state', async () => {
    const { base } = await boot('');
    for (const path of ['/', '/overlay/alerts', '/overlay/chat', '/assets/ojakgyo.css', '/assets/i18n.js']) {
      const res = await fetch(base + path);
      expect(res.status, path).toBe(200);
    }
    const state = (await (await fetch(`${base}/api/state`)).json()) as { statuses: { id: string; state: string }[] };
    expect(state.statuses.find((s) => s.id === 'chzzk')?.state).toBe('disabled');
    expect((await fetch(`${base}/assets/../package.json`)).status).not.toBe(200);
  });

  it('answers the CHZZK login page in the browser language', async () => {
    const { base } = await boot('');
    const ko = await (await fetch(`${base}/auth/chzzk`, { headers: { 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' } })).text();
    expect(ko).toContain('<html lang="ko">');
    expect(ko).toContain('치지직 연결이 꺼져 있습니다');
    const en = await (await fetch(`${base}/auth/chzzk`, { headers: { 'Accept-Language': 'en-US,en;q=0.9,ko;q=0.5' } })).text();
    expect(en).toContain('CHZZK is not enabled');
  });

  it('blocks cross-site requests from other web pages', async () => {
    const { base, port } = await boot('');
    const forged = await fetch(`${base}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ type: 'donation', amount: 1000000 }),
    });
    expect(forged.status).toBe(403);
    const formPost = await fetch(`${base}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"type":"donation"}',
    });
    expect(formPost.status).toBe(415);
    await expect(overlay(port, 'chat', 'https://evil.example')).rejects.toThrow(/403/);
  });

  it('serves the configured VRM and the browser modules the avatar overlay needs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ojakgyo-avatar-'));
    const model = join(dir, 'me.vrm');
    writeFileSync(model, Buffer.from('glTF-fake-model'));
    const { base } = await boot(`outputs:\n  avatar: { enabled: true, model: ${JSON.stringify(model)}, view: full }\n`);

    expect(await (await fetch(`${base}/api/avatar`)).json()).toEqual({ enabled: true, view: 'full', lipSync: true, hasModel: true, format: 'vrm' });
    const vrm = await fetch(`${base}/avatar/model.vrm`);
    expect(vrm.status).toBe(200);
    expect(vrm.headers.get('content-type')).toBe('model/gltf-binary');
    expect(Buffer.from(await vrm.arrayBuffer()).toString()).toBe('glTF-fake-model');

    expect((await fetch(`${base}/overlay/avatar`)).status).toBe(200);
    const three = await fetch(`${base}/vendor/three/build/three.module.js`);
    expect(three.status).toBe(200);
    expect(three.headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${base}/vendor/three-vrm/lib/three-vrm.module.js`)).status).toBe(200);
    // only .js files, only from the two whitelisted packages, never outside them
    expect((await fetch(`${base}/vendor/three/package.json`)).status).toBe(404);
    expect((await fetch(`${base}/vendor/zod/index.js`)).status).toBe(404);
    expect((await fetch(`${base}/vendor/three/%2E%2E/zod/index.js`)).status).not.toBe(200);
  });

  it('has no avatar model when the avatar output is off', async () => {
    const { base } = await boot('');
    expect(await (await fetch(`${base}/api/avatar`)).json()).toMatchObject({ enabled: false, hasModel: false });
    expect((await fetch(`${base}/avatar/model.vrm`)).status).toBe(404);
  });

  it('relays TTS mouth levels and rule expressions to the avatar overlay', async () => {
    const { base, port } = await boot(`
outputs:
  avatar: { enabled: true, model: missing.vrm }
rules:
  - name: big
    on: donation
    when: { minAmount: 10000 }
    actions:
      - type: avatar.expression
        expression: happy
        duration: 2
`);
    const origin = `http://localhost:${port}`;
    const avatar = await overlay(port, 'avatar', origin);
    const alerts = await overlay(port, 'alerts', origin);

    alerts.ws.send(JSON.stringify({ kind: 'mouth', level: 0.5 }));
    alerts.ws.send(JSON.stringify({ kind: 'mouth', level: 7 }));
    await until(() => avatar.messages.filter((m) => m.kind === 'mouth').length >= 2);
    expect(avatar.messages.filter((m) => m.kind === 'mouth').map((m) => m.level)).toEqual([0.5, 1]);

    await fetch(`${base}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'donation', amount: 50000 }),
    });
    await until(() => avatar.messages.some((m) => m.kind === 'avatar'));
    expect(avatar.messages.find((m) => m.kind === 'avatar')).toEqual({ kind: 'avatar', expression: 'happy', weight: 1, duration: 2 });
    avatar.ws.close();
    alerts.ws.close();
  });
});
