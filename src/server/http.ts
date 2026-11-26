import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { createLogger, errorMessage, onLog, type LogRecord } from '../core/logger.js';
import type { Hub } from '../core/hub.js';
import type { OjakgyoEvent } from '../core/events.js';

const log = createLogger('server');

/** `web/` lives at the package root, next to `src/` and `dist/`. */
export const WEB_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

const PAGES: Record<string, string> = {
  '/': 'dashboard.html',
  '/overlay/alerts': 'overlay-alerts.html',
  '/overlay/chat': 'overlay-chat.html',
  '/overlay/avatar': 'overlay-avatar.html',
};

/**
 * Browser modules the avatar overlay imports, served straight from node_modules
 * so the overlay works offline and without a bundler. Only .js files are served.
 */
const require = createRequire(import.meta.url);
function packageRoot(entry: string): string | null {
  try {
    return dirname(dirname(require.resolve(entry)));
  } catch {
    return null;
  }
}
export const VENDOR_ROOTS: Record<string, string | null> = {
  three: packageRoot('three'),
  'three-vrm': packageRoot('@pixiv/three-vrm'),
};

export type OverlayMessage =
  | { kind: 'event'; event: OjakgyoEvent }
  | { kind: 'status'; statuses: ReturnType<Hub['getStatuses']> }
  | { kind: 'log'; record: LogRecord }
  | { kind: 'mouth'; level: number }
  | { kind: 'avatar'; expression: string; weight: number; duration: number }
  | {
      kind: 'alert';
      id: string;
      title: string;
      message: string;
      image?: string;
      sound?: string;
      accent?: string;
      emojis?: Record<string, string>;
      duration: number;
      eventType: string;
      speech?: { mode: 'browser'; text: string; lang: string } | { mode: 'audio'; text: string; audioUrl: string };
      volume: number;
    };

export interface ServerHooks {
  hub: Hub;
  version: string;
  /** Returns a clip for GET /tts/:id. */
  ttsClip(id: string): { data: Buffer; mime: string } | undefined;
  /** Overlay audio level, 0..1, for lip-sync. */
  onMouth(level: number): void;
  simulate(input: Record<string, unknown>): OjakgyoEvent;
  avatar: {
    enabled: boolean;
    view: 'bust' | 'full';
    lipSync: boolean;
    /** Absolute path of the configured .vrm, or null. Never sent to the browser. */
    modelPath: string | null;
  };
  chzzk?: {
    beginLogin(): string;
    completeLogin(code: string, state: string): Promise<string>;
    logout(): Promise<void>;
  };
}

type Client = { ws: WebSocket; role: string };

