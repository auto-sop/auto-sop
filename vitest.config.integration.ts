import { defineConfig } from 'vitest/config';

/**
 * Integration test config — runs ONLY integration tests sequentially
 * (fileParallelism: false) to prevent resource contention in e2e tests
 * that rebuild the project, spawn subprocesses, etc.
 *
 * Separate from the base vitest.config.ts which runs all other tests
 * in parallel. Use via: npm run test:integration
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts', 'test/capture/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    setupFiles: ['test/setup/no-network.ts'],
    hookTimeout: 180_000,
    // BUG-E1: Run integration test files sequentially to prevent flaky
    // failures caused by resource contention under parallel load.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
    },
  },
  resolve: {
    alias: {
      '~': './src',
    },
  },
});
