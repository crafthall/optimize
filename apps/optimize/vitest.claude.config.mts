import { defineConfig } from 'vitest/config';

// `claude` binary, so it is outside `optimize:test`, `optimize:e2e` and `optimize:verify` (: no test there may run
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/optimize-claude',
  test: {
    name: 'optimize-claude',
    watch: false,
    environment: 'node',
    include: ['test/**/*.claude.test.ts'],
    testTimeout: 120_000,
    reporters: ['default'],
  },
});
