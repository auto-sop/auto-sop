/**
 * Writer entrypoint — the detached grandchild process.
 * Runs under: `node dist/capture/writer.cjs <tmpPayloadPath>`
 *
 * MUST never crash Claude Code. Everything is wrapped in try/catch → exit 0.
 * Single-writer-per-process-invocation: one writer process handles one event.
 *
 * Kept intentionally minimal — route handlers live in routes/ and are
 * registered via routes/index.ts. This file should rarely need changes.
 */
import { readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HookPayload } from '../events.js';
import { isCaptureDisabled } from '../kill-switch.js';
import { getCapturePaths } from '../paths.js';
import { createScrubber } from '../../scrubber/index.js';
import { PathResolver } from '../../path-resolver/index.js';
import { routes } from './routes/index.js';
import { runPreStartHooks } from './routes/pre-start-hooks.js';
import { initErrorWriter } from './errors.js';
import { findProjectRoot } from './find-project-root.js';
import type { ErrorWriter, HandlerContext } from './routes/types.js';

const HOOK_SHIM_VERSION = '0.1.0';

/**
 * Write an unhandled-event sentinel file so integration tests can detect
 * when a downstream plan forgot to wire its handler into routes/index.ts.
 */
function logUnhandled(eventName: string, ctx: HandlerContext): void {
  try {
    mkdirSync(ctx.paths.projectStateDir, { recursive: true, mode: 0o700 });
    const sentinelPath = join(ctx.paths.projectStateDir, `unhandled-event.${eventName}`);
    writeFileSync(sentinelPath, new Date().toISOString() + '\n', { mode: 0o600 });
  } catch {
    // Best-effort — never crash the writer
  }
}

// Late-binding error writer — plan 01-05 replaces the stub with real impl.
let errorWriter: ErrorWriter | null = null;

async function run(): Promise<void> {
  const tmpPath = process.argv[2];
  if (!tmpPath) {
    process.exit(0);
  }

  // Kill-switch check
  if (isCaptureDisabled(process.env)) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    process.exit(0);
  }

  try {
    // Read and parse the tmp payload
    const raw = readFileSync(tmpPath, 'utf8');
    let event;
    try {
      event = HookPayload.parse(JSON.parse(raw));
    } catch (err) {
      errorWriter?.('zod_parse_failed', null, err);
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      process.exit(0);
      return; // unreachable, satisfies TS
    }

    // Build context — resolve true project root in case agent cd'd into a subdirectory
    const projectRoot = findProjectRoot(event.cwd);
    const resolver = new PathResolver();
    const { identity } = await resolver.resolve(projectRoot);
    const paths = getCapturePaths(projectRoot, identity.projectId);

    // Ensure capture directories exist
    mkdirSync(paths.projectCaptureDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.projectStateDir, { recursive: true, mode: 0o700 });

    // Initialize error writer (stub returns null until 01-05 lands)
    try {
      errorWriter = initErrorWriter(paths);
    } catch {
      // 01-05 not yet landed — errorWriter stays null
    }

    // Create scrubber
    const scrubber = await createScrubber();

    const ctx: HandlerContext = {
      projectRoot,
      projectId: identity.projectId,
      projectSlug: identity.slug,
      paths,
      scrubber,
      hookShimVersion: HOOK_SHIM_VERSION,
    };

    // Run pre-start hooks (01-05 disk budget check etc.)
    const { abort } = runPreStartHooks(event, ctx);
    if (abort) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      process.exit(0);
      return;
    }

    // Dispatch via table lookup — the single extension point
    const handler = routes[event.hook_event_name];
    if (handler) {
      await handler(event, ctx);
    } else {
      logUnhandled(event.hook_event_name, ctx);
    }

    // Clean up tmp payload
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  } catch (err) {
    // Top-level error boundary — writer MUST never crash CC
    errorWriter?.('writer_uncaught', null, err);
  }

  process.exit(0);
}

// Entry
run();
