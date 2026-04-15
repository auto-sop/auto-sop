import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/smoke.test.ts', '**/node_modules/**'],
    setupFiles: ['test/setup/no-network.ts'],
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
