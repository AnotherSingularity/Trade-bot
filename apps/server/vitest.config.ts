import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Sequential execution for DB-touching suites so they share the test DB
    // without collisions.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-please-change-1234-XXXX-YYYY',
      DATABASE_URL: 'mysql://root:password@127.0.0.1:3306/horizon_trade_test',
      REDIS_URL: 'redis://localhost:6379',
      DRY_RUN: 'true',
      LOGIN_RATE_LIMIT_PER_MINUTE: '10',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});
