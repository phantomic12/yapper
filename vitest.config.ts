import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // vmThreads rather than the default threads pool: same per-file
    // isolation, but jsdom is built once per worker instead of once per
    // file. Measured here over the 49-file suite, 18.7s → 4.2s, with the
    // setup file still applied per file. `isolate: false` would be faster
    // again but shares globals between files, and several suites here set
    // module-level state that must not leak.
    pool: 'vmThreads',
    globals: true,
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/vite-env.d.ts'],
    },
  },
});
