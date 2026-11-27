import type { Hub } from '../core/hub.js';
import { createLogger, errorMessage } from '../core/logger.js';
import type { KeyValueStore } from '../core/store.js';
import { ManagedSocket } from './managed-socket.js';

/**
 * VTube Studio Public API client.
 * Spec: https://github.com/DenchiSoft/VTubeStudio (websocket, default ws://localhost:8001)
 */

const PLUGIN = { pluginName: 'Ojakgyo', pluginDeveloper: 'Ojakgyo Contributors' } as const;
const TOKEN_KEY = 'vts.token';

/** Error ids from DenchiSoft/VTubeStudio Files/ErrorID.cs that ojakgyo reacts to. */
export const VTS_ERROR = {
  hotkeyQueueFull: 200,
  hotkeyCooldown: 203,
  injectParamNotFound: 453,
  injectParamControlledByOtherPlugin: 454,
} as const;

/**
 * Hotkeys: VTS runs one queued hotkey every 5 frames, keeps at most 32 waiting, and refuses the same
 * hotkey twice within 5 frames. During a burst of donations ojakgyo waits and retries instead of dropping.
 */
const HOTKEY_RETRY_FOR_MS = 8_000;
const HOTKEY_MAX_WAITING = 64;

interface VtsMessage {
  apiName?: string;
  requestID?: string;
  messageType?: string;
  data?: Record<string, unknown>;
}

export class VtsApiError extends Error {
  constructor(
    message: string,
    readonly errorID: number,
  ) {
    super(message);
  }
}

export type LipSyncMode = 'auto' | 'set' | 'add';

export interface LipSyncOptions {
  enabled: boolean;
  /** A VTube Studio input parameter, e.g. MouthOpen. */
  parameter: string;
  gain: number;
  /** auto: "set", falling back to "add" when another plugin already sets the parameter. */
  mode?: LipSyncMode;
}

export interface VtsModel {
  id: string;
  name: string;
}

export interface VtsHotkey {
  name: string;
  hotkeyID: string;
  type: string;
  file: string;
}

export interface ItemOptions {
  file: string;
  x: number;
  y: number;
  size: number;
  rotation: number;
}

