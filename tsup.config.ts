import { defineConfig } from 'tsup';

export default defineConfig([
  // Phase 0 library entry points
  {
    entry: ['src/index.ts', 'src/cli.ts'],
    format: ['esm', 'cjs'],
    dts: { entry: 'src/index.ts' },
    sourcemap: false,
    clean: true,
    target: 'node18.17',
    outExtension({ format }) {
      return format === 'esm' ? { js: '.js' } : { js: '.cjs' };
    },
  },
  // Capture shim: production bundle (baked-in writer entry)
  {
    entry: { 'capture/shim': 'src/capture/shim/main.ts' },
    format: ['cjs'],
    sourcemap: false,
    clean: false,
    target: 'node18',
    bundle: true,
    minify: true,
    treeshake: true,
    noExternal: ['nanoid'],
    outExtension() {
      return { js: '.cjs' };
    },
  },
  // Capture shim: bench bundle (env-driven writer entry)
  {
    entry: { 'capture/shim-bench': 'src/capture/shim/main-bench.ts' },
    format: ['cjs'],
    sourcemap: false,
    clean: false,
    target: 'node18',
    bundle: true,
    minify: true,
    treeshake: true,
    noExternal: ['nanoid'],
    outExtension() {
      return { js: '.cjs' };
    },
  },
  // Capture writer: detached grandchild entrypoint (FROZEN after plan 01-03)
  {
    entry: { 'capture/writer': 'src/capture/writer/main.ts' },
    format: ['cjs'],
    sourcemap: false,
    clean: false,
    target: 'node18',
    bundle: true,
    minify: true,
    noExternal: ['nanoid', 'execa'],
    outExtension() {
      return { js: '.cjs' };
    },
  },
]);
