import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: { OJAKGYO_LOG_LEVEL: 'error' },
  },
});
