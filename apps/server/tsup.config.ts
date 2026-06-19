import { defineConfig } from 'tsup';

/**
 * Bundles the server for production. The `@horizon/shared` workspace package is
 * inlined (`noExternal`) so the compiled output has no runtime dependency on
 * TypeScript source. All real npm dependencies remain external.
 */
export default defineConfig({
  entry: { index: 'src/index.ts', migrate: 'src/db/migrate.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: ['@horizon/shared'],
  // BullMQ ships worker scripts it loads at runtime; keep it external.
  external: ['bullmq', 'ioredis', 'mysql2'],
});
