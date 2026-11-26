import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { App } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { MemoryStore } from '../src/core/store.js';
import { sanitizeFace } from '../src/server/http.js';
import { startServer, until, type TestServer } from './helpers.js';

const load = () => import('../web/assets/face-map.js') as Promise<typeof import('../web/assets/face-map.js')>;

describe('face mapping', () => {
  it('mirrors left and right blendshapes', async () => {
    const { mirrorBlend } = await load();
    expect(mirrorBlend({ eyeBlinkLeft: 1, eyeBlinkRight: 0, jawOpen: 0.4 })).toEqual({ eyeBlinkRight: 1, eyeBlinkLeft: 0, jawOpen: 0.4 });
  });

  it('maps ARKit shapes onto VRM presets with resting noise trimmed', async () => {
    const { toVrmPresets } = await load();
    const rest = toVrmPresets({ eyeBlinkLeft: 0.08, eyeBlinkRight: 0.05, jawOpen: 0, mouthSmileLeft: 0.1, mouthSmileRight: 0.1 });
    expect(rest).toMatchObject({ blinkLeft: 0, blinkRight: 0, aa: 0, happy: 0 });
    const talk = toVrmPresets({ eyeBlinkLeft: 0.9, jawOpen: 0.4, mouthPucker: 0.6, mouthSmileLeft: 0.8, mouthSmileRight: 0.8 });
    expect(talk.blinkLeft).toBe(1);
    expect(talk.aa).toBeCloseTo(0.72);
    expect(talk.ou).toBeCloseTo(0.7);
    expect(talk.happy).toBeCloseTo(0.96);
  });

  it('flips head rotation for VRM 0.x rigs and clamps it', async () => {
    const { headRotation } = await load();
    expect(headRotation([0.2, 0.3, 0.1], { mirror: false })).toEqual([0.2, 0.3, 0.1]);
    expect(headRotation([0.2, 0.3, 0.1], { mirror: true })).toEqual([0.2, -0.3, -0.1]);
    expect(headRotation([0.2, 0.3, 0.1], { mirror: false, vrm0: true })).toEqual([-0.2, 0.3, -0.1]);
    expect(headRotation([2, -2, 0], { mirror: false })).toEqual([0.7, -0.7, 0]);
  });

  it('smooths towards new values', async () => {
    const { smooth } = await load();
    expect(smooth(null, { jawOpen: 1 }, 0.5)).toEqual({ jawOpen: 1 });
    expect(smooth({ jawOpen: 0 }, { jawOpen: 1 }, 0.5)).toEqual({ jawOpen: 0.5 });
  });
});

describe('face frame validation', () => {
  it('clamps values, drops junk keys and rejects malformed frames', () => {
    expect(sanitizeFace({ blend: { jawOpen: 2, eyeBlinkLeft: -1, 'bad key!': 1, mouthPucker: 'x' }, head: [9, 0, Number.NaN] })).toEqual({
      blend: { jawOpen: 1, eyeBlinkLeft: 0 },
      head: [Math.PI, 0, 0],
    });
    expect(sanitizeFace({ blend: {}, head: [0, 0] })).toBeNull();
    expect(sanitizeFace(null)).toBeNull();
  });
});

let app: App | null = null;
const servers: TestServer[] = [];
afterEach(async () => {
  await app?.stop();
  app = null;
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function boot(yaml: string) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dataDir = mkdtempSync(join(tmpdir(), 'ojakgyo-data-'));
  const config = parseConfig(`server: { port: ${port} }\n${yaml}`);
  app = new App({ config, path: null, dataDir }, { store: new MemoryStore() });
  await app.start();
  return { base: `http://127.0.0.1:${port}`, port, dataDir };
}

function client(port: number, role: string): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?client=${role}`, { origin: `http://localhost:${port}` });
    const messages: any[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

describe('face tracker pipeline', () => {
  it('relays tracker frames to avatar overlays only from the tracker role', async () => {
    const { port } = await boot('');
    const avatar = await client(port, 'avatar');
    const tracker = await client(port, 'tracker');
    const stranger = await client(port, 'chat');

    stranger.ws.send(JSON.stringify({ kind: 'face', blend: { jawOpen: 1 }, head: [0, 0, 0] }));
    tracker.ws.send(JSON.stringify({ kind: 'face', blend: { jawOpen: 0.25 }, head: [0, 0.5, 0] }));
    await until(() => avatar.messages.some((m) => m.kind === 'face'));
    const faces = avatar.messages.filter((m) => m.kind === 'face');
    expect(faces).toEqual([{ kind: 'face', blend: { jawOpen: 0.25 }, head: [0, 0.5, 0] }]);
    for (const c of [avatar, tracker, stranger]) c.ws.close();
  });

  it('serves the tracker page and MediaPipe runtime files', async () => {
    const { base } = await boot('');
    expect((await fetch(`${base}/tracker`)).status).toBe(200);
    expect((await fetch(`${base}/vendor/mediapipe/vision_bundle.mjs`)).headers.get('content-type')).toContain('javascript');
    const wasm = await fetch(`${base}/vendor/mediapipe/wasm/vision_wasm_internal.wasm`);
    expect(wasm.status).toBe(200);
    expect(wasm.headers.get('content-type')).toBe('application/wasm');
    expect((await fetch(`${base}/vendor/mediapipe/package.json`)).status).toBe(404);
  });

  it('downloads the face model once and serves it from the cache', async () => {
    let hits = 0;
    const model = Buffer.alloc(4096, 7);
    const fake = await startServer((_req, res) => {
      hits++;
      res.end(model);
    });
    servers.push(fake);
    const { base, dataDir } = await boot(`outputs:\n  avatar: { faceModelUrl: "${fake.url}/face_landmarker.task" }\n`);

    const [a, b] = await Promise.all([fetch(`${base}/vendor/models/face_landmarker.task`), fetch(`${base}/vendor/models/face_landmarker.task`)]);
    expect(Buffer.from(await a.arrayBuffer()).equals(model)).toBe(true);
    expect(Buffer.from(await b.arrayBuffer()).equals(model)).toBe(true);
    expect((await fetch(`${base}/vendor/models/face_landmarker.task`)).status).toBe(200);
    expect(hits).toBe(1);
    expect(existsSync(join(dataDir, 'models', 'face_landmarker.task'))).toBe(true);
  });

  it('reports a clear error when the model cannot be fetched', async () => {
    const fake = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    servers.push(fake);
    const { base } = await boot(`outputs:\n  avatar: { faceModelUrl: "${fake.url}/missing.task" }\n`);
    const res = await fetch(`${base}/vendor/models/face_landmarker.task`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/HTTP 404/);
  });
});
