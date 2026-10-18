import { existsSync } from 'node:fs';
import { spawnWriter } from './handoff.js';
import main from './main-core.js';

/**
 * Bench-only shim entry. Identical hot path to the production shim
 * (main-core.ts); the only difference is that the writer entry comes from the
 * environment instead of being baked in, so benchmarks can point it at either
 * the real built writer or a stub.
 */

/** Env var naming the writer entry. Canonical name first, legacy fallback second. */
export const BENCH_WRITER_ENV = 'AUTO_SOP_BENCH_WRITER';
export const LEGACY_BENCH_WRITER_ENV = 'CLAUDE_SOP_BENCH_WRITER';

/**
 * Resolve the writer entry for the bench shim, refusing to run when it is
 * missing. The writer is spawned detached with stdio ignored, so a bad path
 * would otherwise fail silently in the grandchild while the shim exits 0 —
 * a benchmark would then time "work" that never happened.
 */
export function resolveBenchWriter(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
): string {
  const writer = env[BENCH_WRITER_ENV] ?? env[LEGACY_BENCH_WRITER_ENV];
  if (!writer) {
    throw new Error(`Neither ${BENCH_WRITER_ENV} nor ${LEGACY_BENCH_WRITER_ENV} is set`);
  }
  if (!exists(writer)) {
    throw new Error(`Bench writer entry does not exist: ${writer}`);
  }
  return writer;
}

// Run only when executed as the bundled CJS entry, so tests can import
// resolveBenchWriter without the module consuming their stdin.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main(spawnWriter, resolveBenchWriter(process.env));
}
