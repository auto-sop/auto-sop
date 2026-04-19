import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/smoke.test.ts', 'test/smoke-package-imports.test.ts'],
    hookTimeout: 180_000,
  },
  resolve: {
    alias: {
      '~': './src',
    },
  },
});