export class OverlayServer {
  private readonly server: Server;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly clients = new Set<Client>();
  private readonly allowedOrigins: Set<string>;
  private readonly logs: LogRecord[] = [];

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly hooks: ServerHooks,
  ) {
    this.allowedOrigins = new Set([
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      `http://[::1]:${port}`,
      `http://${host}:${port}`,
    ]);
    this.server = createServer((req, res) => {
      this.route(req, res).catch((err) => {
        log.error(`${req.method} ${req.url}: ${errorMessage(err)}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      });
    });
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/ws' || !this.originAllowed(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, url.searchParams.get('client') ?? 'unknown'));
    });

    hooks.hub.on('event', (event) => this.broadcast({ kind: 'event', event }));
    hooks.hub.on('status', () => this.broadcast({ kind: 'status', statuses: hooks.hub.getStatuses() }, 'dashboard'));
    onLog((record) => {
      if (record.level === 'debug') return;
      this.logs.push(record);
      if (this.logs.length > 200) this.logs.shift();
      this.broadcast({ kind: 'log', record }, 'dashboard');
    });
  }

  get origin(): string {
    const h = this.host === '0.0.0.0' || this.host === '::' ? 'localhost' : this.host;
    return `http://${h === '127.0.0.1' ? 'localhost' : h}:${this.port}`;
  }

  listen(): Promise<void> {
    return new Promise((resolveListen, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject);
        this.updateOverlayStatus();
        resolveListen();
      });
    });
  }

  close(): Promise<void> {
    for (const c of this.clients) c.ws.terminate();
    return new Promise((r) => this.server.close(() => r()));
  }

  broadcast(message: OverlayMessage, role?: string): void {
    const data = JSON.stringify(message);
    for (const c of this.clients) {
      if (role && c.role !== role) continue;
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
    }
  }

  overlayCount(role: string): number {
    let n = 0;
    for (const c of this.clients) if (c.role === role) n++;
    return n;
  }

  private accept(ws: WebSocket, role: string): void {
    const client: Client = { ws, role };
    this.clients.add(client);
    this.updateOverlayStatus();
    if (role === 'dashboard') {
      ws.send(JSON.stringify({ kind: 'status', statuses: this.hooks.hub.getStatuses() } satisfies OverlayMessage));
    }
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { kind?: string; level?: number };
        if (msg.kind === 'mouth' && typeof msg.level === 'number' && Number.isFinite(msg.level)) {
          const level = Math.max(0, Math.min(1, msg.level));
          this.hooks.onMouth(level);
          if (this.hooks.avatar.lipSync) this.broadcast({ kind: 'mouth', level }, 'avatar');
        }
      } catch {
        /* ignore */
      }
    });
    ws.on('close', () => {
      this.clients.delete(client);
      this.updateOverlayStatus();
    });
  }

  private updateOverlayStatus(): void {
    const alerts = this.overlayCount('alerts');
    const chat = this.overlayCount('chat');
    const avatar = this.overlayCount('avatar');
    const total = alerts + chat + avatar;
    this.hooks.hub.setStatus('overlay', 'Overlays', total > 0 ? 'connected' : 'disconnected', {
      detail: total > 0 ? `${alerts} alert · ${chat} chat · ${avatar} avatar` : 'No overlay open. Add it as an OBS browser source',
    });
  }

  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    // Browser sources and same-origin pages send our own origin; CLI tools send none.
    return origin === undefined || origin === 'null' || this.allowedOrigins.has(origin);
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method === 'GET' && PAGES[path]) return this.serveFile(res, PAGES[path]!);
    if (req.method === 'GET' && path.startsWith('/assets/')) return this.serveFile(res, path.slice(1));
    if (req.method === 'GET' && path.startsWith('/vendor/')) return this.serveVendor(res, path.slice('/vendor/'.length));

    if (req.method === 'GET' && path === '/api/avatar') {
      const a = this.hooks.avatar;
      return sendJson(res, 200, { enabled: a.enabled, view: a.view, lipSync: a.lipSync, hasModel: a.enabled && !!a.modelPath });
    }
    if (req.method === 'GET' && path === '/avatar/model.vrm') {
      const file = this.hooks.avatar.enabled ? this.hooks.avatar.modelPath : null;
      if (!file) return sendJson(res, 404, { error: 'no avatar model configured' });
      try {
        const info = await stat(file);
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
        createReadStream(file).pipe(res);
      } catch {
        sendJson(res, 404, { error: 'avatar model file not found' });
      }
      return;
    }

    if (req.method === 'GET' && path.startsWith('/tts/')) {
      const clip = this.hooks.ttsClip(path.slice(5));
      if (!clip) return sendJson(res, 404, { error: 'clip expired' });
      res.writeHead(200, { 'Content-Type': clip.mime, 'Cache-Control': 'no-store' });
      return void res.end(clip.data);
    }

    if (req.method === 'GET' && path === '/api/state') {
      return sendJson(res, 200, {
        version: this.hooks.version,
        statuses: this.hooks.hub.getStatuses(),
        events: this.hooks.hub.recentEvents(),
        logs: this.logs,
        overlays: { alerts: `${this.origin}/overlay/alerts`, chat: `${this.origin}/overlay/chat`, avatar: `${this.origin}/overlay/avatar` },
      });
    }

    if (req.method === 'POST' && path === '/api/simulate') {
      if (!this.originAllowed(req)) return sendJson(res, 403, { error: 'forbidden origin' });
      if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
        return sendJson(res, 415, { error: 'send application/json' });
      }
      const body = await readJson(req);
      try {
        const event = this.hooks.simulate(body);
        return sendJson(res, 200, { ok: true, event });
      } catch (err) {
        return sendJson(res, 400, { error: errorMessage(err) });
      }
    }

    const chzzk = this.hooks.chzzk;
    const lang = prefersKorean(req) ? 'ko' : 'en';
    const T = CALLBACK_TEXT[lang];
    if (path === '/auth/chzzk' && req.method === 'GET') {
      if (!chzzk) return sendHtml(res, 400, page(lang, T.disabledTitle, T.disabledBody));
      res.writeHead(302, { Location: chzzk.beginLogin() });
      return void res.end();
    }
    if (path === '/auth/chzzk/callback' && req.method === 'GET') {
      if (!chzzk) return sendHtml(res, 400, page(lang, T.disabledTitle, T.disabledBody));
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state) return sendHtml(res, 400, page(lang, T.cancelledTitle, T.cancelledBody));
      try {
        const name = await chzzk.completeLogin(code, state);
        return sendHtml(res, 200, page(lang, T.connectedTitle, T.connectedBody(name ? `<b>${escapeHtml(name)}</b>` : '')));
      } catch (err) {
        return sendHtml(res, 400, page(lang, T.failedTitle, escapeHtml(errorMessage(err))));
      }
    }
    if (path === '/api/chzzk/logout' && req.method === 'POST') {
      if (!this.originAllowed(req)) return sendJson(res, 403, { error: 'forbidden origin' });
      await chzzk?.logout();
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: 'not found' });
  }

  private async serveVendor(res: ServerResponse, rest: string): Promise<void> {
    const slash = rest.indexOf('/');
    const root = slash > 0 ? VENDOR_ROOTS[rest.slice(0, slash)] : null;
    const relative = slash > 0 ? rest.slice(slash + 1) : '';
    if (!root || extname(relative) !== '.js') return sendJson(res, 404, { error: 'not found' });
    const target = normalize(join(root, relative));
    if (!target.startsWith(root + sep)) return sendJson(res, 403, { error: 'forbidden' });
    try {
      const data = await readFile(target);
      res.writeHead(200, { 'Content-Type': MIME['.js']!, 'Cache-Control': 'max-age=3600' });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: 'not found' });
    }
  }

  private async serveFile(res: ServerResponse, relative: string): Promise<void> {
    const target = normalize(join(WEB_ROOT, relative));
    if (!target.startsWith(WEB_ROOT + sep)) return sendJson(res, 403, { error: 'forbidden' });
    try {
      const data = await readFile(target);
      res.writeHead(200, {
        'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: 'not found' });
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** True when the browser's first preferred language is Korean. */
export function prefersKorean(req: IncomingMessage): boolean {
  const first = String(req.headers['accept-language'] ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  return first === 'ko' || first.startsWith('ko-');
}

const CALLBACK_TEXT = {
  en: {
    disabledTitle: 'CHZZK is not enabled',
    disabledBody: 'Set <code>platforms.chzzk.enabled: true</code> in ojakgyo.yaml.',
    cancelledTitle: 'Login cancelled',
    cancelledBody: 'No authorization code was returned.',
    connectedTitle: 'Connected',
    connectedBody: (name: string) => `${name ? `${name} is` : 'Your channel is'} connected. You can close this tab.`,
    failedTitle: 'Login failed',
    back: 'Back to dashboard',
  },
  ko: {
    disabledTitle: '치지직 연결이 꺼져 있습니다',
    disabledBody: 'ojakgyo.yaml에서 <code>platforms.chzzk.enabled: true</code>로 설정하세요.',
    cancelledTitle: '로그인이 취소되었습니다',
    cancelledBody: '인증 코드를 받지 못했습니다.',
    connectedTitle: '연결 완료',
    connectedBody: (name: string) => `${name ? `${name} 채널이` : '채널이'} 연결되었습니다. 이 탭은 닫아도 됩니다.`,
    failedTitle: '로그인 실패',
    back: '대시보드로 돌아가기',
  },
} as const;

function page(lang: 'en' | 'ko', title: string, body: string): string {
  return `<!doctype html><html lang="${lang}"><meta charset="utf-8"><title>${escapeHtml(title)} · ojakgyo</title>
<link rel="stylesheet" href="/assets/ojakgyo.css"><body class="callback"><main><h1>${escapeHtml(title)}</h1><p>${body}</p><a class="btn secondary" href="/">${CALLBACK_TEXT[lang].back}</a></main></body></html>`;
}
