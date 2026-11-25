import { randomBytes } from 'node:crypto';
import type { Config } from '../../config.js';
import type { Hub } from '../../core/hub.js';
import { createLogger, errorMessage } from '../../core/logger.js';
import type { KeyValueStore } from '../../core/store.js';
import { ChzzkApi, ChzzkApiError, type ChzzkEventName, type ChzzkToken } from './api.js';
import { Eio3Socket } from './eio3.js';
import { mapChzzkEvent } from './mapper.js';

const log = createLogger('chzzk');
const TOKEN_KEY = 'chzzk.token';
const CHANNEL_KEY = 'chzzk.channel';
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

type ChzzkConfig = Config['platforms']['chzzk'];

export interface ChzzkConnectorOptions {
  config: ChzzkConfig;
  hub: Hub;
  store: KeyValueStore;
  /** Must match the "로그인 리디렉션 URL" registered in the CHZZK developer center. */
  redirectUri: string;
  /** Local URL that starts the login flow (shown on the dashboard). */
  loginUrl: string;
}

export class ChzzkConnector {
  readonly api: ChzzkApi;
  private stopped = true;
  private socket: Eio3Socket | null = null;
  private wake: (() => void) | null = null;
  private attempt = 0;
  private readonly pendingStates = new Map<string, number>();

  constructor(private readonly opts: ChzzkConnectorOptions) {
    this.api = new ChzzkApi({
      clientId: opts.config.clientId,
      clientSecret: opts.config.clientSecret,
      apiBase: opts.config.apiBase,
      authorizeUrl: opts.config.authorizeUrl,
    });
  }

  private status(state: Parameters<Hub['setStatus']>[2], extra: { detail?: string; link?: string } = {}): void {
    this.opts.hub.setStatus('chzzk', 'CHZZK', state, extra);
  }

  start(): void {
    const { config } = this.opts;
    if (!config.enabled) return this.status('disabled');
    if (!config.clientId || !config.clientSecret) {
      log.warn('CHZZK is enabled but clientId/clientSecret are missing. See "Connect CHZZK" in the README');
      return this.status('error', { detail: 'Missing clientId / clientSecret' });
    }
    if (!this.opts.store.get<ChzzkToken>(TOKEN_KEY)) {
      log.info(`Log in to CHZZK to connect your channel → ${this.opts.loginUrl}`);
      return this.status('action-needed', { detail: 'Log in to connect your channel', link: this.opts.loginUrl });
    }
    this.run();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.wake?.();
  }

  /** Step 1 of OAuth: where to send the streamer's browser. */
  beginLogin(): string {
    const state = randomBytes(16).toString('hex');
    const now = Date.now();
    for (const [s, t] of this.pendingStates) if (now - t > 10 * 60_000) this.pendingStates.delete(s);
    this.pendingStates.set(state, now);
    return this.api.authorizeUrl(this.opts.redirectUri, state);
  }

  /** Step 2 of OAuth: called by the local callback route. */
  async completeLogin(code: string, state: string): Promise<string> {
    if (!this.pendingStates.delete(state)) throw new Error('Login link expired or state mismatch. Please try again.');
    const token = await this.api.exchangeCode(code, state);
    this.opts.store.set(TOKEN_KEY, token);
    let channelName = '';
    try {
      const me = await this.api.me(token.accessToken);
      channelName = me.channelName;
      this.opts.store.set(CHANNEL_KEY, me);
    } catch (err) {
      log.debug(`users/me failed (missing "유저 정보 조회" scope?): ${errorMessage(err)}`);
    }
    log.info(`Logged in to CHZZK${channelName ? ` as ${channelName}` : ''}`);
    if (this.stopped) this.run();
    else this.socket?.close(); // reconnect with the new token
    return channelName;
  }

  async logout(): Promise<void> {
    const token = this.opts.store.get<ChzzkToken>(TOKEN_KEY);
    this.opts.store.delete(TOKEN_KEY);
    this.opts.store.delete(CHANNEL_KEY);
    this.stop();
    if (token) await this.api.revoke(token.accessToken).catch(() => {});
    this.status('action-needed', { detail: 'Logged out', link: this.opts.loginUrl });
  }

  /** Send a chat message as the logged-in streamer (needs the "채팅 메시지 쓰기" scope). */
  async sendChat(message: string): Promise<void> {
    const token = await this.freshToken();
    await this.api.sendChat(token.accessToken, message);
  }

