// Reading and writing the `rules:` section of ojakgyo.yaml for the dashboard rule editor.
// Rules travel as written in the file (with `${VAR}` placeholders), so saving from the
// dashboard never bakes secrets from the environment into the file.
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Document, isMap, isScalar, isSeq, parseDocument, visit } from 'yaml';
import type { z } from 'zod';
import { ActionSchema } from './config.js';

export interface FieldSpec {
  key: string;
  kind: 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'record';
  required: boolean;
  default?: unknown;
  options?: string[];
  min?: number;
  max?: number;
}

export interface ActionSpec {
  type: string;
  fields: FieldSpec[];
}

type AnySchema = z.ZodType & { def: { type: string; innerType?: AnySchema }; options?: string[]; minValue?: number | null; maxValue?: number | null };

function describe(key: string, schema: AnySchema): FieldSpec {
  const probe = schema.safeParse(undefined);
  let inner = schema;
  while (['default', 'optional', 'nullable', 'prefault'].includes(inner.def.type) && inner.def.innerType) inner = inner.def.innerType;
  const kind = inner.def.type as FieldSpec['kind'];
  const spec: FieldSpec = { key, kind, required: !probe.success };
  if (probe.success && probe.data !== undefined) spec.default = probe.data;
  if (kind === 'enum' && inner.options) spec.options = [...inner.options];
  if (kind === 'number') {
    if (Number.isFinite(inner.minValue)) spec.min = inner.minValue as number;
    if (Number.isFinite(inner.maxValue)) spec.max = inner.maxValue as number;
  }
  return spec;
}

/** Every action type with its fields, read from the config schema so the form cannot drift. */
export function actionCatalog(): ActionSpec[] {
  return ActionSchema.options.map((option) => {
    const shape = option.shape as Record<string, AnySchema>;
    const type = (shape.type as unknown as { value: string }).value;
    return { type, fields: Object.entries(shape).filter(([k]) => k !== 'type').map(([k, s]) => describe(k, s)) };
  });
}

const CATALOG = new Map(actionCatalog().map((a) => [a.type, a]));

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A rule as it should be written: defaults and blanks left out, keys in the usual order. */
export function compactRule(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { name: raw.name };
  if (raw.enabled === false) out.enabled = false;
  const on = Array.isArray(raw.on) ? raw.on : [raw.on];
  out.on = on.length === 1 ? on[0] : on;
  const when = Object.fromEntries(Object.entries((raw.when as Record<string, unknown>) ?? {}).filter(([, v]) => !isEmpty(v)));
  if (Object.keys(when).length) out.when = when;
  if (typeof raw.cooldown === 'number' && raw.cooldown > 0) out.cooldown = raw.cooldown;
  if (raw.stop === true) out.stop = true;
  out.actions = ((raw.actions as Record<string, unknown>[]) ?? []).map((a) => {
    const spec = CATALOG.get(String(a.type));
    const action: Record<string, unknown> = { type: a.type };
    for (const field of spec?.fields ?? []) {
      const v = a[field.key];
      if (isEmpty(v)) continue;
      if ('default' in field && same(v, field.default)) continue;
      action[field.key] = v;
    }
    return action;
  });
  return out;
}

/** The `rules:` list exactly as written in the file, placeholders and all. */
export function readRulesFromFile(path: string): Record<string, unknown>[] {
  const doc = parseDocument(readFileSync(path, 'utf8'));
  if (doc.errors.length) throw new Error(`ojakgyo.yaml has a syntax error: ${doc.errors[0]!.message}`);
  const rules = doc.toJS()?.rules;
  return Array.isArray(rules) ? rules : [];
}

/** `rules:` and its list as YAML text, short lists and conditions on one line like the example config. */
export function rulesSection(rules: Record<string, unknown>[]): string {
  const doc = new Document({});
  const node = doc.createNode(rules.map(compactRule));
  visit(node, {
    Seq(_, seq) {
      if (seq.items.every((i) => isScalar(i))) seq.flow = true;
    },
    Pair(_, pair) {
      if (isScalar(pair.key) && pair.key.value === 'when' && isMap(pair.value)) {
        pair.value.flow = pair.value.items.every((i) => isScalar(i.value) || (isSeq(i.value) && i.value.items.every((s) => isScalar(s))));
      }
    },
  });
  doc.set('rules', node);
  return doc.toString({ lineWidth: 0 });
}

/**
 * New file text with only the `rules:` section swapped. Everything else stays byte for byte:
 * comments, their alignment, quoting and line endings. Comments inside the old section go.
 */
export function replaceRulesSection(text: string, rules: Record<string, unknown>[]): string {
  const crlf = text.includes('\r\n');
  let section = rulesSection(rules);
  if (crlf) section = section.replace(/\n/g, '\r\n');
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`ojakgyo.yaml has a syntax error, fix it by hand first: ${doc.errors[0]!.message}`);
  const nl = crlf ? '\r\n' : '\n';
  let out: string;
  const root = doc.contents;
  const pair = isMap(root) && !root.flow ? root.items.find((p) => isScalar(p.key) && p.key.value === 'rules') : undefined;
  if (pair && isScalar(pair.key) && pair.key.range) {
    const start = pair.key.range[0];
    const value = pair.value as { range?: [number, number, number] } | null;
    const end = value?.range ? value.range[2] : pair.key.range[2];
    let rest = text.slice(end);
    // `rules:` or `rules: []` without its own line break: the section brings one.
    if (!text.slice(start, end).endsWith('\n') && rest.startsWith(nl)) rest = rest.slice(nl.length);
    out = text.slice(0, start) + section + rest;
  } else if (root === null || (isMap(root) && !root.flow)) {
    out = text.trim() ? `${text}${text.endsWith('\n') ? '' : nl}${nl}${section}` : section;
  } else {
    throw new Error('ojakgyo.yaml is not a plain key: value file, so the rules cannot be written into it');
  }
  // Belt and braces: the result must parse and hold exactly the new rules.
  const check = parseDocument(out);
  if (check.errors.length || JSON.stringify(check.toJS()?.rules) !== JSON.stringify(rules.map(compactRule))) {
    throw new Error('could not rewrite the rules section safely; ojakgyo.yaml was left unchanged');
  }
  return out;
}

/** Replace the `rules:` section on disk; the previous file is kept as `<name>.bak`, the write is atomic. */
export function writeRulesToFile(path: string, rules: Record<string, unknown>[]): void {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const out = replaceRulesSection(text, rules);
  if (text) copyFileSync(path, `${path}.bak`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, out);
  renameSync(tmp, path);
}
