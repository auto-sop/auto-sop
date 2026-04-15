import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/smoke.test.ts'],
  },
  resolve: {
    alias: {
      '~': './src',
    },
  },
});