  private run(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        this.attempt = 0;
      } catch (err) {
        if (err instanceof ChzzkApiError && err.status === 401) {
          if (!(await this.tryRefresh())) {
            this.opts.store.delete(TOKEN_KEY);
            log.warn('CHZZK login expired. Please log in again.');
            this.status('action-needed', { detail: 'Login expired', link: this.opts.loginUrl });
            this.stopped = true;
            return;
          }
          log.info('access token refreshed after 401, retrying');
        } else {
          log.warn(`session error: ${errorMessage(err)}`);
          this.status('error', { detail: errorMessage(err) });
        }
      }
      if (this.stopped) break;
      const delay = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)]!;
      log.info(`reconnecting in ${delay / 1000}s`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  /** One session lifetime: fresh URL → connect → subscribe → wait for close. */
  private async connectOnce(): Promise<void> {
    const token = await this.freshToken();
    this.status('connecting');
    const url = await this.api.sessionUrl(token.accessToken);

    const socket = new Eio3Socket();
    this.socket = socket;
    const closed = new Promise<string>((resolve) => socket.once('close', resolve));
    socket.on('event', (name, args) => void this.onSocketEvent(name, args[0]));
    socket.on('error', (err) => log.debug(`socket error: ${err.message}`));

    await socket.connect(url);
    const reason = await closed;
    this.socket = null;
    if (!this.stopped) {
      log.warn(`session ended: ${reason}`);
      this.status('disconnected', { detail: reason });
    } else {
      this.status('disconnected', { detail: 'stopped' });
    }
  }

  private async onSocketEvent(name: string, payload: unknown): Promise<void> {
    if (name === 'SYSTEM') return this.onSystem(payload as { type?: string; data?: Record<string, string> });
    const event = mapChzzkEvent(name, payload);
    if (event) this.opts.hub.publish(event);
    else log.debug(`ignored session event ${name}`);
  }

  private async onSystem(msg: { type?: string; data?: Record<string, string> }): Promise<void> {
    switch (msg.type) {
      case 'connected': {
        const sessionKey = msg.data?.sessionKey;
        if (!sessionKey) return log.warn('connected message without sessionKey');
        const token = await this.freshToken();
        const failed: string[] = [];
        for (const event of this.opts.config.events as ChzzkEventName[]) {
          try {
            await this.api.subscribe(token.accessToken, event, sessionKey);
          } catch (err) {
            failed.push(event);
            log.warn(`subscribe ${event} failed: ${errorMessage(err)}`);
          }
        }
        const channel = this.opts.store.get<{ channelName?: string }>(CHANNEL_KEY)?.channelName;
        if (failed.length === this.opts.config.events.length) {
          this.status('error', { detail: 'Could not subscribe to any event. Check your app scopes.' });
        } else {
          this.status('connected', {
            detail: `${channel ? channel + ' · ' : ''}${this.opts.config.events.filter((e) => !failed.includes(e)).join(', ')}`,
          });
          log.info(`connected${channel ? ` to ${channel}` : ''}`);
        }
        return;
      }
      case 'subscribed':
        return log.debug(`subscribed ${msg.data?.eventType ?? ''}`);
      case 'unsubscribed':
        return log.info(`unsubscribed ${msg.data?.eventType ?? ''}`);
      case 'revoked':
        log.warn(`permission revoked for ${msg.data?.eventType ?? 'an event'}`);
        return this.status('error', { detail: `Permission revoked: ${msg.data?.eventType ?? ''}` });
      default:
        return log.debug(`system message ${msg.type}`);
    }
  }

  private async freshToken(): Promise<ChzzkToken> {
    const token = this.opts.store.get<ChzzkToken>(TOKEN_KEY);
    if (!token) throw new ChzzkApiError(401, 'NO_TOKEN', 'Not logged in to CHZZK');
    if (token.expiresAt - Date.now() > REFRESH_MARGIN_MS) return token;
    if (await this.tryRefresh()) return this.opts.store.get<ChzzkToken>(TOKEN_KEY)!;
    throw new ChzzkApiError(401, 'REFRESH_FAILED', 'Could not refresh the CHZZK token');
  }

  private async tryRefresh(): Promise<boolean> {
    const token = this.opts.store.get<ChzzkToken>(TOKEN_KEY);
    if (!token?.refreshToken) return false;
    try {
      const next = await this.api.refresh(token.refreshToken);
      this.opts.store.set(TOKEN_KEY, next); // refresh tokens are single-use: persist before anything else
      log.debug('access token refreshed');
      return true;
    } catch (err) {
      log.warn(`token refresh failed: ${errorMessage(err)}`);
      return false;
    }
  }
}
