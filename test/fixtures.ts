import { ConfigSchema, type Config } from '../src/config.js';

export const ChzzkConfigSchemaForTest = (input: Record<string, unknown>): Config['platforms']['chzzk'] =>
  ConfigSchema.parse({ platforms: { chzzk: input } }).platforms.chzzk;
