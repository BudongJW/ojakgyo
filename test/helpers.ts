import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { DonationEvent, OjakgyoEvent } from '../src/core/events.js';

export function donation(amount: number, message = '', nickname = '별빛'): DonationEvent {
  return {
    id: 'e1',
    type: 'donation',
    platform: 'chzzk',
    channelId: 'ch',
    receivedAt: 0,
    user: { nickname, role: 'viewer' },
    amount,
    currency: 'KRW',
    kind: 'chat',
    message,
    emojis: {},
  };
}

export function chat(message: string, role: 'viewer' | 'streamer' | 'manager' = 'viewer'): OjakgyoEvent {
  return {
    id: 'c1',
    type: 'chat',
    platform: 'chzzk',
    channelId: 'ch',
    receivedAt: 0,
    user: { nickname: '시청자', role },
    message,
    emojis: {},
  };
}

export interface TestServer {
  server: Server;
  wss: WebSocketServer;
  port: number;
  url: string;
  sockets: WebSocket[];
  close(): Promise<void>;
}

/** HTTP + WebSocket server on a random port. */
export async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void = (_, res) => res.end(),
  onSocket: (ws: WebSocket, req: IncomingMessage) => void = () => {},
): Promise<TestServer> {
  const server = createServer(handler);
  const wss = new WebSocketServer({ server });
  const sockets: WebSocket[] = [];
  wss.on('connection', (ws, req) => {
    sockets.push(ws);
    onSocket(ws, req);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    wss,
    port,
    url: `http://127.0.0.1:${port}`,
    sockets,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.terminate();
        wss.close();
        server.close(() => r());
      }),
  };
}

/** Behaves like CHZZK's Socket.IO v2 session server: open packet, unprompted "40", pongs. */
export function actAsEio3(ws: WebSocket, opts: { pingInterval?: number; pingTimeout?: number } = {}): void {
  ws.send(`0${JSON.stringify({ sid: 'sid-1', upgrades: [], pingInterval: opts.pingInterval ?? 25000, pingTimeout: opts.pingTimeout ?? 60000 })}`);
  ws.send('40');
  ws.on('message', (raw) => {
    if (raw.toString() === '2') ws.send('3');
  });
}

/** Emit a Socket.IO v2 event the way CHZZK does: payload as a JSON string. */
export function emitEio3(ws: WebSocket, name: string, payload: unknown): void {
  ws.send(`42${JSON.stringify([name, JSON.stringify(payload)])}`);
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await wait(10);
  }
}
