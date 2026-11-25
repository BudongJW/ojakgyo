import { createHash } from 'node:crypto';
import type { Hub } from '../core/hub.js';
import { createLogger } from '../core/logger.js';
import { ManagedSocket } from './managed-socket.js';

/**
 * obs-websocket v5 client (built into OBS Studio 28+).
 * Spec: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
 */

const OP = { Hello: 0, Identify: 1, Identified: 2, Request: 6, RequestResponse: 7 } as const;

interface ObsMessage {
  op: number;
  d: Record<string, unknown>;
}

/** base64(sha256(base64(sha256(password + salt)) + challenge)) */
export function obsAuthString(password: string, salt: string, challenge: string): string {
  const secret = createHash('sha256').update(password + salt).digest('base64');
  return createHash('sha256').update(secret + challenge).digest('base64');
}

export class Obs extends ManagedSocket {
  private hello: ((d: Record<string, unknown>) => void) | null = null;
  private identified: (() => void) | null = null;

  constructor(
    url: string,
    hub: Hub,
    private readonly password: string,
  ) {
    super(url, hub, 'obs', 'OBS', createLogger('obs'));
  }

  protected onMessage(message: unknown): void {
    const msg = message as ObsMessage;
    if (msg.op === OP.Hello) this.hello?.(msg.d);
    else if (msg.op === OP.Identified) this.identified?.();
    else if (msg.op === OP.RequestResponse) {
      const id = String(msg.d.requestId);
      const status = msg.d.requestStatus as { result: boolean; code: number; comment?: string };
      if (status?.result) this.settle(id, null, msg.d.responseData ?? {});
      else this.settle(id, new Error(`OBS ${String(msg.d.requestType)}: ${status?.comment ?? `code ${status?.code}`}`));
    }
  }

  protected async handshake(): Promise<void> {
    const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no Hello from OBS')), 5_000);
      this.hello = (d) => {
        clearTimeout(timer);
        resolve(d);
      };
    });
    this.hello = null;

    const auth = hello.authentication as { challenge: string; salt: string } | undefined;
    if (auth && !this.password) throw new Error('OBS requires a password (outputs.obs.password)');

    const identified = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OBS did not accept Identify (wrong password?)')), 5_000);
      this.identified = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.sendJson({
      op: OP.Identify,
      d: {
        rpcVersion: 1,
        eventSubscriptions: 0,
        ...(auth ? { authentication: obsAuthString(this.password, auth.salt, auth.challenge) } : {}),
      },
    });
    await identified;
    this.identified = null;
  }

  request<T = Record<string, unknown>>(requestType: string, requestData: Record<string, unknown> = {}): Promise<T> {
    const requestId = this.nextId('obs');
    const response = this.expect<T>(requestId);
    this.sendJson({ op: OP.Request, d: { requestType, requestId, requestData } });
    return response;
  }

  async currentScene(): Promise<string> {
    const res = await this.request<{ currentProgramSceneName?: string; sceneName?: string }>('GetCurrentProgramScene');
    return res.currentProgramSceneName ?? res.sceneName ?? '';
  }

  async setScene(sceneName: string): Promise<void> {
    this.assertReady();
    await this.request('SetCurrentProgramScene', { sceneName });
  }

  async setSourceVisible(sceneName: string, sourceName: string, visible: boolean): Promise<void> {
    this.assertReady();
    const { sceneItemId } = await this.request<{ sceneItemId: number }>('GetSceneItemId', { sceneName, sourceName });
    await this.request('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: visible });
  }

  async setFilterEnabled(sourceName: string, filterName: string, filterEnabled: boolean): Promise<void> {
    this.assertReady();
    await this.request('SetSourceFilterEnabled', { sourceName, filterName, filterEnabled });
  }
}
