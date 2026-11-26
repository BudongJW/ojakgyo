#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { App } from './app.js';
import { describeLicense, readAvatarLicense } from './avatar/license.js';
import { optimizeGlb } from './avatar/optimize.js';
import { ConfigError, loadConfig } from './config.js';
import { color, createLogger, errorMessage, setLogLevel } from './core/logger.js';
import { VERSION } from './version.js';

const log = createLogger('ojakgyo');
const PKG_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const HELP = `
${color.bold('ojakgyo')} ${color.dim(`v${VERSION}`)}: connect CHZZK events to VTube Studio, OBS and overlays

${color.bold('Usage')}
  ojakgyo init                  Create ojakgyo.yaml and .env in the current folder
  ojakgyo start [-c file]       Start the bridge, dashboard and overlays
  ojakgyo simulate <type>       Send a test event to a running bridge
                                type: chat | donation | subscription
  ojakgyo avatar optimize <file.vrm> [-o out.vrm] [--max 1024]
                                Shrink an avatar's textures for faster loading
  ojakgyo avatar info <file>    Show what an avatar's own license allows (.vrm, .inp, .inx)

${color.bold('Options')}
  -c, --config <file>           Config file (default: ./ojakgyo.yaml)
  -n, --nickname <name>         simulate: viewer nickname
  -a, --amount <won>            simulate: donation amount in KRW
  -m, --message <text>          simulate: message text
  -p, --port <port>             simulate: bridge port (default 7979)
  -o, --out <file>              avatar optimize: output file (default <name>.optimized.vrm)
      --max <px>                avatar optimize: longest texture edge (default 1024)
      --debug                   Verbose logs
  -v, --version                 Print version
  -h, --help                    Show this help
`;

