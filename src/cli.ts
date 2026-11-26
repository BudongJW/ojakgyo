#!/usr/bin/env node
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { App } from './app.js';
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

${color.bold('Options')}
  -c, --config <file>           Config file (default: ./ojakgyo.yaml)
  -n, --nickname <name>         simulate: viewer nickname
  -a, --amount <won>            simulate: donation amount in KRW
  -m, --message <text>          simulate: message text
  -p, --port <port>             simulate: bridge port (default 7979)
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

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      nickname: { type: 'string', short: 'n' },
      amount: { type: 'string', short: 'a' },
      message: { type: 'string', short: 'm' },
      port: { type: 'string', short: 'p' },
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
