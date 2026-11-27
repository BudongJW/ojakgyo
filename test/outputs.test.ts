import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/core/hub.js';
import { MemoryStore } from '../src/core/store.js';
import { Obs, obsAuthString } from '../src/outputs/obs.js';
import { TtsService } from '../src/outputs/tts.js';
import { missingVtsReferences } from '../src/outputs/vts-references.js';
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

type VtsSeen = { messageType: string; data: Record<string, any> };
type VtsReply = (messageType: string, data: unknown) => void;

/**
 * A fake VTube Studio: authenticates, reports model "Hiyori", lists MouthOpen as an input parameter,
 * and hands every other request to `handle` (unanswered requests just time out).
 */
async function fakeVts(handle: (msg: VtsSeen, reply: VtsReply) => void = () => {}) {
  const seen: VtsSeen[] = [];
  const sockets: import('ws').WebSocket[] = [];
  const srv = await startServer(undefined, (ws) => {
    sockets.push(ws);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      seen.push(msg);
      const reply: VtsReply = (messageType, data) =>
        ws.send(JSON.stringify({ apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', requestID: msg.requestID, messageType, data }));
      if (msg.messageType === 'AuthenticationTokenRequest') reply('AuthenticationTokenResponse', { authenticationToken: 'tok-1' });
      else if (msg.messageType === 'AuthenticationRequest') reply('AuthenticationResponse', { authenticated: msg.data.authenticationToken === 'tok-1' });
      else if (msg.messageType === 'EventSubscriptionRequest') reply('EventSubscriptionResponse', { subscribedEventCount: 1, subscribedEvents: [msg.data.eventName] });
      else if (msg.messageType === 'CurrentModelRequest') reply('CurrentModelResponse', { modelLoaded: true, modelName: 'Hiyori', modelID: 'aaa' });
      else if (msg.messageType === 'InputParameterListRequest') reply('InputParameterListResponse', { defaultParameters: [{ name: 'MouthOpen' }, { name: 'MouthSmile' }], customParameters: [] });
      else handle(msg, reply);
    });
  });
  servers.push(srv);
  /** Push an event the way VTube Studio does for subscribed events. */
  const emit = (messageType: string, data: unknown) =>
    sockets.forEach((ws) => ws.send(JSON.stringify({ apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', requestID: 'evt', messageType, data })));
  return { srv, seen, emit };
}

function connectVts(port: number, opts: { lipSync?: Partial<{ enabled: boolean; parameter: string; gain: number; mode: 'auto' | 'set' | 'add' }>; hub?: Hub; store?: MemoryStore } = {}) {
  const vts = new VTubeStudio(`ws://127.0.0.1:${port}`, opts.hub ?? new Hub(), opts.store ?? new MemoryStore(), {
    enabled: false,
    parameter: 'MouthOpen',
    gain: 1,
    ...opts.lipSync,
  });
  vts.start();
  stoppers.push(() => vts.stop());
  return vts;
}

describe('VTube Studio', () => {
  it('requests a token once, stores it, then triggers hotkeys', async () => {
    const { srv, seen } = await fakeVts((msg, reply) => {
      if (msg.messageType !== 'HotkeyTriggerRequest') return;
      if (msg.data.hotkeyID === 'Missing') reply('APIError', { errorID: 202, message: 'Hotkey not found' });
      else reply('HotkeyTriggerResponse', { hotkeyID: 'uuid' });
    });
    const store = new MemoryStore();
    const vts = connectVts(srv.port, { store });
    await until(() => vts.isReady);

    expect(store.get('vts.token')).toBe('tok-1');
    expect(seen.slice(0, 2).map((m) => m.messageType)).toEqual(['AuthenticationTokenRequest', 'AuthenticationRequest']);
    expect(seen[0]!.data).toMatchObject({ pluginName: 'Ojakgyo' });

    await vts.hotkey('Heart Eyes');
    expect(seen.filter((m) => m.messageType === 'HotkeyTriggerRequest').at(-1)).toMatchObject({ data: { hotkeyID: 'Heart Eyes' } });
    await expect(vts.hotkey('Missing')).rejects.toThrow('Hotkey not found');
  });

  it('follows model swaps and shows the model on the dashboard', async () => {
    const { srv, seen, emit } = await fakeVts();
    const hub = new Hub();
    const vts = connectVts(srv.port, { hub });
    const models: (string | null)[] = [];
    vts.onModelChange((m) => models.push(m?.name ?? null));
    await until(() => vts.currentModel?.name === 'Hiyori');
    expect(seen.find((m) => m.messageType === 'EventSubscriptionRequest')?.data).toMatchObject({ eventName: 'ModelLoadedEvent', subscribe: true });
    expect(hub.getStatuses().find((s) => s.id === 'vts')).toMatchObject({ state: 'connected', detail: 'Model: Hiyori' });

    emit('ModelLoadedEvent', { modelLoaded: true, modelName: 'Mao', modelID: 'bbb' });
    await until(() => vts.currentModel?.name === 'Mao');
    emit('ModelLoadedEvent', { modelLoaded: false, modelName: 'Mao', modelID: 'bbb' });
    await until(() => vts.currentModel === null);
    expect(models).toEqual(['Hiyori', 'Mao', null]);
    expect(hub.getStatuses().find((s) => s.id === 'vts')).toMatchObject({ detail: 'No model loaded' });
  });

  it('retries a hotkey VTube Studio is still cooling down instead of dropping it', async () => {
    let attempts = 0;
    const { srv } = await fakeVts((msg, reply) => {
      if (msg.messageType !== 'HotkeyTriggerRequest') return;
      attempts++;
      if (attempts <= 2) reply('APIError', { errorID: 203, message: 'Hotkey cooldown not over' });
      else reply('HotkeyTriggerResponse', { hotkeyID: 'uuid' });
    });
    const vts = connectVts(srv.port);
    await until(() => vts.isReady);
    await vts.hotkey('Heart Eyes');
    expect(attempts).toBe(3);
  });

  it('adds TTS lip-sync on top when another plugin already sets the mouth', async () => {
    const { srv, seen } = await fakeVts((msg, reply) => {
      if (msg.messageType !== 'InjectParameterDataRequest') return;
      if (msg.data.mode === 'set') reply('APIError', { errorID: 454, message: 'Parameter is controlled by another plugin' });
      else reply('InjectParameterDataResponse', {});
    });
    const vts = connectVts(srv.port, { lipSync: { enabled: true } });
    await until(() => vts.currentModel !== null);
    const injects = () => seen.filter((m) => m.messageType === 'InjectParameterDataRequest');

    vts.setMouth(0.5);
    await until(() => injects().some((m) => m.data.mode === 'add'));
    const firstAdd = injects().findIndex((m) => m.data.mode === 'add');
    vts.setMouth(0.7);
    await until(() => injects().length > firstAdd + 3);
    expect(injects().slice(firstAdd).every((m) => m.data.mode === 'add')).toBe(true);
    expect(injects()[firstAdd]!.data.parameterValues[0]).toMatchObject({ id: 'MouthOpen' });
  });

  it('stops lip-sync with one warning when the parameter does not exist', async () => {
    const { srv, seen } = await fakeVts((msg, reply) => {
      if (msg.messageType === 'InjectParameterDataRequest') reply('APIError', { errorID: 453, message: 'Parameter not found' });
    });
    const vts = connectVts(srv.port, { lipSync: { enabled: true, parameter: 'MouthOpne', mode: 'set' } });
    await until(() => vts.currentModel !== null);
    const injects = () => seen.filter((m) => m.messageType === 'InjectParameterDataRequest').length;

    vts.setMouth(0.5);
    await until(() => injects() > 0);
    await new Promise((r) => setTimeout(r, 200));
    const after = injects();
    vts.setMouth(0.9);
    await new Promise((r) => setTimeout(r, 200));
    expect(after).toBeLessThanOrEqual(3);
    expect(injects()).toBe(after);
  });

  it('parses tint colours', () => {
    expect(hexToRgba('#ff8fc7')).toEqual({ r: 255, g: 143, b: 199, a: 255 });
    expect(hexToRgba('00000080')).toEqual({ r: 0, g: 0, b: 0, a: 128 });
  });

  it('finds the hotkeys and expressions a model lacks', () => {
    const { rules } = ConfigSchema.parse({
      rules: [
        { name: 'party', on: 'donation', actions: [{ type: 'vts.hotkey', hotkey: 'Heart Eyes' }, { type: 'vts.hotkey', hotkey: 'id-2' }] },
        { name: 'case', on: 'donation', actions: [{ type: 'vts.hotkey', hotkey: 'heart eyes ' }, { type: 'vts.expression', file: 'blush.exp3.json' }] },
        { name: 'gone', on: 'chat', actions: [{ type: 'vts.hotkey', hotkey: 'Wave' }, { type: 'vts.expression', file: 'cry.exp3.json' }] },
        { name: 'off', on: 'chat', enabled: false, actions: [{ type: 'vts.hotkey', hotkey: 'Nope' }] },
      ],
    });
    const hotkeys = [
      { name: 'Heart Eyes', hotkeyID: 'id-1', type: 'ToggleExpression', file: 'heart.exp3.json' },
      { name: 'Spin', hotkeyID: 'id-2', type: 'TriggerAnimation', file: 'spin.motion3.json' },
    ];
    expect(missingVtsReferences(rules, hotkeys, ['heart.exp3.json', 'Blush.exp3.json'])).toEqual([
      { rule: 'case', kind: 'hotkey', value: 'heart eyes ', suggestion: 'Heart Eyes' },
      { rule: 'case', kind: 'expression', value: 'blush.exp3.json', suggestion: 'Blush.exp3.json' },
      { rule: 'gone', kind: 'hotkey', value: 'Wave' },
      { rule: 'gone', kind: 'expression', value: 'cry.exp3.json' },
    ]);
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
