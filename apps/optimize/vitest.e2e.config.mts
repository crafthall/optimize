import { defineConfig } from 'vitest/config';

// E2E of the built CLI (dist/crafthall-optimize.mjs) in a clean HOME with Crafthall HQ absent (R0-14).
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/optimize-e2e',
  test: {
    name: 'optimize-e2e',
    watch: false,
    environment: 'node',
    include: ['test/**/*.e2e.test.ts'],
    // A test spawns the built CLI, which runs stub `claude` calls in git worktrees; the vitest default of 5 s is below
    // one such run under the parallel load of `optimize:verify`. Matches runCli's spawn timeout (e2e-path.ts).
    testTimeout: 120_000,
    // The package E2E packs and installs the tarball in beforeAll; at a machine load above 100 that took over the
    // 10 s hook default. Same wide limit as a test – it still catches a hang – never a retry.
    hookTimeout: 120_000,
    reporters: ['default'],
  },
});
