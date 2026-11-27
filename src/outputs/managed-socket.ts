import WebSocket from 'ws';
import type { ComponentState, Hub } from '../core/hub.js';
import { errorMessage, type Logger } from '../core/logger.js';

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A WebSocket that keeps itself connected (with backoff), runs an
 * authentication handshake on every connect, and correlates request/response
 * pairs by id. VTube Studio and OBS both build on it.
 */
export abstract class ManagedSocket {
  protected ws: WebSocket | null = null;
  private stopped = true;
  private ready = false;
  private attempt = 0;
  private wake: (() => void) | null = null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  constructor(
    protected readonly url: string,
    protected readonly hub: Hub,
    private readonly statusId: string,
    private readonly statusLabel: string,
    protected readonly log: Logger,
  ) {}

  /** Runs after the socket opens; authenticate here. Throwing closes and retries. */
  protected abstract handshake(): Promise<void>;
  /** Raw message hook; call `settle()` for responses. */
  protected abstract onMessage(message: unknown): void;
  /** Runs once the connection is ready and marked connected; for follow-up requests such as event subscriptions. */
  protected onReady(): Promise<void> | void {}

  get isReady(): boolean {
    return this.ready;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.wake?.();
  }

  protected status(state: ComponentState, detail?: string): void {
    this.hub.setStatus(this.statusId, this.statusLabel, state, detail ? { detail } : {});
  }

  protected nextId(prefix = 'oj'): string {
    this.seq = (this.seq + 1) % 1_000_000;
    return `${prefix}-${this.seq}`;
  }

  protected sendJson(payload: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error(`${this.statusLabel} is not connected`);
    this.ws.send(JSON.stringify(payload));
  }

  /** Register a pending response before sending its request. */
  protected expect<T>(id: string, timeoutMs = 10_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.statusLabel} did not answer in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }

  protected settle(id: string, err: Error | null, value?: unknown): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(value);
  }

  protected assertReady(): void {
    if (!this.ready) throw new Error(`${this.statusLabel} is not connected`);
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      this.status('connecting');
      try {
        await this.connectOnce();
      } catch (err) {
        this.log.debug(`connection failed: ${errorMessage(err)}`);
        if (this.attempt === 0) this.log.warn(`cannot reach ${this.statusLabel} at ${this.url} (will keep retrying)`);
        this.status('disconnected', errorMessage(err));
      }
      if (this.stopped) break;
      const delay = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)]!;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
    this.status('disconnected', 'stopped');
  }

  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, { handshakeTimeout: 5_000 });
      this.ws = ws;
      let opened = false;

      ws.on('open', async () => {
        opened = true;
        try {
          await this.handshake();
          this.ready = true;
          this.attempt = 0;
          this.log.info(`connected to ${this.statusLabel}`);
          this.status('connected');
        } catch (err) {
          this.log.warn(`${this.statusLabel} handshake failed: ${errorMessage(err)}`);
          this.status('error', errorMessage(err));
          ws.close();
          return;
        }
        try {
          await this.onReady();
        } catch (err) {
          this.log.debug(`${this.statusLabel} setup after connect failed: ${errorMessage(err)}`);
        }
      });

      ws.on('message', (raw) => {
        let message: unknown;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        this.onMessage(message);
      });

      ws.on('error', (err) => {
        if (!opened) reject(err);
      });

      ws.on('close', (code, reason) => {
        const wasReady = this.ready;
        this.ready = false;
        this.ws = null;
        for (const [id] of this.pending) this.settle(id, new Error(`${this.statusLabel} disconnected`));
        if (wasReady) this.log.warn(`${this.statusLabel} disconnected (${code}${reason.length ? ` ${reason}` : ''})`);
        if (opened) resolve();
        else reject(new Error(`closed with code ${code}`));
      });
    });
  }
}
