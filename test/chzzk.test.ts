import { afterEach, describe, expect, it } from 'vitest';
import { ChzzkConfigSchemaForTest } from './fixtures.js';
import { ChzzkConnector } from '../src/connectors/chzzk/connector.js';
import { Eio3Socket, toSocketUrl } from '../src/connectors/chzzk/eio3.js';
import { mapChzzkEvent } from '../src/connectors/chzzk/mapper.js';
import type { OjakgyoEvent } from '../src/core/events.js';
import { Hub } from '../src/core/hub.js';
import { MemoryStore } from '../src/core/store.js';
import { actAsEio3, emitEio3, startServer, until, type TestServer } from './helpers.js';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('toSocketUrl', () => {
  it('turns the session URL into the Engine.IO v3 websocket endpoint', () => {
    expect(toSocketUrl('https://ssio08.nchat.naver.com:443?auth=TOKEN')).toBe(
      'wss://ssio08.nchat.naver.com/socket.io/?auth=TOKEN&transport=websocket&EIO=3',
    );
  });

  it('never leaks the token in errors', () => {
    expect(() => toSocketUrl('not a url ?auth=SECRET')).toThrow(/^invalid session url$/);
  });
});

describe('Eio3Socket', () => {
  it('joins, pings and decodes string payloads', async () => {
    const pings: string[] = [];
    const srv = await startServer(undefined, (ws) => {
      actAsEio3(ws, { pingInterval: 50, pingTimeout: 500 });
      ws.on('message', (m) => pings.push(m.toString()));
      setTimeout(() => emitEio3(ws, 'SYSTEM', { type: 'connected', data: { sessionKey: 'key-1' } }), 20);
    });
    servers.push(srv);

    const socket = new Eio3Socket();
    const events: [string, unknown[]][] = [];
    socket.on('event', (name, args) => events.push([name, args]));
    const hs = await socket.connect(`${srv.url}?auth=abc`);
    expect(hs.pingInterval).toBe(50);

    await until(() => events.length > 0 && pings.length >= 2);
    expect(events[0]).toEqual(['SYSTEM', [{ type: 'connected', data: { sessionKey: 'key-1' } }]]);
    expect(pings.every((p) => p === '2')).toBe(true);
    socket.close();
  });

  it('rejects when the server refuses a reused session URL', async () => {
    const srv = await startServer(undefined, (ws) => {
      ws.send('0{"sid":"x","upgrades":[],"pingInterval":25000,"pingTimeout":60000}');
      ws.send('42["error","auth fail"]');
      ws.send('41');
    });
    servers.push(srv);
    await expect(new Eio3Socket().connect(`${srv.url}?auth=used`)).rejects.toThrow(/session refused/);
  });

  it('reports a close when heartbeats stop', async () => {
    const srv = await startServer(undefined, (ws) => {
      ws.send('0{"sid":"x","upgrades":[],"pingInterval":30,"pingTimeout":60}');
      ws.send('40'); // ...and never answers pings
    });
    servers.push(srv);
    const socket = new Eio3Socket();
    const closed = new Promise<string>((r) => socket.once('close', r));
    await socket.connect(`${srv.url}?auth=x`);
    expect(await closed).toBe('heartbeat timeout');
  });
});

describe('mapChzzkEvent', () => {
  it('maps donations, including string amounts and anonymous donors', () => {
    const e = mapChzzkEvent('DONATION', {
      donationType: 'CHAT',
      channelId: 'ch',
      donatorChannelId: null,
      donatorNickname: null,
      payAmount: '10000',
      donationText: '응원해요',
      emojis: {},
    });
    expect(e).toMatchObject({ type: 'donation', amount: 10000, user: null, kind: 'chat', message: '응원해요' });
  });

  it('maps chat roles', () => {
    const e = mapChzzkEvent('CHAT', {
      channelId: 'ch',
      senderChannelId: 'u1',
      profile: { nickname: '매니저님' },
      userRoleCode: 'streaming_channel_manager',
      content: '!모자',
      emojis: {},
      messageTime: 1,
    });
    expect(e).toMatchObject({ type: 'chat', user: { id: 'u1', nickname: '매니저님', role: 'manager' }, message: '!모자' });
  });

  it('maps subscriptions and ignores unknown events', () => {
    expect(
      mapChzzkEvent('SUBSCRIPTION', { channelId: 'ch', subscriberNickname: '구독자', tierNo: 2, tierName: '골드', month: 6 }),
    ).toMatchObject({ type: 'subscription', tier: 2, months: 6, tierName: '골드' });
    expect(mapChzzkEvent('SOMETHING_NEW', {})).toBeNull();
  });
});

