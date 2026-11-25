import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

/**
 * Small JSON key-value store for secrets ojakgyo must remember between runs
 * (OAuth tokens, the VTube Studio plugin token). Written atomically with
 * owner-only permissions. Lives in `.ojakgyo/` next to your config, which is
 * git-ignored by default.
 */
export class FileStore implements KeyValueStore {
  private readonly file: string;
  private data: Record<string, unknown> = {};

  constructor(private readonly dir: string) {
    this.file = join(dir, 'secrets.json');
    if (existsSync(this.file)) {
      try {
        this.data = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      } catch {
        this.data = {};
      }
    }
  }

  get<T>(key: string): T | undefined {
    return this.data[key] as T | undefined;
  }

  set(key: string, value: unknown): void {
    if (value === undefined) delete this.data[key];
    else this.data[key] = value;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  delete(key: string): void {
    this.set(key, undefined);
  }
}

/** In-memory store for tests. */
export class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  set(key: string, value: unknown): void {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, value);
  }
  delete(key: string): void {
    this.data.delete(key);
  }
}
