import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Minimal env so modules that validate env on import (env.ts) can load.
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-please-change-1234',
      DATABASE_URL: 'mysql://root:password@localhost:3306/horizon_trade_test',
      REDIS_URL: 'redis://localhost:6379',
      DRY_RUN: 'true',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});