describe('ChzzkConnector (against a fake CHZZK)', () => {
  it('creates a session, subscribes to every event and publishes them', async () => {
    const calls: string[] = [];
    let sockets = 0;
    const srv: TestServer = await startServer(
      (req, res) => {
        calls.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/open/v1/sessions/auth') {
          return res.end(JSON.stringify({ code: 200, message: null, content: { url: `${srv.url}?auth=s${++sockets}` } }));
        }
        if (req.url?.startsWith('/open/v1/sessions/events/subscribe/')) {
          return res.end(JSON.stringify({ code: 200, message: null }));
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ code: 404, message: 'NOT_FOUND' }));
      },
      (ws) => {
        actAsEio3(ws);
        emitEio3(ws, 'SYSTEM', { type: 'connected', data: { sessionKey: 'sk-1' } });
        setTimeout(() => {
          emitEio3(ws, 'DONATION', { donationType: 'CHAT', channelId: 'ch', donatorNickname: '별빛', payAmount: '5000', donationText: 'hi', emojis: {} });
          emitEio3(ws, 'CHAT', { channelId: 'ch', profile: { nickname: 'a' }, userRoleCode: 'common_user', content: 'ㅎㅇ', emojis: {} });
        }, 80);
      },
    );
    servers.push(srv);

    const hub = new Hub();
    const store = new MemoryStore();
    store.set('chzzk.token', { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3_600_000 });
    const events: OjakgyoEvent[] = [];
    hub.on('event', (e) => events.push(e));

    const connector = new ChzzkConnector({
      config: ChzzkConfigSchemaForTest({ enabled: true, clientId: 'id', clientSecret: 'secret', apiBase: srv.url }),
      hub,
      store,
      redirectUri: 'http://localhost:7979/auth/chzzk/callback',
      loginUrl: 'http://localhost:7979/auth/chzzk',
    });
    connector.start();
    await until(() => events.length >= 2);
    connector.stop();

    expect(calls).toContain('GET /open/v1/sessions/auth Bearer AT');
    for (const ev of ['chat', 'donation', 'subscription']) {
      expect(calls).toContain(`POST /open/v1/sessions/events/subscribe/${ev}?sessionKey=sk-1 Bearer AT`);
    }
    expect(events.map((e) => e.type)).toEqual(['donation', 'chat']);
    expect(hub.getStatuses().find((s) => s.id === 'chzzk')?.state).toMatch(/connected|disconnected/);
  });

  it('asks for a login when there is no token', () => {
    const hub = new Hub();
    const connector = new ChzzkConnector({
      config: ChzzkConfigSchemaForTest({ enabled: true, clientId: 'id', clientSecret: 'secret' }),
      hub,
      store: new MemoryStore(),
      redirectUri: 'http://localhost:7979/auth/chzzk/callback',
      loginUrl: 'http://localhost:7979/auth/chzzk',
    });
    connector.start();
    const status = hub.getStatuses()[0]!;
    expect(status.state).toBe('action-needed');
    expect(status.link).toBe('http://localhost:7979/auth/chzzk');
    const url = new URL(connector.beginLogin());
    expect(url.origin + url.pathname).toBe('https://chzzk.naver.com/account-interlock');
    expect(url.searchParams.get('redirectUri')).toBe('http://localhost:7979/auth/chzzk/callback');
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects a callback with an unknown state', async () => {
    const connector = new ChzzkConnector({
      config: ChzzkConfigSchemaForTest({ enabled: true, clientId: 'id', clientSecret: 'secret' }),
      hub: new Hub(),
      store: new MemoryStore(),
      redirectUri: 'x',
      loginUrl: 'y',
    });
    await expect(connector.completeLogin('code', 'forged-state')).rejects.toThrow(/state mismatch/);
  });
});
