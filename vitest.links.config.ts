import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * Config for `npm run test:links` — the network-dependent half of
 * src/links.test.ts.
 *
 * The opt-in lives in `test.env` rather than in the npm script itself so the
 * command works the same on Windows as on Linux; the old
 * `YAPPER_LINK_CHECK=1 vitest ...` form is POSIX shell syntax and cmd.exe
 * reads it as the (nonexistent) program YAPPER_LINK_CHECK=1.
 *
 * The base config is spread rather than merged because `mergeConfig`
 * concatenates `include`, which would quietly run the whole suite again.
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/links.test.ts'],
    env: { ...base.test?.env, YAPPER_LINK_CHECK: '1' },
  },
});
