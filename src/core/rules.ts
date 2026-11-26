import type { Action, ActionType, Rule } from '../config.js';
import type { OjakgyoEvent } from './events.js';
import { createLogger, errorMessage } from './logger.js';

const log = createLogger('rules');

/** Pure check: does this rule's trigger + conditions match the event? */
export function matchRule(rule: Rule, event: OjakgyoEvent): boolean {
  if (!rule.enabled) return false;
  if (!rule.on.includes(event.type)) return false;

  const w = rule.when;
  if (w.platforms && !w.platforms.includes(event.platform)) return false;
  if (w.roles && !w.roles.includes(event.user?.role ?? 'viewer')) return false;

  const hasAmountRule = w.minAmount !== undefined || w.maxAmount !== undefined || w.amounts !== undefined;
  if (hasAmountRule) {
    if (event.type !== 'donation') return false;
    if (w.minAmount !== undefined && event.amount < w.minAmount) return false;
    if (w.maxAmount !== undefined && event.amount > w.maxAmount) return false;
    if (w.amounts !== undefined && !w.amounts.includes(event.amount)) return false;
  }

  if (w.minTier !== undefined || w.minMonths !== undefined) {
    if (event.type !== 'subscription') return false;
    if (w.minTier !== undefined && event.tier < w.minTier) return false;
    if (w.minMonths !== undefined && event.months < w.minMonths) return false;
  }

  if (w.match !== undefined && !new RegExp(w.match, 'iu').test(event.message)) return false;
  if (w.contains !== undefined) {
    const msg = event.message.toLowerCase();
    if (!w.contains.some((needle) => msg.includes(needle.toLowerCase()))) return false;
  }
  return true;
}

export type ActionHandler<T extends ActionType = ActionType> = (
  action: Extract<Action, { type: T }>,
  event: OjakgyoEvent,
) => Promise<void> | void;

type HandlerMap = { [K in ActionType]?: ActionHandler<K> };

export interface RuleRunResult {
  rule: string;
  actions: number;
  failed: number;
}

/**
 * Evaluates rules in order for each event and runs the matching rules'
 * actions. Actions inside one rule run sequentially (so `delay` works);
 * different rules run concurrently so a slow OBS call never blocks an alert.
 */
export class RuleEngine {
  private readonly handlers: HandlerMap = {};
  private readonly lastFired = new Map<string, number>();

  constructor(
    private rules: Rule[],
    private readonly now: () => number = Date.now,
  ) {
    this.handle('delay', (a) => new Promise((r) => setTimeout(r, a.seconds * 1000)));
  }

  setRules(rules: Rule[]): void {
    this.rules = rules;
    this.lastFired.clear();
  }

  handle<K extends ActionType>(type: K, handler: ActionHandler<K>): this {
    (this.handlers as Record<string, unknown>)[type] = handler;
    return this;
  }

  /** Returns the rules that fired; resolves when all their actions finished. */
  async dispatch(event: OjakgyoEvent): Promise<RuleRunResult[]> {
    const runs: Promise<RuleRunResult>[] = [];
    for (const rule of this.rules) {
      if (!matchRule(rule, event)) continue;
      const last = this.lastFired.get(rule.name);
      const t = this.now();
      if (rule.cooldown > 0 && last !== undefined && t - last < rule.cooldown * 1000) {
        log.debug(`"${rule.name}" is cooling down`);
        continue;
      }
      this.lastFired.set(rule.name, t);
      runs.push(this.runRule(rule, event));
      if (rule.stop) break;
    }
    return Promise.all(runs);
  }

  /** Run one rule's actions for an event, skipping its conditions and cooldown (dashboard "Try"). */
  fire(rule: Rule, event: OjakgyoEvent): Promise<RuleRunResult> {
    return this.runRule(rule, event, ' (try)');
  }

  private async runRule(rule: Rule, event: OjakgyoEvent, note = ''): Promise<RuleRunResult> {
    log.info(`▶ ${rule.name}${note} ${'·'} ${event.type}${event.type === 'donation' ? ` ${event.amount}원` : ''}`);
    let failed = 0;
    for (const action of rule.actions) {
      const handler = this.handlers[action.type] as ActionHandler | undefined;
      if (!handler) {
        log.warn(`"${rule.name}": no output is enabled for ${action.type}, skipping`);
        failed++;
        continue;
      }
      try {
        await handler(action, event);
      } catch (err) {
        failed++;
        log.warn(`"${rule.name}" ${action.type} failed: ${errorMessage(err)}`);
      }
    }
    return { rule: rule.name, actions: rule.actions.length, failed };
  }
}
