import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/core/hub.js';
import { MemoryStore } from '../src/core/store.js';
import { Obs, obsAuthString } from '../src/outputs/obs.js';
import { TtsService } from '../src/outputs/tts.js';
import { hexToRgba, VTubeStudio } from '../src/outputs/vtube-studio.js';
import { ConfigSchema } from '../src/config.js';
import { startServer, until, type TestServer } from './helpers.js';

const servers: TestServer[] = [];
const stoppers: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stoppers.splice(0)) stop();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('OBS (obs-websocket v5)', () => {
  it('computes the documented auth string', () => {
    const secret = createHash('sha256').update('pw' + 'salt').digest('base64');
    const expected = createHash('sha256').update(secret + 'challenge').digest('base64');
    expect(obsAuthString('pw', 'salt', 'challenge')).toBe(expected);
  });

  it('identifies with a password and switches scenes', async () => {
    const requests: Record<string, unknown>[] = [];
    let identifyAuth: unknown;
    const srv = await startServer(undefined, (ws) => {
      ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1, authentication: { challenge: 'c', salt: 's' } } }));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === 1) {
          identifyAuth = msg.d.authentication;
          ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        }
        if (msg.op === 6) {
          requests.push(msg.d);
          const responseData = msg.d.requestType === 'GetCurrentProgramScene' ? { currentProgramSceneName: 'Main' } : {};
          ws.send(JSON.stringify({ op: 7, d: { requestType: msg.d.requestType, requestId: msg.d.requestId, requestStatus: { result: true, code: 100 }, responseData } }));
        }
      });
    });
    servers.push(srv);

    const hub = new Hub();
    const obs = new Obs(`ws://127.0.0.1:${srv.port}`, hub, 'hunter2');
    obs.start();
    stoppers.push(() => obs.stop());
    await until(() => obs.isReady);

    expect(identifyAuth).toBe(obsAuthString('hunter2', 's', 'c'));
    expect(await obs.currentScene()).toBe('Main');
    await obs.setScene('Celebration');
    expect(requests.at(-1)).toMatchObject({ requestType: 'SetCurrentProgramScene', requestData: { sceneName: 'Celebration' } });
  });

  it('surfaces OBS request errors', async () => {
    const srv = await startServer(undefined, (ws) => {
      ws.send(JSON.stringify({ op: 0, d: { rpcVersion: 1 } }));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === 1) ws.send(JSON.stringify({ op: 2, d: {} }));
        if (msg.op === 6) {
          ws.send(JSON.stringify({ op: 7, d: { requestType: msg.d.requestType, requestId: msg.d.requestId, requestStatus: { result: false, code: 600, comment: 'No scene was found' } } }));
        }
      });
    });
    servers.push(srv);
    const obs = new Obs(`ws://127.0.0.1:${srv.port}`, new Hub(), '');
    obs.start();
    stoppers.push(() => obs.stop());
    await until(() => obs.isReady);
    await expect(obs.setScene('Nope')).rejects.toThrow('No scene was found');
  });
});

describe('VTube Studio', () => {
  it('requests a token once, stores it, then triggers hotkeys', async () => {
    const seen: { messageType: string; data: Record<string, unknown> }[] = [];
    const srv = await startServer(undefined, (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        seen.push(msg);
        const reply = (messageType: string, data: unknown) =>
          ws.send(JSON.stringify({ apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', requestID: msg.requestID, messageType, data }));
        if (msg.messageType === 'AuthenticationTokenRequest') reply('AuthenticationTokenResponse', { authenticationToken: 'tok-1' });
        else if (msg.messageType === 'AuthenticationRequest') reply('AuthenticationResponse', { authenticated: msg.data.authenticationToken === 'tok-1' });
        else if (msg.messageType === 'HotkeyTriggerRequest') {
          if (msg.data.hotkeyID === 'Missing') reply('APIError', { errorID: 101, message: 'Hotkey not found' });
          else reply('HotkeyTriggerResponse', { hotkeyID: 'uuid' });
        }
      });
    });
    servers.push(srv);

    const store = new MemoryStore();
    const vts = new VTubeStudio(`ws://127.0.0.1:${srv.port}`, new Hub(), store, { enabled: false, parameter: 'MouthOpen', gain: 1 });
    vts.start();
    stoppers.push(() => vts.stop());
    await until(() => vts.isReady);

    expect(store.get('vts.token')).toBe('tok-1');
    expect(seen.map((m) => m.messageType)).toEqual(['AuthenticationTokenRequest', 'AuthenticationRequest']);
    expect(seen[0]!.data).toMatchObject({ pluginName: 'Ojakgyo' });

    await vts.hotkey('Heart Eyes');
    expect(seen.at(-1)).toMatchObject({ messageType: 'HotkeyTriggerRequest', data: { hotkeyID: 'Heart Eyes' } });
    await expect(vts.hotkey('Missing')).rejects.toThrow('Hotkey not found');
  });

  it('parses tint colours', () => {
    expect(hexToRgba('#ff8fc7')).toEqual({ r: 255, g: 143, b: 199, a: 255 });
    expect(hexToRgba('00000080')).toEqual({ r: 0, g: 0, b: 0, a: 128 });
  });
});

describe('TTS', () => {
  const tts = (input: Record<string, unknown>, fetchImpl?: typeof fetch) =>
    new TtsService(ConfigSchema.parse({ outputs: { tts: input } }).outputs.tts, fetchImpl);

  it('lets the overlay speak in browser mode', async () => {
    expect(await tts({ provider: 'browser' }).prepare('안녕ㅋㅋㅋㅋㅋ')).toEqual({ mode: 'browser', text: '안녕ㅋㅋㅋ', lang: 'ko-KR' });
  });

  it('calls an OpenAI-compatible server and serves the clip', async () => {
    let body: Record<string, unknown> = {};
    const fakeFetch = (async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe('http://tts.local/v1/audio/speech');
      body = JSON.parse(String(init.body));
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
    }) as unknown as typeof fetch;
    const service = tts({ provider: 'openai', baseUrl: 'http://tts.local/v1', voice: 'sora' }, fakeFetch);
    const plan = await service.prepare('감사합니다');
    expect(body).toMatchObject({ input: '감사합니다', voice: 'sora' });
    expect(plan?.mode).toBe('audio');
    const id = (plan as { audioUrl: string }).audioUrl.split('/').pop()!;
    expect(service.clip(id)?.data).toEqual(Buffer.from([1, 2, 3]));
  });

  it('returns nothing for text that cleans up to empty', async () => {
    expect(await tts({ provider: 'browser', blockedWords: ['비밀'] }).prepare('비밀')).toBeNull();
  });
});
