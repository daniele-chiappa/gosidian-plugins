import { defineConfig } from 'vitest/config';

// The page is served at <plugin>/app/: every address in it is relative.
// Nothing inline, so the CSP admits script-src 'self' alone.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    target: 'es2022',
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
