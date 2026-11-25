/**
 * Thin client for the official CHZZK Open API (https://chzzk.gitbook.io/chzzk).
 * Only official, documented endpoints are used: no scraping, no internal APIs.
 */

export interface ChzzkCredentials {
  clientId: string;
  clientSecret: string;
  apiBase: string;
  authorizeUrl: string;
}

export interface ChzzkToken {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  scope?: string;
}

export interface ChzzkUser {
  channelId: string;
  channelName: string;
}

export type ChzzkEventName = 'chat' | 'donation' | 'subscription';

export class ChzzkApiError extends Error {
  override name = 'ChzzkApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Envelope<T> {
  code?: number | string;
  message?: string | null;
  content?: T;
}

export class ChzzkApi {
  constructor(
    private readonly creds: ChzzkCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** URL the streamer opens to grant ojakgyo access to their channel. */
  authorizeUrl(redirectUri: string, state: string): string {
    const url = new URL(this.creds.authorizeUrl);
    url.searchParams.set('clientId', this.creds.clientId);
    url.searchParams.set('redirectUri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  exchangeCode(code: string, state: string): Promise<ChzzkToken> {
    return this.token({ grantType: 'authorization_code', code, state });
  }

  /** Refresh tokens are single-use: persist the returned token immediately. */
  refresh(refreshToken: string): Promise<ChzzkToken> {
    return this.token({ grantType: 'refresh_token', refreshToken });
  }

  async revoke(token: string, hint: 'access_token' | 'refresh_token' = 'access_token'): Promise<void> {
    await this.request('POST', '/auth/v1/token/revoke', {
      body: { clientId: this.creds.clientId, clientSecret: this.creds.clientSecret, token, tokenTypeHint: hint },
    });
  }

  me(accessToken: string): Promise<ChzzkUser> {
    return this.request<ChzzkUser>('GET', '/open/v1/users/me', { bearer: accessToken });
  }

  /** Creates a user session; the returned URL is valid briefly and only once. */
  async sessionUrl(accessToken: string): Promise<string> {
    const { url } = await this.request<{ url: string }>('GET', '/open/v1/sessions/auth', { bearer: accessToken });
    return url;
  }

  async subscribe(accessToken: string, event: ChzzkEventName, sessionKey: string): Promise<void> {
    await this.request('POST', `/open/v1/sessions/events/subscribe/${event}`, {
      bearer: accessToken,
      query: { sessionKey },
    });
  }

  /** Requires the "채팅 메시지 쓰기" scope. CHZZK limits messages to 100 characters. */
  async sendChat(accessToken: string, message: string): Promise<string> {
    const trimmed = Array.from(message).slice(0, 100).join('');
    const { messageId } = await this.request<{ messageId: string }>('POST', '/open/v1/chats/send', {
      bearer: accessToken,
      body: { message: trimmed },
    });
    return messageId;
  }

  private async token(body: Record<string, string>): Promise<ChzzkToken> {
    const res = await this.request<{
      accessToken: string;
      refreshToken: string;
      expiresIn: string | number;
      scope?: string;
    }>('POST', '/auth/v1/token', {
      body: { ...body, clientId: this.creds.clientId, clientSecret: this.creds.clientSecret },
    });
    const expiresIn = Number(res.expiresIn) || 86_400;
    return {
      accessToken: res.accessToken,
      refreshToken: res.refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      ...(res.scope ? { scope: res.scope } : {}),
    };
  }

  private async request<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    opts: { bearer?: string; body?: unknown; query?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(path, this.creds.apiBase);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
    else {
      headers['Client-Id'] = this.creds.clientId;
      headers['Client-Secret'] = this.creds.clientSecret;
    }

    const res = await this.fetchImpl(url, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });

    const text = await res.text();
    let json: Envelope<T> | undefined;
    try {
      json = text ? (JSON.parse(text) as Envelope<T>) : undefined;
    } catch {
      json = undefined;
    }

    const code = json?.code;
    const ok = res.ok && (code === undefined || Number(code) === 200);
    if (!ok) {
      const message = json?.message ?? res.statusText ?? 'request failed';
      throw new ChzzkApiError(res.status, String(code ?? res.status), `CHZZK ${method} ${path}: ${res.status} ${message}`);
    }
    // Responses are wrapped as { code, message, content }; tolerate unwrapped bodies too.
    return (json?.content ?? json ?? {}) as T;
  }
}
