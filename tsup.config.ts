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
    shims: true,
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
    banner: { js: '#!/usr/bin/env node' },
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
  // Capture writer: detached grandchild entrypoint — ALL runtime deps bundled (no ancestor node_modules in installed bundle)
  {
    entry: { 'capture/writer': 'src/capture/writer/main.ts' },
    format: ['cjs'],
    sourcemap: false,
    clean: false,
    target: 'node18',
    bundle: true,
    minify: true,
    noExternal: [/.*/],
    outExtension() {
      return { js: '.cjs' };
    },
  },
  // Plugin shim: bundled copy for dist/plugin/ (same source as capture/shim)
  {
    entry: { 'plugin/shim': 'src/capture/shim/main.ts' },
    format: ['cjs'],
    sourcemap: false,
    clean: false,
    target: 'node18',
    bundle: true,
    minify: true,
    treeshake: true,
    noExternal: ['nanoid'],
    banner: { js: '#!/usr/bin/env node' },
    outExtension() {
      return { js: '.cjs' };
    },
  },
  // Learner: real Phase 3 batch entry point — ALL runtime deps bundled
  {
    entry: { 'plugin/learner': 'src/learner/main.ts' },
    format: ['cjs'],
    sourcemap: false,
    clean: false,
    target: 'node18',
    bundle: true,
    minify: true,
    // FIX: treeshake was stripping saveMetricsState + loadMetricsState because
    // every call site is inside try/catch with empty catch blocks. The tree-shaker
    // treats those as dead code (side-effect-free). Disabling tree-shake for
    // the learner is safe — bundle grows ~10KB but all metrics code survives.
    treeshake: false,
    noExternal: [/.*/],
    banner: { js: '#!/usr/bin/env node' },
    outExtension() {
      return { js: '.cjs' };
    },
    // B10: unicorn-magic (transitive via execa → npm-run-path) imports
    // execFileSync from node:child_process but tree-shaking eliminates
    // the call site. The warning comes from rollup's tree-shake pass
    // which tsup doesn't expose an onwarn callback for, so we suppress
    // all warnings here via silent:true.
    // NOTE: This suppresses ALL warnings for this bundle entry (plugin/learner),
    // not just the unicorn-magic one. Revisit if we see real missing externals
    // or circular dependency warnings that should not be silenced.
    silent: true,
  },
]);
