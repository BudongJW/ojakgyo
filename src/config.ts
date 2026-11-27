import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { EVENT_TYPES, PLATFORMS, ROLES } from './core/events.js';

/* ------------------------------------------------------------------ actions */

const seconds = z.number().nonnegative();

const OverlayAlertAction = z.object({
  type: z.literal('overlay.alert'),
  title: z.string().default('{nickname}'),
  message: z.string().default('{message}'),
  /** URL or path (served from `web/`) of an image or GIF shown on the card. */
  image: z.string().optional(),
  /** URL or path of a sound played when the alert appears. */
  sound: z.string().optional(),
  /** Text read aloud by the configured TTS while the alert is on screen. */
  tts: z.string().optional(),
  duration: seconds.default(6),
  /** Visual accent: any CSS colour. */
  accent: z.string().optional(),
});

const TtsSpeakAction = z.object({
  type: z.literal('tts.speak'),
  text: z.string(),
  voice: z.string().optional(),
});

const VtsHotkeyAction = z.object({
  type: z.literal('vts.hotkey'),
  /** Hotkey name or unique id, as shown in VTube Studio. */
  hotkey: z.string(),
});

const VtsExpressionAction = z.object({
  type: z.literal('vts.expression'),
  /** Expression file, e.g. `smile.exp3.json`. */
  file: z.string().regex(/\.exp3\.json$/i, 'expression files end with .exp3.json'),
  /** Seconds before the expression is turned off again. Omit to leave it on. */
  duration: seconds.optional(),
  fadeTime: z.number().min(0).max(2).default(0.25),
});

const VtsItemAction = z.object({
  type: z.literal('vts.item'),
  /** File name inside the VTube Studio `Items` folder. */
  file: z.string(),
  x: z.number().min(-1000).max(1000).default(0),
  y: z.number().min(-1000).max(1000).default(0.5),
  size: z.number().min(0).max(1).default(0.32),
  rotation: z.number().default(0),
  /** Seconds before the item is removed. 0 keeps it. */
  duration: seconds.default(10),
});

const VtsTintAction = z.object({
  type: z.literal('vts.tint'),
  /** Hex colour such as `#ff6fae`. */
  color: z.string().regex(/^#?[0-9a-f]{6}([0-9a-f]{2})?$/i, 'use a hex colour like #ff6fae'),
  /** Only tint ArtMeshes whose name contains one of these strings. Omit to tint everything. */
  meshes: z.array(z.string()).optional(),
  duration: seconds.default(5),
});

const ObsSceneAction = z.object({
  type: z.literal('obs.scene'),
  scene: z.string(),
  /** Switch back to the previous scene after N seconds. */
  revertAfter: seconds.optional(),
});

const ObsSourceAction = z.object({
  type: z.literal('obs.source'),
  scene: z.string(),
  source: z.string(),
  visible: z.boolean().default(true),
  /** Flip the visibility back after N seconds. */
  duration: seconds.optional(),
});

const ObsFilterAction = z.object({
  type: z.literal('obs.filter'),
  source: z.string(),
  filter: z.string(),
  enabled: z.boolean().default(true),
  duration: seconds.optional(),
});

const AvatarExpressionAction = z.object({
  type: z.literal('avatar.expression'),
  /** VRM expression: happy, angry, sad, relaxed, surprised, or a custom name from your model. */
  expression: z.string().default('happy'),
  weight: z.number().min(0).max(1).default(1),
  /** Seconds to hold the expression before fading back. */
  duration: seconds.default(3),
});

const ChatSendAction = z.object({
  type: z.literal('chat.send'),
  /** Max 100 characters on CHZZK. */
  message: z.string(),
});

const DelayAction = z.object({
  type: z.literal('delay'),
  seconds: seconds,
});

const WebhookAction = z.object({
  type: z.literal('webhook'),
  url: z.url(),
  method: z.enum(['POST', 'PUT', 'GET']).default('POST'),
  /** JSON body. String values are rendered as templates. Defaults to the event itself. */
  body: z.record(z.string(), z.unknown()).optional(),
});

export const ActionSchema = z.discriminatedUnion('type', [
  OverlayAlertAction,
  TtsSpeakAction,
  VtsHotkeyAction,
  VtsExpressionAction,
  VtsItemAction,
  VtsTintAction,
  ObsSceneAction,
  ObsSourceAction,
  ObsFilterAction,
  AvatarExpressionAction,
  ChatSendAction,
  DelayAction,
  WebhookAction,
]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionType = Action['type'];

/* -------------------------------------------------------------------- rules */

const oneOrMany = <T extends z.ZodType>(schema: T) =>
  z.union([schema, z.array(schema).min(1)]).transform((v) => (Array.isArray(v) ? v : [v]) as z.infer<T>[]);

export const RuleSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  on: oneOrMany(z.enum(EVENT_TYPES)),
  when: z
    .object({
      minAmount: z.number().nonnegative().optional(),
      maxAmount: z.number().nonnegative().optional(),
      /** Exact amounts, e.g. [1004, 5252] for the classic "angel" donations. */
      amounts: z.array(z.number()).optional(),
      /** Case-insensitive regular expression tested against the message. */
      match: z
        .string()
        .refine((s) => {
          try {
            new RegExp(s);
            return true;
          } catch {
            return false;
          }
        }, 'invalid regular expression')
        .optional(),
      /** Message must contain at least one of these substrings. */
      contains: z.array(z.string()).optional(),
      roles: z.array(z.enum(ROLES)).optional(),
      platforms: z.array(z.enum(PLATFORMS)).optional(),
      minTier: z.number().int().positive().optional(),
      minMonths: z.number().int().nonnegative().optional(),
    })
    .default({}),
  /** Seconds before this rule may fire again. */
  cooldown: seconds.default(0),
  /** Stop evaluating later rules when this one matches. */
  stop: z.boolean().default(false),
  actions: z.array(ActionSchema).min(1),
});
export type Rule = z.infer<typeof RuleSchema>;

