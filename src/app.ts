import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { describeLicense, readAvatarLicense, type AvatarLicense } from './avatar/license.js';
import { validateRules, type Action, type LoadedConfig, type Rule } from './config.js';
import { ChzzkConnector } from './connectors/chzzk/connector.js';
import { EVENT_TYPES, newEventId, ROLES, type EventType, type OjakgyoEvent } from './core/events.js';
import { Hub } from './core/hub.js';
import { createLogger, errorMessage } from './core/logger.js';
import { matchRule, RuleEngine } from './core/rules.js';
import { FileStore, type KeyValueStore } from './core/store.js';
import { render, renderDeep } from './core/template.js';
import { Obs } from './outputs/obs.js';
import { TtsService } from './outputs/tts.js';
import { missingVtsReferences, type MissingVtsReference } from './outputs/vts-references.js';
import { VTubeStudio } from './outputs/vtube-studio.js';
import { actionCatalog, compactRule, readRulesFromFile, writeRulesToFile } from './rules-file.js';
import { OverlayServer, type RulesApiResult } from './server/http.js';
import { VERSION } from './version.js';

const log = createLogger('ojakgyo');

export interface AppOptions {
  store?: KeyValueStore;
}

/** Wires connectors → hub → rule engine → outputs. */
export class App {
  readonly hub = new Hub();
  readonly engine: RuleEngine;
  readonly server: OverlayServer;
  readonly tts: TtsService;
  readonly vts: VTubeStudio | null;
  readonly obs: Obs | null;
  readonly chzzk: ChzzkConnector | null;
  private readonly store: KeyValueStore;

  constructor(
    private readonly loaded: LoadedConfig,
    opts: AppOptions = {},
  ) {
    const { config } = loaded;
    this.store = opts.store ?? new FileStore(loaded.dataDir);
    this.engine = new RuleEngine(config.rules);
    this.tts = new TtsService(config.outputs.tts);

    const vtsCfg = config.outputs.vtubeStudio;
    this.vts = vtsCfg.enabled ? new VTubeStudio(vtsCfg.url, this.hub, this.store, vtsCfg.lipSync) : null;
    this.vts?.onModelChange((model) => {
      if (model) void this.checkVtsReferences();
    });
    const obsCfg = config.outputs.obs;
    this.obs = obsCfg.enabled ? new Obs(obsCfg.url, this.hub, obsCfg.password) : null;

    const { host, port } = config.server;
    const localOrigin = `http://localhost:${port}`;
    this.chzzk = config.platforms.chzzk.enabled
      ? new ChzzkConnector({
          config: config.platforms.chzzk,
          hub: this.hub,
          store: this.store,
          redirectUri: `${localOrigin}/auth/chzzk/callback`,
          loginUrl: `${localOrigin}/auth/chzzk`,
        })
      : null;

    const modelPath = this.avatarModelPath();
    this.server = new OverlayServer(host, port, {
      hub: this.hub,
      version: VERSION,
      ttsClip: (id) => this.tts.clip(id),
      onMouth: (level) => this.vts?.setMouth(level),
      simulate: (input) => this.simulate(input),
      avatar: {
        enabled: config.outputs.avatar.enabled,
        view: config.outputs.avatar.view,
        lipSync: config.outputs.avatar.lipSync,
        modelPath,
        license: this.avatarLicense(modelPath),
      },
      faceModel: () => this.faceModel(),
      rules: {
        state: () => this.rulesState(),
        save: (raw) => this.saveRules(raw),
        tryRule: (raw) => this.tryRule(raw),
      },
      ...(this.chzzk ? { chzzk: this.chzzk } : {}),
    });

    this.registerActions();
    this.hub.on('event', (event) => {
      void this.engine.dispatch(event).catch((err) => log.error(`rule dispatch failed: ${errorMessage(err)}`));
    });
  }

  /** Resolve `outputs.avatar.model` relative to the config file; warn early if it is missing. */
  private avatarModelPath(): string | null {
    const { avatar } = this.loaded.config.outputs;
    if (!avatar.enabled) return null;
    if (!avatar.model) {
      log.warn('outputs.avatar is enabled but no model is set. Point outputs.avatar.model at a .vrm, .inp or .inx file.');
      return null;
    }
    const base = this.loaded.path ? dirname(this.loaded.path) : process.cwd();
    const file = isAbsolute(avatar.model) ? avatar.model : resolve(base, avatar.model);
    if (!existsSync(file)) log.warn(`avatar model not found: ${file}`);
    else if (!/\.(vrm|glb|inp|inx)$/i.test(file)) log.warn(`avatar model should be a .vrm (3D) or .inp / .inx (Inochi2D) file: ${file}`);
    return file;
  }

