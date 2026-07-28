import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

const reactPath = fileURLToPath(new URL('./node_modules/react', import.meta.url));
const reactDomPath = fileURLToPath(new URL('./node_modules/react-dom', import.meta.url));
const jsxRuntimePath = fileURLToPath(new URL('./node_modules/react/jsx-runtime.js', import.meta.url));
const jsxDevRuntimePath = fileURLToPath(new URL('./node_modules/react/jsx-dev-runtime.js', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^react$/, replacement: reactPath },
      { find: /^react\/jsx-runtime$/, replacement: jsxRuntimePath },
      { find: /^react\/jsx-dev-runtime$/, replacement: jsxDevRuntimePath },
      { find: /^react-dom$/, replacement: reactDomPath },
    ],
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Stage 3C-CI-FIX4 §B3: portable unit config excludes every
    // service-dependent path so Windows CI runs green without
    // MariaDB/Redis. The mandatory external suite is at
    // vitest.external.config.ts; the native suite at
    // vitest.native.config.ts.
    exclude: [
      'tests/native/**',
      'tests/**/*external*.test.ts',
      'tests/stage1_schema_fingerprint.test.ts',
      'tests/stage1_mariadb_probe.test.ts',
      'tests/stage1_redis_probe.test.ts',
      'tests/stage1fix_external_services_integration.test.ts',
      'tests/stage2_end_to_end_integration.test.ts',
      'tests/stage2fix_bootstrap_scope.test.ts',
      // Stage 3C-CI-RESET Part 2 Checkpoint D.0: stage2fix_db_isolation,
      // stage1_supervisor_integration, and stage1_command_runner
      // previously appeared here but only exercise pure functions +
      // in-process command spawns (verified in D0 audit). They now run
      // in portable so no executable test remains unassigned.
      'node_modules/**',
      'dist/**',
    ],
    globals: true,
    testTimeout: 15_000,
    environmentMatchGlobs: [
      ['tests/renderer/**', 'jsdom'],
    ],
    server: {
      deps: {
        inline: ['react-router-dom', 'react-router', '@remix-run/router'],
      },
    },
  },
});
