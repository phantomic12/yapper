import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // vmThreads rather than the default threads pool: jsdom is built
    // once per worker instead of once per file. Measured over the
    // 49-file suite: 18.7s → 3.8s, setup file still applied per file.
    // `isolate: false` was measured too — 3.6s, green three ways
    // including a shuffled run — and rejected: suites here keep
    // module-level state (document registry, engine singletons), and
    // a green run proves nothing about a future test that leaks into
    // a neighbour. The 0.2s is not worth that.
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
