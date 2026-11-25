/* Tiny dependency-free logger with colours and a listener hook for the dashboard. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  level: LogLevel;
  scope: string;
  message: string;
  time: number;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const color = {
  dim: paint('2'),
  bold: paint('1'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
};

const LEVEL_TAG: Record<LogLevel, string> = {
  debug: color.dim('debug'),
  info: color.cyan(' info'),
  warn: color.yellow(' warn'),
  error: color.red('error'),
};

type Listener = (record: LogRecord) => void;

let threshold: LogLevel = (process.env.OJAKGYO_LOG_LEVEL as LogLevel) || 'info';
const listeners = new Set<Listener>();

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export function onLog(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createLogger(scope: string): Logger {
  const write = (level: LogLevel, message: string) => {
    const record: LogRecord = { level, scope, message, time: Date.now() };
    for (const listener of listeners) listener(record);
    if (ORDER[level] < ORDER[threshold]) return;
    const time = new Date(record.time).toLocaleTimeString('en-GB', { hour12: false });
    const line = `${color.dim(time)} ${LEVEL_TAG[level]} ${color.magenta(scope.padEnd(8))} ${message}`;
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: (m) => write('debug', m),
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
  };
}

/** Error -> readable one-liner, without leaking stack noise into the dashboard. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
