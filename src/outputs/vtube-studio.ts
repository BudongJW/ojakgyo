import type { Hub } from '../core/hub.js';
import { createLogger } from '../core/logger.js';
import type { KeyValueStore } from '../core/store.js';
import { ManagedSocket } from './managed-socket.js';

/**
 * VTube Studio Public API client.
 * Spec: https://github.com/DenchiSoft/VTubeStudio (websocket, default ws://localhost:8001)
 */

const PLUGIN = { pluginName: 'Ojakgyo', pluginDeveloper: 'Ojakgyo Contributors' } as const;
const TOKEN_KEY = 'vts.token';

interface VtsMessage {
  apiName?: string;
  requestID?: string;
  messageType?: string;
  data?: Record<string, unknown>;
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

export class VTubeStudio extends ManagedSocket {
  private mouthTimer: NodeJS.Timeout | null = null;
  private mouthValue = 0;
  private mouthUntil = 0;

  constructor(
    url: string,
    hub: Hub,
    private readonly store: KeyValueStore,
    private readonly lipSync: { enabled: boolean; parameter: string; gain: number },
  ) {
    super(url, hub, 'vts', 'VTube Studio', createLogger('vts'));
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
    if (!msg.requestID) return;
    if (msg.messageType === 'APIError') {
      const reason = String(msg.data?.message ?? 'unknown error');
      this.settle(msg.requestID, new Error(`VTube Studio: ${reason} (errorID ${String(msg.data?.errorID ?? '?')})`));
    } else {
      this.settle(msg.requestID, null, msg.data ?? {});
    }
  }

  protected async handshake(): Promise<void> {
    let token = this.store.get<string>(TOKEN_KEY);
    if (token && (await this.authenticate(token))) return;

    this.log.info('requesting plugin access, click "Allow" in VTube Studio');
    this.status('action-needed', 'Click "Allow" in VTube Studio');
    const res = await this.request<{ authenticationToken: string }>('AuthenticationTokenRequest', { ...PLUGIN }, 120_000);
    token = res.authenticationToken;
    this.store.set(TOKEN_KEY, token);
    if (!(await this.authenticate(token))) throw new Error('VTube Studio rejected the plugin token');
  }

  private async authenticate(authenticationToken: string): Promise<boolean> {
    const res = await this.request<{ authenticated: boolean }>('AuthenticationRequest', { ...PLUGIN, authenticationToken });
    if (!res.authenticated) this.store.delete(TOKEN_KEY);
    return res.authenticated;
  }

  async hotkey(nameOrId: string): Promise<void> {
    this.assertReady();
    // The API accepts either the hotkey's unique id or its name.
    await this.request('HotkeyTriggerRequest', { hotkeyID: nameOrId });
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
    if (!this.lipSync.enabled || !this.isReady) return;
    this.mouthValue = Math.max(0, Math.min(1, level * this.lipSync.gain));
    this.mouthUntil = Date.now() + 400;
    if (this.mouthTimer) return;
    this.mouthTimer = setInterval(() => {
      const active = Date.now() < this.mouthUntil;
      const value = active ? this.mouthValue : 0;
      this.request('InjectParameterDataRequest', {
        faceFound: false,
        mode: 'set',
        parameterValues: [{ id: this.lipSync.parameter, value }],
      }).catch(() => {});
      if (!active && this.mouthTimer) {
        clearInterval(this.mouthTimer);
        this.mouthTimer = null;
      }
    }, 33);
  }
}
