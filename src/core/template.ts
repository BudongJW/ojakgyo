import { actorName, type OjakgyoEvent } from './events.js';

const won = new Intl.NumberFormat('ko-KR');

/** All variables a template may use, resolved for one event. */
export function templateVars(event: OjakgyoEvent, anonymousName?: string): Record<string, string> {
  const vars: Record<string, string> = {
    type: event.type,
    platform: event.platform,
    nickname: actorName(event, anonymousName),
    message: event.message,
    role: event.user?.role ?? 'viewer',
    amount: '',
    amountRaw: '',
    tier: '',
    months: '',
  };
  if (event.type === 'donation') {
    vars.amount = won.format(event.amount);
    vars.amountRaw = String(event.amount);
  }
  if (event.type === 'subscription') {
    vars.tier = String(event.tier);
    vars.months = String(event.months);
  }
  return vars;
}

/**
 * Render `{variable}` placeholders. Unknown placeholders are left untouched so
 * typos are visible on stream instead of silently disappearing.
 */
export function render(template: string, event: OjakgyoEvent, anonymousName?: string): string {
  const vars = templateVars(event, anonymousName);
  return template.replace(/\{([a-zA-Z]+)\}/g, (whole, key: string) => (key in vars ? vars[key]! : whole));
}

/** Render every string inside a JSON-like value. */
export function renderDeep(value: unknown, event: OjakgyoEvent, anonymousName?: string): unknown {
  if (typeof value === 'string') return render(value, event, anonymousName);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, event, anonymousName));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, event, anonymousName)]));
  }
  return value;
}
