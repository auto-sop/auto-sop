import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm', 'cjs'],
  dts: { entry: 'src/index.ts' },
  sourcemap: false,
  clean: true,
  target: 'node18.17',
  outExtension({ format }) {
    return format === 'esm' ? { js: '.js' } : { js: '.cjs' };
  },
});
