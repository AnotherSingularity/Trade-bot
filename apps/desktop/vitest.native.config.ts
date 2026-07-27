/**
 * Stage 3C — vitest config for the native Electron integration
 * suite.
 *
 * Kept separate from `vitest.config.ts` so that:
 *   - `npm run test` (the fast unit suite) continues to complete
 *     in ~30 s without spawning Electron / a server;
 *   - the native suite runs single-forked with long timeouts and
 *     zero automatic retry (spec §13 forbids accepting a rerun
 *     result — flakiness must be diagnosed, not papered over).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/native/**/*.test.ts'],
    environment: 'node',
    globals: true,
    // Playwright + Electron + real server bootstrap dominates the
    // wall-clock; individual assertions may still complete quickly.
    testTimeout: 240_000,
    hookTimeout: 300_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // No implicit retries — spec §13.
    retry: 0,
    // Serial: the native suite owns MariaDB + Redis + a spawned
    // server and cannot safely run in parallel with itself.
    fileParallelism: false,
  },
});