  /** Read the usage terms stored in the model and say what they mean for a monetized stream. */
  private avatarLicense(file: string | null): AvatarLicense | null {
    if (!file || !existsSync(file)) return null;
    let license: AvatarLicense;
    try {
      license = readAvatarLicense(file);
    } catch (err) {
      log.warn(`could not read the avatar's license: ${errorMessage(err)}`);
      return null;
    }
    const summary = `avatar license: ${describeLicense(license)}`;
    if (license.verdict === 'ok') log.info(summary);
    else log.warn(summary);
    for (const n of license.notes) {
      const line = `  ${n.text}${n.url ? ` (${n.url})` : ''}`;
      if (n.level === 'info') log.info(line);
      else log.warn(line);
    }
    return license;
  }

  private faceModelDownload: Promise<string> | null = null;

  /** MediaPipe face model, fetched once from outputs.avatar.faceModelUrl and cached on disk. */
  faceModel(): Promise<string> {
    const file = join(this.loaded.dataDir, 'models', 'face_landmarker.task');
    if (existsSync(file) && statSync(file).size > 0) return Promise.resolve(file);
    this.faceModelDownload ??= (async () => {
      const url = this.loaded.config.outputs.avatar.faceModelUrl;
      log.info(`downloading the face tracking model (first use only) from ${new URL(url).host}`);
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length < 1024) throw new Error('model download looks truncated');
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, data);
      renameSync(tmp, file);
      log.info(`face model cached (${(data.length / 1048576).toFixed(1)} MB)`);
      return file;
    })().finally(() => {
      this.faceModelDownload = null;
    });
    return this.faceModelDownload;
  }

  async start(): Promise<void> {
    await this.server.listen();
    if (!this.chzzk) this.hub.setStatus('chzzk', 'CHZZK', 'disabled');
    if (!this.vts) this.hub.setStatus('vts', 'VTube Studio', 'disabled');
    if (!this.obs) this.hub.setStatus('obs', 'OBS', 'disabled');
    this.chzzk?.start();
    this.vts?.start();
    this.obs?.start();
  }

  async stop(): Promise<void> {
    this.chzzk?.stop();
    this.vts?.stop();
    this.obs?.stop();
    await this.server.close();
  }

  /* ── dashboard rule editor ── */

  /** Rules as written in the config file, plus what the editor needs to build its form. */
  rulesState(): Record<string, unknown> {
    const base = { catalog: actionCatalog(), events: EVENT_TYPES, roles: ROLES };
    const path = this.loaded.path;
    const fromConfig = () => this.loaded.config.rules.map((r) => compactRule(r as unknown as Record<string, unknown>));
    if (!path) return { ...base, rules: fromConfig(), file: null, writable: false };
    try {
      return { ...base, rules: readRulesFromFile(path), file: basename(path), writable: true };
    } catch (err) {
      return { ...base, rules: fromConfig(), file: basename(path), writable: false, error: errorMessage(err) };
    }
  }

  /** Validate, write back to ojakgyo.yaml and apply at once. */
  saveRules(raw: unknown): RulesApiResult {
    const path = this.loaded.path;
    if (!path) return { status: 409, body: { error: 'ojakgyo is running without a config file, so there is nowhere to save. Start it next to an ojakgyo.yaml (or with -c).' } };
    if (!Array.isArray(raw)) return { status: 400, body: { error: 'expected { rules: [...] }' } };
    const result = validateRules(raw);
    if (!result.ok) return { status: 400, body: { error: 'Some rules are not valid.', issues: result.issues } };
    try {
      writeRulesToFile(path, raw as Record<string, unknown>[]);
    } catch (err) {
      return { status: 500, body: { error: errorMessage(err) } };
    }
    this.engine.setRules(result.rules);
    this.loaded.config.rules = result.rules;
    log.info(`rules saved to ${basename(path)} and applied (${result.rules.length} rule${result.rules.length === 1 ? '' : 's'})`);
    void this.checkVtsReferences();
    return { status: 200, body: { ok: true, rules: readRulesFromFile(path) } };
  }

  /**
   * Warn when a rule names a VTube Studio hotkey or expression the loaded model does not have.
   * Runs on connect, on every model swap and after the rule editor saves.
   */
  async checkVtsReferences(): Promise<MissingVtsReference[]> {
    const vts = this.vts;
    const model = vts?.currentModel;
    if (!vts || !model) return [];
    const rules = this.loaded.config.rules;
    if (!rules.some((r) => r.actions.some((a) => a.type === 'vts.hotkey' || a.type === 'vts.expression'))) return [];
    try {
      const [hotkeys, files] = await Promise.all([vts.hotkeys(), vts.expressionFiles()]);
      if (vts.currentModel?.id !== model.id) return []; // swapped again meanwhile; that swap checks itself
      const missing = missingVtsReferences(rules, hotkeys, files);
      for (const m of missing) {
        log.warn(`rule "${m.rule}": VTube Studio model "${model.name}" has no ${m.kind} "${m.value}"${m.suggestion ? ` (did you mean "${m.suggestion}"?)` : ''}`);
      }
      if (!missing.length) log.info(`VTube Studio model "${model.name}" has every hotkey and expression your rules use`);
      return missing;
    } catch (err) {
      log.debug(`could not check VTube Studio hotkeys: ${errorMessage(err)}`);
      return [];
    }
  }

  /** Run one rule (saved or not) once with a sample event that fits its conditions. */
  tryRule(raw: unknown): RulesApiResult {
    const result = validateRules([raw]);
    if (!result.ok) return { status: 400, body: { error: 'This rule is not valid yet.', issues: result.issues.map((i) => ({ ...i, path: i.path.slice(1) })) } };
    const rule = { ...result.rules[0]!, enabled: true };
    const event = this.buildEvent(sampleInput(rule));
    void this.engine.fire(rule, event).catch((err) => log.warn(`try failed: ${errorMessage(err)}`));
    return { status: 200, body: { ok: true, matched: matchRule(rule, event), event } };
  }

  /** Inject a fake event, from the dashboard or `ojakgyo simulate`. */
  simulate(input: Record<string, unknown>): OjakgyoEvent {
    const event = this.buildEvent(input);
    this.hub.publish(event);
    return event;
  }

  private buildEvent(input: Record<string, unknown>): OjakgyoEvent {
    const type = String(input.type ?? 'donation') as EventType;
    const nickname = String(input.nickname ?? '').trim() || '테스트시청자';
    const message = String(input.message ?? '');
    const base = { id: newEventId(), platform: 'mock' as const, channelId: 'mock', receivedAt: Date.now() };
    const role = (['streamer', 'manager', 'chat_manager', 'viewer'] as const).find((r) => r === input.role) ?? 'viewer';
    let event: OjakgyoEvent;
    switch (type) {
      case 'chat':
        event = { ...base, type, user: { nickname, role }, message, emojis: {} };
        break;
      case 'donation': {
        const amount = Math.max(0, Math.round(Number(input.amount ?? 1000)) || 0);
        const anonymous = input.anonymous === true;
        event = {
          ...base,
          type,
          user: anonymous ? null : { nickname, role },
          amount,
          currency: 'KRW',
          kind: 'chat',
          message,
          emojis: {},
        };
        break;
      }
      case 'subscription':
        event = {
          ...base,
          type,
          user: { nickname, role },
          tier: Math.max(1, Number(input.tier ?? 1) || 1),
          months: Math.max(1, Number(input.months ?? 1) || 1),
          message,
        };
        break;
      default:
        throw new Error(`unknown event type "${type}"`);
    }
    return event;
  }

  private registerActions(): void {
    const { config } = this.loaded;
    const anon = config.anonymousName;
    const t = (s: string, e: OjakgyoEvent) => render(s, e, anon);
    const later = (seconds: number | undefined, fn: () => Promise<unknown>) => {
      if (!seconds) return;
      setTimeout(() => fn().catch((err) => log.debug(`revert failed: ${errorMessage(err)}`)), seconds * 1000);
    };
    const need = <T>(output: T | null, name: string): T => {
      if (!output) throw new Error(`${name} output is disabled in ojakgyo.yaml`);
      return output;
    };

    this.engine
      .handle('overlay.alert', async (a, e) => {
        const speech = a.tts ? await this.tts.prepare(t(a.tts, e)).catch((err) => {
          log.warn(`TTS failed, showing alert without voice: ${errorMessage(err)}`);
          return null;
        }) : null;
        this.server.broadcast({
          kind: 'alert',
          id: randomUUID(),
          title: t(a.title, e),
          message: t(a.message, e),
          duration: a.duration,
          eventType: e.type,
          emojis: 'emojis' in e ? e.emojis : {},
          volume: config.outputs.tts.volume,
          ...(a.image ? { image: a.image } : {}),
          ...(a.sound ? { sound: a.sound } : {}),
          ...(a.accent ? { accent: a.accent } : {}),
          ...(speech ? { speech } : {}),
        }, 'alerts');
      })
      .handle('tts.speak', async (a, e) => {
        const speech = await this.tts.prepare(t(a.text, e), a.voice);
        if (!speech) return;
        // A voice-only alert: the overlay queues it like any other alert but draws nothing.
        this.server.broadcast({
          kind: 'alert',
          id: randomUUID(),
          title: '',
          message: '',
          duration: 0,
          eventType: e.type,
          volume: config.outputs.tts.volume,
          speech,
        }, 'alerts');
      })
      .handle('vts.hotkey', (a) => need(this.vts, 'VTube Studio').hotkey(a.hotkey))
      .handle('vts.expression', async (a) => {
        const vts = need(this.vts, 'VTube Studio');
        await vts.expression(a.file, true, a.fadeTime);
        later(a.duration, () => vts.expression(a.file, false));
      })
      .handle('vts.item', async (a) => {
        const vts = need(this.vts, 'VTube Studio');
        const id = await vts.loadItem({ file: a.file, x: a.x, y: a.y, size: a.size, rotation: a.rotation });
        later(a.duration, () => vts.unloadItem(id));
      })
      .handle('vts.tint', async (a) => {
        const vts = need(this.vts, 'VTube Studio');
        await vts.tint(a.color, a.meshes);
        later(a.duration, () => vts.tint(null, a.meshes));
      })
      .handle('obs.scene', async (a) => {
        const obs = need(this.obs, 'OBS');
        const previous = a.revertAfter ? await obs.currentScene() : '';
        await obs.setScene(a.scene);
        if (previous && previous !== a.scene) later(a.revertAfter, () => obs.setScene(previous));
      })
      .handle('obs.source', async (a) => {
        const obs = need(this.obs, 'OBS');
        await obs.setSourceVisible(a.scene, a.source, a.visible);
        later(a.duration, () => obs.setSourceVisible(a.scene, a.source, !a.visible));
      })
      .handle('obs.filter', async (a) => {
        const obs = need(this.obs, 'OBS');
        await obs.setFilterEnabled(a.source, a.filter, a.enabled);
        later(a.duration, () => obs.setFilterEnabled(a.source, a.filter, !a.enabled));
      })
      .handle('avatar.expression', (a) => {
        if (!config.outputs.avatar.enabled) throw new Error('avatar output is disabled in ojakgyo.yaml');
        if (this.server.overlayCount('avatar') === 0) log.debug('avatar.expression: no avatar overlay is open');
        this.server.broadcast({ kind: 'avatar', expression: a.expression, weight: a.weight, duration: a.duration }, 'avatar');
      })
      .handle('chat.send', async (a, e) => {
        if (e.platform === 'mock') return log.info(`[chat.send · simulated] ${t(a.message, e)}`);
        if (e.platform !== 'chzzk') throw new Error(`chat.send is not supported on ${e.platform} yet`);
        await need(this.chzzk, 'CHZZK').sendChat(t(a.message, e));
      })
      .handle('webhook', async (a: Extract<Action, { type: 'webhook' }>, e) => {
        const body = a.body ? renderDeep(a.body, e, anon) : e;
        const res = await fetch(a.url, {
          method: a.method,
          headers: { 'Content-Type': 'application/json', 'User-Agent': `ojakgyo/${VERSION}` },
          ...(a.method === 'GET' ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`webhook answered ${res.status}`);
      });
  }
}

/** A test event that a rule's conditions accept, as far as they can be guessed. */
function sampleInput(rule: Rule): Record<string, unknown> {
  const w = rule.when;
  // A plain-text pattern such as ^!hat$ doubles as the sample message.
  const literal = w.match?.replace(/^\^/, '').replace(/\$$/, '');
  return {
    type: rule.on[0],
    nickname: '테스트시청자',
    role: w.roles?.[0] ?? 'viewer',
    amount: w.amounts?.[0] ?? w.minAmount ?? Math.min(1000, w.maxAmount ?? 1000),
    tier: w.minTier ?? 1,
    months: Math.max(1, w.minMonths ?? 1),
    message: w.contains?.[0] ?? (literal && !/[.*+?()[\]{}|\\]/.test(literal) ? literal : '테스트 메시지입니다'),
  };
}
