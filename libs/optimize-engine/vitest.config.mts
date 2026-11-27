import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/optimize-engine',
  test: {
    name: 'optimize-engine',
    watch: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Load-sensitive: at a machine load of 300-600 (parallel agent sessions) tests that spawn git or run
    // hundreds of property cases passed the 5 s default, and pure property tests passed 30 s. One wide limit for
    // every test – it still catches a hang – never a retry, a skip or fewer cases.
    testTimeout: 120_000,
    reporters: ['default'],
  },
});