export function hexToRgba(hex: string): { r: number; g: number; b: number; a: number } {
  const h = hex.replace('#', '');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 255 };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class VTubeStudio extends ManagedSocket {
  private mouthTimer: NodeJS.Timeout | null = null;
  private mouthValue = 0;
  private mouthUntil = 0;
  /** How lip-sync values are injected on this connection ("auto" starts as "set"). */
  private injectMode: 'set' | 'add' = 'set';
  /** Set when lip-sync cannot work on this connection; cleared on reconnect. */
  private injectStopped = false;
  private model: VtsModel | null = null;
  private readonly modelListeners = new Set<(model: VtsModel | null) => void>();
  private hotkeysWaiting = 0;

  constructor(
    url: string,
    hub: Hub,
    private readonly store: KeyValueStore,
    private readonly lipSync: LipSyncOptions,
  ) {
    super(url, hub, 'vts', 'VTube Studio', createLogger('vts'));
  }

  /** The model loaded in VTube Studio, or null when none is (or not connected). */
  get currentModel(): VtsModel | null {
    return this.isReady ? this.model : null;
  }

  /** Called with the new model whenever VTube Studio loads or unloads one. Returns an unsubscribe function. */
  onModelChange(listener: (model: VtsModel | null) => void): () => void {
    this.modelListeners.add(listener);
    return () => this.modelListeners.delete(listener);
  }

  /** Send any VTS API request and resolve with its `data`. */
  request<T = Record<string, unknown>>(messageType: string, data: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    const requestID = this.nextId('vts');
    const response = this.expect<T>(requestID, timeoutMs);
    this.sendJson({ apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', requestID, messageType, data });
    return response;
  }

  protected onMessage(message: unknown): void {
    const msg = message as VtsMessage;
    // Subscribed events arrive unasked; responses (including EventSubscriptionResponse) settle a request.
    if (msg.messageType?.endsWith('Event')) {
      this.onEvent(msg.messageType, msg.data ?? {});
      return;
    }
    if (!msg.requestID) return;
    if (msg.messageType === 'APIError') {
      const errorID = Number(msg.data?.errorID ?? -1);
      const reason = String(msg.data?.message ?? 'unknown error');
      this.settle(msg.requestID, new VtsApiError(`VTube Studio: ${reason} (errorID ${errorID})`, errorID));
    } else {
      this.settle(msg.requestID, null, msg.data ?? {});
    }
  }

  protected async handshake(): Promise<void> {
    this.injectMode = this.lipSync.mode === 'add' ? 'add' : 'set';
    this.injectStopped = false;
    this.model = null;

    let token = this.store.get<string>(TOKEN_KEY);
    if (token && (await this.authenticate(token))) return;

    this.log.info('requesting plugin access, click "Allow" in VTube Studio');
    this.status('action-needed', 'Click "Allow" in VTube Studio');
    const res = await this.request<{ authenticationToken: string }>('AuthenticationTokenRequest', { ...PLUGIN }, 120_000);
    token = res.authenticationToken;
    this.store.set(TOKEN_KEY, token);
    if (!(await this.authenticate(token))) throw new Error('VTube Studio rejected the plugin token');
  }

  /** After connecting: follow model swaps, learn the current model, check the lip-sync parameter. */
  protected override async onReady(): Promise<void> {
    try {
      await this.request('EventSubscriptionRequest', { eventName: 'ModelLoadedEvent', subscribe: true, config: {} });
    } catch (err) {
      this.log.debug(`could not subscribe to model changes: ${errorMessage(err)}`);
    }
    const current = await this.request<{ modelLoaded: boolean; modelName: string; modelID: string }>('CurrentModelRequest');
    this.setModel(current.modelLoaded ? { id: current.modelID, name: current.modelName } : null);
    if (this.lipSync.enabled) await this.checkLipSyncParameter();
  }

  private async authenticate(authenticationToken: string): Promise<boolean> {
    const res = await this.request<{ authenticated: boolean }>('AuthenticationRequest', { ...PLUGIN, authenticationToken });
    if (!res.authenticated) this.store.delete(TOKEN_KEY);
    return res.authenticated;
  }

  private onEvent(type: string, data: Record<string, unknown>): void {
    if (type !== 'ModelLoadedEvent') return;
    this.setModel(data.modelLoaded ? { id: String(data.modelID ?? ''), name: String(data.modelName ?? '') } : null);
  }

  private setModel(model: VtsModel | null): void {
    const changed = model?.id !== this.model?.id;
    this.model = model;
    if (!this.isReady) return;
    this.status('connected', model ? `Model: ${model.name}` : 'No model loaded');
    if (!changed) return;
    this.log.info(model ? `model: ${model.name}` : 'no model loaded');
    for (const listener of this.modelListeners) {
      try {
        listener(model);
      } catch (err) {
        this.log.debug(`model listener failed: ${errorMessage(err)}`);
      }
    }
  }

  /** Hotkeys of the loaded model. */
  async hotkeys(): Promise<VtsHotkey[]> {
    this.assertReady();
    const res = await this.request<{ availableHotkeys?: VtsHotkey[] }>('HotkeysInCurrentModelRequest');
    return res.availableHotkeys ?? [];
  }

  /** Expression files (`*.exp3.json`) of the loaded model. */
  async expressionFiles(): Promise<string[]> {
    this.assertReady();
    const res = await this.request<{ expressions?: { file: string }[] }>('ExpressionStateRequest', { details: false });
    return (res.expressions ?? []).map((e) => e.file.trim());
  }

  async hotkey(nameOrId: string): Promise<void> {
    this.assertReady();
    if (this.hotkeysWaiting >= HOTKEY_MAX_WAITING) {
      throw new Error(`skipped hotkey "${nameOrId}": ${HOTKEY_MAX_WAITING} hotkeys are already waiting for VTube Studio`);
    }
    this.hotkeysWaiting++;
    try {
      const giveUpAt = Date.now() + HOTKEY_RETRY_FOR_MS;
      for (;;) {
        try {
          // The API accepts either the hotkey's unique id or its name.
          await this.request('HotkeyTriggerRequest', { hotkeyID: nameOrId });
          return;
        } catch (err) {
          const busy = err instanceof VtsApiError && (err.errorID === VTS_ERROR.hotkeyCooldown || err.errorID === VTS_ERROR.hotkeyQueueFull);
          if (!busy || !this.isReady || Date.now() >= giveUpAt) throw err;
          await sleep(err.errorID === VTS_ERROR.hotkeyCooldown ? 120 : 250);
        }
      }
    } finally {
      this.hotkeysWaiting--;
    }
  }

  async expression(file: string, active: boolean, fadeTime = 0.25): Promise<void> {
    this.assertReady();
    await this.request('ExpressionActivationRequest', { expressionFile: file, active, fadeTime });
  }

  async loadItem(opts: ItemOptions): Promise<string> {
    this.assertReady();
    const res = await this.request<{ instanceID: string }>('ItemLoadRequest', {
      fileName: opts.file,
      positionX: opts.x,
      positionY: opts.y,
      size: opts.size,
      rotation: opts.rotation,
      fadeTime: 0.4,
      order: 30,
      failIfOrderTaken: false,
      smoothing: 0,
      censored: false,
      flipped: false,
      locked: false,
      unloadWhenPluginDisconnects: true,
    });
    return res.instanceID;
  }

  async unloadItem(instanceID: string): Promise<void> {
    if (!this.isReady) return;
    await this.request('ItemUnloadRequest', {
      unloadAllInScene: false,
      unloadAllLoadedByThisPlugin: false,
      allowUnloadingItemsLoadedByUserOrOtherPlugins: false,
      instanceIDs: [instanceID],
    });
  }

  async tint(hex: string | null, meshes?: string[]): Promise<void> {
    this.assertReady();
    const c = hex ? hexToRgba(hex) : { r: 255, g: 255, b: 255, a: 255 };
    await this.request('ColorTintRequest', {
      colorTint: { colorR: c.r, colorG: c.g, colorB: c.b, colorA: c.a, mixWithSceneLightingColor: 1 },
      artMeshMatcher: meshes?.length ? { tintAll: false, nameContains: meshes } : { tintAll: true },
    });
  }

  /**
   * Drive the mouth from TTS audio levels (0..1). Values are re-sent at 30 Hz
   * while audio plays, because VTS releases an injected parameter after 1 s.
   */
  setMouth(level: number): void {
    if (!this.lipSync.enabled || !this.isReady || this.injectStopped) return;
    this.mouthValue = Math.max(0, Math.min(1, level * this.lipSync.gain));
    this.mouthUntil = Date.now() + 400;
    if (this.mouthTimer) return;
    this.mouthTimer = setInterval(() => {
      const active = Date.now() < this.mouthUntil;
      if (this.isReady && !this.injectStopped) this.injectMouth(active ? this.mouthValue : 0);
      if ((!active || this.injectStopped) && this.mouthTimer) {
        clearInterval(this.mouthTimer);
        this.mouthTimer = null;
      }
    }, 33);
  }

  private injectMouth(value: number): void {
    const mode = this.injectMode;
    this.request('InjectParameterDataRequest', {
      faceFound: false,
      mode,
      parameterValues: [{ id: this.lipSync.parameter, value }],
    }).catch((err) => this.onInjectError(err, mode));
  }

  /**
   * "set" lets only one plugin write a parameter. When another plugin (VBridger, for example) already
   * sets the lip-sync parameter, mode "auto" switches to "add" so the TTS mouth rides on top of it.
   * Anything else stops lip-sync until the next connect, with one warning instead of 30 per second.
   */
  private onInjectError(err: unknown, mode: 'set' | 'add'): void {
    if (this.injectStopped || mode !== this.injectMode || !this.isReady) return;
    const id = err instanceof VtsApiError ? err.errorID : -1;
    const param = this.lipSync.parameter;
    if (mode === 'set' && id === VTS_ERROR.injectParamControlledByOtherPlugin && (this.lipSync.mode ?? 'auto') === 'auto') {
      this.injectMode = 'add';
      this.log.warn(`another plugin already sets "${param}" (VBridger?), so TTS lip-sync now adds to it instead`);
      return;
    }
    this.injectStopped = true;
    let hint = '';
    if (id === VTS_ERROR.injectParamNotFound) hint = ` "${param}" is not a VTube Studio input parameter; check outputs.vtubeStudio.lipSync.parameter.`;
    else if (id === VTS_ERROR.injectParamControlledByOtherPlugin) hint = ' Another plugin controls this parameter; set outputs.vtubeStudio.lipSync.mode to auto or add.';
    this.log.warn(`TTS lip-sync stopped until VTube Studio reconnects: ${errorMessage(err)}.${hint}`);
  }

  /** Warn once at connect when the configured lip-sync parameter does not exist. */
  private async checkLipSyncParameter(): Promise<void> {
    const res = await this.request<{ customParameters?: { name: string }[]; defaultParameters?: { name: string }[] }>('InputParameterListRequest');
    const names = [...(res.defaultParameters ?? []), ...(res.customParameters ?? [])].map((p) => p.name);
    if (names.length && !names.includes(this.lipSync.parameter)) {
      const close = names.find((n) => n.toLowerCase() === this.lipSync.parameter.toLowerCase());
      this.log.warn(`lip-sync parameter "${this.lipSync.parameter}" is not a VTube Studio input parameter${close ? ` (did you mean "${close}"?)` : '; MouthOpen is the usual one'}`);
    }
  }
}
