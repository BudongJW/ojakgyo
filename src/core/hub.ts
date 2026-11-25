import { EventEmitter } from 'node:events';
import type { OjakgyoEvent } from './events.js';

export type ComponentState = 'disabled' | 'connecting' | 'connected' | 'disconnected' | 'error' | 'action-needed';

export interface ComponentStatus {
  id: string;
  label: string;
  state: ComponentState;
  detail?: string;
  /** Optional link the dashboard shows, e.g. the login URL. */
  link?: string;
  updatedAt: number;
}

interface HubEvents {
  event: [OjakgyoEvent];
  status: [ComponentStatus];
}

/**
 * Central nervous system: connectors publish events here, the rule engine and
 * the dashboard listen. Also keeps component health for the status panel.
 */
export class Hub extends EventEmitter<HubEvents> {
  private readonly statuses = new Map<string, ComponentStatus>();
  private readonly history: OjakgyoEvent[] = [];

  constructor(private readonly historySize = 100) {
    super();
    this.setMaxListeners(50);
  }

  publish(event: OjakgyoEvent): void {
    this.history.push(event);
    if (this.history.length > this.historySize) this.history.shift();
    this.emit('event', event);
  }

  setStatus(id: string, label: string, state: ComponentState, extra: { detail?: string; link?: string } = {}): void {
    const status: ComponentStatus = { id, label, state, ...extra, updatedAt: Date.now() };
    this.statuses.set(id, status);
    this.emit('status', status);
  }

  getStatuses(): ComponentStatus[] {
    return [...this.statuses.values()];
  }

  recentEvents(): OjakgyoEvent[] {
    return [...this.history];
  }
}
