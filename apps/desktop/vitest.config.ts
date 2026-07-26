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
