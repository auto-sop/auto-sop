/**
 * Shared learner spawn logic — used by both `recap --run` and `learn-now`.
 *
 * Extracts the child-process spawning, env-var wiring, and recap-line
 * collection into a single reusable function so both verbs stay thin.
 */
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execa } from 'execa';

// ── Types ──────────────────────────────────────────────────

export interface LearnerOptions {
  dryRun?: boolean;
  offline?: boolean;
  forceLlm?: boolean;
  limit?: number;
  json?: boolean;
}

export interface LearnerResult {
  exitCode: number;
  recapLines: unknown[];
  error?: string | undefined;
}

// ── Learner discovery ──────────────────────────────────────

export function findLearnerCjs(): string | null {
  // Check installed location first
  const installed = path.join(
    os.homedir(),
    '.auto-sop',
    'marketplace',
    'auto-sop',
    'learner.cjs',
  );
  if (existsSync(installed)) return installed;

  // Check dist/plugin/ (dev mode)
  const devPath = path.resolve('dist/plugin/learner.cjs');
  if (existsSync(devPath)) return devPath;

  return null;
}

// ── Recap log path ─────────────────────────────────────────

export function recapLogPath(home?: string): string {
  return path.join(home ?? os.homedir(), '.auto-sop', 'logs', 'recap.log');
}

// ── Main spawn function ────────────────────────────────────

/**
 * Spawn the learner child process and return new recap lines.
 *
 * Handles env-var mapping for all flags:
 * - `offline`   → CLAUDE_SOP_LEARNER_MODE=offline
 * - `dryRun`    → CLAUDE_SOP_LEARNER_DRY_RUN=1
 * - `forceLlm`  → CLAUDE_SOP_FORCE_LLM=1
 */
export async function runLearner(opts: LearnerOptions): Promise<LearnerResult> {
  const learnerPath = findLearnerCjs();
  if (!learnerPath) {
    return {
      exitCode: 1,
      recapLines: [],
      error: 'learner.cjs not found',
    };
  }

  const logPath = recapLogPath();

  // Record pre-run line count so we can extract only new lines after
  let preRunLines = 0;
  try {
    const text = readFileSync(logPath, 'utf8');
    preRunLines = text.split('\n').filter((l) => l.trim()).length;
  } catch {
    // file doesn't exist yet
  }

  // Build child env
  const env: Record<string, string> = {
    HOME: os.homedir(),
    PATH: process.env.PATH ?? '',
  };
  if (opts.offline) {
    env.AUTO_SOP_LEARNER_MODE = 'offline';
    env.CLAUDE_SOP_LEARNER_MODE = 'offline'; // backward compat
  }
  if (opts.dryRun) {
    env.AUTO_SOP_LEARNER_DRY_RUN = '1';
    env.CLAUDE_SOP_LEARNER_DRY_RUN = '1'; // backward compat
  }
  if (opts.forceLlm) {
    env.AUTO_SOP_FORCE_LLM = '1';
    env.CLAUDE_SOP_FORCE_LLM = '1'; // backward compat
  }

  // Spawn
  let exitCode = 0;
  let spawnError: string | undefined;
  try {
    await execa('node', [learnerPath], { env, timeout: 130_000 });
  } catch (err) {
    exitCode = 1;
    spawnError = err instanceof Error ? err.message : String(err);
  }

  // Extract new recap lines
  const recapLines: unknown[] = [];
  try {
    const text = readFileSync(logPath, 'utf8');
    const allLines = text.split('\n').filter((l) => l.trim());
    const newLines = allLines.slice(preRunLines);
    for (const line of newLines) {
      try {
        recapLines.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
  } catch {
    // no recap log
  }

  return { exitCode, recapLines, error: spawnError };
}