function banner(origin: string): void {
  const row = (label: string, url: string, note = '') =>
    `  ${label.padEnd(15)}${color.cyan(url)}${note ? `  ${color.dim(note)}` : ''}`;
  const lines = [
    '',
    `  ${color.bold('ojakgyo')} ${color.dim(`v${VERSION}`)}`,
    '',
    row('Dashboard', `${origin}/`),
    row('Alert overlay', `${origin}/overlay/alerts`, '1920×1080 browser source'),
    row('Chat overlay', `${origin}/overlay/chat`, '500×800 browser source'),
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

async function cmdStart(configPath?: string): Promise<void> {
  const loaded = loadConfig(configPath);
  if (!loaded.path) log.warn('No ojakgyo.yaml found, running with defaults. Run `ojakgyo init` to create one.');
  else log.info(`config: ${loaded.path}`);
  const app = new App(loaded);
  await app.start();
  banner(app.server.origin);
  if (loaded.config.rules.length === 0) log.warn('No rules configured: events will show on the dashboard but trigger nothing.');

  let stopping = false;
  const shutdown = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    log.info('shutting down…');
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function cmdInit(): void {
  const target = resolve('ojakgyo.yaml');
  if (existsSync(target)) {
    log.warn('ojakgyo.yaml already exists, leaving it untouched.');
  } else {
    copyFileSync(resolve(PKG_ROOT, 'ojakgyo.example.yaml'), target);
    log.info(`created ${target}`);
  }
  const envFile = resolve('.env');
  if (!existsSync(envFile)) {
    writeFileSync(
      envFile,
      [
        '# Register an app at https://developers.chzzk.naver.com and paste its keys here.',
        '# Redirect URL to register: http://localhost:7979/auth/chzzk/callback',
        'CHZZK_CLIENT_ID=',
        'CHZZK_CLIENT_SECRET=',
        '',
        '# Tools → WebSocket Server Settings in OBS',
        'OBS_PASSWORD=',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    log.info(`created ${envFile} ${color.dim('(keep it out of git)')}`);
  }
  log.info(`next: fill in .env, then run ${color.bold('ojakgyo start')}`);
}

async function cmdSimulate(type: string | undefined, v: Record<string, string | boolean | undefined>): Promise<void> {
  if (!type || !['chat', 'donation', 'subscription'].includes(type)) {
    throw new Error('simulate needs a type: chat | donation | subscription');
  }
  const port = Number(v.port ?? 7979);
  const body = {
    type,
    nickname: v.nickname,
    amount: v.amount !== undefined ? Number(v.amount) : undefined,
    message: v.message ?? (type === 'chat' ? '안녕하세요!' : '오작교 테스트 후원입니다 ✨'),
  };
  const res = await fetch(`http://127.0.0.1:${port}/api/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {
    throw new Error(`no bridge running on port ${port}. Start one with \`ojakgyo start\``);
  });
  const json = (await res.json()) as { ok?: boolean; error?: string };
  if (!res.ok) throw new Error(json.error ?? `bridge answered ${res.status}`);
  log.info(`sent a simulated ${type}`);
}

function cmdAvatarInfo(file: string): void {
  const l = readAvatarLicense(resolve(file));
  const verdictLog = l.verdict === 'ok' ? log.info : log.warn;
  verdictLog(describeLicense(l));
  const format = { vrm1: 'VRM 1.0', vrm0: 'VRM 0.x', inochi2d: 'Inochi2D puppet', glb: 'glTF without VRM data' }[l.format];
  log.info(`format ${format}${l.license ? ` · license ${l.license}` : ''}`);
  for (const n of l.notes) (n.level === 'info' ? log.info : log.warn)(`${n.text}${n.url ? ` ${n.url}` : ''}`);
  log.info(color.dim("These are the file's own fields. A model converted from someone else's character keeps the original owner's terms."));
}

function cmdAvatar(sub: string | undefined, file: string | undefined, v: Record<string, string | boolean | undefined>): void {
  if (sub === 'info' && file) return cmdAvatarInfo(file);
  if (sub !== 'optimize' || !file) throw new Error('usage: ojakgyo avatar optimize <file.vrm> [-o out.vrm] [--max 1024]  |  ojakgyo avatar info <file>');
  const maxSize = Number(v.max ?? 1024);
  if (!Number.isInteger(maxSize) || maxSize < 64 || maxSize > 8192) throw new Error('--max must be a whole number between 64 and 8192');
  const input = resolve(file);
  const ext = extname(input) || '.vrm';
  const out = resolve(typeof v.out === 'string' ? v.out : join(dirname(input), `${basename(input, ext)}.optimized${ext}`));
  if (out === input) throw new Error('refusing to overwrite the input file; pick another --out');

  const { output, report } = optimizeGlb(readFileSync(input), { maxSize });
  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
  for (const img of report.images) {
    log.info(`${img.name.padEnd(28).slice(0, 28)} ${img.from.join('×')} → ${img.to.join('×')}  ${mb(img.bytesBefore)} → ${mb(img.bytesAfter)}`);
  }
  if (report.images.length === 0) {
    log.info(`nothing to do: every texture is already ${maxSize}px or smaller`);
    return;
  }
  writeFileSync(out, output);
  // The copy keeps the original's license; say so when that license limits what the copy may be.
  try {
    const license = readAvatarLicense(input);
    if (license.notes.some((n) => n.code === 'noModification')) log.warn("this model's license does not allow modification: keep the optimized copy to yourself, or ask the author first");
    if (license.notes.some((n) => n.code === 'noRedistribution')) log.info("this model's license does not allow sharing the file, and that covers the optimized copy too");
  } catch {
    /* license fields are informational */
  }
  const saved = 1 - report.bytesAfter / report.bytesBefore;
  log.info(`${color.bold(mb(report.bytesBefore))} → ${color.bold(mb(report.bytesAfter))} (${Math.round(saved * 100)}% smaller), ${report.images.length} textures resized`);
  log.info(`wrote ${out}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      nickname: { type: 'string', short: 'n' },
      amount: { type: 'string', short: 'a' },
      message: { type: 'string', short: 'm' },
      port: { type: 'string', short: 'p' },
      out: { type: 'string', short: 'o' },
      max: { type: 'string' },
      debug: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.debug) setLogLevel('debug');
  if (values.version) return void console.log(VERSION);

  const [command, ...rest] = positionals;
  switch (command) {
    case 'start':
      return cmdStart(values.config);
    case 'init':
      return cmdInit();
    case 'simulate':
      return cmdSimulate(rest[0], values);
    case 'avatar':
      return cmdAvatar(rest[0], rest[1], values);
    case undefined:
    case 'help':
      return void console.log(HELP);
    default:
      console.log(HELP);
      throw new Error(`unknown command "${command}"`);
  }
}

main().catch((err) => {
  if (err instanceof ConfigError) log.error(err.message);
  else log.error(errorMessage(err));
  process.exit(1);
});
