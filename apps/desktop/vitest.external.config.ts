/**
 * Stage 3C-CI-FIX4 §B2 — external-services vitest config.
 *
 * The mandatory integration suite that requires REAL MariaDB and
 * REAL Redis. Runs on the pinned Linux native workflow BEFORE the
 * native harness (so a schema/probe regression fails fast without
 * burning wall-clock on Electron). NEVER runs on Windows CI (which
 * has no services provisioned).
 *
 * When HORIZON_REQUIRE_EXTERNAL_SERVICES=true the tests MUST fail
 * on missing services — no silent skip.
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

const reactPath = fileURLToPath(new URL('./node_modules/react', import.meta.url));
const reactDomPath = fileURLToPath(new URL('./node_modules/react-dom', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^react$/, replacement: reactPath },
      { find: /^react-dom$/, replacement: reactDomPath },
    ],
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'node',
    // Stage 3C-CI-RESET §3.2 — external declared inventory (each
    // file appears exactly once across the three vitest configs).
    include: [
      'tests/stage1_schema_fingerprint.test.ts',
      'tests/stage1_mariadb_probe.test.ts',
      'tests/stage1_redis_probe.test.ts',
      'tests/stage1fix_external_services_integration.test.ts',
      'tests/stage2_end_to_end_integration.test.ts',
      'tests/stage2fix_bootstrap_scope.test.ts',
      'tests/native/protectionSeedRegression.test.ts',
      // §1.4: the auth seam is a real external preflight — not the
      // Electron certification journey. It goes here (external), NOT
      // in vitest.native.config.ts. Discovered exactly once.
      'tests/native/auth_seam_login_body.integration.test.ts',
    ],
    exclude: ['node_modules/**', 'dist/**'],
    globals: true,
    testTimeout: 90_000,
    hookTimeout: 180_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    retry: 0,
    fileParallelism: false,
  },
});