/* ------------------------------------------------------------------- config */

const ChzzkSchema = z.object({
  enabled: z.boolean().default(false),
  clientId: z.string().default(''),
  clientSecret: z.string().default(''),
  events: z.array(z.enum(EVENT_TYPES)).default(['chat', 'donation', 'subscription']),
  /** Override only for testing against a mock server. */
  apiBase: z.url().default('https://openapi.chzzk.naver.com'),
  authorizeUrl: z.url().default('https://chzzk.naver.com/account-interlock'),
});

const VtsSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default('ws://127.0.0.1:8001'),
  lipSync: z
    .object({
      enabled: z.boolean().default(false),
      parameter: z.string().default('MouthOpen'),
      gain: z.number().positive().default(1.6),
      /** auto: "set", or "add" on top when another plugin (e.g. VBridger) already sets the parameter. */
      mode: z.enum(['auto', 'set', 'add']).default('auto'),
    })
    .default({ enabled: false, parameter: 'MouthOpen', gain: 1.6, mode: 'auto' }),
});

const ObsSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default('ws://127.0.0.1:4455'),
  password: z.string().default(''),
});

const AvatarSchema = z.object({
  enabled: z.boolean().default(false),
  /** Path to a .vrm file (relative to this config file) shown by /overlay/avatar. */
  model: z.string().default(''),
  /** Default framing: `bust` (head and shoulders) or `full` (whole body). */
  view: z.enum(['bust', 'full']).default('bust'),
  /** Move the mouth while donation TTS plays. */
  lipSync: z.boolean().default(true),
  /** Where /tracker fetches the MediaPipe face model on first use (cached in .ojakgyo/models). */
  faceModelUrl: z
    .url()
    .default('https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'),
});

const TtsSchema = z.object({
  /**
   * - `none`: TTS disabled
   * - `browser`: the overlay speaks with the Web Speech API (no server needed)
   * - `openai`: any OpenAI-compatible `/v1/audio/speech` endpoint (local or hosted)
   * - `gpt-sovits`: GPT-SoVITS `api_v2.py` server
   */
  provider: z.enum(['none', 'browser', 'openai', 'gpt-sovits']).default('browser'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default('tts-1'),
  voice: z.string().default(''),
  language: z.string().default('ko'),
  /** GPT-SoVITS reference audio settings. */
  refAudioPath: z.string().default(''),
  promptText: z.string().default(''),
  promptLang: z.string().default('ko'),
  maxLength: z.number().int().positive().default(120),
  blockedWords: z.array(z.string()).default([]),
  /** Collapse `ㅋㅋㅋㅋㅋㅋ` to `ㅋㅋㅋ` and friends. */
  collapseRepeats: z.number().int().min(1).default(3),
  stripUrls: z.boolean().default(true),
  volume: z.number().min(0).max(1).default(1),
});

const ServerSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(7979),
});

