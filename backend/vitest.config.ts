import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests share one database; run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://nops:nops@localhost:55432/nops_test',
      SESSION_SECRET: 'test-session-secret-test-session-secret',
      CRON_SECRET: 'test-cron-secret',
      DEMO_MODE: 'true',
      DB_POOL_MAX: '20',
      // Never use a real AI key from .env in tests; assistant tests inject a fake model.
      GROQ_API_KEY: '',
      CORS_ORIGINS: '',
    },
  },
});
