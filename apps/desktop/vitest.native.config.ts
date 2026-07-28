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
    // Stage 3C-CI-RESET §3.3 — EXPLICIT native certification inventory.
    // No broad glob. The audit identified that a broad
    // `tests/native/**/*.test.ts` include silently altered
    // certification counts every time a new test file appeared and
    // let auth seam + protection-seed regression run twice under
    // different configs. This file lists only the native Electron
    // journey. protectionSeedRegression + auth_seam_login_body run
    // under vitest.external.config.ts, exactly once each.
    include: [
      'tests/native/nativeElectron.integration.test.ts',
    ],
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
    // Stage 3C-CI-FIX9 §3.1: fail fast after the first substantive
    // native failure so the suite does not spend minutes repeating
    // 25s screen-navigation waits behind an unauthenticated AuthGate
    // (the FIX8 run's exact failure mode). afterAll still runs so
    // Electron close + server kill + scratch DB drop + Redis
    // namespace clear + process-leak check still fire.
    bail: 1,
  },
});