export const ConfigSchema = z.object({
  server: ServerSchema.default(ServerSchema.parse({})),
  platforms: z
    .object({
      chzzk: ChzzkSchema.default(ChzzkSchema.parse({})),
    })
    .default({ chzzk: ChzzkSchema.parse({}) }),
  outputs: z
    .object({
      vtubeStudio: VtsSchema.default(VtsSchema.parse({})),
      obs: ObsSchema.default(ObsSchema.parse({})),
      tts: TtsSchema.default(TtsSchema.parse({})),
      avatar: AvatarSchema.default(AvatarSchema.parse({})),
    })
    .default({ vtubeStudio: VtsSchema.parse({}), obs: ObsSchema.parse({}), tts: TtsSchema.parse({}), avatar: AvatarSchema.parse({}) }),
  /** Name used when a donation has no nickname. */
  anonymousName: z.string().default('익명의 후원자'),
  rules: z.array(RuleSchema).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;
export type TtsConfig = Config['outputs']['tts'];
export type AvatarConfig = Config['outputs']['avatar'];

export interface LoadedConfig {
  config: Config;
  /** Absolute path of the config file, or null when running on defaults. */
  path: string | null;
  /** Directory where tokens and other state are kept. */
  dataDir: string;
}

/** Replace `${NAME}` and `${NAME:-fallback}` with environment variables. */
export function substituteEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return text.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_, name: string, fallback?: string) => {
    const value = env[name];
    return value !== undefined && value !== '' ? value : (fallback ?? '');
  });
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function parseConfig(text: string, env: NodeJS.ProcessEnv = process.env): Config {
  let raw: unknown;
  try {
    raw = parseYaml(substituteEnv(text, env)) ?? {};
  } catch (err) {
    throw new ConfigError(`Could not parse YAML: ${(err as Error).message}`);
  }
  // `key: ${EMPTY_VAR}` parses as null; treat it as "not set" so defaults apply.
  const result = ConfigSchema.safeParse(dropNulls(raw));
  if (!result.success) {
    throw new ConfigError(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export interface RuleIssue {
  /** Where the problem is, e.g. [0, 'actions', 1, 'scene']. */
  path: (string | number)[];
  message: string;
}

/** `${VAR}` placeholders in every string of a parsed YAML value, like parseConfig does for the file. */
export function substituteEnvDeep(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string') return substituteEnv(value, env);
  if (Array.isArray(value)) return value.map((v) => substituteEnvDeep(v, env));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnvDeep(v, env)]));
  return value;
}

/**
 * Validate rules as they are written in ojakgyo.yaml (placeholders allowed), for the dashboard
 * editor. Returns the parsed rules, or every problem with its path so the form can point at it.
 */
export function validateRules(raw: unknown, env: NodeJS.ProcessEnv = process.env): { ok: true; rules: Rule[] } | { ok: false; issues: RuleIssue[] } {
  const result = z.array(RuleSchema).safeParse(dropNulls(substituteEnvDeep(raw, env)));
  if (result.success) {
    const names = new Set<string>();
    const issues: RuleIssue[] = [];
    result.data.forEach((rule, i) => {
      // Cooldowns are tracked by name, so two rules with one name would share a cooldown.
      if (names.has(rule.name)) issues.push({ path: [i, 'name'], message: 'another rule already has this name' });
      names.add(rule.name);
    });
    return issues.length ? { ok: false, issues } : { ok: true, rules: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map((i) => ({
      path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
      // A missing required field reads "expected string, received undefined"; say it plainly.
      message: i.code === 'invalid_type' && /received undefined$/.test(i.message) ? 'required' : i.message,
    })),
  };
}

function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => v !== null).map(dropNulls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, dropNulls(v)]),
    );
  }
  return value;
}

export function loadConfig(path?: string): LoadedConfig {
  const candidates = path ? [path] : ['ojakgyo.yaml', 'ojakgyo.yml'];
  for (const candidate of candidates) {
    const abs = resolve(candidate);
    if (!existsSync(abs)) continue;
    const dir = dirname(abs);
    const envFile = resolve(dir, '.env');
    if (existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);
    return { config: parseConfig(readFileSync(abs, 'utf8')), path: abs, dataDir: resolve(dir, '.ojakgyo') };
  }
  if (path) throw new ConfigError(`Config file not found: ${path}`);
  return { config: parseConfig(''), path: null, dataDir: resolve('.ojakgyo') };
}
