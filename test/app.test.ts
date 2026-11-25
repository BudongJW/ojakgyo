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
    for (const path of ['/', '/overlay/alerts', '/overlay/chat', '/assets/ojakgyo.css']) {
      const res = await fetch(base + path);
      expect(res.status, path).toBe(200);
    }
    const state = (await (await fetch(`${base}/api/state`)).json()) as { statuses: { id: string; state: string }[] };
    expect(state.statuses.find((s) => s.id === 'chzzk')?.state).toBe('disabled');
    expect((await fetch(`${base}/assets/../package.json`)).status).not.toBe(200);
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
});
