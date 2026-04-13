/**
 * Global mirror: JSONL index only (NOT full copy of capture content).
 *
 * On every turn finalization, one JSON line is appended to
 * `~/.claude/sop/<hash12>/index.jsonl` (or the dev-army variant).
 *
 * Also handles project-move migration: when PathResolver detects the
 * project was moved, rename the global dir atomically and rewrite
 * the index paths.
 */
import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { lockSync, unlockSync } from 'proper-lockfile';
import type { TurnMeta } from '../types.js';
import type { CapturePaths } from '../paths.js';

export interface GlobalIndexLine {
  turn_id: string;
  session_id: string;
  project_id: string;
  project_path: string;
  project_turn_dir: string;
  agent: string;
  parent_turn_id: string | null;
  finalization_reason: string;
  t: string;
}

export function resolveGlobalTargetDir(
  paths: CapturePaths,
  projectRoot: string,
  detectDevArmyAgent: (root: string) => string | null,
): string {
  const devArmyAgent = detectDevArmyAgent(projectRoot);
  return devArmyAgent ? paths.devArmyGlobalDir(devArmyAgent) : paths.globalProjectDir;
}

export function appendGlobalIndexLine(
  paths: CapturePaths,
  projectRoot: string,
  meta: TurnMeta,
  turnDirAbs: string,
  detectDevArmyAgent: (root: string) => string | null,
): void {
  const targetDir = resolveGlobalTargetDir(paths, projectRoot, detectDevArmyAgent);
  const indexPath = join(targetDir, 'index.jsonl');
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  if (!existsSync(indexPath)) {
    try {
      writeFileSync(indexPath, '', { mode: 0o600, flag: 'wx' });
    } catch (err) {
      // EEXIST race — another writer created it between our check and write
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }

  const line: GlobalIndexLine = {
    turn_id: meta.turn_id,
    session_id: meta.session_id,
    project_id: meta.project_id,
    project_path: projectRoot,
    project_turn_dir: turnDirAbs,
    agent: meta.agent,
    parent_turn_id: meta.parent_turn_id,
    finalization_reason: meta.finalization_reason ?? 'unknown',
    t: meta.finalized_at ?? new Date().toISOString(),
  };

  // Plan mandates proper-lockfile for global index (multi-project concurrent writers)
  lockSync(indexPath);
  try {
    appendFileSync(indexPath, JSON.stringify(line) + '\n', { mode: 0o600 });
  } finally {
    unlockSync(indexPath);
  }
}

/**
 * Migrate the global dir when a project is moved (D2).
 *
 * - Same dir: no-op
 * - Old doesn't exist: no-op
 * - New already exists: collision, log and abort
 * - Otherwise: atomic rename + rewrite index paths
 */
export function migrateGlobalDirOnMove(
  oldGlobalDir: string,
  newGlobalDir: string,
  newProjectPath: string,
): { moved: boolean; linesRewritten: number } {
  if (oldGlobalDir === newGlobalDir) {
    return { moved: false, linesRewritten: 0 };
  }
  if (!existsSync(oldGlobalDir)) {
    return { moved: false, linesRewritten: 0 };
  }
  if (existsSync(newGlobalDir)) {
    // Collision — don't clobber existing data
    try {
      mkdirSync(newGlobalDir, { recursive: true, mode: 0o700 });
      const migrationLog = join(newGlobalDir, 'migration.log');
      const entry = `${new Date().toISOString()} collision with ${oldGlobalDir}\n`;
      appendFileSync(migrationLog, entry, { mode: 0o600 });
    } catch {
      // Best-effort logging
    }
    return { moved: false, linesRewritten: 0 };
  }

  // Atomic rename (same filesystem — both under ~/.claude/sop/)
  mkdirSync(dirname(newGlobalDir), { recursive: true, mode: 0o700 });
  renameSync(oldGlobalDir, newGlobalDir);

  // Rewrite index.jsonl paths
  const indexPath = join(newGlobalDir, 'index.jsonl');
  let linesRewritten = 0;

  if (existsSync(indexPath)) {
    const raw = readFileSync(indexPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const rewritten: string[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as GlobalIndexLine;
        // Replace old project path prefix with new one
        if (parsed.project_turn_dir && parsed.project_path) {
          parsed.project_turn_dir = parsed.project_turn_dir.replace(
            parsed.project_path,
            newProjectPath,
          );
        }
        parsed.project_path = newProjectPath;
        rewritten.push(JSON.stringify(parsed));
        linesRewritten++;
      } catch {
        // Preserve malformed lines as-is
        rewritten.push(line);
      }
    }

    // Atomic rewrite via tmp + rename
    const tmpPath = indexPath + `.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, rewritten.join('\n') + '\n', { mode: 0o600 });
    renameSync(tmpPath, indexPath);
  }

  // Append migration log
  try {
    const migrationLog = join(newGlobalDir, 'migration.log');
    const entry = `${new Date().toISOString()} moved from ${oldGlobalDir} to ${newGlobalDir}, rewrote ${linesRewritten} lines\n`;
    appendFileSync(migrationLog, entry, { mode: 0o600 });
  } catch {
    // Best-effort
  }

  return { moved: true, linesRewritten };
}
