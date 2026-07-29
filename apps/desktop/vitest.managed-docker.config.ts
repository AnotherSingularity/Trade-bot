/**
 * Stage 5C — Managed-Docker orchestrator integration vitest config.
 *
 * Runs the orchestrator against a real docker daemon. Independent
 * from the external-services config (which is auth/seed focused) so
 * this suite can be triggered on a docker-capable runner without
 * requiring the full MariaDB/Redis probe suite.
 *
 * Gated at the file level on HORIZON_REQUIRE_MANAGED_DOCKER=true; the
 * config always includes the file but the file itself skips its
 * describe block if the env var is not set.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/integration/managedDockerOrchestrator.integration.test.ts',
    ],
    exclude: ['node_modules/**', 'dist/**'],
    globals: true,
    testTimeout: 300_000,
    hookTimeout: 180_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    retry: 0,
    fileParallelism: false,
  },
});
