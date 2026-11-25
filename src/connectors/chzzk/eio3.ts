import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/**
 * A minimal, receive-only Socket.IO v2 client (Engine.IO protocol v3) over the
 * websocket transport.
 *
 * CHZZK's session server only speaks the protocol of socket.io-client
 * 1.0.0–2.0.3. Instead of pulling that 2017-era dependency tree (and its
 * outdated `ws`) into every install, ojakgyo implements the tiny subset the
 * session socket needs:
 *
 *   - Engine.IO open packet `0{...}` with pingInterval / pingTimeout
 *   - the default namespace connect `40`, which the server sends unprompted
 *   - client-initiated heartbeat: we send `2`, the server answers `3`
 *   - incoming events `42["NAME", arg0, ...]` (string args are JSON-decoded)
 *
 * Session URLs are single-use: always fetch a fresh one before reconnecting.
 */

export interface Handshake {
  sid: string;
  pingInterval: number;
  pingTimeout: number;
}

interface Eio3Events {
  open: [Handshake];
  event: [name: string, args: unknown[]];
  close: [reason: string];
  error: [Error];
}

/** `https://ssio08.nchat.naver.com:443?auth=X` -> `wss://ssio08.nchat.naver.com:443/socket.io/?auth=X&transport=websocket&EIO=3` */
export function toSocketUrl(sessionUrl: string): string {
  let url: URL;
  try {
    url = new URL(sessionUrl);
  } catch {
    // Never echo the URL: it carries the session's auth token.
    throw new Error('invalid session url');
  }
  if (url.protocol === 'https:' || url.protocol === 'wss:') url.protocol = 'wss:';
  else if (url.protocol === 'http:' || url.protocol === 'ws:') url.protocol = 'ws:';
  else throw new Error(`unsupported session url scheme ${url.protocol}`);
  url.pathname = '/socket.io/';
  url.searchParams.set('transport', 'websocket');
  url.searchParams.set('EIO', '3');
  url.hash = '';
  return url.toString();
}

function decodeArg(arg: unknown): unknown {
  if (typeof arg !== 'string') return arg;
  const trimmed = arg.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return arg;
  try {
    return JSON.parse(trimmed);
  } catch {
    return arg;
  }
}

export class Eio3Socket extends EventEmitter<Eio3Events> {
  private ws: WebSocket | null = null;
  private handshake: Handshake | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private deadline: NodeJS.Timeout | null = null;
  private closed = false;
  private joined = false;

  /** Connect and resolve once the default namespace is joined. */
  connect(sessionUrl: string, timeoutMs = 10_000): Promise<Handshake> {
    const ws = new WebSocket(toSocketUrl(sessionUrl), { handshakeTimeout: timeoutMs });
    this.ws = ws;

    return new Promise<Handshake>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled || this.joined) return;
        settled = true;
        clearTimeout(timer);
        this.shutdown(err.message);
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('timed out joining session')), timeoutMs);

      ws.on('message', (raw) => {
        const frame = raw.toString();
        if (!this.joined) {
          if (frame.startsWith('0')) {
            try {
              const hs = JSON.parse(frame.slice(1)) as Handshake;
              if (!(hs.pingInterval > 0 && hs.pingTimeout > 0)) throw new Error('missing ping settings');
              this.handshake = hs;
            } catch (err) {
              fail(new Error(`bad open packet: ${(err as Error).message}`));
            }
            return;
          }
          if (frame === '40' || frame.startsWith('40{')) {
            if (!this.handshake) return fail(new Error('namespace connect before open packet'));
            if (settled) return;
            settled = true;
            this.joined = true;
            clearTimeout(timer);
            this.startHeartbeat();
            this.emit('open', this.handshake);
            resolve(this.handshake);
            return;
          }
          if (frame.startsWith('44')) return fail(new Error(`session refused: ${frame.slice(2, 200)}`));
          if (frame.startsWith('42')) {
            // e.g. 42["error","auth fail"] when a session URL is reused.
            return fail(new Error(`session refused: ${frame.slice(2, 200)}`));
          }
        }
        this.onFrame(frame);
      });

      ws.on('error', (err) => {
        if (!this.joined) fail(new Error(`websocket error: ${err.message}`));
        else this.emit('error', err);
      });

      ws.on('close', (code) => {
        if (!this.joined) fail(new Error(`socket closed before joining (code ${code})`));
        else this.shutdown(`socket closed (code ${code})`);
      });
    });
  }

  close(): void {
    this.shutdown('closed by client');
  }

  private onFrame(frame: string): void {
    // engine.io-client 3.x semantics: every packet pushes the deadline out; the
    // next ping is only scheduled once the previous one has been answered.
    this.bumpDeadline();
    const type = frame[0];
    if (type === '3') return this.schedulePing(); // pong
    if (type === '2') return void this.send('3' + frame.slice(1)); // server ping (EIO4-style servers)
    if (type === '6') return; // noop
    if (type === '1') return this.shutdown('server closed the session');
    if (type !== '4') return;

    const packet = frame.slice(1);
    if (packet.startsWith('1')) return this.shutdown('server closed the namespace');
    if (!packet.startsWith('2')) return;

    // Event packets may carry an ack id between the type and the JSON array: 2<id>[...]
    const start = packet.indexOf('[');
    if (start < 0) return;
    try {
      const payload = JSON.parse(packet.slice(start)) as unknown[];
      const [name, ...args] = payload;
      if (typeof name === 'string') this.emit('event', name, args.map(decodeArg));
    } catch {
      // A malformed frame should never take the bridge down.
    }
  }

  private startHeartbeat(): void {
    this.bumpDeadline();
    this.schedulePing();
  }

  private schedulePing(): void {
    const hs = this.handshake;
    if (!hs || this.closed) return;
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => {
      this.pingTimer = null;
      this.send('2');
      // After a ping the server has pingTimeout to answer with a pong.
      this.setDeadline(hs.pingTimeout);
    }, hs.pingInterval);
  }

  private bumpDeadline(): void {
    if (!this.handshake) return;
    this.setDeadline(this.handshake.pingInterval + this.handshake.pingTimeout);
  }

  private setDeadline(ms: number): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = setTimeout(() => this.shutdown('heartbeat timeout'), ms);
  }

  private send(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearTimeout(this.pingTimer);
    if (this.deadline) clearTimeout(this.deadline);
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.removeAllListeners('close');
      ws.on('error', () => {});
      ws.close();
    }
    if (this.joined) this.emit('close', reason);
  }
}
