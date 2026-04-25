import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: [
      'test/smoke.test.ts',
      'test/smoke-package-imports.test.ts',
      'test/integration/**',
      'test/capture/integration/**',
      '**/node_modules/**',
    ],
    setupFiles: ['test/setup/no-network.ts'],
    hookTimeout: 180_000,
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
