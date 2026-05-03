/**
 * Global mirror hooks — wired via side-effect import in routes/index.ts.
 *
 * 1. Finalize hook: appends one JSONL line per finalized turn to the global index.
 * 2. Pre-start hook: detects project move and migrates the global dir atomically.
 *
 * main.ts is NEVER edited — all wiring is through hook registries.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerFinalizeHook } from './finalize-hooks.js';
import { registerPreStartHook } from './pre-start-hooks.js';
import { appendGlobalIndexLine, migrateGlobalDirOnMove } from '../global-mirror.js';
import { detectAgent, getCapturePaths } from '../../paths.js';
import { getErrorWriter } from '../errors.js';

// ── Finalize hook: append one index line per turn ────────────────────
registerFinalizeHook((finalizedDir, meta, ctx) => {
  try {
    appendGlobalIndexLine(ctx.paths, ctx.projectRoot, meta, finalizedDir, detectAgent);
  } catch (err) {
    getErrorWriter()?.('global_mirror_failed', meta.turn_id, err);
  }
});

// ── Pre-start hook: detect project move and migrate global dir ───────
registerPreStartHook((_event, ctx) => {
  try {
    // Read stored project.json synchronously to detect move
    const projectJsonPath = join(ctx.projectRoot, '.auto-sop', 'project.json');
    let stored: { version: number; projectId: string } | null = null;
    try {
      const raw = readFileSync(projectJsonPath, 'utf8');
      stored = JSON.parse(raw) as { version: number; projectId: string };
      if (stored.version !== 1) stored = null;
    } catch {
      // No stored project.json yet — no move possible
      stored = null;
    }

    if (stored && stored.projectId !== ctx.projectId) {
      // Project was moved — compute old and new global dirs
      const oldPaths = getCapturePaths(ctx.projectRoot, stored.projectId);
      const oldGlobalDir = resolveGlobalDirForCtx(oldPaths, ctx.projectRoot);
      const newGlobalDir = resolveGlobalDirForCtx(ctx.paths, ctx.projectRoot);

      const result = migrateGlobalDirOnMove(oldGlobalDir, newGlobalDir, ctx.projectRoot);
      if (result.moved) {
        getErrorWriter()?.(
          'project_moved',
          null,
          `${oldGlobalDir} -> ${newGlobalDir}, rewrote ${result.linesRewritten} lines`,
        );
      }
    }
  } catch (err) {
    getErrorWriter()?.('project_move_migration_failed', null, err);
  }
  return { abort: false };
});

/**
 * Resolve the global dir for a given paths + projectRoot combo,
 * taking the agent namespace into account.
 */
function resolveGlobalDirForCtx(
  paths: ReturnType<typeof getCapturePaths>,
  projectRoot: string,
): string {
  const agent = detectAgent(projectRoot);
  return agent ? paths.agentGlobalDir(agent) : paths.globalProjectDir;
}
